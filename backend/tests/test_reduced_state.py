"""Per-qubit reduced state (Bloch vector, purity, provenance) and the polar amplitude view, server-side.

The reference values here do NOT come from the code under test: hand-written states whose answer is known on paper
(a Bell pair is maximally mixed, a product state is pure), and Qiskit's own ``Statevector.expectation_value`` and
``partial_trace`` purity as an independent oracle on random circuits. The provenance checks resolve every ``result_id``
against the real provenance store and recompute from the STORED statevector.
"""

from __future__ import annotations

import cmath
import itertools
import json
import math
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import TraceRequest, TraceStepResponse
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.amplitude_view import PHASE_DEFINED_ABOVE, BasisAmplitude, derive_amplitude_view
from qentor.execution.bloch import BlochSource, bloch_coordinates
from qentor.execution.reduced_state import (
    ENTANGLEMENT_TOLERANCE,
    REDUCED_STATE_METHOD,
    QubitReducedState,
    derive_qubit_states,
    qubit_reduced_state,
)
from qentor.execution.trace import trace_circuit
from qentor.provenance.store import ProvenanceStore
from tests.trace_fakes import ScriptedAdapter, make_result

S = 1 / math.sqrt(2)
SOURCE = BlochSource(step_index=3, result_id="res_x", execution_id="exec_x", circuit_hash="hash_x", backend="b", backend_version="1")


def gate(name: str, targets, controls=(), params=()) -> GateOp:
    return GateOp(gate=name, targets=list(targets), controls=list(controls), params=list(params))


def circ(n: int, *ops: GateOp) -> Circuit:
    return Circuit(num_qubits=n, num_clbits=0, ops=list(ops))


def states(statevector, n):
    return derive_qubit_states(statevector, n, source=SOURCE)


def xyz(q: QubitReducedState) -> tuple[float, float, float]:
    return (q.bloch.x, q.bloch.y, q.bloch.z)


def assertVector(test: unittest.TestCase, got, expected, tol=1e-12, msg=None) -> None:
    for g_, e_ in zip(got, expected):
        test.assertAlmostEqual(g_, e_, delta=tol, msg=msg)


BELL_STATE = [[S, 0.0], [0.0, 0.0], [0.0, 0.0], [S, 0.0]]
GHZ3 = [[S, 0.0]] + [[0.0, 0.0]] * 6 + [[S, 0.0]]


