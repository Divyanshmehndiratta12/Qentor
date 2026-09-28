"""Tests for the first real verifier: qentor.verification.bell_state.

Two kinds of coverage:

- End-to-end tests that run the real Aer adapter (skipped, not faked, if qiskit-aer
  is unavailable in this environment — same pattern as test_aer_adapter.py) and feed
  its real ``ExecutionResult``, wrapped in a real ``ProvenanceRecord``, into the
  verifier.
- Adversarial unit tests with hand-built ``ProvenanceRecord``s representing a
  simulator/circuit bug (wrong support, wrong shape, mismatched hash, failed
  execution) to prove the verifier actually catches them rather than always
  reporting VERIFIED. Per CLAUDE.md, fixtures like these belong only in tests.
"""

from __future__ import annotations

import unittest

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord
from qentor.provenance.models import VerificationStatus as ExecutionStatus
from qentor.verification.bell_state import verify_bell_state
from qentor.verification.models import CheckStatus, VerificationStatus

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

BELL_EXTRA_CLBIT = Circuit(
    num_qubits=2,
    num_clbits=3,
    ops=[
        GateOp(gate="h", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
    ],
)


def _record_for(circuit: Circuit, *, backend: str, backend_version: str, execution_mode: str, payload: dict) -> ProvenanceRecord:
    return ProvenanceRecord.new(
        circuit_hash=circuit_hash(circuit),
        backend=backend,
        backend_version=backend_version,
        execution_mode=execution_mode,
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.VERIFIED,
        payload=payload,
    )


class AerBackedTestCase(unittest.TestCase):
    """Runs the real Aer adapter; skips (does not fake) if unavailable."""

    def setUp(self) -> None:
        self.adapter = AerAdapter()

    def run_or_skip(self, circuit: Circuit, mode: str, shots: int | None = None):
        try:
            return self.adapter.run(circuit, mode, shots)
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")


class TestEndToEndAgainstRealAer(AerBackedTestCase):
    def test_statevector_bell_state_is_verified(self) -> None:
        result = self.run_or_skip(BELL_NO_MEASURE, "statevector")
        record = _record_for(
            BELL_NO_MEASURE,
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode=result.execution_mode,
            payload=result.to_payload(),
        )

        report = verify_bell_state(BELL_NO_MEASURE, record)

        self.assertEqual(report.verification_status, VerificationStatus.VERIFIED)
        self.assertEqual(report.expected_support, ["00", "11"])
        self.assertEqual(report.observed_support, ["00", "11"])
        self.assertEqual(report.result_id, record.result_id)
        self.assertEqual(report.circuit_hash, record.circuit_hash)
        self.assertTrue(all(c.status is CheckStatus.PASS for c in report.checks))

    def test_shots_bell_state_is_verified(self) -> None:
        result = self.run_or_skip(BELL, "shots", shots=2000)
        record = _record_for(
            BELL,
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode=result.execution_mode,
            payload=result.to_payload(),
        )

        report = verify_bell_state(BELL, record)

        self.assertEqual(report.verification_status, VerificationStatus.VERIFIED)
        self.assertEqual(report.expected_support, ["00", "11"])
        self.assertEqual(report.observed_support, ["00", "11"])

    def test_shots_with_unmeasured_extra_clbit_still_verifies_against_padded_support(self) -> None:
        """Regression for the real bug this replicates: a Bell circuit with a spare,
        never-measured classical bit produces 3-character outcomes ("000"/"011"), not
        2-character ones. The verifier must expect the padded shape, not "00"/"11"."""
        result = self.run_or_skip(BELL_EXTRA_CLBIT, "shots", shots=2000)
        record = _record_for(
            BELL_EXTRA_CLBIT,
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode=result.execution_mode,
            payload=result.to_payload(),
        )

        report = verify_bell_state(BELL_EXTRA_CLBIT, record)

        self.assertEqual(report.verification_status, VerificationStatus.VERIFIED)
        self.assertEqual(report.expected_support, ["000", "011"])
        self.assertEqual(report.observed_support, ["000", "011"])


class TestAdversarialCases(unittest.TestCase):
    """Hand-built provenance records exercising each way a real result can go wrong.
    These payloads never leave this test file — see CLAUDE.md's "test fixtures stay
    in tests"."""

    def test_wrong_statevector_support_is_failed_not_verified(self) -> None:
        # A buggy simulator/adapter reporting the |01>+|10> (anti-correlated) state
        # instead of the true Bell |00>+|11>.
        s = 0.7071067811865476
        record = _record_for(
            BELL_NO_MEASURE,
            backend="qiskit-aer",
            backend_version="0.17.2",
            execution_mode="statevector",
            payload={
                "execution_id": "aer-local-fake",
                "statevector": [[0.0, 0.0], [s, 0.0], [s, 0.0], [0.0, 0.0]],
            },
        )

        report = verify_bell_state(BELL_NO_MEASURE, record)

        self.assertEqual(report.verification_status, VerificationStatus.FAILED)
        self.assertEqual(report.expected_support, ["00", "11"])
        self.assertEqual(report.observed_support, ["01", "10"])
        subset_check = next(c for c in report.checks if c.name == "observed_support_within_expected")
        self.assertEqual(subset_check.status, CheckStatus.FAIL)

    def test_shots_with_extra_unexpected_bitstring_is_failed(self) -> None:
        # A buggy circuit/backend that leaks some probability onto "01".
        record = _record_for(
            BELL,
            backend="qiskit-aer",
            backend_version="0.17.2",
            execution_mode="shots",
            payload={
                "execution_id": "aer-local-fake",
                "probabilities": {"00": 0.49, "11": 0.49, "01": 0.02},
                "counts": {"00": 490, "11": 490, "01": 20},
            },
        )

        report = verify_bell_state(BELL, record)

        self.assertEqual(report.verification_status, VerificationStatus.FAILED)
        self.assertEqual(report.observed_support, ["00", "01", "11"])

    def test_circuit_not_matching_bell_pattern_is_unverifiable(self) -> None:
        not_bell = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])
        record = _record_for(
            not_bell,
            backend="qiskit-aer",
            backend_version="0.17.2",
            execution_mode="statevector",
            payload={"execution_id": "aer-local-fake", "statevector": [[0.7071067811865476, 0.0], [0.7071067811865476, 0.0], [0.0, 0.0], [0.0, 0.0]]},
        )

        report = verify_bell_state(not_bell, record)

        self.assertEqual(report.verification_status, VerificationStatus.UNVERIFIABLE)
        self.assertEqual(report.expected_support, [])
        self.assertEqual(report.observed_support, [])
        pattern_check = next(c for c in report.checks if c.name == "circuit_matches_bell_pattern")
        self.assertEqual(pattern_check.status, CheckStatus.FAIL)

    def test_mismatched_circuit_hash_is_an_error(self) -> None:
        other_circuit = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[1])])
        record = _record_for(
            other_circuit,
            backend="qiskit-aer",
            backend_version="0.17.2",
            execution_mode="statevector",
            payload={"execution_id": "aer-local-fake", "statevector": [[1.0, 0.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]},
        )

        # Verifying BELL_NO_MEASURE against a record produced for a different circuit.
        report = verify_bell_state(BELL_NO_MEASURE, record)

        self.assertEqual(report.verification_status, VerificationStatus.ERROR)
        hash_check = next(c for c in report.checks if c.name == "circuit_hash_matches_record")
        self.assertEqual(hash_check.status, CheckStatus.FAIL)

    def test_failed_execution_is_an_error_not_a_verdict(self) -> None:
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(BELL),
            backend="qiskit-aer",
            backend_version="unknown",
            execution_mode="shots",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.ERROR,
            payload={"error": "shots mode requires shots > 0"},
        )

        report = verify_bell_state(BELL, record)

        self.assertEqual(report.verification_status, VerificationStatus.ERROR)
        execution_check = next(c for c in report.checks if c.name == "execution_succeeded")
        self.assertEqual(execution_check.status, CheckStatus.FAIL)


if __name__ == "__main__":
    unittest.main()
