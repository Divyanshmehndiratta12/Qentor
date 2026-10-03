"""The per-qubit state view that ``/api/execute`` (and a shared page) carries for a statevector run.

The browser draws one Bloch sphere per qubit of the FINAL state of a run. Those values are the server's: derived from the
statevector in the STORED record by ``qentor.execution.reduced_state``, tagged with that record's identity. These tests pin:

* the values for known states (a product state, a Bell pair, a phase state) against exact textbook values written here as
  literals — never recomputed with the code under test;
* that they agree with the trace's own final step (two independent routes to the same state);
* that a shots run has none, and a bad state is UNUSABLE with a reason, not invented numbers;
* that no client field can reach them, and that the stored record is the only source.
"""

from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ExecuteRequest, TraceRequest
from qentor.api.state_view import final_state_qubit_states
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.provenance.store import ProvenanceStore


def g(name, targets, controls=(), params=(), clbits=()):
    return GateOp(gate=name, targets=list(targets), controls=list(controls), params=list(params), clbits=list(clbits))


def circ(n, *ops, clbits=0):
    return Circuit(num_qubits=n, num_clbits=clbits, ops=list(ops))


H0 = circ(1, g("h", [0]))
X0 = circ(1, g("x", [0]))
PLUS_I = circ(1, g("h", [0]), g("s", [0]))  # |+i>: Bloch +y
BELL = circ(2, g("h", [0]), g("cx", [1], [0]))
PRODUCT = circ(2, g("h", [0]), g("x", [1]))  # q0 = |+>, q1 = |1>
GHZ3 = circ(3, g("h", [0]), g("cx", [1], [0]), g("cx", [2], [1]))
BELL_MEASURED = circ(2, g("h", [0]), g("cx", [1], [0]), g("measure", [0], clbits=[0]), g("measure", [1], clbits=[1]), clbits=2)

TOL = 1e-9


class StateViewCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmpdir.name) / "state-view.db")
        self._patcher = patch.object(app_module, "_store", self.store)
        self._patcher.start()

    def tearDown(self) -> None:
        self._patcher.stop()
        self.store.close()
        self._tmpdir.cleanup()

    def run_circuit(self, circuit: Circuit, mode="statevector", backend="qiskit-aer", shots=None):
        return app_module.execute(ExecuteRequest(circuit=circuit, mode=mode, backend=backend, shots=shots))

    def assertBloch(self, state, x, y, z, purity, entangled) -> None:
        self.assertEqual(state.status, "OK", state.reason)
        self.assertAlmostEqual(state.bloch.x, x, delta=TOL)
        self.assertAlmostEqual(state.bloch.y, y, delta=TOL)
        self.assertAlmostEqual(state.bloch.z, z, delta=TOL)
        self.assertAlmostEqual(state.purity, purity, delta=TOL)
        self.assertEqual(state.entangled_with_rest, entangled)


