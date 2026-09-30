"""Tests for POST /api/tutor.

Calls the FastAPI route function directly (httpx/TestClient is not a project
dependency — see test_api_execute.py). The module-level ``_store`` in
qentor.api.app is patched to a temp-path ProvenanceStore per test.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from qentor.api import app as app_module
from qentor.api.schemas import TutorRequest
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord
from qentor.provenance.models import ExecutionStatus
from qentor.provenance.store import ProvenanceStore
from qentor.tutor.deterministic import UNSUPPORTED_QUESTION_ANSWER
from qentor.tutor.llm import LLMDraft, LLMUnavailable

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

OTHER_CIRCUIT = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[1])])


class TutorEndpointTestCase(unittest.TestCase):
    """Real Aer adapter (skipped, not faked, if unavailable); module-level
    store swapped for a temp-path one."""

    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        except Exception:
            pass  # any other error means Aer IS importable; proceed

        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmpdir.name) / "tutor.db")
        self._store_patcher = patch.object(app_module, "_store", self.store)
        self._store_patcher.start()

    def tearDown(self) -> None:
        self._store_patcher.stop()
        self.store.close()
        self._tmpdir.cleanup()

    def _insert_record(self, circuit: Circuit, mode: str, shots: int | None = None) -> ProvenanceRecord:
        result = AerAdapter().run(circuit, mode, shots)
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(circuit),
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode=result.execution_mode,
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED,
            payload=result.to_payload(),
        )
        self.store.insert(record)
        return record

    def _insert_failed_record(self, circuit: Circuit) -> ProvenanceRecord:
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(circuit),
            backend="qiskit-aer",
            backend_version="unknown",
            execution_mode="shots",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.ERROR,
            payload={"error": "shots mode requires shots > 0"},
        )
        self.store.insert(record)
        return record


class TestGroundedAnswers(TutorEndpointTestCase):
    def test_result_question_is_grounded_in_the_persisted_shots_result(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertEqual(response.result_id, record.result_id)
        self.assertEqual(response.circuit_hash, record.circuit_hash)
        self.assertEqual(response.provenance_class, "SIMULATION")
        self.assertEqual(response.verification_status, "STATE_CHECKED")
        self.assertTrue(response.used_fallback_template)
        self.assertGreater(len(response.facts), 0)

        probability_facts = [f for f in response.facts if f.kind == "probability"]
        self.assertEqual({f.description.split(":")[0] for f in probability_facts}, {"outcome 00", "outcome 11"})
        for fact in probability_facts:
            self.assertIn(fact.id, response.answer)
            self.assertIn(fact.description, response.answer)

    def test_circuit_question_is_grounded_in_the_actual_gate_list(self) -> None:
        record = self._insert_record(BELL_NO_MEASURE, "statevector")

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL_NO_MEASURE, question="What does this circuit do?")
        )

        self.assertIn("h(q0)", response.answer)
        self.assertIn("cx(control=q0, target=q1)", response.answer)
        amplitude_facts = [f for f in response.facts if f.kind == "amplitude"]
        self.assertEqual(len(amplitude_facts), 2)


class TestUnknownResultId(TutorEndpointTestCase):
    def test_unknown_result_id_raises_404(self) -> None:
        request = TutorRequest(result_id="res_does_not_exist", circuit=BELL, question="What was the result?")

        with self.assertRaises(HTTPException) as ctx:
            app_module.tutor_endpoint(request)

        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("res_does_not_exist", ctx.exception.detail)


class TestCircuitContextMismatch(TutorEndpointTestCase):
    def test_circuit_not_matching_the_record_raises_422(self) -> None:
        record = self._insert_record(BELL_NO_MEASURE, "statevector")

        request = TutorRequest(result_id=record.result_id, circuit=OTHER_CIRCUIT, question="What does this circuit do?")

        with self.assertRaises(HTTPException) as ctx:
            app_module.tutor_endpoint(request)

        self.assertEqual(ctx.exception.status_code, 422)


class TestFailedExecution(TutorEndpointTestCase):
    def test_failed_execution_gets_an_honest_answer_not_a_fabricated_one(self) -> None:
        record = self._insert_failed_record(BELL)

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertEqual(response.verification_status, "ERROR")
        self.assertIn(record.result_id, response.answer)
        self.assertIn("ERROR", response.answer)
        self.assertNotIn("probability", response.answer)
        self.assertEqual([f.kind for f in response.facts], ["circuit_summary", "execution_status"])


class TestUnsupportedQuestion(TutorEndpointTestCase):
    def test_unrecognised_question_returns_the_exact_unsupported_answer(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="Will this win me the lottery?")
        )

        self.assertEqual(response.answer, UNSUPPORTED_QUESTION_ANSWER)


class FakeLLMAdapter:
    """Test double for qentor.tutor.llm.LLMAdapter — never makes a real call."""

    name = "fake"

    def __init__(self, draft: LLMDraft | None = None, *, raises: Exception | None = None) -> None:
        self._draft = draft
        self._raises = raises

    def generate(self, question: str, facts: list, language: str = "en") -> LLMDraft:
        if self._raises is not None:
            raise self._raises
        assert self._draft is not None
        return self._draft


class TestLlmIntegrationEndToEnd(TutorEndpointTestCase):
    """The endpoint with the module-level ``_llm_adapter`` patched — proves the
    guard/fallback wiring holds through the real request path, not just the
    orchestrator function in isolation (see test_tutor_llm.py for that)."""

    def _patch_llm(self, adapter) -> None:
        patcher = patch.object(app_module, "_llm_adapter", adapter)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_no_llm_configured_uses_deterministic_template(self) -> None:
        self._patch_llm(None)
        record = self._insert_record(BELL, "shots", shots=2000)

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertTrue(response.used_fallback_template)

    def test_successful_llm_response_is_returned_and_not_flagged_as_fallback(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)
        facts = app_module.build_fact_sheet(BELL, record)
        probability_fact = next(f for f in facts if f.kind == "probability")
        self._patch_llm(
            FakeLLMAdapter(
                draft=LLMDraft(
                    answer=f"This circuit shows {probability_fact.description} ({probability_fact.id}).",
                    cited_fact_ids=[probability_fact.id],
                )
            )
        )

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertFalse(response.used_fallback_template)
        self.assertIn(probability_fact.description, response.answer)

    def test_llm_citing_an_unknown_fact_falls_back(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)
        self._patch_llm(FakeLLMAdapter(draft=LLMDraft(answer="Trust me (F999).", cited_fact_ids=["F999"])))

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("Trust me", response.answer)

    def test_llm_provider_failure_falls_back(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)
        self._patch_llm(FakeLLMAdapter(raises=LLMUnavailable("connection refused")))

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertTrue(response.used_fallback_template)
        self.assertGreater(len(response.answer), 0)

    def test_hallucinated_probability_never_reaches_the_response(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)
        self._patch_llm(
            FakeLLMAdapter(draft=LLMDraft(answer="P(01) = 0.123456, remarkably!", cited_fact_ids=[]))
        )

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("0.123456", response.answer)
        for fact in response.facts:
            self.assertNotIn("0.123456", fact.description)

    def test_failed_execution_never_calls_the_llm(self) -> None:
        calls: list[str] = []

        class RecordingAdapter(FakeLLMAdapter):
            def generate(self, question: str, facts: list, language: str = "en") -> LLMDraft:
                calls.append(question)
                return LLMDraft(answer="should not be reached", cited_fact_ids=[])

        self._patch_llm(RecordingAdapter())
        record = self._insert_failed_record(BELL)

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertEqual(calls, [])
        self.assertTrue(response.used_fallback_template)
        self.assertNotEqual(response.answer, "should not be reached")


class TestLanguageField(TutorEndpointTestCase):
    """POST /api/tutor's `language` field (docs/ARCHITECTURE.md §10) — omitted
    means English, an explicit code selects the deterministic template's
    wrapper text, and every numeric fact still comes through unchanged."""

    def test_omitted_language_defaults_to_english(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)

        response = app_module.tutor_endpoint(
            TutorRequest(result_id=record.result_id, circuit=BELL, question="What was the result?")
        )

        self.assertIn("For this result:", response.answer)

    def test_hindi_language_translates_the_wrapper_but_not_the_numbers(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)

        response = app_module.tutor_endpoint(
            TutorRequest(
                result_id=record.result_id, circuit=BELL, question="What was the result?", language="hi"
            )
        )

        self.assertIn("इस परिणाम के लिए", response.answer)
        for fact in response.facts:
            if fact.kind == "probability":
                self.assertIn(fact.description, response.answer)

    def test_kannada_language_translates_the_wrapper_but_not_the_numbers(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)

        response = app_module.tutor_endpoint(
            TutorRequest(
                result_id=record.result_id, circuit=BELL, question="What was the result?", language="kn"
            )
        )

        self.assertIn("ಈ ಫಲಿತಾಂಶಕ್ಕಾಗಿ", response.answer)
        for fact in response.facts:
            if fact.kind == "probability":
                self.assertIn(fact.description, response.answer)

    def test_unsupported_language_code_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            TutorRequest.model_validate(
                {
                    "result_id": "res_x",
                    "circuit": BELL.canonical_dict(),
                    "question": "What was the result?",
                    "language": "fr",
                }
            )


class TestRequestSchemaRejectsClientSuppliedResults(unittest.TestCase):
    """Mirrors test_api_execute.py / test_api_verify_bell_state.py's schema
    guard: no field exists for a client to smuggle in a probability, count or
    verdict alongside the question and circuit."""

    def test_extra_verification_status_field_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            TutorRequest.model_validate(
                {
                    "result_id": "res_x",
                    "circuit": BELL.canonical_dict(),
                    "question": "What was the result?",
                    "verification_status": "VERIFIED",
                }
            )

    def test_empty_question_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            TutorRequest.model_validate(
                {"result_id": "res_x", "circuit": BELL.canonical_dict(), "question": ""}
            )

    def test_valid_request_round_trips(self) -> None:
        req = TutorRequest.model_validate(
            {"result_id": "res_x", "circuit": BELL.canonical_dict(), "question": "hello"}
        )
        self.assertEqual(req.result_id, "res_x")
        self.assertEqual(req.question, "hello")


if __name__ == "__main__":
    unittest.main()
