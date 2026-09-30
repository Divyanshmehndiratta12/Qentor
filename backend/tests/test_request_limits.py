"""Explicit request limits (``qentor.execution.limits``).

Before this, "how big a circuit can I run?" was decided by the operating system's
memory: a 30-qubit statevector made a backend ask for gigabytes. These tests pin the
replacement: every over-sized request is refused with a structured 422 BEFORE any
backend is asked to allocate anything, and the limits are the documented numbers.

Routes are called directly (as in ``test_api_execute``); ``adapter.run`` is replaced by a
mock that fails the test if it is ever reached for a refused request.
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from qentor.api import app as app_module
from qentor.api.schemas import ExecuteRequest, MultiInputTestRequest, OptimizeRequest, TraceRequest
from qentor.circuit.model import Circuit, GateOp
from qentor.execution import limits
from qentor.execution.limits import (
    EQUIVALENCE_MAX_QUBITS,
    MAX_OPERATIONS,
    MAX_QUBITS_BY_BACKEND,
    MAX_SHOTS,
    LimitExceeded,
    check_equivalence_limits,
    check_run_limits,
)
from qentor.verification.equivalence import EquivalenceStatus, check_equivalence
from tests.test_api_tutor import TutorEndpointTestCase


def _circuit(num_qubits: int, ops: int = 1, clbits: int = 0) -> Circuit:
    return Circuit(num_qubits=num_qubits, num_clbits=clbits, ops=[GateOp(gate="h", targets=[0]) for _ in range(ops)])


class TestDocumentedLimits(unittest.TestCase):
    def test_the_limits_are_the_documented_numbers(self) -> None:
        self.assertEqual(MAX_QUBITS_BY_BACKEND, {"qiskit-aer": 16, "cirq": 14, "pennylane": 14})
        self.assertEqual((MAX_OPERATIONS, MAX_SHOTS, EQUIVALENCE_MAX_QUBITS), (500, 100_000, 10))

    def test_every_backend_the_api_accepts_has_a_limit(self) -> None:
        self.assertEqual(set(MAX_QUBITS_BY_BACKEND), set(app_module._adapters))

    def test_the_module_documents_every_limit(self) -> None:
        doc = limits.__doc__ or ""
        for needle in ("16", "14", "500", "100000", "10"):
            self.assertIn(needle, doc)


class TestCheckRunLimits(unittest.TestCase):
    def test_a_request_exactly_at_each_limit_is_allowed(self) -> None:
        for backend, cap in MAX_QUBITS_BY_BACKEND.items():
            check_run_limits(_circuit(cap), backend)
        check_run_limits(_circuit(2, ops=MAX_OPERATIONS), "qiskit-aer")
        check_run_limits(_circuit(2), "qiskit-aer", shots=MAX_SHOTS)

    def test_one_over_each_limit_is_refused_with_the_numbers(self) -> None:
        for backend, cap in MAX_QUBITS_BY_BACKEND.items():
            with self.assertRaises(LimitExceeded) as raised:
                check_run_limits(_circuit(cap + 1), backend)
            exc = raised.exception
            self.assertEqual((exc.code, exc.limit, exc.requested, exc.backend), (limits.TOO_MANY_QUBITS, cap, cap + 1, backend))
            self.assertEqual(set(exc.detail()), {"code", "message", "limit", "requested", "backend"})
            self.assertIn(str(cap), exc.message)

    def test_operation_and_shot_limits(self) -> None:
        with self.assertRaises(LimitExceeded) as ops:
            check_run_limits(_circuit(2, ops=MAX_OPERATIONS + 1), "qiskit-aer")
        self.assertEqual((ops.exception.code, ops.exception.limit), (limits.TOO_MANY_OPERATIONS, MAX_OPERATIONS))
        with self.assertRaises(LimitExceeded) as shots:
            check_run_limits(_circuit(2), "qiskit-aer", shots=MAX_SHOTS + 1)
        self.assertEqual((shots.exception.code, shots.exception.requested), (limits.TOO_MANY_SHOTS, MAX_SHOTS + 1))

    def test_a_tighter_caller_limit_can_lower_but_never_raise_the_backend_limit(self) -> None:
        with self.assertRaises(LimitExceeded):
            check_run_limits(_circuit(9), "qiskit-aer", max_qubits_override=8)
        with self.assertRaises(LimitExceeded):
            check_run_limits(_circuit(17), "qiskit-aer", max_qubits_override=99)  # 99 cannot raise 16

    def test_an_unknown_backend_is_refused_not_defaulted(self) -> None:
        with self.assertRaises(LimitExceeded) as raised:
            check_run_limits(_circuit(2), "made-up-backend")
        self.assertEqual(raised.exception.code, limits.UNKNOWN_BACKEND)

    def test_equivalence_limit(self) -> None:
        check_equivalence_limits(EQUIVALENCE_MAX_QUBITS)
        with self.assertRaises(LimitExceeded) as raised:
            check_equivalence_limits(EQUIVALENCE_MAX_QUBITS + 1)
        self.assertEqual(raised.exception.limit, EQUIVALENCE_MAX_QUBITS)


class TestTheApiRefusesBeforeAnyBackendRuns(TutorEndpointTestCase):
    """The store is a temp DB; every adapter's ``run`` is a mock that must stay untouched."""

    def setUp(self) -> None:
        super().setUp()
        self.runs = {}
        for name, adapter in app_module._adapters.items():
            mock = MagicMock(side_effect=AssertionError(f"{name}.run was reached for a refused request"))
            patcher = patch.object(adapter, "run", mock)
            patcher.start()
            self.addCleanup(patcher.stop)
            self.runs[name] = mock

    def refused(self, call, **expected) -> dict:
        with self.assertRaises(HTTPException) as raised:
            call()
        self.assertEqual(raised.exception.status_code, 422)
        detail = raised.exception.detail
        self.assertIsInstance(detail, dict)
        for key, value in expected.items():
            self.assertEqual(detail[key], value, detail)
        for mock in self.runs.values():
            mock.assert_not_called()
        return detail

    def test_execute_refuses_too_many_qubits_on_every_backend(self) -> None:
        for backend, cap in MAX_QUBITS_BY_BACKEND.items():
            for mode in ("statevector", "shots"):
                circuit = _circuit(cap + 1, clbits=1)
                request = ExecuteRequest(circuit=circuit, mode=mode, shots=10 if mode == "shots" else None, backend=backend)
                self.refused(lambda r=request: app_module.execute(r), code=limits.TOO_MANY_QUBITS, limit=cap, requested=cap + 1, backend=backend)

    def test_a_32_qubit_request_is_refused_deterministically_not_by_a_memory_error(self) -> None:
        for backend in MAX_QUBITS_BY_BACKEND:
            request = ExecuteRequest(circuit=_circuit(32), mode="statevector", backend=backend)
            self.refused(lambda r=request: app_module.execute(r), code=limits.TOO_MANY_QUBITS)

    def test_execute_refuses_too_many_operations_and_shots(self) -> None:
        self.refused(
            lambda: app_module.execute(ExecuteRequest(circuit=_circuit(2, ops=MAX_OPERATIONS + 1), mode="statevector")),
            code=limits.TOO_MANY_OPERATIONS,
        )
        self.refused(
            lambda: app_module.execute(ExecuteRequest(circuit=_circuit(2, clbits=1), mode="shots", shots=MAX_SHOTS + 1)),
            code=limits.TOO_MANY_SHOTS,
            limit=MAX_SHOTS,
        )

    def test_trace_refuses_a_circuit_over_the_backend_limit(self) -> None:
        self.refused(
            lambda: app_module.execute_trace(TraceRequest(circuit=_circuit(17), backend="qiskit-aer")),
            code=limits.TOO_MANY_QUBITS,
            limit=16,
        )

    def test_multi_input_refuses_a_circuit_over_the_backend_limit(self) -> None:
        request = MultiInputTestRequest(
            circuit=_circuit(15, clbits=1),
            input_qubits=[0],
            output_qubits=[0],
            cases=[{"input_bits": "0", "expected_output": "0"}],
            backend="cirq",
        )
        self.refused(lambda: app_module.multi_input_test_endpoint(request), code=limits.TOO_MANY_QUBITS, limit=14, backend="cirq")

    def test_optimize_refuses_a_circuit_over_the_equivalence_limit_even_when_a_backend_could_run_it(self) -> None:
        # 12 qubits is fine for Aer (limit 16) but an equivalence check needs a 4096 x 4096 operator (limit 10)
        detail = self.refused(
            lambda: app_module.optimize_endpoint(OptimizeRequest(circuit=_circuit(12, ops=2), backend="qiskit-aer")),
            code=limits.TOO_MANY_QUBITS,
            limit=EQUIVALENCE_MAX_QUBITS,
        )
        self.assertNotIn("backend", detail)