class TestKnownStates(StateViewCase):
    def test_one_qubit_states_have_their_textbook_bloch_vectors(self) -> None:
        # |+> = +x, |1> = -z, |+i> = +y, and nothing about a state is looked up from the gates that built it.
        for circuit, (x, y, z) in ((H0, (1, 0, 0)), (X0, (0, 0, -1)), (PLUS_I, (0, 1, 0))):
            with self.subTest(ops=[o.gate for o in circuit.ops]):
                (state,) = self.run_circuit(circuit).qubit_states
                self.assertEqual(state.qubit, 0)
                self.assertBloch(state, x, y, z, 1.0, False)

    def test_a_product_state_gives_each_qubit_its_own_pure_vector(self) -> None:
        q0, q1 = self.run_circuit(PRODUCT).qubit_states
        self.assertBloch(q0, 1, 0, 0, 1.0, False)
        self.assertBloch(q1, 0, 0, -1, 1.0, False)

    def test_each_qubit_of_a_bell_pair_is_maximally_mixed_and_says_it_is_entangled(self) -> None:
        for state in self.run_circuit(BELL).qubit_states:
            self.assertBloch(state, 0, 0, 0, 0.5, True)
            self.assertAlmostEqual(state.bloch_length, 0.0, delta=TOL)

    def test_ghz_has_one_mixed_vector_per_qubit_and_no_global_one(self) -> None:
        response = self.run_circuit(GHZ3)
        self.assertEqual([s.qubit for s in response.qubit_states], [0, 1, 2])
        for state in response.qubit_states:
            self.assertBloch(state, 0, 0, 0, 0.5, True)

    def test_qubit_order_is_q0_first(self) -> None:
        # X on q1 only: |q1 q0> = |10>, so q0 is |0> (+z) and q1 is |1> (-z).
        q0, q1 = self.run_circuit(circ(2, g("x", [1]))).qubit_states
        self.assertEqual((q0.qubit, q1.qubit), (0, 1))
        self.assertBloch(q0, 0, 0, 1, 1.0, False)
        self.assertBloch(q1, 0, 0, -1, 1.0, False)

    def test_a_relative_phase_moves_the_vector_round_the_equator_but_not_the_probabilities(self) -> None:
        # |+> then Z gives |->: Bloch -x. The outcome probabilities are the same as |+>'s; the vector is not.
        (state,) = self.run_circuit(circ(1, g("h", [0]), g("z", [0]))).qubit_states
        self.assertBloch(state, -1, 0, 0, 1.0, False)


class TestIdentityAndProvenance(StateViewCase):
    def test_every_state_names_the_stored_record_it_came_from(self) -> None:
        response = self.run_circuit(BELL)
        record = self.store.get(response.result_id)
        self.assertIsNotNone(record)
        for state in response.qubit_states:
            src = state.derived_from
            self.assertEqual(src.result_id, response.result_id)
            self.assertEqual(src.circuit_hash, circuit_hash(BELL))
            self.assertEqual(src.execution_id, record.payload["execution_id"])
            self.assertEqual((src.backend, src.backend_version), (response.backend, response.backend_version))
            self.assertEqual(src.step_index, len(BELL.ops))  # the whole circuit was applied

    def test_it_is_derived_from_the_stored_statevector_not_from_anything_else(self) -> None:
        response = self.run_circuit(BELL)
        record = self.store.get(response.result_id)
        # Rebuild the view from the STORED record: identical to what the response carried.
        again = final_state_qubit_states(record, BELL)
        self.assertEqual([s.model_dump() for s in again], [s.model_dump() for s in response.qubit_states])

    def test_agrees_with_the_traces_final_step_two_routes_to_the_same_state(self) -> None:
        for circuit in (H0, PLUS_I, BELL, PRODUCT, GHZ3):
            with self.subTest(n=circuit.num_qubits, ops=len(circuit.ops)):
                run = self.run_circuit(circuit).qubit_states
                trace = app_module.execute_trace(TraceRequest(circuit=circuit))
                final = trace.steps[-1].qubit_states
                self.assertEqual(len(run), len(final))
                for a, b in zip(run, final):
                    self.assertEqual((a.qubit, a.status), (b.qubit, b.status))
                    for axis in "xyz":
                        self.assertAlmostEqual(getattr(a.bloch, axis), getattr(b.bloch, axis), delta=TOL)
                    self.assertAlmostEqual(a.purity, b.purity, delta=TOL)
                    self.assertEqual(a.entangled_with_rest, b.entangled_with_rest)

    def test_the_three_simulators_agree_on_the_view(self) -> None:
        reference = self.run_circuit(BELL).qubit_states
        for backend in ("cirq", "pennylane"):
            try:
                other = self.run_circuit(BELL, backend=backend).qubit_states
            except Exception as exc:  # a backend that is not installed here is not a failure of this feature
                self.skipTest(f"{backend} unavailable: {exc}")
            self.assertEqual(len(other), len(reference))
            for a, b in zip(reference, other):
                for axis in "xyz":
                    self.assertAlmostEqual(getattr(a.bloch, axis), getattr(b.bloch, axis), delta=1e-6)
                self.assertEqual(a.entangled_with_rest, b.entangled_with_rest)


