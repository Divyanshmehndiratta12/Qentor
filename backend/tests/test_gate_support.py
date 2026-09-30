"""The gate set (h x y z s sdg t tdg rx ry rz cx cz swap ccx measure) across the whole backend.

For each new gate: the model accepts exactly the right shapes, every backend runs it and reaches the
same state as the verifier's unitary for EVERY operand order (bit-order bugs hide in the orders a
fixture does not happen to use), the optimizer's new cancellation rules are correct and stay verified,
the tutor describes the gate without dropping an operand, and an unsupported backend/gate combination
is a structured refusal, never a crash or a silent difference.
"""

from __future__ import annotations

import itertools
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ExecuteRequest, TraceRequest
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution import capabilities
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.capabilities import BACKEND_GATE_UNSUPPORTED, SUPPORTED_GATES, UnsupportedGate, check_gate_support
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.tutor.facts import _describe_op
from qentor.tutor.trace_context import GATE_NOTES
from qentor.verification.equivalence import EquivalenceStatus, _to_qiskit_circuit_without_measurement, check_equivalence
from qentor.verification.optimizer import OptimizationStatus, optimize_circuit
from tests.test_api_tutor import TutorEndpointTestCase

NEW_GATES = ("sdg", "tdg", "cz", "swap", "ccx")


def gate(name, targets, controls=(), params=()):
    return GateOp(gate=name, targets=list(targets), controls=list(controls), params=list(params))


def circ(n, *ops):
    return Circuit(num_qubits=n, num_clbits=0, ops=list(ops))


def asymmetric_prefix(n):
    """A product state with a different, non-symmetric state on each qubit, so a wrongly ordered
    operand changes the result."""
    ops = []
    for q in range(n):
        ops.append(gate("h", [q]))
        ops.append(gate("rz", [q], params=[0.3 + 0.41 * q]))
        ops.append(gate("ry", [q], params=[0.7 + 0.29 * q]))
    return ops


class TestTheModelAcceptsExactlyTheRightShapes(unittest.TestCase):
    def test_the_gate_set_is_the_documented_one(self) -> None:
        self.assertEqual(
            [g.value for g in GateName],
            ["h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz", "cx", "cz", "swap", "ccx", "measure"],
        )

    def test_valid_shapes(self) -> None:
        GateOp(gate="sdg", targets=[0])
        GateOp(gate="tdg", targets=[3])
        GateOp(gate="cz", targets=[1], controls=[0])
        GateOp(gate="swap", targets=[2, 0])
        GateOp(gate="ccx", targets=[1], controls=[2, 0])

    def test_operand_order_is_preserved_exactly(self) -> None:
        self.assertEqual(GateOp(gate="swap", targets=[2, 0]).targets, [2, 0])
        self.assertEqual(GateOp(gate="ccx", targets=[1], controls=[2, 0]).controls, [2, 0])

    def test_the_wrong_shapes_are_all_refused(self) -> None:
        bad = [
            {"gate": "sdg", "targets": [0], "params": [1.0]},
            {"gate": "tdg", "targets": [0, 1]},
            {"gate": "tdg", "targets": [0], "controls": [1]},
            {"gate": "cz", "targets": [1], "controls": []},
            {"gate": "cz", "targets": [1], "controls": [0, 2]},
            {"gate": "cz", "targets": [1], "controls": [1]},
            {"gate": "cz", "targets": [1], "controls": [0], "params": [1.0]},
            {"gate": "swap", "targets": [0]},
            {"gate": "swap", "targets": [0, 0]},
            {"gate": "swap", "targets": [0, 1], "controls": [2]},
            {"gate": "swap", "targets": [0, 1], "clbits": [0]},
            {"gate": "ccx", "targets": [2], "controls": [0]},
            {"gate": "ccx", "targets": [2], "controls": [0, 0]},
            {"gate": "ccx", "targets": [0], "controls": [0, 1]},
            {"gate": "ccx", "targets": [2, 3], "controls": [0, 1]},
            {"gate": "ccx", "targets": [2], "controls": [0, 1], "params": [1.0]},
        ]
        for fields in bad:
            with self.subTest(fields=fields), self.assertRaises(ValidationError):
                GateOp.model_validate(fields)

    def test_the_index_range_check_covers_every_operand(self) -> None:
        for ops in (
            [{"gate": "swap", "targets": [0, 3]}],
            [{"gate": "ccx", "targets": [0], "controls": [1, 3]}],
        ):
            with self.assertRaises(ValidationError):
                Circuit.model_validate({"num_qubits": 3, "num_clbits": 0, "ops": ops})


