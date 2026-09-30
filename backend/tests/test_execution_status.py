"""What an execution's status means (T3): three different things used to share "VERIFIED".

1. the backend ran                                         -> the run did not raise
2. what it returned is a well-formed physical result       -> ``STATE_CHECKED`` (this file)
3. the circuit has a property / two circuits agree         -> ``qentor.verification`` verdicts

Only (3) says anything about whether a circuit is right. These tests pin that a successful
simulation is recorded and worded as (2) and never as (3), that the check is real (a malformed
backend result is refused, not passed through), and that older rows are not upgraded.
"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from qentor.api import app as app_module
from qentor.api.schemas import ExecuteRequest, TraceRequest
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import ExecutionResult
from qentor.execution.sanity import STATE_CHECKED_PLAIN, state_problems
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.tutor.claims import find_violations
from qentor.tutor.facts import build_fact_sheet
from qentor.verification.bell_state import verify_bell_state
from qentor.verification.models import VerificationStatus as PropertyVerdict
from tests.test_api_tutor import TutorEndpointTestCase

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
H_ONLY = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])


def _result(*, statevector=None, probabilities=None, counts=None, mode="statevector") -> ExecutionResult:
    return ExecutionResult(
        backend_name="qiskit-aer",
        backend_version="test",
        execution_mode=mode,
        execution_id="fake",
        statevector=statevector,
        probabilities=probabilities,
        counts=counts,
    )


class TestTheStatusVocabulary(unittest.TestCase):
    def test_an_execution_is_never_called_verified(self) -> None:
        self.assertEqual({s.value for s in ExecutionStatus}, {"STATE_CHECKED", "FAILED", "ERROR", "SUCCEEDED"})
        self.assertFalse(hasattr(ExecutionStatus, "VERIFIED"))

    def test_the_word_verified_belongs_to_property_verification_only(self) -> None:
        self.assertEqual(PropertyVerdict.VERIFIED.value, "VERIFIED")

    def test_the_plain_sentence_says_what_it_does_not_show(self) -> None:
        self.assertIn("does not show the circuit does what you intend", STATE_CHECKED_PLAIN)
        for word in ("verified", "correct", "equivalent"):
            self.assertNotIn(word, STATE_CHECKED_PLAIN.lower())


class TestStateSanityCheck(unittest.TestCase):
    def test_a_normalised_statevector_passes(self) -> None:
        s = 0.5**0.5
        self.assertEqual(state_problems(_result(statevector=[[s, 0.0], [s, 0.0]]), 1), [])

    def test_each_kind_of_malformed_result_is_named(self) -> None:
        cases = {
            "wrong size": (_result(statevector=[[1.0, 0.0]]), 1, "expected 2"),
            "not normalised": (_result(statevector=[[1.0, 0.0], [1.0, 0.0]]), 1, "squared norm"),
            "non-finite": (_result(statevector=[[float("nan"), 0.0], [0.0, 0.0]]), 1, "non-finite"),
            "probabilities sum": (_result(probabilities={"0": 0.5, "1": 0.4}, mode="shots"), 1, "sum to"),
            "probability out of range": (_result(probabilities={"0": 1.5, "1": -0.5}, mode="shots"), 1, "outside"),
            "negative count": (_result(counts={"0": -1, "1": 11}, mode="shots"), 1, "non-negative"),
            "no data": (_result(), 1, "no statevector"),
        }
        for name, (result, n, needle) in cases.items():
            with self.subTest(name):
                problems = state_problems(result, n)
                self.assertTrue(problems)
                self.assertIn(needle, " ".join(problems))

    def test_counts_must_add_up_to_the_requested_shots(self) -> None:
        good = _result(probabilities={"0": 0.5, "1": 0.5}, counts={"0": 50, "1": 50}, mode="shots")
        self.assertEqual(state_problems(good, 1, shots=100), [])
        problems = state_problems(good, 1, shots=99)
        self.assertIn("not the 99 shots", " ".join(problems))

    def test_numpy_style_integers_count_as_integers(self) -> None:
        import numpy as np

        result = _result(probabilities={"0": 0.5, "1": 0.5}, counts={"0": np.int64(50), "1": np.int64(50)}, mode="shots")
        self.assertEqual(state_problems(result, 1, shots=100), [])


class TestExecuteRecordsTheStateCheck(TutorEndpointTestCase):
    def test_a_successful_statevector_and_shots_run_is_state_checked_not_verified(self) -> None:
        for mode, shots in (("statevector", None), ("shots", 100)):
            response = app_module.execute(ExecuteRequest(circuit=BELL, mode=mode, shots=shots))
            self.assertEqual(response.verification_status, "STATE_CHECKED")
            self.assertEqual(self.store.get(response.result_id).verification_status, ExecutionStatus.STATE_CHECKED)

    def test_every_backend_and_a_trace_step_are_recorded_the_same_way(self) -> None:
        for backend in ("qiskit-aer", "cirq", "pennylane"):
            response = app_module.execute(ExecuteRequest(circuit=H_ONLY, mode="statevector", backend=backend))
            self.assertEqual(response.verification_status, "STATE_CHECKED", backend)
        trace = app_module.execute_trace(TraceRequest(circuit=H_ONLY))
        self.assertEqual({s.provenance.verification_status for s in trace.steps}, {"STATE_CHECKED"})

    def test_a_malformed_backend_result_is_refused_and_recorded_as_failed_without_its_numbers(self) -> None:
        bad = _result(statevector=[[2.0, 0.0], [0.0, 0.0]])  # squared norm 4
        with patch.object(app_module._adapters["qiskit-aer"], "run", return_value=bad):
            with self.assertRaises(HTTPException) as raised:
                app_module.execute(ExecuteRequest(circuit=H_ONLY, mode="statevector"))
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(raised.exception.detail["code"], "EXECUTION_STATE_INVALID")
        self.assertIn("squared norm", raised.exception.detail["message"])
        rows = self.store._conn.execute("SELECT verification_status, payload_json FROM results").fetchall()
        self.assertEqual([r["verification_status"] for r in rows], ["FAILED"])
        self.assertNotIn('"statevector":', rows[0]["payload_json"])  # no amplitudes were stored
        self.assertIn("EXECUTION_STATE_INVALID", rows[0]["payload_json"])

    def test_counts_that_do_not_add_up_are_refused_too(self) -> None:
        bad = _result(probabilities={"0": 1.0}, counts={"0": 7}, mode="shots")
        circuit = Circuit(num_qubits=1, num_clbits=1, ops=[GateOp(gate="measure", targets=[0], clbits=[0])])
        with patch.object(app_module._adapters["qiskit-aer"], "run", return_value=bad):
            with self.assertRaises(HTTPException) as raised:
                app_module.execute(ExecuteRequest(circuit=circuit, mode="shots", shots=100))
        self.assertEqual(raised.exception.detail["code"], "EXECUTION_STATE_INVALID")

    def test_a_failed_record_is_never_explained_by_the_tutor(self) -> None:
        from qentor.api.schemas import TutorRequest

        bad = _result(statevector=[[2.0, 0.0], [0.0, 0.0]])
        with patch.object(app_module._adapters["qiskit-aer"], "run", return_value=bad):
            with self.assertRaises(HTTPException):
                app_module.execute(ExecuteRequest(circuit=H_ONLY, mode="statevector"))
        failed_id = self.store._conn.execute("SELECT result_id FROM results").fetchone()["result_id"]
        response = app_module.tutor_endpoint(TutorRequest(question="What was the result?", result_id=failed_id, circuit=H_ONLY))
        self.assertNotIn("amplitude", response.answer)
        self.assertEqual(response.verification_status, "FAILED")


class TestOlderRowsAreNotUpgraded(TutorEndpointTestCase):
    def _insert_legacy_row(self) -> str:
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(H_ONLY),
            backend="qiskit-aer",
            backend_version="old",
            execution_mode="statevector",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED,
            payload={"execution_id": "legacy", "statevector": [[0.70710678, 0.0], [0.70710678, 0.0]]},
        )
        row = list(record.to_row())
        row[6] = "VERIFIED"  # what rows written before the rename stored
        with self.store._lock:
            self.store._conn.execute(
                "INSERT INTO results (result_id, circuit_hash, backend, backend_version, execution_mode, provenance_class, "
                "verification_status, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row,
            )
            self.store._conn.commit()
        return record.result_id

    def test_a_row_stored_as_verified_reads_back_as_succeeded_not_state_checked(self) -> None:
        legacy = self.store.get(self._insert_legacy_row())
        self.assertEqual(legacy.verification_status, ExecutionStatus.SUCCEEDED)

    def test_such_a_row_is_not_usable_by_the_tutor_or_the_bell_verifier(self) -> None:
        from qentor.api.schemas import TutorRequest

        result_id = self._insert_legacy_row()
        response = app_module.tutor_endpoint(TutorRequest(question="What was the result?", result_id=result_id, circuit=H_ONLY))
        self.assertNotIn("amplitude", response.answer)
        record = self.store.get(result_id)
        report = verify_bell_state(BELL, record)
        self.assertEqual(report.verification_status, PropertyVerdict.ERROR)


class TestTutorFactsAndTheClaimGuard(TutorEndpointTestCase):
    def test_the_execution_fact_says_state_checked_and_what_that_does_not_show(self) -> None:
        record = self._insert_record(BELL, "shots", 100)
        facts = build_fact_sheet(BELL, record)
        status = next(f for f in facts if f.kind == "execution_status")
        self.assertIn("STATE_CHECKED", status.description)
        self.assertIn("does not show the circuit does what you intend", status.description)
        self.assertNotIn("VERIFIED", status.description)

    def test_a_model_cannot_call_a_state_checked_circuit_verified_or_correct(self) -> None:
        record = self._insert_record(BELL, "shots", 100)
        facts = build_fact_sheet(BELL, record)
        for claim in (
            "Your circuit is verified.",
            "This circuit is correct.",
            "The run passed, so the circuit works.",
            "The state check shows your circuit is equivalent to a Bell pair.",
        ):
            with self.subTest(claim=claim):
                self.assertTrue(find_violations(claim, facts), claim)

    def test_the_deterministic_answers_never_call_an_execution_verified(self) -> None:
        from qentor.api.schemas import TutorRequest

        record = self._insert_record(BELL, "shots", 100)
        for question in ("What was the result?", "Explain my result", "Explain this circuit"):
            response = app_module.tutor_endpoint(TutorRequest(question=question, result_id=record.result_id, circuit=BELL))
            self.assertNotIn("VERIFIED", response.answer, question)
            self.assertNotIn("verified", response.answer.lower(), question)


if __name__ == "__main__":
    unittest.main()
