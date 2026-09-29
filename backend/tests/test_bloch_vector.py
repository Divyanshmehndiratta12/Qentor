"""Tests for ``qentor.execution.bloch`` and its use in ``trace_circuit``.

Every Bloch vector under test is derived from a state a REAL backend returned
(an Aer trace); nothing here feeds a hand-written state to the production code
except where a test is explicitly about what the function does with a state a
gate could never produce (the trust tests) or an invalid one. Expected
coordinates like (0, 0, +1) are hard-coded — as TEST assertions only; the
production code contains no table of states, gates or coordinates.

An independent numpy implementation (Pauli expectation values <psi|sigma|psi>,
a different route to the same numbers than the production formula) is the
oracle for the "any state" tests.
"""

from __future__ import annotations

import ast
import cmath
import math
import unittest
from pathlib import Path

import numpy as np

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.bloch import (
    BLOCH_METHOD,
    NORM_TOLERANCE,
    BlochSource,
    BlochVector,
    bloch_coordinates,
    derive_bloch_vector,
)
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.execution.trace import TraceBackendFault, trace_circuit

from tests.trace_fakes import ScriptedAdapter, make_result

LIMITS = {"max_qubits": 8, "max_operations": 255}
TOL = 1e-12  # doubles: a backend's ~1e-16 residue is far below this


def circ(num_qubits: int, ops: list[GateOp]) -> Circuit:
    return Circuit(num_qubits=num_qubits, num_clbits=0, ops=ops)


def g(name: str, q: int = 0, **kw) -> GateOp:
    return GateOp(gate=name, targets=[q], **kw)


def pauli_expectations(state) -> tuple[float, float, float]:
    """Independent oracle: <X>, <Y>, <Z> of a single-qubit state via numpy."""
    psi = np.array([complex(re, im) for re, im in state])
    sigma = (
        np.array([[0, 1], [1, 0]], dtype=complex),
        np.array([[0, -1j], [1j, 0]], dtype=complex),
        np.array([[1, 0], [0, -1]], dtype=complex),
    )
    return tuple(float(np.real(np.conj(psi) @ (s @ psi))) for s in sigma)