class _Backends(unittest.TestCase):
    ADAPTERS = (AerAdapter(), CirqAdapter(), PennyLaneAdapter())

    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        except Exception:
            pass

    def assertAllBackendsAgree(self, circuit: Circuit, label: str) -> None:
        from qiskit.quantum_info import Statevector

        predicted = Statevector(_to_qiskit_circuit_without_measurement(circuit)).data
        for adapter in self.ADAPTERS:
            state = [complex(re, im) for re, im in adapter.run(circuit, "statevector").statevector]
            overlap = abs(sum(p.conjugate() * s for p, s in zip(predicted, state)))
            self.assertAlmostEqual(overlap, 1.0, places=9, msg=f"{label}: {adapter.name} differs from the verifier")
            worst = max(abs(a - b) for a, b in zip(state, [complex(re, im) for re, im in AerAdapter().run(circuit, "statevector").statevector]))
            self.assertLess(worst, 1e-9, f"{label}: {adapter.name} differs from qiskit-aer (including global phase)")


class TestEveryBackendRunsEveryGateInEveryOperandOrder(_Backends):
    def test_single_qubit_new_gates_on_each_qubit(self) -> None:
        for name in ("sdg", "tdg"):
            for qubit in range(3):
                circuit = circ(3, *asymmetric_prefix(3), gate(name, [qubit]))
                self.assertAllBackendsAgree(circuit, f"{name} on q{qubit}")

    def test_cz_in_every_ordered_pair(self) -> None:
        for c, t in itertools.permutations(range(3), 2):
            self.assertAllBackendsAgree(circ(3, *asymmetric_prefix(3), gate("cz", [t], [c])), f"cz control q{c} target q{t}")

    def test_swap_in_every_ordered_pair(self) -> None:
        for a, b in itertools.permutations(range(3), 2):
            self.assertAllBackendsAgree(circ(3, *asymmetric_prefix(3), gate("swap", [a, b])), f"swap q{a}, q{b}")

    def test_ccx_in_every_ordering_of_three_qubits(self) -> None:
        for c1, c2, t in itertools.permutations(range(3), 3):
            self.assertAllBackendsAgree(circ(3, *asymmetric_prefix(3), gate("ccx", [t], [c1, c2])), f"ccx controls q{c1},q{c2} target q{t}")

    def test_ccx_flips_only_when_both_controls_are_one_on_basis_inputs(self) -> None:
        for adapter in self.ADAPTERS:
            for bits in itertools.product((0, 1), repeat=3):
                prep = [gate("x", [q]) for q, b in enumerate(bits) if b]
                state = adapter.run(circ(3, *prep, gate("ccx", [2], [0, 1])), "statevector").statevector
                index = max(range(len(state)), key=lambda i: state[i][0] ** 2 + state[i][1] ** 2)
                observed = tuple((index >> q) & 1 for q in range(3))
                expected = (bits[0], bits[1], bits[2] ^ (bits[0] & bits[1]))
                self.assertEqual(observed, expected, f"{adapter.name} ccx on {bits}")

    def test_swap_exchanges_two_qubits_on_a_basis_input(self) -> None:
        for adapter in self.ADAPTERS:
            state = adapter.run(circ(3, gate("x", [0]), gate("swap", [0, 2])), "statevector").statevector
            index = max(range(len(state)), key=lambda i: state[i][0] ** 2 + state[i][1] ** 2)
            self.assertEqual(index, 0b100, adapter.name)  # q2 = 1, q0 = 0

    def test_sdg_undoes_s_and_tdg_undoes_t_on_every_backend(self) -> None:
        for adapter in self.ADAPTERS:
            base = adapter.run(circ(1, gate("h", [0])), "statevector").statevector
            for forward, back in (("s", "sdg"), ("t", "tdg"), ("sdg", "s"), ("tdg", "t")):
                state = adapter.run(circ(1, gate("h", [0]), gate(forward, [0]), gate(back, [0])), "statevector").statevector
                self.assertLess(max(abs(complex(*a) - complex(*b)) for a, b in zip(state, base)), 1e-9, f"{adapter.name} {forward}{back}")

    def test_shots_mode_runs_the_new_gates_on_every_backend(self) -> None:
        circuit = Circuit(
            num_qubits=3,
            num_clbits=3,
            ops=[gate("x", [0]), gate("x", [1]), gate("ccx", [2], [0, 1])] + [GateOp(gate="measure", targets=[q], clbits=[q]) for q in range(3)],
        )
        for adapter in self.ADAPTERS:
            result = adapter.run(circuit, "shots", 200)
            self.assertEqual(set(result.counts), {"111"}, adapter.name)


