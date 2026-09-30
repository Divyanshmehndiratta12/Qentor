"""Tests for POST /api/verify/bell-state.

Calls the FastAPI route function directly, the same convention test_api_execute.py
uses, because the ``httpx`` TestClient dependency is not installed. This exercises
the real request validation, provenance lookup, verifier invocation and response
shape — only the ASGI transport itself is untested.

The module-level ``_store`` in qentor.api.app is patched to a temp-path
ProvenanceStore per test, so nothing here touches backend/data/qentor.db.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from qentor.api import app as app_module
from qentor.api.schemas import VerifyBellStateRequest
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord
from qentor.provenance.models import ExecutionStatus
from qentor.provenance.store import ProvenanceStore

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


class VerifyBellStateEndpointTestCase(unittest.TestCase):
    """Base class: real Aer adapter (skipped, not faked, if unavailable), and the
    endpoint's module-level store swapped for a temp-path one."""

    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        except Exception:
            pass  # any other error means Aer IS importable; proceed

        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmpdir.name) / "verify.db")
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


class TestSuccessfulVerification(VerifyBellStateEndpointTestCase):
    def test_shots_bell_state_is_verified(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)

        response = app_module.verify_bell_state_endpoint(
            VerifyBellStateRequest(result_id=record.result_id, circuit=BELL)
        )

        self.assertEqual(response.verification_status, "VERIFIED")
        self.assertEqual(response.result_id, record.result_id)
        self.assertEqual(response.circuit_hash, record.circuit_hash)
        self.assertEqual(response.verifier, "bell_state/1")
        self.assertEqual(response.expected_support, ["00", "11"])
        self.assertEqual(response.observed_support, ["00", "11"])
        self.assertTrue(all(c.status == "PASS" for c in response.checks))

    def test_statevector_bell_state_is_verified(self) -> None:
        record = self._insert_record(BELL_NO_MEASURE, "statevector")

        response = app_module.verify_bell_state_endpoint(
            VerifyBellStateRequest(result_id=record.result_id, circuit=BELL_NO_MEASURE)
        )

        self.assertEqual(response.verification_status, "VERIFIED")
        self.assertEqual(response.expected_support, ["00", "11"])
        self.assertEqual(response.observed_support, ["00", "11"])


class TestUnknownResultId(VerifyBellStateEndpointTestCase):
    def test_unknown_result_id_raises_404(self) -> None:
        request = VerifyBellStateRequest(result_id="res_does_not_exist", circuit=BELL)

        with self.assertRaises(HTTPException) as ctx:
            app_module.verify_bell_state_endpoint(request)

        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("res_does_not_exist", ctx.exception.detail)


class TestFailedAndUnverifiableVerification(VerifyBellStateEndpointTestCase):
    def test_circuit_not_matching_bell_pattern_is_unverifiable_not_success(self) -> None:
        not_bell = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])
        record = self._insert_record(not_bell, "statevector")

        response = app_module.verify_bell_state_endpoint(
            VerifyBellStateRequest(result_id=record.result_id, circuit=not_bell)
        )

        self.assertEqual(response.verification_status, "UNVERIFIABLE")
        self.assertEqual(response.expected_support, [])
        self.assertEqual(response.observed_support, [])
        pattern_check = next(c for c in response.checks if c.name == "circuit_matches_bell_pattern")
        self.assertEqual(pattern_check.status, "FAIL")

    def test_mismatched_circuit_is_reported_as_error_not_fabricated_success(self) -> None:
        """A circuit that doesn't hash to the stored record must never be silently
        accepted — the endpoint returns the verifier's ERROR report (HTTP 200 with an
        honest body), not a fabricated VERIFIED, and not a generic HTTP error either:
        this is a verification-domain outcome, per requirement 6."""
        record = self._insert_record(BELL_NO_MEASURE, "statevector")
        different_circuit = Circuit(
            num_qubits=2,
            num_clbits=0,
            ops=[GateOp(gate="h", targets=[1]), GateOp(gate="cx", controls=[1], targets=[0])],
        )

        response = app_module.verify_bell_state_endpoint(
            VerifyBellStateRequest(result_id=record.result_id, circuit=different_circuit)
        )

        self.assertEqual(response.verification_status, "ERROR")
        hash_check = next(c for c in response.checks if c.name == "circuit_hash_matches_record")
        self.assertEqual(hash_check.status, "FAIL")


class TestResponseSchema(VerifyBellStateEndpointTestCase):
    def test_response_has_exactly_the_documented_fields(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)

        response = app_module.verify_bell_state_endpoint(
            VerifyBellStateRequest(result_id=record.result_id, circuit=BELL)
        )
        dumped = response.model_dump()

        self.assertEqual(
            set(dumped.keys()),
            {
                "result_id",
                "circuit_hash",
                "verifier",
                "verification_status",
                "checks",
                "expected_support",
                "observed_support",
            },
        )
        for check in dumped["checks"]:
            self.assertEqual(set(check.keys()), {"name", "status", "detail"})
            self.assertIn(check["status"], ("PASS", "FAIL"))


class TestRequestSchemaRejectsClientSuppliedResults(unittest.TestCase):
    """Mirrors test_api_execute.py's schema guard: no field exists for a client to
    smuggle in a probability, count or verdict alongside the circuit."""

    def test_extra_verification_status_field_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            VerifyBellStateRequest.model_validate(
                {
                    "result_id": "res_x",
                    "circuit": BELL.canonical_dict(),
                    "verification_status": "VERIFIED",
                }
            )

    def test_valid_request_round_trips(self) -> None:
        req = VerifyBellStateRequest.model_validate(
            {"result_id": "res_x", "circuit": BELL.canonical_dict()}
        )
        self.assertEqual(req.result_id, "res_x")
        self.assertEqual(req.circuit.num_qubits, 2)


if __name__ == "__main__":
    unittest.main()
