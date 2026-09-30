"""Tests for the deterministic, no-LLM tutor foundation:
qentor.tutor.facts.build_fact_sheet and qentor.tutor.deterministic.*.

Hand-built ProvenanceRecords are used here (never shipped code) per CLAUDE.md's
"test fixtures stay in tests" — these tests are about the fact-sheet/answer
logic itself, not about exercising a real Aer run (that's covered elsewhere,
e.g. test_verification_bell_state.py and test_api_tutor.py).
"""

from __future__ import annotations

import unittest

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord
from qentor.provenance.models import ExecutionStatus
from qentor.tutor.deterministic import (
    UNSUPPORTED_QUESTION_ANSWER,
    answer_failed_execution,
    answer_question,
)
from qentor.tutor.facts import build_fact_sheet

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

BELL_NO_MEASURE = Circuit(
    num_qubits=2,
    num_clbits=0,
    ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])],
)


def _record(circuit: Circuit, *, execution_mode: str, payload: dict, status=ExecutionStatus.STATE_CHECKED) -> ProvenanceRecord:
    return ProvenanceRecord.new(
        circuit_hash=circuit_hash(circuit),
        backend="qiskit-aer",
        backend_version="0.17.2",
        execution_mode=execution_mode,
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=status,
        payload=payload,
    )


class TestBuildFactSheet(unittest.TestCase):
    def test_shots_record_has_circuit_status_and_probability_facts(self) -> None:
        record = _record(
            BELL,
            execution_mode="shots",
            payload={
                "execution_id": "aer-local-fake",
                "probabilities": {"00": 0.498, "11": 0.502},
                "counts": {"00": 498, "11": 502},
            },
        )

        facts = build_fact_sheet(BELL, record)
        kinds = [f.kind for f in facts]

        self.assertEqual(kinds[0], "circuit_summary")
        self.assertEqual(kinds[1], "execution_status")
        self.assertEqual(kinds[2:], ["probability", "probability"])

        circuit_fact = facts[0]
        self.assertIn("h(q0)", circuit_fact.description)
        self.assertIn("cx(control=q0, target=q1)", circuit_fact.description)
        self.assertIn("measure(q0 -> c0)", circuit_fact.description)

        probability_facts = {f.description.split(":")[0]: f for f in facts if f.kind == "probability"}
        self.assertIn("outcome 00", probability_facts)
        self.assertIn("498 shots", facts[2].description)

        # Every fact cites the same result_id — nothing is fabricated per-fact.
        self.assertTrue(all(f.result_id == record.result_id for f in facts))
        # Ids are unique and stable (F1, F2, ...).
        self.assertEqual([f.id for f in facts], [f"F{i + 1}" for i in range(len(facts))])

    def test_statevector_record_only_lists_nonzero_amplitudes(self) -> None:
        s = 0.7071067811865476
        record = _record(
            BELL_NO_MEASURE,
            execution_mode="statevector",
            payload={
                "execution_id": "aer-local-fake",
                "statevector": [[s, 0.0], [0.0, 0.0], [0.0, 0.0], [s, 0.0]],
            },
        )

        facts = build_fact_sheet(BELL_NO_MEASURE, record)
        amplitude_facts = [f for f in facts if f.kind == "amplitude"]

        self.assertEqual(len(amplitude_facts), 2)
        descriptions = " ".join(f.description for f in amplitude_facts)
        self.assertIn("|00⟩", descriptions)
        self.assertIn("|11⟩", descriptions)
        self.assertNotIn("|01⟩", descriptions)
        self.assertNotIn("|10⟩", descriptions)

    def test_no_probability_or_amplitude_facts_when_payload_has_neither(self) -> None:
        record = _record(
            BELL,
            execution_mode="shots",
            payload={"error": "shots mode requires shots > 0"},
            status=ExecutionStatus.ERROR,
        )

        facts = build_fact_sheet(BELL, record)

        self.assertEqual([f.kind for f in facts], ["circuit_summary", "execution_status"])