class TestTheReducedStateOfKnownStates(unittest.TestCase):
    def test_each_qubit_of_a_bell_pair_is_maximally_mixed_and_entangled(self) -> None:
        for q in states(BELL_STATE, 2):
            self.assertEqual(q.status, "OK")
            assertVector(self, xyz(q), (0.0, 0.0, 0.0))
            self.assertAlmostEqual(q.bloch_length, 0.0, places=12)
            self.assertAlmostEqual(q.purity, 0.5, places=12)
            self.assertIs(q.entangled_with_rest, True)

    def test_all_three_qubits_of_ghz_are_maximally_mixed(self) -> None:
        result = states(GHZ3, 3)
        self.assertEqual([q.qubit for q in result], [0, 1, 2])
        for q in result:
            self.assertAlmostEqual(q.bloch_length, 0.0, places=12)
            self.assertAlmostEqual(q.purity, 0.5, places=12)
            self.assertIs(q.entangled_with_rest, True)

    def test_a_product_state_gives_each_qubit_its_own_unit_vector(self) -> None:
        # q0 = |+>, q1 = |0>  ->  index = q1*2 + q0: amplitudes on |00> and |01> (q0 = 1) equal.
        product = [[S, 0.0], [S, 0.0], [0.0, 0.0], [0.0, 0.0]]
        q0, q1 = states(product, 2)
        assertVector(self, xyz(q0), (1.0, 0.0, 0.0))
        assertVector(self, xyz(q1), (0.0, 0.0, 1.0))
        for q in (q0, q1):
            self.assertAlmostEqual(q.bloch_length, 1.0, places=12)
            self.assertAlmostEqual(q.purity, 1.0, places=12)
            self.assertIs(q.entangled_with_rest, False)

    def test_the_qubit_index_is_the_bit_position_not_the_position_in_the_list(self) -> None:
        # |100>: q2 = 1, q1 = q0 = 0. Only q2 points down.
        basis = [[0.0, 0.0]] * 8
        basis[0b100] = [1.0, 0.0]
        zs = [xyz(q)[2] for q in states(basis, 3)]
        assertVector(self, zs, (1.0, 1.0, -1.0))
        basis = [[0.0, 0.0]] * 8
        basis[0b001] = [1.0, 0.0]
        assertVector(self, [xyz(q)[2] for q in states(basis, 3)], (-1.0, 1.0, 1.0))

    def test_phase_moves_the_vector_round_the_equator(self) -> None:
        plus_i = [[S, 0.0], [0.0, S]]  # (|0> + i|1>)/sqrt2 -> +y
        minus = [[S, 0.0], [-S, 0.0]]  # -> -x
        assertVector(self, xyz(states(plus_i, 1)[0]), (0.0, 1.0, 0.0))
        assertVector(self, xyz(states(minus, 1)[0]), (-1.0, 0.0, 0.0))

    def test_a_partly_entangled_qubit_is_between_the_two_extremes(self) -> None:
        # cos(t)|00> + sin(t)|11>: each qubit has Bloch length |cos 2t| and purity (1 + cos^2 2t)/2.
        t = 0.3
        c, s = math.cos(t), math.sin(t)
        q0, q1 = states([[c, 0.0], [0.0, 0.0], [0.0, 0.0], [s, 0.0]], 2)
        for q in (q0, q1):
            self.assertAlmostEqual(q.bloch_length, abs(math.cos(2 * t)), places=12)
            self.assertAlmostEqual(q.purity, (1 + math.cos(2 * t) ** 2) / 2, places=12)
            self.assertIs(q.entangled_with_rest, True)
            self.assertAlmostEqual(q.bloch.z, math.cos(2 * t), places=12)

    def test_a_single_qubit_register_agrees_with_the_single_qubit_bloch_vector(self) -> None:
        rng = random.Random(3)
        for _ in range(20):
            a, b = complex(rng.gauss(0, 1), rng.gauss(0, 1)), complex(rng.gauss(0, 1), rng.gauss(0, 1))
            norm = math.sqrt(abs(a) ** 2 + abs(b) ** 2)
            raw = [[a.real / norm, a.imag / norm], [b.real / norm, b.imag / norm]]
            (only,) = states(raw, 1)
            assertVector(self, xyz(only), bloch_coordinates(raw), tol=1e-12)
            self.assertAlmostEqual(only.purity, 1.0, places=12)
            self.assertIs(only.entangled_with_rest, False)

    def test_a_global_phase_changes_nothing(self) -> None:
        rotated = [[(amp[0] + 1j * amp[1]) * cmath.exp(0.77j)] for amp in GHZ3]
        rotated = [[z[0].real, z[0].imag] for z in rotated]
        for a, b in zip(states(GHZ3, 3), states(rotated, 3)):
            assertVector(self, xyz(a), xyz(b))
            self.assertAlmostEqual(a.purity, b.purity, places=12)

    def test_values_are_not_rounded_or_snapped(self) -> None:
        nearly = [[1.0, 0.0], [1e-16, 0.0]]
        self.assertNotEqual(states(nearly, 1)[0].bloch.x, 0.0)  # a 1e-16 residue stays a residue

    def test_a_qubit_is_entangled_only_when_its_purity_drops_below_one_by_more_than_the_tolerance(self) -> None:
        near = 1e-7  # a tiny, real entanglement: 1 - purity ~ 2e-14 is under tolerance, so not flagged
        c, s = math.cos(near), math.sin(near)
        tiny = states([[c, 0.0], [0.0, 0.0], [0.0, 0.0], [s, 0.0]], 2)[0]
        self.assertLess(1.0 - tiny.purity, ENTANGLEMENT_TOLERANCE)
        self.assertIs(tiny.entangled_with_rest, False)


