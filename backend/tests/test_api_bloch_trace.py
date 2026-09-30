"""API-level tests for ``bloch_vector`` on POST /api/execute/trace.

Calls the route function directly with ``qentor.api.app._store`` patched to a
temp ProvenanceStore, so every provenance link is checked against real stored
rows: the Bloch vector's ``derived_from.result_id`` must resolve to a record
whose circuit hash and statevector are exactly the ones it was derived from.
The independent numpy oracle recomputes the coordinates from the STORED
payload (not from the response), closing the loop.
"""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import TraceRequest, TraceResponse, TraceStepResponse
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.store import ProvenanceStore

from tests.trace_fakes import SENTINEL_STATES, ScriptedAdapter, make_result

TOL = 1e-12


def g(name: str, q: int = 0, **kw) -> GateOp:
    return GateOp(gate=name, targets=[q], **kw)


ZERO = Circuit(num_qubits=1, num_clbits=0, ops=[])
H = Circuit(num_qubits=1, num_clbits=0, ops=[g("h")])
HZ = Circuit(num_qubits=1, num_clbits=0, ops=[g("h"), g("z")])
HZH = Circuit(num_qubits=1, num_clbits=0, ops=[g("h"), g("z"), g("h")])
BELL = Circuit(num_qubits=2, num_clbits=0, ops=[g("h"), GateOp(gate="cx", controls=[0], targets=[1])])
BELL_MEASURED = Circuit(
    num_qubits=2,
    num_clbits=2,
    ops=[*BELL.ops, GateOp(gate="measure", targets=[0], clbits=[0]), GateOp(gate="measure", targets=[1], clbits=[1])],
)
H_MEASURED = Circuit(num_qubits=1, num_clbits=1, ops=[g("h"), GateOp(gate="measure", targets=[0], clbits=[0])])


def pauli_expectations(state) -> tuple[float, float, float]:
    psi = np.array([complex(re, im) for re, im in state])
    sigma = (
        np.array([[0, 1], [1, 0]], dtype=complex),
        np.array([[0, -1j], [1j, 0]], dtype=complex),
        np.array([[1, 0], [0, -1]], dtype=complex),
    )
    return tuple(float(np.real(np.conj(psi) @ (s @ psi))) for s in sigma)


class BlochEndpointCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")

        self._tmp = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmp.name) / "bloch.db")
        self._patcher = patch.object(app_module, "_store", self.store)
        self._patcher.start()

    def tearDown(self) -> None:
        self._patcher.stop()
        self.store.close()
        self._tmp.cleanup()

    def trace(self, circuit: Circuit, **kwargs) -> TraceResponse:
        return app_module.execute_trace(TraceRequest(circuit=circuit, **kwargs))

    def assertVector(self, actual, expected, tol: float = TOL) -> None:
        for got, want, axis in zip(actual, expected, "xyz"):
            self.assertAlmostEqual(got, want, delta=tol, msg=f"{axis}: got {actual}, want {expected}")


class TestSingleQubitResponses(BlochEndpointCase):
    def test_zero_state_has_bloch_plus_z(self) -> None:
        response = self.trace(ZERO)
        bloch = response.steps[0].bloch_vector
        self.assertVector((bloch.x, bloch.y, bloch.z), (0, 0, 1))

    def test_h_gives_plus_z_then_plus_x(self) -> None:
        steps = self.trace(H).steps
        self.assertVector((steps[0].bloch_vector.x, steps[0].bloch_vector.y, steps[0].bloch_vector.z), (0, 0, 1))
        self.assertVector((steps[1].bloch_vector.x, steps[1].bloch_vector.y, steps[1].bloch_vector.z), (1, 0, 0))

    def test_h_z_moves_plus_x_to_minus_x(self) -> None:
        steps = self.trace(HZ).steps
        got = [(s.bloch_vector.x, s.bloch_vector.y, s.bloch_vector.z) for s in steps]
        for actual, expected in zip(got, [(0, 0, 1), (1, 0, 0), (-1, 0, 0)]):
            self.assertVector(actual, expected)

    def test_h_z_h_ends_at_minus_z(self) -> None:
        steps = self.trace(HZH).steps
        got = [(s.bloch_vector.x, s.bloch_vector.y, s.bloch_vector.z) for s in steps]
        for actual, expected in zip(got, [(0, 0, 1), (1, 0, 0), (-1, 0, 0), (0, 0, -1)]):
            self.assertVector(actual, expected)

    def test_a_single_qubit_circuit_with_a_terminal_measurement_still_has_bloch_on_every_step(self) -> None:
        response = self.trace(H_MEASURED)
        self.assertEqual(len(response.steps), 2)  # initial + after H; the measure is not a step
        self.assertTrue(all(s.bloch_vector is not None for s in response.steps))
        self.assertVector(
            (response.steps[1].bloch_vector.x, response.steps[1].bloch_vector.y, response.steps[1].bloch_vector.z),
            (1, 0, 0),
        )