class TestOptimizerRulesForTheNewGates(_Backends):
    def optimize(self, circuit: Circuit):
        return optimize_circuit(circuit, adapter=AerAdapter(), record_execution=lambda result, hash_: f"res_{hash_[:6]}")

    def assertShortenedAndVerified(self, circuit: Circuit, expected_ops: int) -> None:
        report = self.optimize(circuit)
        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER, report.reason)
        self.assertEqual(report.candidate_op_count, expected_ops)
        self.assertEqual(report.equivalence.status, EquivalenceStatus.EQUIVALENT)

    def assertNotShortened(self, circuit: Circuit) -> None:
        self.assertEqual(self.optimize(circuit).status, OptimizationStatus.NO_OPTIMIZATION_FOUND)

    def test_inverse_pairs_cancel(self) -> None:
        for a, b in (("s", "sdg"), ("sdg", "s"), ("t", "tdg"), ("tdg", "t")):
            with self.subTest(pair=(a, b)):
                self.assertShortenedAndVerified(circ(1, gate(a, [0]), gate(b, [0])), 0)

    def test_equal_pairs_do_not_cancel(self) -> None:
        for name in ("s", "sdg", "t", "tdg"):
            with self.subTest(gate=name):
                self.assertNotShortened(circ(1, gate(name, [0]), gate(name, [0])))

    def test_cz_is_symmetric_so_either_order_cancels(self) -> None:
        self.assertShortenedAndVerified(circ(2, gate("cz", [1], [0]), gate("cz", [1], [0])), 0)
        self.assertShortenedAndVerified(circ(2, gate("cz", [1], [0]), gate("cz", [0], [1])), 0)

    def test_swap_cancels_in_either_operand_order(self) -> None:
        self.assertShortenedAndVerified(circ(2, gate("swap", [0, 1]), gate("swap", [0, 1])), 0)
        self.assertShortenedAndVerified(circ(2, gate("swap", [0, 1]), gate("swap", [1, 0])), 0)

    def test_ccx_cancels_with_the_controls_in_either_order_but_not_with_another_target(self) -> None:
        self.assertShortenedAndVerified(circ(3, gate("ccx", [2], [0, 1]), gate("ccx", [2], [1, 0])), 0)
        self.assertNotShortened(circ(3, gate("ccx", [2], [0, 1]), gate("ccx", [0], [1, 2])))

    def test_the_pair_rule_itself_refuses_a_ccx_pair_with_another_target(self) -> None:
        """The peephole pass only offers a pair that touches the same qubits, so this cannot be reached through
        ``optimize_circuit``; the rule is still wrong if it says yes, so it is tested on its own."""
        from qentor.verification import optimizer

        same = optimizer._combine_cancel_self_inverse(gate("ccx", [2], [0, 1]), gate("ccx", [2], [1, 0]))
        other_target = optimizer._combine_cancel_self_inverse(gate("ccx", [2], [0, 1]), gate("ccx", [3], [0, 1]))
        self.assertIsNone(same)  # None = the pair cancels
        self.assertIs(other_target, optimizer._NO_MATCH)

    def test_different_gates_or_qubits_never_cancel(self) -> None:
        self.assertNotShortened(circ(2, gate("cz", [1], [0]), gate("cx", [1], [0])))
        self.assertNotShortened(circ(3, gate("swap", [0, 1]), gate("swap", [1, 2])))
        self.assertNotShortened(circ(2, gate("cz", [1], [0]), gate("h", [1]), gate("cz", [1], [0])))

    def test_a_cancellation_inside_a_longer_circuit_is_still_verified(self) -> None:
        self.assertShortenedAndVerified(circ(2, gate("h", [0]), gate("s", [0]), gate("sdg", [0]), gate("cz", [1], [0])), 2)


