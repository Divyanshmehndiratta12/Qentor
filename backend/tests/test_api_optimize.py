"""Tests for POST /api/optimize.

Calls the FastAPI route function directly (httpx/TestClient is not a project
dependency — see test_api_execute.py). The module-level ``_store`` is patched
to a temp-path ProvenanceStore per test.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qentor.api import app as app_module
from qentor.api.schemas import OptimizeRequest
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.store import ProvenanceStore

HH = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[0])])

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


class OptimizeEndpointTestCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        except Exception:
            pass

        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmpdir.name) / "optimize.db")
        self._store_patcher = patch.object(app_module, "_store", self.store)
        self._store_patcher.start()

    def tearDown(self) -> None:
        self._store_patcher.stop()
        self.store.close()
        self._tmpdir.cleanup()


class TestVerifiedShorterEndToEnd(OptimizeEndpointTestCase):
    def test_response_shape_and_persisted_supporting_execution(self) -> None:
        response = app_module.optimize_endpoint(OptimizeRequest(circuit=HH))

        self.assertEqual(response.status, "VERIFIED_SHORTER")
        self.assertEqual(response.original_op_count, 2)
        self.assertEqual(response.candidate_op_count, 0)
        self.assertEqual(len(response.original_circuit_hash), 64)
        self.assertEqual(len(response.candidate_circuit_hash), 64)
        self.assertIsNotNone(response.equivalence)
        self.assertEqual(response.equivalence.status, "EQUIVALENT")
        self.assertIsNotNone(response.candidate_circuit)
        self.assertEqual(response.candidate_circuit.ops, [])

        self.assertIsNotNone(response.result_id)
        record = self.store.get(response.result_id)
        self.assertIsNotNone(record)
        self.assertEqual(record.circuit_hash, response.candidate_circuit_hash)
        self.assertEqual(record.backend, "qiskit-aer")


class TestNoOptimizationFoundEndToEnd(OptimizeEndpointTestCase):
    def test_bell_circuit_is_returned_unchanged_with_explicit_status(self) -> None:
        response = app_module.optimize_endpoint(OptimizeRequest(circuit=BELL))

        self.assertEqual(response.status, "NO_OPTIMIZATION_FOUND")
        self.assertEqual(response.original_circuit_hash, response.candidate_circuit_hash)
        self.assertIsNone(response.candidate_circuit)
        self.assertIsNone(response.result_id)
        self.assertIsNotNone(response.reason)


class TestAdapterSelection(OptimizeEndpointTestCase):
    def test_backend_field_selects_the_adapter_for_supporting_execution(self) -> None:
        for backend in ("qiskit-aer", "cirq", "pennylane"):
            try:
                response = app_module.optimize_endpoint(OptimizeRequest(circuit=HH, backend=backend))
            except AdapterUnavailable as exc:
                self.skipTest(f"{backend} unavailable in this environment: {exc}")
            with self.subTest(backend=backend):
                self.assertEqual(response.status, "VERIFIED_SHORTER")
                record = self.store.get(response.result_id)
                self.assertEqual(record.backend, backend)


class TestRequestSchemaRejectsClientSuppliedVerificationClaims(unittest.TestCase):
    """No field exists for a client to smuggle in a probability, amplitude,
    count or a pre-decided 'verified'/equivalence verdict."""

    def test_extra_verified_field_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            OptimizeRequest.model_validate({"circuit": HH.canonical_dict(), "verified": True})

    def test_extra_status_field_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            OptimizeRequest.model_validate({"circuit": HH.canonical_dict(), "status": "VERIFIED_SHORTER"})

    def test_extra_probability_field_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            OptimizeRequest.model_validate(
                {"circuit": HH.canonical_dict(), "probabilities": {"0": 1.0}}
            )

    def test_unknown_backend_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            OptimizeRequest.model_validate({"circuit": HH.canonical_dict(), "backend": "not-a-real-backend"})

    def test_valid_request_round_trips(self) -> None:
        request = OptimizeRequest.model_validate({"circuit": HH.canonical_dict()})
        self.assertEqual(request.backend, "qiskit-aer")
        self.assertEqual(request.circuit.num_qubits, 1)


if __name__ == "__main__":
    unittest.main()