class TestIdentitiesBetweenTheReportedNumbers(unittest.TestCase):
    def test_purity_equals_one_plus_length_squared_over_two_on_random_states(self) -> None:
        rng = random.Random(11)
        for n in (2, 3, 4, 5):
            for _ in range(10):
                raw = [complex(rng.gauss(0, 1), rng.gauss(0, 1)) for _ in range(2**n)]
                norm = math.sqrt(sum(abs(z) ** 2 for z in raw))
                vec = [[z.real / norm, z.imag / norm] for z in raw]
                for q in states(vec, n):
                    self.assertEqual(q.status, "OK")
                    self.assertAlmostEqual(q.purity, (1 + q.bloch_length**2) / 2, places=12)
                    self.assertLessEqual(q.bloch_length, 1 + 1e-12)
                    self.assertGreaterEqual(q.purity, 0.5 - 1e-12)


class TestAgainstAnIndependentOracle(unittest.TestCase):
    """Qiskit's Pauli expectation values and partial-trace purity, on random circuits run through real Aer."""

    def setUp(self) -> None:
        try:
            AerAdapter().run(circ(1), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")

    @staticmethod
    def random_circuit(rng: random.Random) -> Circuit:
        n = rng.randint(2, 5)
        ops: list[GateOp] = []
        for _ in range(rng.randint(3, 14)):
            kind = rng.choice(["h", "x", "s", "t", "rx", "ry", "rz", "cx", "cz", "cp", "swap", "ccx"])
            qs = list(range(n))
            rng.shuffle(qs)
            angle = rng.uniform(-3, 3)
            if kind in ("h", "x", "s", "t"):
                ops.append(gate(kind, [qs[0]]))
            elif kind in ("rx", "ry", "rz"):
                ops.append(gate(kind, [qs[0]], params=[angle]))
            elif kind in ("cx", "cz"):
                ops.append(gate(kind, [qs[1]], [qs[0]]))
            elif kind == "cp":
                ops.append(gate("cp", [qs[1]], [qs[0]], [angle]))
            elif kind == "swap":
                ops.append(gate("swap", [qs[0], qs[1]]))
            elif n >= 3:
                ops.append(gate("ccx", [qs[2]], [qs[0], qs[1]]))
        return Circuit(num_qubits=n, num_clbits=0, ops=ops)

    def test_every_qubit_of_every_random_state_matches_qiskit(self) -> None:
        from qiskit.quantum_info import DensityMatrix, Pauli, Statevector, partial_trace

        rng = random.Random(20260930)
        checked = 0
        for _ in range(40):
            circuit = self.random_circuit(rng)
            raw = AerAdapter().run(circuit, "statevector").statevector
            state = Statevector([complex(re, im) for re, im in raw])
            for q in states(raw, circuit.num_qubits):
                expected = tuple(float(state.expectation_value(Pauli(p), [q.qubit]).real) for p in "XYZ")
                assertVector(self, xyz(q), expected, tol=1e-9, msg=f"qubit {q.qubit} of {circuit.canonical_json()}")
                others = [i for i in range(circuit.num_qubits) if i != q.qubit]
                reduced = partial_trace(DensityMatrix(state), others)
                self.assertAlmostEqual(q.purity, float(reduced.purity().real), places=9)
                checked += 1
        self.assertGreater(checked, 100)

    def test_the_other_simulators_give_the_same_qubit_states(self) -> None:
        from qentor.execution.cirq_adapter import CirqAdapter
        from qentor.execution.pennylane_adapter import PennyLaneAdapter

        rng = random.Random(5)
        for _ in range(12):
            circuit = self.random_circuit(rng)
            reference = states(AerAdapter().run(circuit, "statevector").statevector, circuit.num_qubits)
            for adapter in (CirqAdapter(), PennyLaneAdapter()):
                got = states(adapter.run(circuit, "statevector").statevector, circuit.num_qubits)
                for a, b in zip(reference, got):
                    assertVector(self, xyz(a), xyz(b), tol=1e-9, msg=adapter.name)
                    self.assertAlmostEqual(a.purity, b.purity, places=9, msg=adapter.name)

    def test_cp_entangles_exactly_when_its_angle_is_not_a_multiple_of_two_pi(self) -> None:
        from qiskit.quantum_info import Pauli, Statevector

        for theta in (0.0, 0.4, math.pi / 2, math.pi, 2 * math.pi):
            circuit = circ(2, gate("h", [0]), gate("h", [1]), gate("cp", [1], [0], [theta]))
            raw = AerAdapter().run(circuit, "statevector").statevector
            for q in states(raw, 2):
                # <X> of either qubit of (|+>|+> after CP(theta)) is (1 + cos theta) / 2
                self.assertAlmostEqual(q.bloch.x, (1 + math.cos(theta)) / 2, places=9)
                expected = Statevector([complex(*a) for a in raw]).expectation_value(Pauli("X"), [q.qubit]).real
                self.assertAlmostEqual(q.bloch.x, expected, places=9)
                self.assertIs(q.entangled_with_rest, not math.isclose(math.cos(theta), 1.0, abs_tol=1e-7), f"theta={theta}")
        # CP(pi) on |+>|+> is the graph state: both qubits maximally mixed.
        graph = states(AerAdapter().run(circ(2, gate("h", [0]), gate("h", [1]), gate("cp", [1], [0], [math.pi])), "statevector").statevector, 2)
        for q in graph:
            self.assertAlmostEqual(q.bloch_length, 0.0, places=9)
            self.assertAlmostEqual(q.purity, 0.5, places=9)


class TestUnusableCasesAreExplicit(unittest.TestCase):
    def assertUnusable(self, q: QubitReducedState, fragment: str) -> None:
        self.assertEqual(q.status, "UNUSABLE")
        self.assertIn(fragment, q.reason or "")
        self.assertEqual((q.bloch, q.bloch_length, q.purity, q.entangled_with_rest), (None, None, None, None))
        self.assertEqual(q.derived_from, SOURCE)  # still tied to its step

    def test_no_state(self) -> None:
        for q in states(None, 2):
            self.assertUnusable(q, "no statevector")

    def test_wrong_number_of_amplitudes(self) -> None:
        for q in states([[1.0, 0.0], [0.0, 0.0], [0.0, 0.0]], 2):
            self.assertUnusable(q, "3 amplitudes")

    def test_not_normalised(self) -> None:
        for q in states([[0.5, 0.0], [0.5, 0.0]], 1):
            self.assertUnusable(q, "squared norm")

    def test_non_finite_or_non_numeric_components(self) -> None:
        for bad in (float("nan"), float("inf")):
            self.assertUnusable(states([[bad, 0.0], [0.0, 0.0]], 1)[0], "finite")
        self.assertUnusable(states([["x", 0.0], [0.0, 0.0]], 1)[0], "not a number")
        self.assertUnusable(states([[True, 0.0], [0.0, 0.0]], 1)[0], "not a number")
        self.assertUnusable(states([[1.0], [0.0, 0.0]], 1)[0], "[re, im]")

    def test_qubit_out_of_range(self) -> None:
        self.assertUnusable(qubit_reduced_state(BELL_STATE, 2, 2, source=SOURCE), "outside a 2-qubit register")
        self.assertUnusable(qubit_reduced_state(BELL_STATE, -1, 2, source=SOURCE), "outside a 2-qubit register")

    def test_a_derived_qubit_state_that_is_not_a_valid_density_matrix_is_unusable_not_shown(self) -> None:
        """A normalised state cannot produce one mathematically, so this simulates numerical corruption in the
        reduction itself and requires the guard to refuse it (explicitly) instead of reporting impossible numbers."""
        from qentor.execution import reduced_state

        corrupt = [
            ((0.9, 0.9, 0j), "purity"),  # purity 1.62: above 1
            ((0.3, 0.0, 0j), "purity"),  # purity 0.09: below 1/2
            ((0.25, 0.25, 0.55 + 0j), "Bloch vector"),  # purity 0.73 is in range but the vector is 1.1 long
        ]
        for (rho00, rho11, rho01), fragment in corrupt:
            with self.subTest(rho=(rho00, rho11, rho01)), patch.object(reduced_state, "_reduced_density", return_value=(rho00, rho11, rho01)):
                (q,) = states([[1.0, 0.0], [0.0, 0.0]], 1)
                self.assertUnusable(q, fragment)
        # ...while a valid maximally mixed qubit is still reported, so the guard is not simply refusing everything
        with patch.object(reduced_state, "_reduced_density", return_value=(0.5, 0.5, 0j)):
            (mixed,) = states([[1.0, 0.0], [0.0, 0.0]], 1)
        self.assertEqual(mixed.status, "OK")
        self.assertAlmostEqual(mixed.purity, 0.5)

    def test_a_register_with_no_qubits_has_no_entries(self) -> None:
        self.assertEqual(states([[1.0, 0.0]], 0), [])

    def test_an_unusable_entry_never_carries_a_number(self) -> None:
        dumped = states([[0.5, 0.0], [0.5, 0.0]], 1)[0].model_dump()
        self.assertEqual({k: dumped[k] for k in ("bloch", "bloch_length", "purity", "entangled_with_rest")}, dict.fromkeys(("bloch", "bloch_length", "purity", "entangled_with_rest")))


class TestProvenanceOfEveryQubit(unittest.TestCase):
    def test_each_entry_names_its_source_and_the_method(self) -> None:
        for q in states(BELL_STATE, 2):
            self.assertEqual(q.derived_from, SOURCE)
            self.assertEqual(q.method, REDUCED_STATE_METHOD)


class TestTheTraceCarriesThemPerStep(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(circ(1), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")

    def run_trace(self, circuit: Circuit):
        return trace_circuit(
            circuit, AerAdapter(), max_qubits=8, max_operations=200, record_execution=lambda result, h: f"res_{h[:8]}"
        )

    def test_every_step_has_one_entry_per_qubit_each_tied_to_that_step(self) -> None:
        circuit = circ(3, gate("h", [0]), gate("cx", [1], [0]), gate("cx", [2], [1]), gate("cp", [0], [2], [0.6]))
        trace = self.run_trace(circuit)
        self.assertEqual(len(trace.steps), 5)
        for step in trace.steps:
            self.assertEqual([q.qubit for q in step.qubit_states], [0, 1, 2])
            self.assertEqual(len(step.amplitude_view), 8)
            for q in step.qubit_states:
                self.assertEqual(q.derived_from.step_index, step.step_index)
                self.assertEqual(q.derived_from.result_id, step.result_id)
                self.assertEqual(q.derived_from.execution_id, step.execution_id)
                self.assertEqual(q.derived_from.circuit_hash, step.prefix_circuit_hash)
                self.assertEqual((q.derived_from.backend, q.derived_from.backend_version), (trace.backend, trace.backend_version))

    def test_the_story_of_a_ghz_circuit_step_by_step(self) -> None:
        circuit = circ(3, gate("h", [0]), gate("cx", [1], [0]), gate("cx", [2], [1]))
        trace = self.run_trace(circuit)
        lengths = [[round(q.bloch_length, 9) for q in step.qubit_states] for step in trace.steps]
        self.assertEqual(lengths[0], [1.0, 1.0, 1.0])  # |000>
        self.assertEqual(lengths[1], [1.0, 1.0, 1.0])  # H on q0: |+>|0>|0>, still a product
        self.assertEqual(lengths[2], [0.0, 0.0, 1.0])  # CX q0->q1: Bell pair on q0,q1; q2 untouched
        self.assertEqual(lengths[3], [0.0, 0.0, 0.0])  # CX q1->q2: GHZ
        self.assertEqual([[q.entangled_with_rest for q in s.qubit_states] for s in trace.steps][2], [True, True, False])

    def test_a_single_qubit_trace_has_both_the_old_vector_and_the_new_entry_and_they_agree(self) -> None:
        trace = self.run_trace(circ(1, gate("h", [0]), gate("s", [0])))
        for step in trace.steps:
            (only,) = step.qubit_states
            assertVector(self, xyz(only), (step.bloch_vector.x, step.bloch_vector.y, step.bloch_vector.z), tol=1e-12)
            self.assertEqual(only.derived_from, step.bloch_vector.derived_from)

    def test_the_values_follow_a_scripted_backend_not_the_gates(self) -> None:
        # A backend that returns a product state after a CX: the per-qubit values must follow the amplitudes.
        product = [[S, 0.0], [S, 0.0], [0.0, 0.0], [0.0, 0.0]]
        adapter = ScriptedAdapter(lambda i, c: make_result(product))
        trace = trace_circuit(circ(2, gate("cx", [1], [0])), adapter, max_qubits=8, max_operations=10)
        for step in trace.steps:
            assertVector(self, xyz(step.qubit_states[0]), (1.0, 0.0, 0.0))
            assertVector(self, xyz(step.qubit_states[1]), (0.0, 0.0, 1.0))
            self.assertEqual([q.entangled_with_rest for q in step.qubit_states], [False, False])


class EndpointCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(circ(1), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        self._tmp = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmp.name) / "reduced.db")
        self._patcher = patch.object(app_module, "_store", self.store)
        self._patcher.start()

    def tearDown(self) -> None:
        self._patcher.stop()
        self.store.close()
        self._tmp.cleanup()

    def trace(self, circuit: Circuit, backend: str = "qiskit-aer"):
        return app_module.execute_trace(TraceRequest(circuit=circuit, backend=backend))


class TestTheEndpointAndItsProvenance(EndpointCase):
    BELL = circ(2, gate("h", [0]), gate("cx", [1], [0]))

    def test_every_qubit_entry_resolves_to_the_stored_record_it_was_derived_from(self) -> None:
        response = self.trace(self.BELL)
        for step in response.steps:
            record = self.store.get(step.provenance.result_id)
            self.assertEqual(record.circuit_hash, step.provenance.circuit_hash)
            for q in step.qubit_states:
                self.assertEqual(q.derived_from.result_id, record.result_id)
                self.assertEqual(q.derived_from.circuit_hash, record.circuit_hash)
                self.assertEqual(q.derived_from.step_index, step.step_index)
            # recompute independently from the STORED statevector, not the response
            stored = record.payload["statevector"]
            for shown, again in zip(step.qubit_states, states(stored, 2)):
                assertVector(self, xyz(shown), xyz(again), tol=1e-12)
                self.assertAlmostEqual(shown.purity, again.purity, places=12)

    def test_the_prefix_circuit_hash_is_the_circuit_cut_off_after_that_step(self) -> None:
        response = self.trace(self.BELL)
        for step in response.steps:
            prefix = circ(2, *self.BELL.ops[: step.step_index])
            self.assertEqual(step.qubit_states[0].derived_from.circuit_hash, circuit_hash(prefix))

    def test_the_bell_steps_over_the_api(self) -> None:
        response = self.trace(self.BELL)
        final = response.steps[-1]
        for q in final.qubit_states:
            self.assertAlmostEqual(q.bloch_length, 0.0, places=9)
            self.assertAlmostEqual(q.purity, 0.5, places=9)
            self.assertIs(q.entangled_with_rest, True)
        # the one-qubit Bloch vector is still absent for the register
        self.assertTrue(all(step.bloch_vector is None for step in response.steps))
        self.assertAlmostEqual(response.steps[0].qubit_states[0].bloch_length, 1.0, places=9)

    def test_the_response_json_has_the_documented_fields(self) -> None:
        dumped = json.loads(self.trace(self.BELL).model_dump_json())
        q = dumped["steps"][2]["qubit_states"][0]
        self.assertEqual(
            set(q), {"qubit", "status", "reason", "bloch", "bloch_length", "purity", "entangled_with_rest", "method", "derived_from"}
        )
        self.assertEqual(set(q["bloch"]), {"x", "y", "z"})
        self.assertEqual(set(q["derived_from"]), {"step_index", "result_id", "execution_id", "circuit_hash", "backend", "backend_version"})
        self.assertEqual(set(dumped["steps"][2]["amplitude_view"][0]), {"magnitude", "probability", "phase"})

    def test_all_three_backends_serve_the_same_qubit_states(self) -> None:
        circuit = circ(3, gate("h", [0]), gate("cp", [1], [0], [1.1]), gate("cx", [2], [1]), gate("ry", [2], params=[0.4]))
        reference = self.trace(circuit, "qiskit-aer")
        for backend in ("cirq", "pennylane"):
            other = self.trace(circuit, backend)
            for a, b in zip(reference.steps, other.steps):
                for qa, qb in zip(a.qubit_states, b.qubit_states):
                    assertVector(self, xyz(qa), xyz(qb), tol=1e-9, msg=backend)
                    self.assertEqual(qb.derived_from.backend, backend)

    def test_a_client_cannot_supply_a_qubit_state(self) -> None:
        for extra in ({"qubit_states": []}, {"amplitude_view": []}, {"bloch": [0, 0, 1]}):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                TraceRequest.model_validate({"circuit": self.BELL.canonical_dict(), **extra})

    def test_the_fields_are_optional_on_the_response_model(self) -> None:
        for name in ("qubit_states", "amplitude_view"):
            self.assertFalse(TraceStepResponse.model_fields[name].is_required())

    def test_no_separate_endpoint_was_added(self) -> None:
        paths = {r.path for r in app_module.app.routes}
        self.assertFalse({p for p in paths if "qubit" in p.lower() or "reduced" in p.lower()})


class TestTheAmplitudeView(unittest.TestCase):
    def test_polar_form_of_known_amplitudes(self) -> None:
        view = derive_amplitude_view([[S, 0.0], [0.0, S], [-S, 0.0], [0.0, 0.0]])
        self.assertAlmostEqual(view[0].phase, 0.0, places=12)
        self.assertAlmostEqual(view[1].phase, math.pi / 2, places=12)
        self.assertAlmostEqual(view[2].phase, math.pi, places=12)
        self.assertIsNone(view[3].phase)  # the angle of zero is undefined: no number is invented
        for v in view[:3]:
            self.assertAlmostEqual(v.magnitude, S, places=12)
            self.assertAlmostEqual(v.probability, 0.5, places=12)
        self.assertEqual((view[3].magnitude, view[3].probability), (0.0, 0.0))

    def test_the_sign_of_the_imaginary_part_sets_the_sign_of_the_phase(self) -> None:
        up, down = derive_amplitude_view([[0.0, 1.0]])[0], derive_amplitude_view([[0.0, -1.0]])[0]
        self.assertAlmostEqual(up.phase, math.pi / 2)
        self.assertAlmostEqual(down.phase, -math.pi / 2)

    def test_magnitude_squared_is_probability_and_probabilities_sum_to_one_on_real_states(self) -> None:
        rng = random.Random(9)
        raw = [complex(rng.gauss(0, 1), rng.gauss(0, 1)) for _ in range(16)]
        norm = math.sqrt(sum(abs(z) ** 2 for z in raw))
        vec = [[z.real / norm, z.imag / norm] for z in raw]
        view = derive_amplitude_view(vec)
        self.assertAlmostEqual(sum(v.probability for v in view), 1.0, places=12)
        for v, z in zip(view, raw):
            self.assertAlmostEqual(v.magnitude**2, v.probability, places=12)
            self.assertAlmostEqual(v.phase, cmath.phase(z), places=12)

    def test_the_threshold_below_which_a_phase_is_not_reported(self) -> None:
        below = math.sqrt(PHASE_DEFINED_ABOVE) * 0.9
        above = math.sqrt(PHASE_DEFINED_ABOVE) * 1.1
        self.assertIsNone(derive_amplitude_view([[below, 0.0]])[0].phase)
        self.assertIsNotNone(derive_amplitude_view([[above, 0.0]])[0].phase)

    def test_a_malformed_state_is_refused_not_repaired(self) -> None:
        for bad in ([[1.0]], [[float("nan"), 0.0]], [[float("inf"), 0.0]], [["a", 0.0]], [[True, 0.0]]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                derive_amplitude_view(bad)

    def test_the_view_model_forbids_extra_fields(self) -> None:
        with self.assertRaises(ValidationError):
            BasisAmplitude.model_validate({"magnitude": 1.0, "probability": 1.0, "phase": 0.0, "extra": 1})


class TestEveryStepOfACpCircuit(EndpointCase):
    def test_amplitude_phases_show_the_cp_phase_on_the_11_state_only(self) -> None:
        theta = 0.9
        response = self.trace(circ(2, gate("h", [0]), gate("h", [1]), gate("cp", [1], [0], [theta])))
        before, after = response.steps[2].amplitude_view, response.steps[3].amplitude_view
        for index in range(3):
            self.assertAlmostEqual(after[index].phase, before[index].phase, places=9)
        self.assertAlmostEqual(after[3].phase - before[3].phase, theta, places=9)
        for b, a in zip(before, after):
            self.assertAlmostEqual(a.probability, b.probability, places=9)  # CP changes phases, never outcome probabilities


if __name__ == "__main__":
    unittest.main()