class TestAnswerQuestion(unittest.TestCase):
    def setUp(self) -> None:
        self.record = _record(
            BELL,
            execution_mode="shots",
            payload={
                "execution_id": "aer-local-fake",
                "probabilities": {"00": 0.5, "11": 0.5},
                "counts": {"00": 500, "11": 500},
            },
        )
        self.facts = build_fact_sheet(BELL, self.record)

    def test_circuit_question_cites_the_circuit_summary_fact(self) -> None:
        answer = answer_question("What does this circuit do?", self.facts, self.record)
        circuit_fact = next(f for f in self.facts if f.kind == "circuit_summary")
        self.assertIn(circuit_fact.id, answer)
        self.assertIn("h(q0)", answer)

    def test_result_question_cites_every_probability_fact(self) -> None:
        answer = answer_question("What was the result?", self.facts, self.record)
        for fact in self.facts:
            if fact.kind == "probability":
                self.assertIn(fact.id, answer)
                self.assertIn(fact.description, answer)

    def test_unrecognised_question_returns_the_exact_unsupported_answer(self) -> None:
        answer = answer_question("Tell me a joke.", self.facts, self.record)
        self.assertEqual(answer, UNSUPPORTED_QUESTION_ANSWER)

    def test_answer_never_contains_a_number_not_in_the_fact_sheet(self) -> None:
        # Adversarial-in-spirit: the deterministic answer must only ever repeat
        # numbers already present in the fact sheet it was given, never invent one.
        answer = answer_question("probabilities please", self.facts, self.record)
        for fact in self.facts:
            if fact.kind == "probability":
                self.assertIn(fact.description, answer)
        self.assertNotIn("0.999999", answer)


class TestAnswerQuestionMultilingual(unittest.TestCase):
    """docs/ARCHITECTURE.md §10: only the wrapper text is translated — every
    fact's own description (numbers, bitstrings, gate names) must appear in
    the answer unchanged regardless of the selected language."""

    def setUp(self) -> None:
        self.record = _record(
            BELL,
            execution_mode="shots",
            payload={
                "execution_id": "aer-local-fake",
                "probabilities": {"00": 0.5, "11": 0.5},
                "counts": {"00": 500, "11": 500},
            },
        )
        self.facts = build_fact_sheet(BELL, self.record)

    def test_omitted_language_defaults_to_english(self) -> None:
        answer = answer_question("What was the result?", self.facts, self.record)
        self.assertIn("For this result:", answer)

    def test_hindi_result_answer_is_translated_with_numbers_unchanged(self) -> None:
        answer = answer_question("What was the result?", self.facts, self.record, "hi")
        self.assertIn("इस परिणाम के लिए", answer)
        for fact in self.facts:
            if fact.kind == "probability":
                self.assertIn(fact.description, answer)

    def test_kannada_result_answer_is_translated_with_numbers_unchanged(self) -> None:
        answer = answer_question("What was the result?", self.facts, self.record, "kn")
        self.assertIn("ಈ ಫಲಿತಾಂಶಕ್ಕಾಗಿ", answer)
        for fact in self.facts:
            if fact.kind == "probability":
                self.assertIn(fact.description, answer)

    def test_hindi_circuit_answer_still_cites_the_real_gate_list(self) -> None:
        answer = answer_question("What does this circuit do?", self.facts, self.record, "hi")
        circuit_fact = next(f for f in self.facts if f.kind == "circuit_summary")
        self.assertIn(circuit_fact.description, answer)
        self.assertIn(circuit_fact.id, answer)

    def test_unrecognised_language_falls_back_to_english_template(self) -> None:
        answer = answer_question("What was the result?", self.facts, self.record, "fr")
        self.assertIn("For this result:", answer)

    def test_hindi_failed_execution_mentions_result_id_and_status_untranslated(self) -> None:
        failed = _record(
            BELL,
            execution_mode="shots",
            payload={"error": "shots mode requires shots > 0"},
            status=ExecutionStatus.ERROR,
        )
        answer = answer_failed_execution(failed, "hi")
        self.assertIn(failed.result_id, answer)
        self.assertIn("ERROR", answer)

    def test_kannada_failed_execution_mentions_result_id_and_status_untranslated(self) -> None:
        failed = _record(
            BELL,
            execution_mode="shots",
            payload={"error": "shots mode requires shots > 0"},
            status=ExecutionStatus.ERROR,
        )
        answer = answer_failed_execution(failed, "kn")
        self.assertIn(failed.result_id, answer)
        self.assertIn("ERROR", answer)


class TestAnswerFailedExecution(unittest.TestCase):
    def test_mentions_the_result_id_and_status_not_a_fabricated_number(self) -> None:
        record = _record(
            BELL,
            execution_mode="shots",
            payload={"error": "shots mode requires shots > 0"},
            status=ExecutionStatus.ERROR,
        )
        answer = answer_failed_execution(record)
        self.assertIn(record.result_id, answer)
        self.assertIn("ERROR", answer)
        self.assertNotIn("probability", answer)


if __name__ == "__main__":
    unittest.main()