class TestWhatHasNoState(StateViewCase):
    def test_a_shots_run_has_no_state_view(self) -> None:
        response = self.run_circuit(BELL_MEASURED, mode="shots", shots=64)
        self.assertEqual(response.qubit_states, [])
        self.assertNotIn("statevector", response.payload)

    def test_a_circuit_with_measurements_in_statevector_mode_still_derives_from_its_one_collapsed_state(self) -> None:
        response = self.run_circuit(BELL_MEASURED)
        # The collapsed state is a product state, so each qubit is pure: this is what the stored statevector says, and it
        # is the frontend's job (not this layer's) to label it "one collapsed state".
        self.assertEqual(len(response.qubit_states), 2)
        for state in response.qubit_states:
            self.assertEqual(state.status, "OK")
            self.assertAlmostEqual(state.purity, 1.0, delta=TOL)

    def test_a_record_with_no_statevector_gives_nothing_rather_than_a_zero_vector(self) -> None:
        record = ProvenanceRecord.new(
            circuit_hash="0" * 64,
            backend="qiskit-aer",
            backend_version="x",
            execution_mode="shots",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED,
            payload={"execution_id": "e", "probabilities": {"0": 1.0}, "counts": {"0": 10}, "shots": 10},
        )
        self.assertEqual(final_state_qubit_states(record, H0), [])

    def test_a_statevector_record_whose_payload_has_no_statevector_gives_nothing(self) -> None:
        record = ProvenanceRecord.new(
            circuit_hash="0" * 64,
            backend="qiskit-aer",
            backend_version="x",
            execution_mode="statevector",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED,
            payload={"execution_id": "e"},  # an old or damaged record: there is no state to read
        )
        self.assertEqual(final_state_qubit_states(record, H0), [])

    def test_a_malformed_stored_state_is_unusable_with_a_reason_and_no_numbers(self) -> None:
        def record_with(statevector):
            return ProvenanceRecord.new(
                circuit_hash="0" * 64,
                backend="qiskit-aer",
                backend_version="x",
                execution_mode="statevector",
                provenance_class=ProvenanceClass.SIMULATION,
                verification_status=ExecutionStatus.STATE_CHECKED,
                payload={"execution_id": "e", "statevector": statevector},
            )

        bad_states = {
            "not normalised": [[1.0, 0.0], [1.0, 0.0]],
            "wrong length": [[1.0, 0.0], [0.0, 0.0], [0.0, 0.0]],
            "not finite": [[math.nan, 0.0], [0.0, 0.0]],
        }
        for name, state in bad_states.items():
            with self.subTest(name):
                (qubit,) = final_state_qubit_states(record_with(state), H0)
                self.assertEqual(qubit.status, "UNUSABLE")
                self.assertTrue(qubit.reason)
                self.assertIsNone(qubit.bloch)
                self.assertIsNone(qubit.purity)
                self.assertIsNone(qubit.entangled_with_rest)


class TestNoClientInfluence(StateViewCase):
    def test_the_request_has_no_field_through_which_a_client_could_supply_a_state(self) -> None:
        self.assertEqual(set(ExecuteRequest.model_fields), {"circuit", "mode", "shots", "backend"})
        for bad in ("qubit_states", "bloch", "statevector", "purity"):
            with self.subTest(bad), self.assertRaises(ValidationError):
                ExecuteRequest.model_validate({"circuit": H0.canonical_dict(), "mode": "statevector", bad: {"x": 0, "y": 0, "z": 1}})

    def test_the_values_follow_the_circuit_and_nothing_else(self) -> None:
        a = self.run_circuit(H0).qubit_states[0]
        b = self.run_circuit(X0).qubit_states[0]
        self.assertNotEqual((a.bloch.x, a.bloch.z), (b.bloch.x, b.bloch.z))

    def test_the_stored_payload_is_unchanged_by_the_view(self) -> None:
        response = self.run_circuit(BELL)
        record = self.store.get(response.result_id)
        self.assertEqual(record.payload, response.payload)
        self.assertNotIn("qubit_states", record.payload)  # derived on the way out, never stored beside the state it came from


if __name__ == "__main__":
    unittest.main()
