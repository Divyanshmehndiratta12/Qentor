"""The controlled-phase gate ``cp(theta) control, target``: diag(1, 1, 1, e^{i*theta}).

Everything the canonical-model rule ("a gate is added only together with its QASM emission, all three backends,
the equivalence checker, the frontend model and a shared golden fixture") requires, for ``cp`` specifically:
exact arity, serialisation, the QASM text, an independent parser's reading of it, the physics on each backend
(the |11> phase and nothing else), cross-backend agreement in every operand order, the generated SDK programs,
gate-support reporting, the equivalence checker, the optimizer leaving it alone, and the tutor keeping its angle.
"""

from __future__ import annotations

import ast
import cmath
import itertools
import math
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import AgreementRequest, ExecuteRequest, TraceRequest
from qentor.circuit.codegen import generate_code
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.circuit.qasm import to_qasm3
from qentor.execution import capabilities
from qentor.execution.aer import AerAdapter
from qentor.execution.capabilities import SUPPORTED_GATES, UnsupportedGate, check_gate_support
from qentor.tutor.facts import _describe_op
from qentor.tutor.trace_context import GATE_NOTES
from qentor.verification.equivalence import EquivalenceStatus, _to_qiskit_circuit_without_measurement, check_equivalence
from qentor.verification.experiment_compare import describe_op
from qentor.verification.optimizer import OptimizationStatus, optimize_circuit
from tests.test_codegen import assert_only_a_fixed_template
from tests.test_gate_support import _Backends, asymmetric_prefix, circ, gate
from tests.test_api_tutor import TutorEndpointTestCase


def cp(control: int, target: int, theta: float) -> GateOp:
    return gate("cp", [target], [control], [theta])


