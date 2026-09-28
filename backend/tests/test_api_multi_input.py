"""Tests for POST /api/test/multi-input.

Calls the FastAPI route function directly (httpx/TestClient is not a project
dependency — see test_api_execute.py). The module-level ``_store`` in
qentor.api.app is patched to a temp-path ProvenanceStore per test, so every
per-case execution this endpoint persists is checked against a real store,
not a stub.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qentor.api import app as app_module
from qentor.api.schemas import MultiInputTestCaseRequest, MultiInputTestRequest
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.store import ProvenanceStore

COPY = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="cx", controls=[0], targets=[1])])


class MultiInputEndpointTestCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        except Exception:
            pass

        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmpdir.name) / "multi_input.db")
        self._store_patcher = patch.object(app_module, "_store", self.store)
        self._store_patcher.start()

    def tearDown(self) -> None:
        self._store_patcher.stop()
        self.store.close()
        self._tmpdir.cleanup()


class TestAllPassEndToEnd(MultiInputEndpointTestCase):
    def test_response_shape_and_provenance_on_a_passing_run(self) -> None:
        request = MultiInputTestRequest(
            circuit=COPY,
            input_qubits=[0],
            output_qubits=[1],
            cases=[
                MultiInputTestCaseRequest(input_bits="0", expected_output="0"),
                MultiInputTestCaseRequest(input_bits="1", expected_output="1"),
            ],
        )

        response = app_module.multi_input_test_endpoint(request)

        self.assertEqual(response.overall_status, "ALL_PASSED")
        self.assertEqual(response.backend, "qiskit-aer")
        self.assertIsNotNone(response.backend_version)
        self.assertEqual(len(response.circuit_hash), 64)
        self.assertEqual([c.status for c in response.cases], ["PASS", "PASS"])
        self.assertEqual(response.counterexamples, [])

        # Every case's execution was really persisted, independently readable.
        for case in response.cases:
            self.assertIsNotNone(case.result_id)
            record = self.store.get(case.result_id)
            self.assertIsNotNone(record)
            self.assertEqual(record.circuit_hash, case.circuit_hash)
            self.assertEqual(record.backend, "qiskit-aer")


class TestSomeFailedEndToEnd(MultiInputEndpointTestCase):
    def test_failing_case_reports_a_counterexample_with_its_own_result_id(self) -> None:
        request = MultiInputTestRequest(
            circuit=COPY,
            input_qubits=[0],
            output_qubits=[1],
            cases=[
                MultiInputTestCaseRequest(input_bits="0", expected_output="0"),
                MultiInputTestCaseRequest(input_bits="1", expected_output="0"),  # wrong
            ],
        )

        response = app_module.multi_input_test_endpoint(request)

        self.assertEqual(response.overall_status, "SOME_FAILED")
        self.assertEqual(len(response.counterexamples), 1)
        counterexample = response.counterexamples[0]
        self.assertEqual(counterexample.input_bits, "1")
        self.assertEqual(counterexample.observed_distribution, {"1": 1.0})
        self.assertIsNotNone(counterexample.result_id)
        self.assertIsNotNone(self.store.get(counterexample.result_id))


class TestAdapterSelection(MultiInputEndpointTestCase):
    def test_backend_field_selects_the_matching_adapter(self) -> None:
        for backend in ("qiskit-aer", "cirq", "pennylane"):
            request = MultiInputTestRequest(
                circuit=COPY,
                input_qubits=[0],
                output_qubits=[1],
                cases=[MultiInputTestCaseRequest(input_bits="1", expected_output="1")],
                backend=backend,
            )
            try:
                response = app_module.multi_input_test_endpoint(request)
            except AdapterUnavailable as exc:
                self.skipTest(f"{backend} unavailable in this environment: {exc}")
            with self.subTest(backend=backend):
                self.assertEqual(response.backend, backend)
                self.assertEqual(response.overall_status, "ALL_PASSED")


class TestRequestValidation(unittest.TestCase):
    """Pure pydantic-schema-level checks — no store needed."""

    def test_extra_field_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            MultiInputTestRequest.model_validate(
                {
                    "circuit": COPY.canonical_dict(),
                    "input_qubits": [0],
                    "output_qubits": [1],
                    "cases": [{"input_bits": "1", "expected_output": "1"}],
                    "observed_distribution": {"1": 1.0},
                }
            )

    def test_empty_cases_list_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            MultiInputTestRequest.model_validate(
                {"circuit": COPY.canonical_dict(), "input_qubits": [0], "output_qubits": [1], "cases": []}
            )

    def test_unknown_backend_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            MultiInputTestRequest.model_validate(
                {
                    "circuit": COPY.canonical_dict(),
                    "input_qubits": [0],
                    "output_qubits": [1],
                    "cases": [{"input_bits": "1", "expected_output": "1"}],
                    "backend": "not-a-real-backend",
                }
            )

    def test_valid_request_round_trips(self) -> None:
        request = MultiInputTestRequest.model_validate(
            {
                "circuit": COPY.canonical_dict(),
                "input_qubits": [0],
                "output_qubits": [1],
                "cases": [{"input_bits": "1", "expected_output": "1"}],
            }
        )
        self.assertEqual(request.backend, "qiskit-aer")
        self.assertEqual(request.cases[0].input_bits, "1")


class TestUnsupportedRequestRejectedAsHttpError(MultiInputEndpointTestCase):
    def test_out_of_range_qubit_raises_422(self) -> None:
        from fastapi import HTTPException

        request = MultiInputTestRequest(
            circuit=COPY,
            input_qubits=[7],
            output_qubits=[1],
            cases=[MultiInputTestCaseRequest(input_bits="1", expected_output="1")],
        )
        with self.assertRaises(HTTPException) as ctx:
            app_module.multi_input_test_endpoint(request)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_mismatched_bit_length_raises_422(self) -> None:
        from fastapi import HTTPException

        request = MultiInputTestRequest(
            circuit=COPY,
            input_qubits=[0, 1],
            output_qubits=[1],
            cases=[MultiInputTestCaseRequest(input_bits="1", expected_output="1")],
        )
        with self.assertRaises(HTTPException) as ctx:
            app_module.multi_input_test_endpoint(request)
        self.assertEqual(ctx.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