class TestValuesMatchTheStoredBackendState(BlochEndpointCase):
    def test_coordinates_equal_an_independent_computation_on_the_STORED_statevector(self) -> None:
        for circuit in (ZERO, H, HZ, HZH):
            for step in self.trace(circuit).steps:
                with self.subTest(step=step.step_index, ops=len(circuit.ops)):
                    stored = self.store.get(step.bloch_vector.derived_from.result_id)
                    self.assertIsNotNone(stored)
                    self.assertVector(
                        (step.bloch_vector.x, step.bloch_vector.y, step.bloch_vector.z),
                        pauli_expectations(stored.payload["statevector"]),
                    )

    def test_the_response_statevector_and_the_stored_one_are_the_same_numbers(self) -> None:
        for step in self.trace(HZH).steps:
            stored = self.store.get(step.provenance.result_id)
            self.assertEqual(stored.payload["statevector"], step.statevector)

    def test_full_float_precision_survives_serialisation(self) -> None:
        """ry(0.7)|0> has z = cos(0.7) exactly; the JSON must carry that to
        full double precision, not a display-rounded value."""
        ry = Circuit(num_qubits=1, num_clbits=0, ops=[g("ry", params=[0.7])])
        z = json.loads(self.trace(ry).model_dump_json())["steps"][1]["bloch_vector"]["z"]

        self.assertAlmostEqual(z, math.cos(0.7), delta=1e-12)
        self.assertNotEqual(z, round(z, 6))
        self.assertNotEqual(z, round(z, 12))

    def test_residues_in_the_final_h_z_h_state_stay_tiny_and_finite(self) -> None:
        final = json.loads(self.trace(HZH).model_dump_json())["steps"][3]["bloch_vector"]
        for axis in "xy":
            self.assertTrue(math.isfinite(final[axis]))
            self.assertLess(abs(final[axis]), 1e-15)
        self.assertAlmostEqual(final["z"], -1.0, delta=1e-15)


class TestProvenanceOverTheApi(BlochEndpointCase):
    def test_derived_from_is_the_source_steps_own_provenance(self) -> None:
        response = self.trace(HZH)

        for step in response.steps:
            source = step.bloch_vector.derived_from
            with self.subTest(step=step.step_index):
                self.assertEqual(source.step_index, step.step_index)
                self.assertEqual(source.result_id, step.provenance.result_id)
                self.assertEqual(source.execution_id, step.execution_id)
                self.assertEqual(source.circuit_hash, step.provenance.circuit_hash)
                self.assertEqual(source.backend, step.provenance.backend)
                self.assertEqual(source.backend_version, step.provenance.backend_version)
                self.assertEqual(source.backend, response.backend)
                self.assertEqual(source.backend_version, response.backend_version)

    def test_the_source_resolves_to_a_persisted_record_for_the_exact_prefix_circuit(self) -> None:
        response = self.trace(HZH)

        for step in response.steps:
            source = step.bloch_vector.derived_from
            record = self.store.get(source.result_id)
            with self.subTest(step=step.step_index):
                self.assertIsNotNone(record)
                self.assertEqual(record.circuit_hash, source.circuit_hash)
                self.assertEqual(record.payload["execution_id"], source.execution_id)
                self.assertEqual((record.backend, record.backend_version), (source.backend, source.backend_version))
                prefix = Circuit(num_qubits=1, num_clbits=0, ops=HZH.ops[: step.step_index])
                self.assertEqual(source.circuit_hash, circuit_hash(prefix))

    def test_steps_do_not_share_a_source(self) -> None:
        sources = [s.bloch_vector.derived_from for s in self.trace(HZH).steps]
        self.assertEqual(len({s.result_id for s in sources}), 4)
        self.assertEqual(len({s.execution_id for s in sources}), 4)

    def test_the_method_is_named_and_no_verdict_is_attached(self) -> None:
        dumped = json.loads(self.trace(H).model_dump_json())["steps"][1]["bloch_vector"]
        self.assertEqual(dumped["method"], "bloch-from-statevector/1")
        self.assertEqual(set(dumped), {"x", "y", "z", "method", "derived_from"})
        self.assertFalse({"verified", "verification_status", "correct", "verdict"} & set(dumped))
        self.assertFalse({"verified", "verification_status", "correct", "verdict"} & set(dumped["derived_from"]))