class TestRequestsAtTheLimitStillRun(TutorEndpointTestCase):
    """A limit is only honest if a request exactly at it works (real backends, real runs)."""

    def test_a_14_qubit_request_runs_on_every_backend(self) -> None:
        for backend in MAX_QUBITS_BY_BACKEND:
            circuit = _circuit(14)
            response = app_module.execute(ExecuteRequest(circuit=circuit, mode="statevector", backend=backend))
            self.assertEqual(response.backend, backend)
            self.assertEqual(len(response.payload["statevector"]), 2**14)

    def test_a_16_qubit_request_runs_on_aer(self) -> None:
        response = app_module.execute(ExecuteRequest(circuit=_circuit(16), mode="statevector", backend="qiskit-aer"))
        self.assertEqual(len(response.payload["statevector"]), 2**16)

    def test_the_maximum_shots_are_accepted(self) -> None:
        circuit = Circuit(num_qubits=1, num_clbits=1, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="measure", targets=[0], clbits=[0])])
        response = app_module.execute(ExecuteRequest(circuit=circuit, mode="shots", shots=MAX_SHOTS))
        self.assertEqual(sum(response.payload["counts"].values()), MAX_SHOTS)


class TestEquivalenceRefusesOnItsOwn(unittest.TestCase):
    """The checker itself is capped, so a future caller that forgets the API check still cannot
    ask Qiskit for a 2**n x 2**n operator."""

    def test_over_the_limit_is_unverifiable_and_builds_no_operator(self) -> None:
        big = _circuit(EQUIVALENCE_MAX_QUBITS + 1, ops=2)
        with patch("qiskit.quantum_info.Operator", side_effect=AssertionError("an operator was built")):
            report = check_equivalence(big, big)
        self.assertEqual(report.status, EquivalenceStatus.UNVERIFIABLE)
        self.assertIn(str(EQUIVALENCE_MAX_QUBITS), report.reason or "")
        self.assertIn("within_size_limit", [c.name for c in report.checks])

    def test_at_the_limit_it_still_decides(self) -> None:
        circuit = _circuit(EQUIVALENCE_MAX_QUBITS, ops=2)  # H H = identity
        empty = Circuit(num_qubits=EQUIVALENCE_MAX_QUBITS, num_clbits=0, ops=[])
        self.assertEqual(check_equivalence(circuit, empty).status, EquivalenceStatus.EQUIVALENT)


if __name__ == "__main__":
    unittest.main()