class TestArity(unittest.TestCase):
    def test_valid_shapes(self) -> None:
        for control, target, theta in ((0, 1, 0.5), (1, 0, -2.5), (3, 0, 0.0), (0, 2, 1.0), (2, 1, 1e-12)):
            op = GateOp(gate="cp", targets=[target], controls=[control], params=[theta])
            self.assertEqual((op.controls, op.targets, op.params), ([control], [target], [theta]))

    def test_operand_roles_are_preserved(self) -> None:
        op = GateOp(gate="cp", targets=[0], controls=[2], params=[0.3])
        self.assertEqual((op.controls, op.targets), ([2], [0]))

    def test_every_wrong_shape_is_refused_with_a_reason(self) -> None:
        bad = [
            ({"gate": "cp", "targets": [1], "controls": [0]}, "exactly 1 parameter"),
            ({"gate": "cp", "targets": [1], "controls": [0], "params": [0.1, 0.2]}, "exactly 1 parameter"),
            ({"gate": "cp", "targets": [1], "params": [0.1]}, "exactly 1 control"),
            ({"gate": "cp", "targets": [2], "controls": [0, 1], "params": [0.1]}, "exactly 1 control"),
            ({"gate": "cp", "controls": [0], "params": [0.1]}, "exactly 1 target"),
            ({"gate": "cp", "targets": [1, 2], "controls": [0], "params": [0.1]}, "exactly 1 target"),
            ({"gate": "cp", "targets": [0], "controls": [0], "params": [0.1]}, "different qubits"),
            ({"gate": "cp", "targets": [1], "controls": [0], "params": [0.1], "clbits": [0]}, "no classical bits"),
            ({"gate": "cp", "targets": [1], "controls": [0], "params": [float("nan")]}, "finite"),
            ({"gate": "cp", "targets": [1], "controls": [0], "params": [float("inf")]}, "finite"),
            ({"gate": "cp", "targets": [1], "controls": [0], "params": [float("-inf")]}, "finite"),
        ]
        for fields, reason in bad:
            with self.subTest(fields=fields):
                with self.assertRaises(ValidationError) as raised:
                    GateOp.model_validate(fields)
                self.assertIn(reason, str(raised.exception))

    def test_a_parameter_that_is_not_a_number_is_refused(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp.model_validate({"gate": "cp", "targets": [1], "controls": [0], "params": ["pi"]})

    def test_other_controlled_gates_still_refuse_a_parameter_and_cp_is_not_one_of_them(self) -> None:
        for name in ("cx", "cz"):
            with self.assertRaises(ValidationError):
                GateOp.model_validate({"gate": name, "targets": [1], "controls": [0], "params": [0.5]})

    def test_the_circuit_range_check_covers_the_control_and_the_target(self) -> None:
        for control, target in ((3, 0), (0, 3)):
            with self.assertRaises(ValidationError):
                Circuit.model_validate(
                    {"num_qubits": 3, "num_clbits": 0, "ops": [{"gate": "cp", "targets": [target], "controls": [control], "params": [0.5]}]}
                )


class TestSerialisation(unittest.TestCase):
    def test_qasm_text_is_the_stdgates_cp_with_control_first(self) -> None:
        self.assertEqual(
            to_qasm3(circ(3, cp(2, 0, 0.5))),
            'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[3] q;\ncp(0.5) q[2], q[0];\n',
        )

    def test_angles_print_as_the_other_rotations_do(self) -> None:
        self.assertIn("cp(1.0) q[0], q[1];", to_qasm3(circ(2, cp(0, 1, 1.0))))
        self.assertIn("cp(-0.25) q[0], q[1];", to_qasm3(circ(2, cp(0, 1, -0.25))))
        self.assertIn("cp(1e-05) q[0], q[1];", to_qasm3(circ(2, cp(0, 1, 1e-05))))

    def test_canonical_json_round_trips(self) -> None:
        circuit = circ(3, cp(1, 2, 0.123456789), cp(2, 0, -3.0))
        again = Circuit.from_canonical_json(circuit.canonical_json())
        self.assertEqual(again.canonical_dict(), circuit.canonical_dict())
        self.assertEqual(circuit_hash(again), circuit_hash(circuit))
        self.assertEqual(circuit.canonical_dict()["ops"][0], {"gate": "cp", "targets": [2], "controls": [1], "params": [0.123456789], "clbits": []})

    def test_angle_and_operand_order_are_part_of_the_hash(self) -> None:
        base = circuit_hash(circ(2, cp(0, 1, 0.5)))
        self.assertNotEqual(base, circuit_hash(circ(2, cp(0, 1, 0.6))))
        self.assertNotEqual(base, circuit_hash(circ(2, cp(1, 0, 0.5))))

    def test_an_independent_parser_reads_the_emitted_text_as_the_same_operator(self) -> None:
        from qiskit import qasm3
        from qiskit.quantum_info import Operator

        try:
            AerAdapter().run(circ(1), "statevector")
        except Exception as exc:  # noqa: BLE001
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        for control, target, theta in itertools.product(range(3), range(3), (0.7, -2.0, math.pi)):
            if control == target:
                continue
            circuit = circ(3, gate("h", [0]), gate("h", [1]), cp(control, target, theta))
            imported = qasm3.loads(to_qasm3(circuit))
            self.assertTrue(
                Operator(imported).equiv(Operator(_to_qiskit_circuit_without_measurement(circuit)), atol=1e-9),
                f"cp({theta}) control q{control} target q{target}",
            )


class TestThePhysicsOnEveryBackend(_Backends):
    @staticmethod
    def amplitudes(adapter, circuit: Circuit) -> list[complex]:
        return [complex(re, im) for re, im in adapter.run(circuit, "statevector").statevector]

    def test_only_the_11_amplitude_picks_up_the_phase_and_by_exactly_e_to_the_i_theta(self) -> None:
        theta = 0.9
        for adapter in self.ADAPTERS:
            for control, target in itertools.permutations(range(3), 2):
                for bits in itertools.product((0, 1), repeat=3):
                    prep = [gate("x", [q]) for q, b in enumerate(bits) if b]
                    state = self.amplitudes(adapter, circ(3, *prep, cp(control, target, theta)))
                    index = sum(b << q for q, b in enumerate(bits))
                    expected = cmath.exp(1j * theta) if bits[control] and bits[target] else 1.0
                    self.assertAlmostEqual(abs(state[index] - expected), 0.0, places=9, msg=f"{adapter.name} cp {control}->{target} on {bits}")
                    self.assertAlmostEqual(sum(abs(a) ** 2 for i, a in enumerate(state) if i != index), 0.0, places=9)

    def test_theta_zero_is_the_identity_and_theta_pi_is_cz(self) -> None:
        for adapter in self.ADAPTERS:
            prefix = asymmetric_prefix(2)
            base = self.amplitudes(adapter, circ(2, *prefix))
            zero = self.amplitudes(adapter, circ(2, *prefix, cp(0, 1, 0.0)))
            pi = self.amplitudes(adapter, circ(2, *prefix, cp(0, 1, math.pi)))
            cz = self.amplitudes(adapter, circ(2, *prefix, gate("cz", [1], [0])))
            self.assertLess(max(abs(a - b) for a, b in zip(base, zero)), 1e-9, adapter.name)
            self.assertLess(max(abs(a - b) for a, b in zip(pi, cz)), 1e-9, adapter.name)

    def test_cp_does_not_change_outcome_probabilities_on_its_own_but_does_change_the_state(self) -> None:
        for adapter in self.ADAPTERS:
            before = self.amplitudes(adapter, circ(2, gate("h", [0]), gate("h", [1])))
            after = self.amplitudes(adapter, circ(2, gate("h", [0]), gate("h", [1]), cp(0, 1, math.pi / 2)))
            self.assertLess(max(abs(abs(a) ** 2 - abs(b) ** 2) for a, b in zip(before, after)), 1e-12, adapter.name)
            self.assertGreater(abs(before[3] - after[3]), 0.1, adapter.name)

    def test_shots_mode_measures_a_basis_input_unchanged_by_cp(self) -> None:
        circuit = Circuit(
            num_qubits=2,
            num_clbits=2,
            ops=[gate("x", [0]), gate("x", [1]), cp(0, 1, 0.3), *(GateOp(gate="measure", targets=[q], clbits=[q]) for q in range(2))],
        )
        for adapter in self.ADAPTERS:
            self.assertEqual(set(adapter.run(circuit, "shots", 100).counts), {"11"}, adapter.name)


class TestCrossBackendAgreement(_Backends):
    def test_every_backend_matches_the_verifiers_unitary_in_every_ordered_pair_and_several_angles(self) -> None:
        for theta in (0.7, -1.9, math.pi / 2, 3.0):
            for control, target in itertools.permutations(range(3), 2):
                self.assertAllBackendsAgree(
                    circ(3, *asymmetric_prefix(3), cp(control, target, theta)), f"cp({theta}) control q{control} target q{target}"
                )

    def test_a_chain_of_cp_gates_agrees(self) -> None:
        circuit = circ(4, *asymmetric_prefix(4), cp(0, 3, 0.4), cp(3, 1, -0.8), cp(1, 2, 1.3), gate("h", [2]), cp(2, 0, 2.2))
        self.assertAllBackendsAgree(circuit, "cp chain")


class TestAgreementThroughTheApi(TutorEndpointTestCase):
    def test_the_agreement_endpoint_reports_AGREE_with_provenance_for_each_operand_order(self) -> None:
        for control, target in itertools.permutations(range(3), 2):
            with self.subTest(control=control, target=target):
                response = app_module.compare_backends_endpoint(
                    AgreementRequest(circuit=circ(3, *asymmetric_prefix(3), cp(control, target, 1.1)))
                )
                self.assertEqual(response.status, "AGREE")
                self.assertEqual([b.status for b in response.backends], ["RAN"] * 3)
                for pair in response.pairs:
                    self.assertTrue(pair.agrees)
                    self.assertAlmostEqual(pair.fidelity, 1.0, places=9)
                for entry in response.backends:
                    self.assertEqual(self.store.get(entry.provenance.result_id).verification_status.value, "STATE_CHECKED")

    def test_execute_and_trace_carry_cp_with_provenance(self) -> None:
        circuit = circ(2, gate("h", [0]), gate("h", [1]), cp(0, 1, 0.5))
        result = app_module.execute(ExecuteRequest(circuit=circuit, mode="statevector", backend="qiskit-aer"))
        self.assertEqual(result.verification_status, "STATE_CHECKED")
        trace = app_module.execute_trace(TraceRequest(circuit=circuit))
        self.assertEqual([s.operation.gate.value for s in trace.steps[1:]], ["h", "h", "cp"])
        self.assertEqual(trace.steps[-1].operation.params, [0.5])
        self.assertEqual({s.provenance.verification_status for s in trace.steps}, {"STATE_CHECKED"})

    def test_a_cp_circuit_with_a_backend_that_cannot_run_it_is_a_structured_refusal(self) -> None:
        limited = {**SUPPORTED_GATES, "cirq": frozenset(g for g in GateName if g is not GateName.CP)}
        with patch.object(capabilities, "SUPPORTED_GATES", limited):
            with self.assertRaises(HTTPException) as raised:
                app_module.execute(ExecuteRequest(circuit=circ(2, cp(0, 1, 0.5)), mode="statevector", backend="cirq"))
        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(raised.exception.detail["code"], "BACKEND_GATE_UNSUPPORTED")
        self.assertEqual(raised.exception.detail["gates"], ["cp"])


class TestGateSupportReporting(unittest.TestCase):
    def test_every_backend_declares_cp(self) -> None:
        for backend, gates in SUPPORTED_GATES.items():
            self.assertIn(GateName.CP, gates, backend)
            check_gate_support(circ(2, cp(0, 1, 0.5)), backend)

    def test_an_unknown_backend_supports_nothing_not_even_cp(self) -> None:
        with self.assertRaises(UnsupportedGate) as raised:
            check_gate_support(circ(2, cp(0, 1, 0.5)), "made-up-backend")
        self.assertEqual(raised.exception.gates, ["cp"])


class TestGeneratedPrograms(unittest.TestCase):
    def test_each_framework_renders_cp_with_the_control_first_and_the_angle(self) -> None:
        circuit = circ(3, cp(2, 0, 0.5))
        self.assertIn("qc.cp(0.5, 2, 0)", generate_code(circuit, "qiskit"))
        self.assertIn("cirq.cphase(0.5)(q[2], q[0])", generate_code(circuit, "cirq"))
        self.assertIn("qml.ControlledPhaseShift(0.5, wires=[2, 0])", generate_code(circuit, "pennylane"))

    def test_the_programs_are_only_allow_listed_calls(self) -> None:
        for theta in (0.5, -1.0, 1e-05, 3.0):
            for framework in ("qiskit", "cirq", "pennylane"):
                assert_only_a_fixed_template(self, generate_code(circ(3, cp(0, 2, theta)), framework), f"cp {theta}/{framework}")
                ast.parse(generate_code(circ(3, cp(0, 2, theta)), framework))


class TestEquivalenceAndOptimizer(_Backends):
    def test_cp_pi_is_cz_and_cp_is_symmetric_and_opposite_angles_cancel(self) -> None:
        cases = [
            (circ(2, cp(0, 1, math.pi)), circ(2, gate("cz", [1], [0])), EquivalenceStatus.EQUIVALENT),
            (circ(2, cp(0, 1, 0.7)), circ(2, cp(1, 0, 0.7)), EquivalenceStatus.EQUIVALENT),
            (circ(2, cp(0, 1, 0.7), cp(0, 1, -0.7)), circ(2), EquivalenceStatus.EQUIVALENT),
            (circ(2, cp(0, 1, 0.7)), circ(2, cp(0, 1, 0.8)), EquivalenceStatus.NOT_EQUIVALENT),
            (circ(2, cp(0, 1, math.pi / 2)), circ(2, gate("cz", [1], [0])), EquivalenceStatus.NOT_EQUIVALENT),
            (circ(2, cp(0, 1, 0.7)), circ(2), EquivalenceStatus.NOT_EQUIVALENT),
        ]
        for a, b, expected in cases:
            self.assertEqual(check_equivalence(a, b).status, expected, to_qasm3(a) + to_qasm3(b))

    def test_the_optimizer_has_no_cp_rule_so_it_leaves_cp_alone_rather_than_guessing(self) -> None:
        for circuit in (circ(2, cp(0, 1, 0.7), cp(0, 1, -0.7)), circ(2, cp(0, 1, 0.3), cp(0, 1, 0.4)), circ(2, cp(0, 1, 0.0))):
            report = optimize_circuit(circuit)
            self.assertEqual(report.status, OptimizationStatus.NO_OPTIMIZATION_FOUND)
            self.assertIsNone(report.candidate_circuit)

    def test_cp_inside_a_circuit_the_optimizer_does_shorten_is_preserved_and_verified(self) -> None:
        circuit = circ(2, gate("h", [0]), gate("h", [0]), cp(0, 1, 0.7))
        report = optimize_circuit(circuit)
        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertEqual([op.gate.value for op in report.candidate_circuit.ops], ["cp"])
        self.assertEqual(report.candidate_circuit.ops[0].params, [0.7])


class TestTheTutorKeepsTheAngle(unittest.TestCase):
    def test_operations_are_described_with_control_target_and_angle(self) -> None:
        self.assertEqual(_describe_op(cp(0, 1, 0.5)), "cp(control=q0, target=q1, angle=0.500000)")
        self.assertEqual(describe_op(cp(0, 1, 0.5)), "cp(control=q0, target=q1, angle=0.500000)")
        self.assertEqual(_describe_op(gate("cx", [1], [0])), "cx(control=q0, target=q1)")  # wording unchanged
        self.assertEqual(describe_op(gate("cz", [1], [0])), "cz(control=q0, target=q1)")

    def test_two_cps_that_differ_only_in_angle_are_described_differently(self) -> None:
        self.assertNotEqual(_describe_op(cp(0, 1, 0.5)), _describe_op(cp(0, 1, 0.6)))
        self.assertNotEqual(describe_op(cp(0, 1, 0.5)), describe_op(cp(0, 1, 0.6)))

    def test_the_trace_note_exists_and_quotes_no_value_from_a_run(self) -> None:
        note = GATE_NOTES["cp"]
        self.assertIn("both qubits are 1", note)
        self.assertNotRegex(note, r"\d\.\d")


if __name__ == "__main__":
    unittest.main()