class AerBlochCase(unittest.TestCase):
    def setUp(self) -> None:
        self.aer = AerAdapter()
        try:
            self.aer.run(circ(1, []), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")

    def trace(self, circuit: Circuit, **kwargs):
        return trace_circuit(circuit, self.aer, **LIMITS, **kwargs)

    def vectors(self, circuit: Circuit) -> list[tuple[float, float, float]]:
        """(x, y, z) for every step of a REAL Aer trace of ``circuit``."""
        trace = self.trace(circuit)
        out = []
        for step in trace.steps:
            self.assertIsNotNone(step.bloch_vector, f"step {step.step_index} has no Bloch vector")
            out.append((step.bloch_vector.x, step.bloch_vector.y, step.bloch_vector.z))
        return out

    def assertVector(self, actual, expected, tol: float = TOL) -> None:
        for got, want, axis in zip(actual, expected, "xyz"):
            self.assertAlmostEqual(got, want, delta=tol, msg=f"{axis}: got {actual}, want {expected}")


class TestNamedStates(AerBlochCase):
    """The eight states of the milestone, each from a real Aer trace."""

    def test_A_zero_is_plus_z(self) -> None:
        self.assertVector(self.vectors(circ(1, []))[0], (0, 0, 1))

    def test_B_one_is_minus_z(self) -> None:
        self.assertVector(self.vectors(circ(1, [g("x")]))[-1], (0, 0, -1))

    def test_C_plus_state_is_plus_x(self) -> None:
        self.assertVector(self.vectors(circ(1, [g("h")]))[-1], (1, 0, 0))

    def test_D_x_then_h_is_the_minus_state_minus_x(self) -> None:
        self.assertVector(self.vectors(circ(1, [g("x"), g("h")]))[-1], (-1, 0, 0))

    def test_E_s_on_plus_is_plus_i_plus_y(self) -> None:
        self.assertVector(self.vectors(circ(1, [g("h"), g("s")]))[-1], (0, 1, 0))

    def test_F_s_dagger_on_plus_is_minus_i_minus_y(self) -> None:
        # The gate set has no sdg; S^dagger = S^3 exactly, and rz(-pi/2) is the
        # same rotation up to a global phase. Both must land on -y.
        self.assertVector(self.vectors(circ(1, [g("h"), g("s"), g("s"), g("s")]))[-1], (0, -1, 0))
        self.assertVector(self.vectors(circ(1, [g("h"), g("rz", params=[-math.pi / 2])]))[-1], (0, -1, 0))

    def test_G_h_then_z_moves_from_plus_x_to_minus_x(self) -> None:
        steps = self.vectors(circ(1, [g("h"), g("z")]))
        self.assertVector(steps[0], (0, 0, 1))
        self.assertVector(steps[1], (1, 0, 0))  # after H
        self.assertVector(steps[2], (-1, 0, 0))  # after Z: relative phase pi flips x

    def test_H_h_z_h_ends_at_minus_z(self) -> None:
        steps = self.vectors(circ(1, [g("h"), g("z"), g("h")]))
        expected = [(0, 0, 1), (1, 0, 0), (-1, 0, 0), (0, 0, -1)]
        self.assertEqual(len(steps), 4)
        for got, want in zip(steps, expected):
            self.assertVector(got, want)


class TestAgainstAnIndependentOracle(AerBlochCase):
    """Beyond the textbook states: arbitrary rotations, checked against numpy
    Pauli expectation values of the SAME backend statevector."""

    CIRCUITS = {
        "ry(0.7)": circ(1, [g("ry", params=[0.7])]),
        "rx(1.1) rz(0.3)": circ(1, [g("rx", params=[1.1]), g("rz", params=[0.3])]),
        "h t ry(2.2) s": circ(1, [g("h"), g("t"), g("ry", params=[2.2]), g("s")]),
        "rx rz ry mix": circ(1, [g("rx", params=[0.4]), g("rz", params=[-1.3]), g("ry", params=[0.9]), g("y")]),
    }

    def test_matches_pauli_expectations_and_has_unit_length(self) -> None:
        for name, circuit in self.CIRCUITS.items():
            trace = self.trace(circuit)
            for step in trace.steps:
                with self.subTest(circuit=name, step=step.step_index):
                    bloch = step.bloch_vector
                    self.assertVector((bloch.x, bloch.y, bloch.z), pauli_expectations(step.statevector))
                    self.assertAlmostEqual(math.sqrt(bloch.x**2 + bloch.y**2 + bloch.z**2), 1.0, delta=1e-9)

    def test_full_precision_is_preserved_not_rounded_for_display(self) -> None:
        z = self.vectors(self.CIRCUITS["ry(0.7)"])[-1][2]
        self.assertAlmostEqual(z, math.cos(0.7), delta=TOL)  # ry(theta)|0> has z = cos(theta)
        self.assertNotEqual(z, round(z, 6))
        self.assertNotEqual(z, round(z, 12))


class TestNumericalRobustness(unittest.TestCase):
    """The backend's own ~1e-16 residue (real values from the H-Z-H trace)."""

    RESIDUE = [[2.220446049250313e-16, 6.123233995736765e-17], [1.0, -6.123233995736766e-17]]

    def test_tiny_residues_do_not_destabilise_the_result(self) -> None:
        x, y, z = bloch_coordinates(self.RESIDUE)
        for value in (x, y, z):
            self.assertTrue(math.isfinite(value))
        self.assertAlmostEqual(z, -1.0, delta=1e-15)
        self.assertLess(abs(x), 1e-15)
        self.assertLess(abs(y), 1e-15)

    def test_residues_are_not_snapped_to_zero(self) -> None:
        x, _, _ = bloch_coordinates(self.RESIDUE)
        self.assertNotEqual(x, 0.0)  # no aggressive rounding: ~4.4e-16 stays ~4.4e-16
        self.assertAlmostEqual(x, 4.440892098500626e-16, delta=1e-25)

    def test_a_real_h_z_h_trace_is_finite_and_tight(self) -> None:
        aer = AerAdapter()
        try:
            trace = trace_circuit(circ(1, [g("h"), g("z"), g("h")]), aer, **LIMITS)
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        final = trace.steps[-1].bloch_vector
        self.assertAlmostEqual(final.z, -1.0, delta=1e-15)
        self.assertLess(abs(final.x) + abs(final.y), 1e-15)


class TestGlobalPhaseInvariance(AerBlochCase):
    def test_real_backend_states_that_differ_by_global_phase_have_the_same_bloch_vector(self) -> None:
        """rz(pi/2) and s are the same rotation up to a global phase e^{-i pi/4}:
        Aer returns visibly DIFFERENT amplitudes for them, one Bloch vector."""
        via_s = self.trace(circ(1, [g("h"), g("s")])).steps[-1]
        via_rz = self.trace(circ(1, [g("h"), g("rz", params=[math.pi / 2])])).steps[-1]

        differ = max(abs(complex(*a) - complex(*b)) for a, b in zip(via_s.statevector, via_rz.statevector))
        self.assertGreater(differ, 0.1, "the two raw states should genuinely differ by a phase")
        # ...and the phase between them is one global factor:
        ratios = [complex(*b) / complex(*a) for a, b in zip(via_s.statevector, via_rz.statevector)]
        self.assertAlmostEqual(abs(ratios[0] - ratios[1]), 0.0, delta=1e-12)

        for got, want in zip(
            (via_rz.bloch_vector.x, via_rz.bloch_vector.y, via_rz.bloch_vector.z),
            (via_s.bloch_vector.x, via_s.bloch_vector.y, via_s.bloch_vector.z),
        ):
            self.assertAlmostEqual(got, want, delta=TOL)

    def test_multiplying_a_backend_state_by_any_global_phase_changes_nothing(self) -> None:
        trace = self.trace(circ(1, [g("rx", params=[0.4]), g("rz", params=[-1.3]), g("ry", params=[0.9])]))
        for step in trace.steps:
            base = bloch_coordinates(step.statevector)
            for phi in (0.0, 0.3, math.pi / 2, math.pi, -2.1, 5.9):
                phase = cmath.exp(1j * phi)
                rotated = [[(complex(*a) * phase).real, (complex(*a) * phase).imag] for a in step.statevector]
                with self.subTest(step=step.step_index, phi=phi):
                    for got, want in zip(bloch_coordinates(rotated), base):
                        self.assertAlmostEqual(got, want, delta=1e-12)

    def test_relative_phase_is_NOT_ignored(self) -> None:
        """|+> and |-> differ only by a RELATIVE phase (pi on |1>): different
        Bloch vectors. Global-phase invariance must not swallow this."""
        plus = self.trace(circ(1, [g("h")])).steps[-1].bloch_vector
        minus = self.trace(circ(1, [g("h"), g("z")])).steps[-1].bloch_vector
        self.assertAlmostEqual(plus.x, 1.0, delta=TOL)
        self.assertAlmostEqual(minus.x, -1.0, delta=TOL)
        # A relative phase of pi/2 (S) lands on a third axis entirely.
        plus_i = self.trace(circ(1, [g("h"), g("s")])).steps[-1].bloch_vector
        self.assertAlmostEqual(plus_i.y, 1.0, delta=TOL)


class TestMultiQubitStatesHaveNoBlochVector(AerBlochCase):
    def test_bell_trace_has_none_for_initial_after_h_and_after_cx(self) -> None:
        bell = circ(2, [g("h"), GateOp(gate="cx", controls=[0], targets=[1])])
        trace = self.trace(bell)

        self.assertEqual(len(trace.steps), 3)
        for step in trace.steps:
            self.assertIsNone(step.bloch_vector, f"Bell step {step.step_index} must not get a Bloch vector")
            self.assertEqual(len(step.statevector), 4)  # the state itself is still reported in full

    def test_even_an_unentangled_two_or_three_qubit_state_gets_none(self) -> None:
        """No per-qubit (reduced-state) abstraction exists, so nothing is
        invented — not even where a per-qubit vector would be well defined."""
        for name, circuit in {
            "2q product |+>|0>": circ(2, [g("h")]),
            "2q |0>|1>": circ(2, [g("x", 1)]),
            "3q ghz-ish": circ(3, [g("h"), GateOp(gate="cx", controls=[0], targets=[1])]),
            "3q untouched": circ(3, []),
        }.items():
            with self.subTest(circuit=name):
                self.assertTrue(all(step.bloch_vector is None for step in self.trace(circuit).steps))

    def test_the_bloch_function_itself_refuses_a_multi_qubit_state(self) -> None:
        s = 2**-0.5
        multi_qubit_states = {
            "bell": [[s, 0.0], [0.0, 0.0], [0.0, 0.0], [s, 0.0]],
            "four equal amplitudes": [[0.5, 0.0]] * 4,
            # The next two have a FIRST PAIR of amplitudes that is itself
            # normalised, so a function that quietly looked only at
            # statevector[:2] would return a plausible-looking (and wrong)
            # vector for them. They must be refused for having the wrong size.
            "2q product (|00>+|01>)/sqrt2": [[s, 0.0], [s, 0.0], [0.0, 0.0], [0.0, 0.0]],
            "2q |00> exactly": [[1.0, 0.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]],
            "3q |000> exactly": [[1.0, 0.0]] + [[0.0, 0.0]] * 7,
            "3q |+>|00>": [[s, 0.0], [s, 0.0]] + [[0.0, 0.0]] * 6,
        }
        for name, state in multi_qubit_states.items():
            with self.subTest(state=name):
                self.assertIsNone(bloch_coordinates(state))
                self.assertIsNone(derive_bloch_vector(state, source=_SOURCE))
        self.assertIsNone(bloch_coordinates([[1.0, 0.0]] * 1))  # one amplitude: not a qubit either


class TestTrust(AerBlochCase):
    def test_coordinates_follow_the_returned_amplitudes_not_the_gate_names(self) -> None:
        """A backend returning a state NO gate sequence here would produce. If
        the coordinates came from gate names / textbook answers they would be
        the X gate's (0, 0, -1); they must instead follow the amplitudes."""
        state = [[0.6, 0.0], [0.0, 0.8]]  # 0.6|0> + 0.8i|1>
        adapter = ScriptedAdapter(lambda i, c: make_result(state))

        trace = trace_circuit(circ(1, [g("x")]), adapter, **LIMITS)

        for step in trace.steps:
            self.assertVector(
                (step.bloch_vector.x, step.bloch_vector.y, step.bloch_vector.z), (0.0, 0.96, -0.28)
            )

    def test_an_h_gate_whose_backend_returned_zero_gets_plus_z_not_plus_x(self) -> None:
        adapter = ScriptedAdapter(lambda i, c: make_result([[1.0, 0.0], [0.0, 0.0]]))
        trace = trace_circuit(circ(1, [g("h")]), adapter, **LIMITS)  # "textbook" H|0> would be +x
        final = trace.steps[-1].bloch_vector
        self.assertVector((final.x, final.y, final.z), (0, 0, 1))

    def test_no_bloch_is_computed_from_gate_information(self) -> None:
        """bloch.py takes a statevector and nothing about the circuit. Checked on
        the parsed code (imports, names, attributes) so docstrings and comments
        that mention gates don't count."""
        source = (Path(__file__).resolve().parents[1] / "qentor" / "execution" / "bloch.py").read_text(encoding="utf-8")
        tree = ast.parse(source)

        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        self.assertFalse({m for m in imported if m.startswith("qentor.circuit")}, "bloch.py must not import the circuit model")
        self.assertFalse(
            {m for m in imported if m.split(".")[0] in {"numpy", "qiskit", "qiskit_aer", "cirq", "pennylane", "scipy"}},
            "bloch.py must not import a simulator or numeric library",
        )

        used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {
            n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)
        }
        self.assertFalse({"GateName", "GateOp", "Circuit", "gate", "ops", "targets"} & used)

    def test_trace_feeds_the_bloch_function_only_the_returned_statevector(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "qentor" / "execution" / "trace.py").read_text(encoding="utf-8")
        calls = [n for n in ast.walk(ast.parse(source)) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "derive_bloch_vector"]
        self.assertEqual(len(calls), 1)
        self.assertEqual([ast.unparse(a) for a in calls[0].args], ["result.statevector"])
        self.assertEqual([k.arg for k in calls[0].keywords], ["source"])

    def test_invalid_states_have_no_bloch_vector(self) -> None:
        bad_states = {
            "not normalised (0.5)": [[0.5, 0.0], [0.5, 0.0]],
            "not normalised (2.0)": [[1.0, 0.0], [1.0, 0.0]],
            "just outside tolerance": [[math.sqrt(1 - 2e-9), 0.0], [0.0, 0.0]],
            "NaN": [[float("nan"), 0.0], [0.0, 0.0]],
            "infinity": [[float("inf"), 0.0], [0.0, 0.0]],
            "one amplitude": [[1.0, 0.0]],
            "empty": [],
            "amplitude with 1 component": [[1.0], [0.0, 0.0]],
            "amplitude with 3 components": [[1.0, 0.0, 0.0], [0.0, 0.0]],
            "non-numeric": [["1", 0.0], [0.0, 0.0]],
            "boolean masquerading as a number": [[True, 0.0], [0.0, 0.0]],
            "None component": [[None, 0.0], [0.0, 0.0]],
        }
        for name, state in bad_states.items():
            with self.subTest(state=name):
                self.assertIsNone(bloch_coordinates(state))
                self.assertIsNone(derive_bloch_vector(state, source=_SOURCE))

    def test_missing_state_has_no_bloch_vector(self) -> None:
        self.assertIsNone(bloch_coordinates(None))
        self.assertIsNone(derive_bloch_vector(None, source=_SOURCE))

    def test_a_state_just_inside_tolerance_is_accepted(self) -> None:
        self.assertIsNotNone(bloch_coordinates([[math.sqrt(1 - 0.5 * NORM_TOLERANCE), 0.0], [0.0, 0.0]]))

    def test_an_invalid_backend_state_stops_the_trace_so_no_step_or_bloch_exists(self) -> None:
        for name, state in {
            "unnormalised": [[0.5, 0.0], [0.5, 0.0]],
            "wrong size": [[1.0, 0.0]] * 4,
        }.items():
            with self.subTest(state=name), self.assertRaises(TraceBackendFault):
                trace_circuit(circ(1, [g("h")]), ScriptedAdapter(lambda i, c, s=state: make_result(s)), **LIMITS)

    def test_a_backend_that_returns_no_state_yields_no_trace_and_no_bloch(self) -> None:
        adapter = ScriptedAdapter(lambda i, c: make_result(None, execution_mode="shots", counts={"0": 5}))
        with self.assertRaises(TraceBackendFault):
            trace_circuit(circ(1, [g("h")]), adapter, **LIMITS)

    def test_the_bloch_vector_makes_no_verification_claim(self) -> None:
        bloch = self.trace(circ(1, [g("h")])).steps[-1].bloch_vector
        self.assertEqual(set(BlochVector.model_fields), {"x", "y", "z", "method", "derived_from"})
        self.assertEqual(
            set(BlochSource.model_fields),
            {"step_index", "result_id", "execution_id", "circuit_hash", "backend", "backend_version"},
        )
        forbidden = {"verified", "verification_status", "status", "correct", "passed", "equivalent", "verdict"}
        self.assertFalse(forbidden & (set(BlochVector.model_fields) | set(BlochSource.model_fields)))
        self.assertEqual(bloch.method, BLOCH_METHOD)