class TestTutorSeesEveryOperand(unittest.TestCase):
    def test_operations_are_described_without_dropping_a_control_or_a_target(self) -> None:
        self.assertEqual(_describe_op(gate("cx", [1], [0])), "cx(control=q0, target=q1)")  # unchanged wording
        self.assertEqual(_describe_op(gate("cz", [1], [0])), "cz(control=q0, target=q1)")
        self.assertEqual(_describe_op(gate("ccx", [1], [2, 0])), "ccx(controls=q2, q0, target=q1)")
        self.assertEqual(_describe_op(gate("swap", [2, 0])), "swap(q2, q0)")
        self.assertEqual(_describe_op(gate("sdg", [1])), "sdg(q1)")
        self.assertEqual(_describe_op(gate("tdg", [0])), "tdg(q0)")

    def test_every_gate_the_trace_can_step_over_has_a_plain_note(self) -> None:
        for g in GateName:
            if g is not GateName.MEASURE:
                self.assertIn(g.value, GATE_NOTES, g.value)


class TestTraceStepsOverTheNewGates(TutorEndpointTestCase):
    def test_a_trace_has_one_step_per_operation_including_multi_qubit_gates(self) -> None:
        circuit = circ(3, gate("h", [0]), gate("h", [1]), gate("ccx", [2], [1, 0]), gate("swap", [0, 2]), gate("sdg", [1]), gate("cz", [2], [0]))
        trace = app_module.execute_trace(TraceRequest(circuit=circuit))
        self.assertEqual(len(trace.steps), 7)
        self.assertEqual([s.operation.gate.value for s in trace.steps[1:]], ["h", "h", "ccx", "swap", "sdg", "cz"])
        self.assertEqual({s.provenance.verification_status for s in trace.steps}, {"STATE_CHECKED"})


class TestSupportMatrixAndStructuredRefusal(TutorEndpointTestCase):
    def test_every_backend_declares_exactly_the_gates_the_adapters_run(self) -> None:
        self.assertEqual(set(SUPPORTED_GATES), {"qiskit-aer", "cirq", "pennylane"})
        for backend, gates in SUPPORTED_GATES.items():
            self.assertEqual(gates, frozenset(GateName), backend)

    def test_a_supported_circuit_passes_the_check(self) -> None:
        for backend in SUPPORTED_GATES:
            check_gate_support(circ(3, gate("ccx", [2], [0, 1]), gate("swap", [0, 1])), backend)

    def test_an_unsupported_combination_is_a_structured_refusal_naming_the_gates(self) -> None:
        limited = {**SUPPORTED_GATES, "cirq": frozenset(g for g in GateName if g not in (GateName.CCX, GateName.SWAP))}
        with patch.object(capabilities, "SUPPORTED_GATES", limited):
            with self.assertRaises(UnsupportedGate) as raised:
                check_gate_support(circ(3, gate("h", [0]), gate("ccx", [2], [0, 1]), gate("swap", [0, 1])), "cirq")
        exc = raised.exception
        self.assertEqual((exc.code, exc.backend, exc.gates), (BACKEND_GATE_UNSUPPORTED, "cirq", ["ccx", "swap"]))
        self.assertEqual(set(exc.detail()), {"code", "message", "backend", "gates"})
        self.assertIn("ccx, swap", exc.message)

    def test_the_api_refuses_before_running_and_the_other_backends_still_work(self) -> None:
        limited = {**SUPPORTED_GATES, "cirq": frozenset(g for g in GateName if g is not GateName.CCX)}
        circuit = circ(3, gate("x", [0]), gate("x", [1]), gate("ccx", [2], [0, 1]))
        with patch.object(capabilities, "SUPPORTED_GATES", limited):
            with patch.object(app_module._adapters["cirq"], "run", side_effect=AssertionError("cirq.run was reached")):
                with self.assertRaises(HTTPException) as raised:
                    app_module.execute(ExecuteRequest(circuit=circuit, mode="statevector", backend="cirq"))
                self.assertEqual(raised.exception.status_code, 422)
                self.assertEqual(raised.exception.detail["code"], BACKEND_GATE_UNSUPPORTED)
                self.assertEqual(raised.exception.detail["gates"], ["ccx"])
            ok = app_module.execute(ExecuteRequest(circuit=circuit, mode="statevector", backend="qiskit-aer"))
            self.assertEqual(ok.verification_status, "STATE_CHECKED")

    def test_a_backend_missing_from_the_table_supports_nothing(self) -> None:
        with self.assertRaises(UnsupportedGate):
            check_gate_support(circ(1, gate("h", [0])), "made-up-backend")


if __name__ == "__main__":
    unittest.main()
