"""Tests for ``qentor.execution.trace`` — the backend's own state after each
operation.

Reference states for every physics assertion are obtained by running the REAL
Aer adapter on each truncated circuit independently of the trace code; no
amplitude is hard-coded as an expectation. Where a test needs a backend
misbehaving or a value the trace could not have computed, it uses the scripted
fakes in ``trace_fakes`` — and only to prove a property of the trace layer.

Aer-dependent tests skip with the real import error if Aer is unavailable,
exactly like the other adapter tests.
"""

from __future__ import annotations

import ast
import math
import unittest
from pathlib import Path

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.execution.trace import (
    NORM_TOLERANCE,
    TRACE_METHOD,
    TraceBackendFault,
    TraceNotSupported,
    trace_circuit,
)

from tests.trace_fakes import SENTINEL_STATES, ScriptedAdapter, make_result

LIMITS = {"max_qubits": 8, "max_operations": 255}


def circ(num_qubits: int, ops: list[GateOp], num_clbits: int = 0) -> Circuit:
    return Circuit(num_qubits=num_qubits, num_clbits=num_clbits, ops=ops)


def prefix_of(circuit: Circuit, k: int) -> Circuit:
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=circuit.ops[:k])


def probabilities(statevector: list[list[float]]) -> list[float]:
    return [re * re + im * im for re, im in statevector]


X_CIRCUIT = circ(1, [GateOp(gate="x", targets=[0])])
H_CIRCUIT = circ(1, [GateOp(gate="h", targets=[0])])
HZH_CIRCUIT = circ(
    1, [GateOp(gate="h", targets=[0]), GateOp(gate="z", targets=[0]), GateOp(gate="h", targets=[0])]
)
BELL_NO_MEASURE = circ(
    2, [GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])]
)
# Asymmetric on purpose (not qubit-swap symmetric like Bell), so a wrong bit
# order between backends would show up.
ASYMMETRIC = circ(
    3,
    [
        GateOp(gate="h", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="x", targets=[2]),
        GateOp(gate="s", targets=[1]),
        GateOp(gate="ry", targets=[2], params=[0.7]),
    ],
)