class TestProvenanceTiesEachVectorToItsSourceStep(AerBlochCase):
    def test_derived_from_names_exactly_the_step_it_was_computed_from(self) -> None:
        circuit = circ(1, [g("h"), g("z"), g("h")])
        recorded: list[tuple[str, list]] = []

        def record(result, prefix_hash):
            recorded.append((prefix_hash, result.statevector))
            return f"res_{len(recorded)}"

        trace = self.trace(circuit, record_execution=record)

        self.assertEqual(len(trace.steps), 4)
        for step in trace.steps:
            source = step.bloch_vector.derived_from
            with self.subTest(step=step.step_index):
                self.assertEqual(source.step_index, step.step_index)
                self.assertEqual(source.result_id, step.result_id)
                self.assertEqual(source.execution_id, step.execution_id)
                self.assertEqual(source.circuit_hash, step.prefix_circuit_hash)
                self.assertEqual(source.backend, trace.backend)
                self.assertEqual(source.backend_version, trace.backend_version)
                # The prefix circuit hash really is that step's prefix circuit:
                prefix = Circuit(num_qubits=1, num_clbits=0, ops=circuit.ops[: step.step_index])
                self.assertEqual(source.circuit_hash, circuit_hash(prefix))
                # ...and the record it points at holds the very state used.
                stored_hash, stored_state = recorded[step.step_index]
                self.assertEqual(stored_hash, source.circuit_hash)
                self.assertVector(
                    (step.bloch_vector.x, step.bloch_vector.y, step.bloch_vector.z),
                    pauli_expectations(stored_state),
                )

    def test_every_step_has_its_own_distinct_source(self) -> None:
        trace = self.trace(circ(1, [g("h"), g("z"), g("h")]), record_execution=lambda r, h: f"res_{h[:8]}")
        sources = [s.bloch_vector.derived_from for s in trace.steps]
        self.assertEqual(len({s.execution_id for s in sources}), 4)
        self.assertEqual(len({s.circuit_hash for s in sources}), 4)
        self.assertEqual(len({s.result_id for s in sources}), 4)

    def test_without_a_recorder_the_result_id_is_absent_not_invented(self) -> None:
        trace = self.trace(circ(1, [g("h")]))
        self.assertTrue(all(s.bloch_vector.derived_from.result_id is None for s in trace.steps))