class TestBellAndOtherMultiQubitResponses(BlochEndpointCase):
    def test_bell_steps_serialise_bloch_vector_as_null(self) -> None:
        response = self.trace(BELL)
        dumped = json.loads(response.model_dump_json())

        self.assertEqual(len(dumped["steps"]), 3)
        for step in dumped["steps"]:
            self.assertIn("bloch_vector", step)  # a stable, explicit null — not a missing key
            self.assertIsNone(step["bloch_vector"])
            self.assertEqual(len(step["statevector"]), 4)  # the full 2-qubit state is still returned

    def test_bell_with_terminal_measurements_is_the_same(self) -> None:
        response = self.trace(BELL_MEASURED)
        self.assertEqual(len(response.steps), 3)
        self.assertTrue(all(s.bloch_vector is None for s in response.steps))
        self.assertEqual(len(response.terminal_measurements), 2)

    def test_no_global_vector_is_returned_anywhere_on_the_response(self) -> None:
        dumped = json.loads(self.trace(BELL).model_dump_json())
        self.assertNotIn("bloch_vector", {k for k in dumped if k != "steps"})


class TestCompatibility(BlochEndpointCase):
    PREVIOUS_STEP_KEYS = {"step_index", "operation_index", "operation", "execution_id", "provenance", "statevector"}

    def test_every_previous_step_field_is_still_present_and_unchanged(self) -> None:
        self.assertEqual(set(TraceStepResponse.model_fields), self.PREVIOUS_STEP_KEYS | {"bloch_vector", "change"})

        dumped = json.loads(self.trace(HZH).model_dump_json())
        for step in dumped["steps"]:
            self.assertTrue(self.PREVIOUS_STEP_KEYS <= set(step))
        self.assertEqual(
            set(dumped),
            {
                "circuit_hash", "traced_circuit_hash", "backend", "backend_version", "num_qubits", "mode",
                "trace_method", "basis_ordering", "steps", "terminal_measurements", "final_result_id",
            },
        )

    def test_a_client_that_drops_bloch_vector_sees_exactly_the_old_response(self) -> None:
        dumped = json.loads(self.trace(BELL).model_dump_json())
        for step in dumped["steps"]:
            step.pop("bloch_vector")
            step.pop("change")  # additive since: what the operation changed, computed by the server
            self.assertEqual(set(step), self.PREVIOUS_STEP_KEYS)

    def test_bloch_vector_is_optional_on_the_response_model(self) -> None:
        self.assertFalse(TraceStepResponse.model_fields["bloch_vector"].is_required())

    def test_a_client_cannot_supply_a_bloch_vector_or_any_quantum_value(self) -> None:
        for extra in ({"bloch_vector": {"x": 0, "y": 0, "z": 1}}, {"statevector": [[1, 0]]}, {"bloch": [0, 0, 1]}):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                TraceRequest.model_validate({"circuit": ZERO.canonical_dict(), **extra})

    def test_the_trace_route_and_execute_are_still_the_only_routes_involved(self) -> None:
        paths = {r.path for r in app_module.app.routes}
        self.assertIn("/api/execute/trace", paths)
        self.assertFalse({p for p in paths if "bloch" in p.lower()}, "no separate Bloch endpoint")


class TestTrustOverTheApi(BlochEndpointCase):
    def with_adapter(self, adapter):
        return patch.dict(app_module._adapters, {"qiskit-aer": adapter})

    def test_coordinates_come_from_whatever_state_the_backend_returned(self) -> None:
        """Scripted backend states no H gate produces: the API's Bloch vector
        must follow them, not the gate's textbook answer."""
        adapter = ScriptedAdapter(
            lambda i, c: make_result(SENTINEL_STATES[i], backend_name="qiskit-aer", backend_version="9.9-test")
        )
        with self.with_adapter(adapter):
            steps = self.trace(H).steps

        # SENTINEL_STATES[0] = 0.6|0> + 0.8|1>  ->  x = 0.96, y = 0, z = -0.28
        self.assertVector((steps[0].bloch_vector.x, steps[0].bloch_vector.y, steps[0].bloch_vector.z), (0.96, 0.0, -0.28))
        # SENTINEL_STATES[1] = 0.6i|0> + 0.8i|1>  (global phase i) -> the SAME vector
        self.assertVector((steps[1].bloch_vector.x, steps[1].bloch_vector.y, steps[1].bloch_vector.z), (0.96, 0.0, -0.28))

    def test_an_invalid_backend_state_is_a_502_with_no_bloch_and_no_trace(self) -> None:
        adapter = ScriptedAdapter(lambda i, c: make_result([[0.5, 0.0], [0.5, 0.0]]))
        with self.with_adapter(adapter), self.assertRaises(HTTPException) as ctx:
            self.trace(H)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(ctx.exception.detail["code"], "TRACE_STATE_NOT_NORMALISED")
        self.assertNotIn("bloch", json.dumps(ctx.exception.detail).lower())

    def test_shots_mode_is_refused_with_no_bloch(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self.trace(H, mode="shots", shots=100)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertNotIn("bloch", json.dumps(ctx.exception.detail).lower())


if __name__ == "__main__":
    unittest.main()