class AerTraceCase(unittest.TestCase):
    """Skips (with the real reason) when Aer can't run here."""

    def setUp(self) -> None:
        self.aer = AerAdapter()
        try:
            self.aer.run(circ(1, []), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")

    def trace(self, circuit: Circuit, **kwargs):
        return trace_circuit(circuit, self.aer, **LIMITS, **kwargs)

    def independent_state(self, circuit: Circuit, k: int) -> list[list[float]]:
        """The backend's state for the first ``k`` ops, obtained WITHOUT the
        trace code — the reference every physics assertion is checked against."""
        return self.aer.run(prefix_of(circuit, k), "statevector").statevector

    def assertStatesEqual(self, actual, expected, tol: float = 1e-9) -> None:
        self.assertEqual(len(actual), len(expected))
        for (are, aim), (ere, eim) in zip(actual, expected):
            self.assertAlmostEqual(are, ere, delta=tol)
            self.assertAlmostEqual(aim, eim, delta=tol)

    def assertEveryStepIsTheBackendsOwn(self, circuit: Circuit, trace) -> None:
        self.assertEqual(len(trace.steps), len(circuit.ops) + 1)
        for step in trace.steps:
            self.assertStatesEqual(step.statevector, self.independent_state(circuit, step.step_index))


class TestOneQubitX(AerTraceCase):
    def test_initial_state_then_x(self) -> None:
        trace = self.trace(X_CIRCUIT)

        self.assertEqual([s.step_index for s in trace.steps], [0, 1])
        self.assertEqual([s.operation_index for s in trace.steps], [None, 0])
        self.assertEveryStepIsTheBackendsOwn(X_CIRCUIT, trace)

        # Physics, read off the backend's own amplitudes: |0> then |1>.
        initial, after_x = (probabilities(s.statevector) for s in trace.steps)
        self.assertAlmostEqual(initial[0], 1.0, places=9)
        self.assertAlmostEqual(after_x[1], 1.0, places=9)

    def test_gate_metadata_is_the_canonical_op(self) -> None:
        trace = self.trace(X_CIRCUIT)

        self.assertIsNone(trace.steps[0].operation)
        op = trace.steps[1].operation
        self.assertIs(op.gate, GateName.X)
        self.assertEqual((op.targets, op.controls, op.params, op.clbits), ([0], [], [], []))
        self.assertEqual(op, X_CIRCUIT.ops[0])  # literally the submitted GateOp


class TestHadamard(AerTraceCase):
    def test_amplitudes_come_from_the_backend(self) -> None:
        trace = self.trace(H_CIRCUIT)

        self.assertEveryStepIsTheBackendsOwn(H_CIRCUIT, trace)
        after_h = probabilities(trace.steps[1].statevector)
        self.assertAlmostEqual(after_h[0], 0.5, places=9)
        self.assertAlmostEqual(after_h[1], 0.5, places=9)
        self.assertAlmostEqual(sum(after_h), 1.0, places=9)

    def test_trace_forwards_backend_values_and_computes_none(self) -> None:
        """A backend returning values no real gate would produce: the trace
        must hand them back untouched. If it computed, normalised, rotated or
        rounded anything itself, they would come back different."""
        adapter = ScriptedAdapter(lambda i, c: make_result(SENTINEL_STATES[i], execution_id=f"scripted-{i}"))

        trace = trace_circuit(H_CIRCUIT, adapter, **LIMITS)

        self.assertEqual([s.statevector for s in trace.steps], SENTINEL_STATES[:2])
        self.assertEqual([s.execution_id for s in trace.steps], ["scripted-0", "scripted-1"])
        self.assertEqual(trace.backend, "scripted")
        self.assertEqual(trace.backend_version, "0.0-test")


class TestHZH(AerTraceCase):
    def test_every_intermediate_state_is_present_and_backend_computed(self) -> None:
        trace = self.trace(HZH_CIRCUIT)

        self.assertEqual([s.step_index for s in trace.steps], [0, 1, 2, 3])
        self.assertEqual([s.operation_index for s in trace.steps], [None, 0, 1, 2])
        self.assertEqual(
            [s.operation.gate.value if s.operation else None for s in trace.steps], [None, "h", "z", "h"]
        )
        self.assertEveryStepIsTheBackendsOwn(HZH_CIRCUIT, trace)

    def test_final_state_matches_a_direct_backend_execution(self) -> None:
        trace = self.trace(HZH_CIRCUIT)
        direct = self.aer.run(HZH_CIRCUIT, "statevector")  # the existing /api/execute path

        self.assertStatesEqual(trace.steps[-1].statevector, direct.statevector)
        # H Z H = X: the backend's own final state is |1>.
        self.assertAlmostEqual(probabilities(trace.steps[-1].statevector)[1], 1.0, places=9)


class TestBell(AerTraceCase):
    def test_initial_after_h_after_cx(self) -> None:
        trace = self.trace(BELL_NO_MEASURE)

        self.assertEqual(len(trace.steps), 3)
        self.assertEqual([s.operation.gate.value if s.operation else None for s in trace.steps], [None, "h", "cx"])
        self.assertEveryStepIsTheBackendsOwn(BELL_NO_MEASURE, trace)

        initial, after_h, after_cx = (probabilities(s.statevector) for s in trace.steps)
        self.assertAlmostEqual(initial[0], 1.0, places=9)  # |00>
        self.assertAlmostEqual(after_h[0], 0.5, places=9)  # (|00> + |01>)/sqrt(2): q0 in superposition
        self.assertAlmostEqual(after_h[1], 0.5, places=9)
        self.assertAlmostEqual(after_cx[0], 0.5, places=9)  # (|00> + |11>)/sqrt(2)
        self.assertAlmostEqual(after_cx[3], 0.5, places=9)
        self.assertAlmostEqual(after_cx[1] + after_cx[2], 0.0, places=9)

    def test_controlled_gate_metadata(self) -> None:
        cx = self.trace(BELL_NO_MEASURE).steps[2].operation
        self.assertIs(cx.gate, GateName.CX)
        self.assertEqual((cx.controls, cx.targets), ([0], [1]))

    def test_parameters_are_reported_for_parametric_gates(self) -> None:
        circuit = circ(1, [GateOp(gate="rx", targets=[0], params=[math.pi / 3])])
        trace = self.trace(circuit)
        self.assertEqual(trace.steps[1].operation.params, [math.pi / 3])
        self.assertEveryStepIsTheBackendsOwn(circuit, trace)


class TestEmptyCircuit(AerTraceCase):
    def test_a_single_initial_step_is_also_the_final_state(self) -> None:
        empty = circ(2, [])
        trace = self.trace(empty)

        self.assertEqual(len(trace.steps), 1)
        step = trace.steps[0]
        self.assertEqual((step.step_index, step.operation_index, step.operation), (0, None, None))
        self.assertStatesEqual(step.statevector, self.independent_state(empty, 0))
        self.assertAlmostEqual(probabilities(step.statevector)[0], 1.0, places=9)  # |00>
        self.assertEqual(trace.traced_circuit_hash, trace.circuit_hash)


class TestMeasurements(AerTraceCase):
    def test_terminal_measurements_are_stripped_and_listed(self) -> None:
        measured = circ(
            2,
            [
                GateOp(gate="h", targets=[0]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="measure", targets=[1], clbits=[1]),
            ],
            num_clbits=2,
        )
        trace = self.trace(measured)

        self.assertEqual(len(trace.steps), 3)  # initial, h, cx — no step for a measure
        self.assertEqual([m.operation_index for m in trace.terminal_measurements], [2, 3])
        self.assertEqual([m.operation.gate for m in trace.terminal_measurements], [GateName.MEASURE] * 2)
        self.assertNotEqual(trace.circuit_hash, trace.traced_circuit_hash)
        self.assertEqual(trace.circuit_hash, circuit_hash(measured))
        self.assertEqual(trace.traced_circuit_hash, trace.steps[-1].prefix_circuit_hash)

    def test_traced_state_is_deterministic_despite_a_measurement(self) -> None:
        """The whole reason measurements are stripped: left in, Aer would
        collapse the state at random and two runs would disagree."""
        measured = circ(
            1, [GateOp(gate="h", targets=[0]), GateOp(gate="measure", targets=[0], clbits=[0])], num_clbits=1
        )
        first, second = self.trace(measured), self.trace(measured)

        for a, b in zip(first.steps, second.steps):
            self.assertStatesEqual(a.statevector, b.statevector, tol=1e-12)
        probs = probabilities(first.steps[-1].statevector)
        self.assertAlmostEqual(probs[0], 0.5, places=9)  # pre-measurement superposition survives

    def test_measurement_followed_by_a_gate_is_refused_before_any_backend_call(self) -> None:
        circuit = circ(
            1,
            [
                GateOp(gate="h", targets=[0]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="x", targets=[0]),
            ],
            num_clbits=1,
        )
        adapter = ScriptedAdapter(lambda i, c: make_result(SENTINEL_STATES[0]))

        with self.assertRaises(TraceNotSupported) as ctx:
            trace_circuit(circuit, adapter, **LIMITS)

        self.assertEqual(ctx.exception.code, "TRACE_MID_CIRCUIT_MEASUREMENT")
        self.assertEqual(adapter.calls, [])


class TestUnsupported(unittest.TestCase):
    """Refusals need no real backend: they must happen BEFORE one is asked."""

    def setUp(self) -> None:
        self.adapter = ScriptedAdapter(lambda i, c: make_result(SENTINEL_STATES[0]))

    def test_shots_mode_is_refused_and_the_backend_is_never_called(self) -> None:
        with self.assertRaises(TraceNotSupported) as ctx:
            trace_circuit(H_CIRCUIT, self.adapter, mode="shots", **LIMITS)

        self.assertEqual(ctx.exception.code, "TRACE_MODE_UNSUPPORTED")
        self.assertIn("statevector", ctx.exception.message)
        self.assertEqual(self.adapter.calls, [])

    def test_too_many_qubits_is_refused(self) -> None:
        with self.assertRaises(TraceNotSupported) as ctx:
            trace_circuit(circ(3, []), self.adapter, max_qubits=2, max_operations=10)
        self.assertEqual(ctx.exception.code, "TRACE_CIRCUIT_TOO_LARGE")
        self.assertEqual(self.adapter.calls, [])

    def test_too_many_operations_is_refused(self) -> None:
        many = circ(1, [GateOp(gate="x", targets=[0])] * 4)
        with self.assertRaises(TraceNotSupported) as ctx:
            trace_circuit(many, self.adapter, max_qubits=8, max_operations=3)
        self.assertEqual(ctx.exception.code, "TRACE_TOO_MANY_OPERATIONS")
        self.assertEqual(self.adapter.calls, [])

    def test_at_the_limit_is_allowed(self) -> None:
        adapter = ScriptedAdapter(lambda i, c: make_result(SENTINEL_STATES[0]))
        trace = trace_circuit(circ(1, [GateOp(gate="x", targets=[0])] * 3), adapter, max_qubits=1, max_operations=3)
        self.assertEqual(len(trace.steps), 4)


class TestBackendMisbehaviourIsRefusedNotRepaired(unittest.TestCase):
    def fault(self, respond, circuit: Circuit = H_CIRCUIT) -> TraceBackendFault:
        adapter = ScriptedAdapter(respond)
        with self.assertRaises(TraceBackendFault) as ctx:
            trace_circuit(circuit, adapter, **LIMITS)
        return ctx.exception

    def test_a_result_with_no_statevector_yields_a_fault_not_substitute_data(self) -> None:
        fault = self.fault(lambda i, c: make_result(None, execution_mode="shots", counts={"0": 10}))
        self.assertEqual(fault.code, "TRACE_BACKEND_RETURNED_NO_STATE")
        self.assertEqual(fault.circuit_hash, circuit_hash(prefix_of(H_CIRCUIT, 0)))

    def test_a_wrong_sized_state_is_a_fault(self) -> None:
        fault = self.fault(lambda i, c: make_result([[1.0, 0.0]] * 1 + [[0.0, 0.0]] * 3))  # 4 amps for 1 qubit
        self.assertEqual(fault.code, "TRACE_BACKEND_RETURNED_WRONG_SIZE")

    def test_an_unnormalised_state_is_a_fault_and_is_not_rescaled(self) -> None:
        fault = self.fault(lambda i, c: make_result([[0.5, 0.0], [0.5, 0.0]]))  # norm 0.5
        self.assertEqual(fault.code, "TRACE_STATE_NOT_NORMALISED")

    def test_a_backend_that_changes_identity_mid_trace_is_a_fault(self) -> None:
        def respond(i, c):
            return make_result(SENTINEL_STATES[i], backend_name="a" if i == 0 else "b")

        self.assertEqual(self.fault(respond).code, "TRACE_BACKEND_CHANGED")

    def test_backend_errors_propagate_unchanged(self) -> None:
        def unavailable(i, c):
            raise AdapterUnavailable("no such runtime")

        def failed(i, c):
            raise AdapterExecutionError("run failed")

        for respond, expected in ((unavailable, AdapterUnavailable), (failed, AdapterExecutionError)):
            with self.subTest(expected=expected.__name__), self.assertRaises(expected):
                trace_circuit(H_CIRCUIT, ScriptedAdapter(respond), **LIMITS)

    def test_a_failure_part_way_leaves_no_partial_trace(self) -> None:
        def respond(i, c):
            if i == 1:
                raise AdapterExecutionError("boom on the second run")
            return make_result(SENTINEL_STATES[i])

        with self.assertRaises(AdapterExecutionError):
            trace_circuit(H_CIRCUIT, ScriptedAdapter(respond), **LIMITS)  # raises; nothing is returned


class TestWhatTheBackendIsAsked(unittest.TestCase):
    def test_one_statevector_run_per_prefix_of_the_canonical_circuit(self) -> None:
        adapter = ScriptedAdapter(lambda i, c: make_result(SENTINEL_STATES[i]))

        trace_circuit(HZH_CIRCUIT, adapter, **LIMITS)

        self.assertEqual([mode for _, mode in adapter.calls], ["statevector"] * 4)
        self.assertEqual(
            [circuit.ops for circuit, _ in adapter.calls],
            [HZH_CIRCUIT.ops[:k] for k in range(4)],
        )
        for circuit, _ in adapter.calls:
            self.assertEqual(circuit.num_qubits, HZH_CIRCUIT.num_qubits)


class TestProvenance(AerTraceCase):
    def test_hashes_and_backend_identity(self) -> None:
        trace = self.trace(BELL_NO_MEASURE)
        real = self.aer.run(BELL_NO_MEASURE, "statevector")

        self.assertEqual(trace.circuit_hash, circuit_hash(BELL_NO_MEASURE))
        self.assertEqual(trace.traced_circuit_hash, trace.circuit_hash)  # no measure to strip
        self.assertEqual(trace.backend, "qiskit-aer")
        self.assertEqual(trace.backend_version, real.backend_version)
        self.assertEqual(trace.trace_method, TRACE_METHOD)
        for step in trace.steps:
            self.assertEqual(step.prefix_circuit_hash, circuit_hash(prefix_of(BELL_NO_MEASURE, step.step_index)))
        self.assertEqual(len({s.prefix_circuit_hash for s in trace.steps}), 3)  # distinct circuits

    def test_every_state_is_attributable_to_a_distinct_backend_run(self) -> None:
        trace = self.trace(BELL_NO_MEASURE)

        ids = [s.execution_id for s in trace.steps]
        self.assertTrue(all(i.startswith("aer-local-") for i in ids))
        self.assertEqual(len(set(ids)), len(ids))

    def test_record_callback_is_called_once_per_step_with_that_steps_own_real_result(self) -> None:
        seen: list[tuple[str, str, list]] = []

        def record(result, prefix_hash):
            seen.append((prefix_hash, result.backend_name, result.statevector))
            return f"res_{len(seen)}"

        trace = self.trace(BELL_NO_MEASURE, record_execution=record)

        self.assertEqual([s.result_id for s in trace.steps], ["res_1", "res_2", "res_3"])
        self.assertEqual(trace.final_result_id, "res_3")
        for step, (prefix_hash, backend, state) in zip(trace.steps, seen):
            self.assertEqual(prefix_hash, step.prefix_circuit_hash)
            self.assertEqual(backend, "qiskit-aer")
            # Value-equal to what the adapter returned (pydantic copies lists
            # on construction, so identity is the wrong property; unchanged
            # values is the right one).
            self.assertEqual(state, step.statevector)

    def test_without_a_recorder_result_ids_are_absent_not_invented(self) -> None:
        trace = self.trace(BELL_NO_MEASURE)
        self.assertEqual([s.result_id for s in trace.steps], [None, None, None])
        self.assertIsNone(trace.final_result_id)

    def test_a_trace_makes_no_verification_claim(self) -> None:
        fields = set(type(self.trace(H_CIRCUIT)).model_fields) | set(type(self.trace(H_CIRCUIT).steps[0]).model_fields)
        self.assertFalse({"verified", "verification_status", "passed", "equivalent"} & fields)


class TestCrossBackendAgreement(AerTraceCase):
    """CLAUDE.md: cross-backend agreement threshold 1e-6. Compared on
    probabilities (phase-agnostic) and on a circuit that is NOT qubit-swap
    symmetric, so a bit-order mismatch between backends would show."""

    def test_cirq_and_pennylane_traces_agree_with_aer_step_by_step(self) -> None:
        aer_trace = self.trace(ASYMMETRIC)
        compared = 0
        for adapter in (CirqAdapter(), PennyLaneAdapter()):
            with self.subTest(backend=adapter.name):
                try:
                    other = trace_circuit(ASYMMETRIC, adapter, **LIMITS)
                except AdapterUnavailable as exc:
                    self.skipTest(f"{adapter.name} unavailable: {exc}")
                self.assertEqual(other.backend, adapter.name)
                self.assertEqual(len(other.steps), len(aer_trace.steps))
                for a, b in zip(aer_trace.steps, other.steps):
                    for pa, pb in zip(probabilities(a.statevector), probabilities(b.statevector)):
                        self.assertAlmostEqual(pa, pb, delta=1e-6)
                compared += 1
        self.assertGreater(compared, 0)


class TestNoNewSimulationCode(unittest.TestCase):
    """Import-graph guards, in the style of test_architecture_rule.py."""

    TRACE_FILE = Path(__file__).resolve().parents[1] / "qentor" / "execution" / "trace.py"

    def imported(self) -> set[str]:
        names: set[str] = set()
        for node in ast.walk(ast.parse(self.TRACE_FILE.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names.update(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                names.add(node.module)
        return names

    def test_trace_never_imports_the_provenance_writer_or_the_tutor(self) -> None:
        imported = self.imported()
        self.assertNotIn("qentor.provenance.store", imported)
        self.assertFalse({m for m in imported if "tutor" in m})

    def test_trace_does_not_import_a_simulator_or_numeric_library(self) -> None:
        """It only asks adapters. If it ever imports qiskit/cirq/pennylane/numpy
        it has started to do quantum maths of its own."""
        offenders = {m for m in self.imported() if m.split(".")[0] in {"qiskit", "qiskit_aer", "cirq", "pennylane", "numpy", "scipy"}}
        self.assertEqual(offenders, set())

    def test_norm_tolerance_is_the_projects_documented_one(self) -> None:
        self.assertEqual(NORM_TOLERANCE, 1e-9)


if __name__ == "__main__":
    unittest.main()