class TestCrossBackend(AerBlochCase):
    """Cirq/PennyLane may return a different GLOBAL phase than Aer for the same
    circuit; the Bloch vector must not care."""

    CIRCUITS = {
        "h z h": circ(1, [g("h"), g("z"), g("h")]),
        "h s": circ(1, [g("h"), g("s")]),
        "rx rz ry": circ(1, [g("rx", params=[0.4]), g("rz", params=[-1.3]), g("ry", params=[0.9])]),
    }

    def test_cirq_and_pennylane_agree_with_aer(self) -> None:
        compared = 0
        for adapter in (CirqAdapter(), PennyLaneAdapter()):
            for name, circuit in self.CIRCUITS.items():
                with self.subTest(backend=adapter.name, circuit=name):
                    try:
                        other = trace_circuit(circuit, adapter, **LIMITS)
                    except AdapterUnavailable as exc:
                        self.skipTest(f"{adapter.name} unavailable: {exc}")
                    reference = self.trace(circuit)
                    for a, b in zip(reference.steps, other.steps):
                        self.assertVector(
                            (b.bloch_vector.x, b.bloch_vector.y, b.bloch_vector.z),
                            (a.bloch_vector.x, a.bloch_vector.y, a.bloch_vector.z),
                            tol=1e-9,
                        )
                        self.assertEqual(b.bloch_vector.derived_from.backend, adapter.name)
                    compared += 1
        self.assertEqual(compared, 6)


_SOURCE = BlochSource(
    step_index=0, result_id="res_x", execution_id="e", circuit_hash="h", backend="b", backend_version="1"
)


if __name__ == "__main__":
    unittest.main()
