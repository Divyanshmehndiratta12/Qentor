"""Tests for POST /api/execute/trace.

Calls the route function directly (httpx/TestClient is not a project
dependency — see test_api_execute.py) with ``qentor.api.app._store`` patched
to a temp ProvenanceStore per test, so every persisted step is read back from
a real store. Reference states come from the real Aer adapter / the existing
``execute`` route; the scripted fakes are used only for backend-failure paths.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ExecuteRequest, ExecuteResponse, TraceRequest
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ProvenanceClass, ExecutionStatus
from qentor.provenance.store import ProvenanceStore

from tests.trace_fakes import SENTINEL_STATES, ScriptedAdapter, make_result

BELL_NO_MEASURE = Circuit(
    num_qubits=2,
    num_clbits=0,
    ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])],
)
BELL_MEASURED = Circuit(
    num_qubits=2,
    num_clbits=2,
    ops=[
        GateOp(gate="h", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
    ],
)
ONE_QUBIT_H = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])


class TraceEndpointCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")

        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmpdir.name) / "trace.db")
        self._patcher = patch.object(app_module, "_store", self.store)
        self._patcher.start()

    def tearDown(self) -> None:
        self._patcher.stop()
        self.store.close()
        self._tmpdir.cleanup()

    def trace(self, circuit: Circuit, **kwargs):
        return app_module.execute_trace(TraceRequest(circuit=circuit, **kwargs))

    def all_records(self, circuit_hashes: list[str]):
        return [r for h in circuit_hashes for r in self.store.list_by_circuit_hash(h)]

    def assertRefused(self, ctx, status: int, code: str) -> None:
        self.assertEqual(ctx.exception.status_code, status)
        self.assertIsInstance(ctx.exception.detail, dict)  # structured, not free text
        self.assertEqual(ctx.exception.detail["code"], code)
        self.assertTrue(ctx.exception.detail["message"])


class TestResponseShapeAndProvenance(TraceEndpointCase):
    def test_top_level_identity(self) -> None:
        response = self.trace(BELL_NO_MEASURE)

        self.assertEqual(response.circuit_hash, circuit_hash(BELL_NO_MEASURE))
        self.assertEqual(len(response.circuit_hash), 64)
        self.assertEqual(response.traced_circuit_hash, response.circuit_hash)
        self.assertEqual(response.backend, "qiskit-aer")
        self.assertTrue(response.backend_version)
        self.assertEqual(response.mode, "statevector")
        self.assertEqual(response.trace_method, "prefix-statevector")
        self.assertEqual(response.num_qubits, 2)
        self.assertIn("q[n-1]", response.basis_ordering)  # bit order stated with the data

    def test_steps_are_ordered_and_identify_their_operation(self) -> None:
        response = self.trace(BELL_NO_MEASURE)

        self.assertEqual([s.step_index for s in response.steps], [0, 1, 2])
        self.assertEqual([s.operation_index for s in response.steps], [None, 0, 1])
        self.assertIsNone(response.steps[0].operation)
        self.assertEqual(response.steps[1].operation, BELL_NO_MEASURE.ops[0])
        self.assertEqual(response.steps[2].operation, BELL_NO_MEASURE.ops[1])

    def test_every_step_resolves_to_a_real_persisted_backend_record(self) -> None:
        response = self.trace(BELL_NO_MEASURE)

        seen_ids = set()
        for step in response.steps:
            prov = step.provenance
            record = self.store.get(prov.result_id)
            self.assertIsNotNone(record, f"step {step.step_index} has no persisted record")
            seen_ids.add(prov.result_id)

            # The response's provenance IS the stored record, field for field.
            self.assertEqual(record.circuit_hash, prov.circuit_hash)
            self.assertEqual(record.backend, prov.backend)
            self.assertEqual(record.backend_version, prov.backend_version)
            self.assertEqual(record.execution_mode, prov.execution_mode)
            self.assertEqual(record.provenance_class.value, prov.provenance_class)
            self.assertEqual(record.verification_status.value, prov.verification_status)
            self.assertEqual(record.created_at, prov.created_at)
            # ...and the state in the response IS the stored payload, untouched.
            self.assertEqual(record.payload["statevector"], step.statevector)
            self.assertEqual(record.payload["execution_id"], step.execution_id)

            self.assertEqual(prov.backend, "qiskit-aer")
            self.assertEqual(prov.execution_mode, "statevector")
            self.assertEqual(record.provenance_class, ProvenanceClass.SIMULATION)
        self.assertEqual(len(seen_ids), 3)  # three distinct records

    def test_each_steps_circuit_hash_is_its_own_prefix(self) -> None:
        response = self.trace(BELL_NO_MEASURE)

        for step in response.steps:
            prefix = Circuit(num_qubits=2, num_clbits=0, ops=BELL_NO_MEASURE.ops[: step.step_index])
            self.assertEqual(step.provenance.circuit_hash, circuit_hash(prefix))
        self.assertEqual(response.steps[-1].provenance.circuit_hash, response.circuit_hash)

    def test_final_result_links_to_the_last_step_and_matches_a_plain_execute(self) -> None:
        response = self.trace(BELL_NO_MEASURE)
        executed = app_module.execute(ExecuteRequest(circuit=BELL_NO_MEASURE, mode="statevector"))

        self.assertEqual(response.final_result_id, response.steps[-1].provenance.result_id)
        # Same circuit hash as the existing /api/execute path would have used...
        self.assertEqual(executed.circuit_hash, response.steps[-1].provenance.circuit_hash)
        # ...and the same backend-computed state.
        for (tre, tim), (ere, eim) in zip(response.steps[-1].statevector, executed.payload["statevector"]):
            self.assertAlmostEqual(tre, ere, places=9)
            self.assertAlmostEqual(tim, eim, places=9)

    def test_a_step_record_is_usable_by_existing_consumers(self) -> None:
        """Steps are ordinary execution records, so they can be looked up by
        circuit hash like anything /api/execute wrote."""
        response = self.trace(ONE_QUBIT_H)
        final = response.steps[-1].provenance

        found = self.store.list_by_circuit_hash(final.circuit_hash)
        self.assertEqual([r.result_id for r in found], [final.result_id])

    def test_verification_status_only_means_the_backend_ran(self) -> None:
        for step in self.trace(BELL_NO_MEASURE).steps:
            self.assertEqual(step.provenance.verification_status, ExecutionStatus.STATE_CHECKED.value)
        # No circuit-level verdict of any kind exists on the response.
        from qentor.api.schemas import TraceResponse

        self.assertFalse({"verified", "equivalent", "passed", "verification_status"} & set(TraceResponse.model_fields))

    def test_a_measured_circuit_reports_terminal_measurements(self) -> None:
        response = self.trace(BELL_MEASURED)

        self.assertEqual(len(response.steps), 3)
        self.assertEqual([m.operation_index for m in response.terminal_measurements], [2, 3])
        self.assertEqual(response.circuit_hash, circuit_hash(BELL_MEASURED))
        self.assertNotEqual(response.traced_circuit_hash, response.circuit_hash)
        self.assertEqual(response.traced_circuit_hash, response.steps[-1].provenance.circuit_hash)

    def test_cirq_is_selectable_and_labelled_as_cirq(self) -> None:
        try:
            response = self.trace(BELL_NO_MEASURE, backend="cirq")
        except HTTPException as exc:
            if exc.status_code == 503:
                self.skipTest(f"cirq unavailable: {exc.detail}")
            raise
        self.assertEqual(response.backend, "cirq")
        self.assertTrue(all(s.provenance.backend == "cirq" for s in response.steps))


class TestUnsupportedRequests(TraceEndpointCase):
    def test_shots_mode_is_a_structured_refusal_with_no_data_and_no_records(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self.trace(BELL_MEASURED, mode="shots", shots=1000)

        self.assertRefused(ctx, 422, "TRACE_MODE_UNSUPPORTED")
        # Nothing was executed or persisted on the way to refusing.
        self.assertEqual(self.all_records([circuit_hash(BELL_MEASURED)]), [])

    def test_measurement_followed_by_a_gate_is_refused(self) -> None:
        circuit = Circuit(
            num_qubits=1,
            num_clbits=1,
            ops=[
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="x", targets=[0]),
            ],
        )
        with self.assertRaises(HTTPException) as ctx:
            self.trace(circuit)
        self.assertRefused(ctx, 422, "TRACE_MID_CIRCUIT_MEASUREMENT")

    def test_too_many_qubits_uses_the_existing_harness_limit(self) -> None:
        from qentor.verification.multi_input_harness import MAX_SWEEP_QUBITS

        too_big = Circuit(num_qubits=MAX_SWEEP_QUBITS + 1, num_clbits=0, ops=[])
        with self.assertRaises(HTTPException) as ctx:
            self.trace(too_big)
        self.assertRefused(ctx, 422, "TRACE_CIRCUIT_TOO_LARGE")
        self.assertIn(str(MAX_SWEEP_QUBITS), ctx.exception.detail["message"])

        at_limit = Circuit(num_qubits=MAX_SWEEP_QUBITS, num_clbits=0, ops=[])
        self.assertEqual(len(self.trace(at_limit).steps), 1)  # exactly at the limit is fine

    def test_too_many_operations_uses_the_existing_run_budget(self) -> None:
        from qentor.verification.multi_input_harness import MAX_TEST_CASES

        long = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="x", targets=[0])] * MAX_TEST_CASES)
        with self.assertRaises(HTTPException) as ctx:
            self.trace(long)
        self.assertRefused(ctx, 422, "TRACE_TOO_MANY_OPERATIONS")


class TestBackendFailuresAreStructuredAndNeverSubstituted(TraceEndpointCase):
    def with_adapter(self, adapter):
        return patch.dict(app_module._adapters, {"qiskit-aer": adapter})

    def test_unavailable_backend_is_a_503_with_no_data(self) -> None:
        def respond(i, c):
            raise AdapterUnavailable("runtime blocked")

        with self.with_adapter(ScriptedAdapter(respond)), self.assertRaises(HTTPException) as ctx:
            self.trace(BELL_NO_MEASURE)

        self.assertRefused(ctx, 503, "TRACE_BACKEND_UNAVAILABLE")
        self.assertIn("runtime blocked", ctx.exception.detail["message"])

    def test_a_failed_run_is_a_400_and_logs_an_error_record(self) -> None:
        def respond(i, c):
            raise AdapterExecutionError("Aer run did not succeed")

        with self.with_adapter(ScriptedAdapter(respond)), self.assertRaises(HTTPException) as ctx:
            self.trace(BELL_NO_MEASURE)

        self.assertRefused(ctx, 400, "TRACE_BACKEND_EXECUTION_FAILED")
        [record] = self.store.list_by_circuit_hash(circuit_hash(BELL_NO_MEASURE))
        self.assertEqual(record.verification_status, ExecutionStatus.ERROR)
        self.assertNotIn("statevector", record.payload)

    def test_an_unusable_state_is_a_502_and_the_bad_state_is_not_stored_as_a_result(self) -> None:
        bad = [[0.5, 0.0], [0.5, 0.0]]  # norm 0.5

        with self.with_adapter(ScriptedAdapter(lambda i, c: make_result(bad))), self.assertRaises(HTTPException) as ctx:
            self.trace(ONE_QUBIT_H)

        self.assertRefused(ctx, 502, "TRACE_STATE_NOT_NORMALISED")
        [record] = self.store.list_by_circuit_hash(circuit_hash(Circuit(num_qubits=1, num_clbits=0, ops=[])))
        self.assertEqual(record.verification_status, ExecutionStatus.ERROR)
        self.assertNotIn("statevector", record.payload)

    def test_the_api_passes_through_exactly_what_a_backend_returned(self) -> None:
        adapter = ScriptedAdapter(
            lambda i, c: make_result(SENTINEL_STATES[i], backend_name="qiskit-aer", backend_version="9.9-test")
        )
        with self.with_adapter(adapter):
            response = self.trace(ONE_QUBIT_H)

        self.assertEqual([s.statevector for s in response.steps], SENTINEL_STATES[:2])
        self.assertEqual(response.backend_version, "9.9-test")


class TestSchema(unittest.TestCase):
    def test_request_has_no_field_for_client_supplied_quantum_values(self) -> None:
        for extra in ({"statevector": [[1, 0]]}, {"probabilities": {"0": 1.0}}, {"amplitudes": [1, 0]}, {"verified": True}):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                TraceRequest.model_validate({"circuit": ONE_QUBIT_H.canonical_dict(), **extra})

    def test_mode_defaults_to_statevector_and_shots_is_accepted_only_so_it_can_be_refused(self) -> None:
        self.assertEqual(TraceRequest.model_validate({"circuit": ONE_QUBIT_H.canonical_dict()}).mode, "statevector")
        self.assertEqual(
            TraceRequest.model_validate({"circuit": ONE_QUBIT_H.canonical_dict(), "mode": "shots", "shots": 10}).mode,
            "shots",
        )

    def test_unknown_backend_and_mode_are_validation_errors(self) -> None:
        for bad in ({"backend": "ibm_hardware"}, {"mode": "unitary"}):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                TraceRequest.model_validate({"circuit": ONE_QUBIT_H.canonical_dict(), **bad})


class TestExistingApiUnchanged(unittest.TestCase):
    def test_execute_route_and_response_shape_are_untouched(self) -> None:
        self.assertEqual(
            set(ExecuteResponse.model_fields),
            {
                "result_id",
                "circuit_hash",
                "backend",
                "backend_version",
                "execution_mode",
                "provenance_class",
                "verification_status",
                "created_at",
                "payload",
            },
        )
        self.assertEqual(
            set(ExecuteRequest.model_fields), {"circuit", "mode", "shots", "backend"}
        )

    def test_both_routes_are_registered_side_by_side(self) -> None:
        paths = {route.path for route in app_module.app.routes}
        self.assertIn("/api/execute", paths)
        self.assertIn("/api/execute/trace", paths)
        # Every pre-existing route is still there.
        for path in (
            "/api/verify/bell-state",
            "/api/tutor",
            "/api/test/multi-input",
            "/api/optimize",
            "/api/lessons",
        ):
            self.assertIn(path, paths)


if __name__ == "__main__":
    unittest.main()
