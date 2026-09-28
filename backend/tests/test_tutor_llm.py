"""Tests for the optional LLM layer: qentor.tutor.config/llm/guard/answer.

A ``FakeLLMAdapter`` stands in for a real provider throughout — no test here
needs, or should need, a real API key (CLAUDE.md: never require secrets for
the test suite). These tests prove the guard actually rejects a bad draft
rather than trusting it, per docs/AI_BOUNDARY.md §4 step 3.
"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord
from qentor.provenance.models import VerificationStatus as ExecutionStatus
from qentor.tutor.answer import answer_question_with_llm
from qentor.tutor.config import (
    API_KEY_ENV_VAR,
    ENABLE_LLM_ENV_VAR,
    PROVIDER_ENV_VAR,
    build_default_llm_adapter,
    llm_enabled,
)
from qentor.tutor.facts import build_fact_sheet
from qentor.tutor.guard import GuardRejection, validate_llm_draft
from qentor.tutor.llm import AnthropicAdapter, LLMDraft, LLMUnavailable

BELL = Circuit(
    num_qubits=2,
    num_clbits=2,
    ops=[
        GateOp(gate="h", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
    ],
)


def _record(payload: dict) -> ProvenanceRecord:
    return ProvenanceRecord.new(
        circuit_hash=circuit_hash(BELL),
        backend="qiskit-aer",
        backend_version="0.17.2",
        execution_mode="shots",
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.VERIFIED,
        payload=payload,
    )


class FakeLLMAdapter:
    """Test double for qentor.tutor.llm.LLMAdapter — never makes a real call."""

    name = "fake"

    def __init__(self, draft: LLMDraft | None = None, *, raises: Exception | None = None) -> None:
        self._draft = draft
        self._raises = raises
        self.calls: list[tuple[str, list]] = []

    def generate(self, question: str, facts: list) -> LLMDraft:
        self.calls.append((question, facts))
        if self._raises is not None:
            raise self._raises
        assert self._draft is not None
        return self._draft


class TestConfig(unittest.TestCase):
    def test_disabled_by_default(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(ENABLE_LLM_ENV_VAR, None)
            self.assertFalse(llm_enabled())
            self.assertIsNone(build_default_llm_adapter())

    def test_enabled_but_no_api_key_returns_none(self) -> None:
        with patch.dict(os.environ, {ENABLE_LLM_ENV_VAR: "true"}, clear=False):
            os.environ.pop(API_KEY_ENV_VAR, None)
            self.assertIsNone(build_default_llm_adapter())

    def test_enabled_with_api_key_builds_the_anthropic_adapter(self) -> None:
        with patch.dict(
            os.environ,
            {ENABLE_LLM_ENV_VAR: "true", API_KEY_ENV_VAR: "sk-fake-test-key"},
            clear=False,
        ):
            adapter = build_default_llm_adapter()
        self.assertIsInstance(adapter, AnthropicAdapter)

    def test_unknown_provider_returns_none(self) -> None:
        with patch.dict(
            os.environ,
            {
                ENABLE_LLM_ENV_VAR: "true",
                API_KEY_ENV_VAR: "sk-fake-test-key",
                PROVIDER_ENV_VAR: "not-a-real-provider",
            },
            clear=False,
        ):
            self.assertIsNone(build_default_llm_adapter())


class TestGuard(unittest.TestCase):
    def setUp(self) -> None:
        self.record = _record(
            {
                "execution_id": "aer-local-fake",
                "probabilities": {"00": 0.5, "11": 0.5},
                "counts": {"00": 500, "11": 500},
            }
        )
        self.facts = build_fact_sheet(BELL, self.record)

    def test_valid_draft_passes(self) -> None:
        probability_fact = next(f for f in self.facts if f.kind == "probability")
        draft = LLMDraft(
            answer=f"The circuit shows {probability_fact.description} ({probability_fact.id}).",
            cited_fact_ids=[probability_fact.id],
        )
        answer = validate_llm_draft(draft, self.facts)
        self.assertIn(probability_fact.description, answer)

    def test_empty_answer_is_rejected(self) -> None:
        with self.assertRaises(GuardRejection):
            validate_llm_draft(LLMDraft(answer="   ", cited_fact_ids=[]), self.facts)

    def test_citing_an_unknown_fact_id_is_rejected(self) -> None:
        with self.assertRaises(GuardRejection):
            validate_llm_draft(
                LLMDraft(answer="Some claim (F999).", cited_fact_ids=["F999"]),
                self.facts,
            )

    def test_ungrounded_decimal_is_rejected_even_with_valid_citations(self) -> None:
        """The core adversarial case: a fabricated number the model invented,
        attached to a real, valid fact id — citation-checking alone would miss
        this. The guard must also check the number itself is grounded."""
        real_fact = self.facts[0]
        draft = LLMDraft(
            answer=f"P(00) = 0.999999, seemingly ({real_fact.id}).",
            cited_fact_ids=[real_fact.id],
        )
        with self.assertRaises(GuardRejection):
            validate_llm_draft(draft, self.facts)

    def test_ungrounded_percentage_is_rejected(self) -> None:
        with self.assertRaises(GuardRejection):
            validate_llm_draft(LLMDraft(answer="That's about 73% likely.", cited_fact_ids=[]), self.facts)

    def test_number_that_matches_a_fact_description_is_allowed(self) -> None:
        probability_fact = next(f for f in self.facts if f.kind == "probability")
        # Repeats the exact real number from the fact description.
        draft = LLMDraft(
            answer=f"Consistent with {probability_fact.description} ({probability_fact.id}).",
            cited_fact_ids=[probability_fact.id],
        )
        validate_llm_draft(draft, self.facts)  # must not raise


class TestAnswerQuestionWithLlm(unittest.TestCase):
    def setUp(self) -> None:
        self.record = _record(
            {
                "execution_id": "aer-local-fake",
                "probabilities": {"00": 0.5, "11": 0.5},
                "counts": {"00": 500, "11": 500},
            }
        )
        self.facts = build_fact_sheet(BELL, self.record)

    def test_no_llm_configured_uses_deterministic_template(self) -> None:
        answer, used_fallback = answer_question_with_llm("What was the result?", self.facts, self.record, None)
        self.assertTrue(used_fallback)
        self.assertTrue(len(answer) > 0)

    def test_successful_llm_response_is_used_verbatim(self) -> None:
        circuit_fact = next(f for f in self.facts if f.kind == "circuit_summary")
        fake = FakeLLMAdapter(
            draft=LLMDraft(answer=f"This is a Bell circuit ({circuit_fact.id}).", cited_fact_ids=[circuit_fact.id])
        )

        answer, used_fallback = answer_question_with_llm("What does this circuit do?", self.facts, self.record, fake)

        self.assertFalse(used_fallback)
        self.assertEqual(answer, f"This is a Bell circuit ({circuit_fact.id}).")
        self.assertEqual(len(fake.calls), 1)

    def test_citing_an_unknown_fact_id_falls_back(self) -> None:
        fake = FakeLLMAdapter(draft=LLMDraft(answer="Trust me (F999).", cited_fact_ids=["F999"]))

        answer, used_fallback = answer_question_with_llm("What was the result?", self.facts, self.record, fake)

        self.assertTrue(used_fallback)
        self.assertNotIn("Trust me", answer)

    def test_invalid_llm_response_falls_back(self) -> None:
        # cited_fact_ids is the wrong type entirely — not a list.
        bad_draft = LLMDraft(answer="ok", cited_fact_ids=[])
        bad_draft.cited_fact_ids = "F1"  # type: ignore[assignment]
        fake = FakeLLMAdapter(draft=bad_draft)

        answer, used_fallback = answer_question_with_llm("What was the result?", self.facts, self.record, fake)

        self.assertTrue(used_fallback)

    def test_provider_failure_falls_back(self) -> None:
        fake = FakeLLMAdapter(raises=LLMUnavailable("connection refused"))

        answer, used_fallback = answer_question_with_llm("What was the result?", self.facts, self.record, fake)

        self.assertTrue(used_fallback)
        self.assertTrue(len(answer) > 0)

    def test_hallucinated_probability_never_reaches_the_answer(self) -> None:
        """The LLM invents a plausible-looking but fabricated probability
        for an outcome that was never in the fact sheet at all. The guard
        must reject it and the final answer must never contain it."""
        fake = FakeLLMAdapter(
            draft=LLMDraft(answer="P(01) = 0.123456, a striking result!", cited_fact_ids=[])
        )

        answer, used_fallback = answer_question_with_llm("What was the result?", self.facts, self.record, fake)

        self.assertTrue(used_fallback)
        self.assertNotIn("0.123456", answer)
        # The real facts' actual numbers are still the only ones on record.
        for fact in self.facts:
            if fact.kind == "probability":
                self.assertNotIn("01:", fact.description)


if __name__ == "__main__":
    unittest.main()
