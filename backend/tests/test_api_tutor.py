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
from qentor.provenance.models import VerificationStatus as ExecutionStatus
from qentor.provenance.store import ProvenanceStore
from qentor.tutor.deterministic import UNSUPPORTED_QUESTION_ANSWER

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
            verification_status=ExecutionStatus.VERIFIED,
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
        self.assertEqual(response.verification_status, "VERIFIED")
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
