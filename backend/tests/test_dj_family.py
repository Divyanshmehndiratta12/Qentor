"""The Deutsch-Jozsa n=3 oracle family: 72 oracles = 2 constant + C(8,4) = 70 balanced (VERIFICATION_ARCHITECTURE §4.2).

Every behavioural assertion is read from the real Aer adapter (or Cirq). The scripted adapters in this file only prove
that the sweep reports what a backend returned instead of what it expects.
"""

from __future__ import annotations

import time
import unittest
from itertools import combinations

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.verification import dj_family as dj
from qentor.verification.multi_input_harness import project_distribution

from .trace_fakes import ScriptedAdapter, make_result

FAMILY = dj.build_family()


def _by_table(table: str) -> dj.DJOracle:
    return next(o for o in FAMILY if o.truth_table == table)


class TestFamilyDefinition(unittest.TestCase):
    def test_family_is_exactly_72_made_of_2_constant_and_70_balanced(self) -> None:
        self.assertEqual(len(FAMILY), 72)
        self.assertEqual(sum(o.kind == "constant" for o in FAMILY), 2)
        self.assertEqual(sum(o.kind == "balanced" for o in FAMILY), 70)
        self.assertEqual(len(list(combinations(range(8), 4))), 70)  # C(8,4), the number the requirement names

    def test_the_two_constants_are_all_zero_and_all_one(self) -> None:
        self.assertEqual([o.truth_table for o in FAMILY if o.kind == "constant"], ["00000000", "11111111"])

    def test_every_balanced_table_has_exactly_four_ones_and_all_72_tables_are_distinct(self) -> None:
        for o in FAMILY:
            if o.kind == "balanced":
                self.assertEqual(sum(o.outputs), 4, o.truth_table)
        self.assertEqual(len({o.truth_table for o in FAMILY}), 72)
        self.assertEqual([o.index for o in FAMILY], list(range(72)))

    def test_every_oracle_uses_only_the_documented_construction(self) -> None:
        # multi-controlled X as a Toffoli ladder through ONE clean work qubit, X gates only on input wires
        for o in FAMILY:
            for op in dj.oracle_ops(o):
                self.assertIn(op.gate.value, ("x", "ccx"), o.truth_table)
                if op.gate.value == "x":
                    self.assertIn(op.targets[0], dj.INPUT_QUBITS)
        self.assertEqual(dj.oracle_ops(_by_table("00000000")), [])  # constant 0: nothing to flip

    def test_a_function_outside_the_promise_is_refused_not_generated(self) -> None:
        for bad in [(1, 0, 0, 0, 0, 0, 0, 0), (1, 1, 1, 0, 0, 0, 0, 0), (1, 1, 1, 1, 1, 1, 1, 0), (0,) * 7, (0, 2) + (0,) * 6]:
            with self.assertRaises(ValueError, msg=str(bad)):
                dj.classify(bad)


class TestBitOrderIsPinned(unittest.TestCase):
    def test_truth_table_index_is_the_integer_q2q1q0(self) -> None:
        f_is_q0 = _by_table("01010101")  # f(x) = q0
        self.assertEqual(f_is_q0.as_mapping()["001"], 1)  # q0 set
        self.assertEqual(f_is_q0.as_mapping()["010"], 0)  # q1 set
        self.assertEqual(f_is_q0.as_mapping()["100"], 0)  # q2 set
        f_is_q2 = _by_table("00001111")  # f(x) = q2
        self.assertEqual(f_is_q2.as_mapping()["100"], 1)
        self.assertEqual(f_is_q2.as_mapping()["001"], 0)

    def test_the_backend_flips_the_ancilla_exactly_where_the_wire_order_says(self) -> None:
        aer = AerAdapter()
        # f(x) = q0, input x = "001": X on q0 only, then the oracle. Expect q3 = 1 and q0 = 1: basis state index
        # 2^3 + 2^0 = 9, displayed q4 q3 q2 q1 q0 = "01001".
        circuit = Circuit(num_qubits=5, num_clbits=0, ops=[GateOp(gate="x", targets=[0]), *dj.oracle_ops(_by_table("01010101"))])
        result = aer.run(circuit, "statevector")
        distribution = project_distribution(result.statevector, [4, 3, 2, 1, 0])
        self.assertEqual(set(distribution), {"01001"})
        self.assertAlmostEqual(distribution["01001"], 1.0, places=9)
        # the same input on f(x) = q2 must NOT flip the ancilla: "00001"
        circuit2 = Circuit(num_qubits=5, num_clbits=0, ops=[GateOp(gate="x", targets=[0]), *dj.oracle_ops(_by_table("00001111"))])
        distribution2 = project_distribution(aer.run(circuit2, "statevector").statevector, [4, 3, 2, 1, 0])
        self.assertEqual(set(distribution2), {"00001"})

    def test_the_harness_expectation_string_is_work_ancilla_then_x(self) -> None:
        # For f = q0 and input "011" the expected output over q4 q3 q2 q1 q0 is work "0", ancilla f(3)=1, x "011".
        oracle = _by_table("01010101")
        report = dj.check_oracle_behaviour(oracle, AerAdapter())
        self.assertTrue(report.passed)
        # reading the same table with the opposite index order is a different function (not q0), and the circuit of
        # f = q0 must fail against it on every input
        reversed_reading = dj.DJOracle(index=oracle.index, kind=oracle.kind, outputs=tuple(reversed(oracle.outputs)))
        self.assertEqual(reversed_reading.truth_table, "10101010")
        failed = dj.check_oracle_behaviour(reversed_reading, AerAdapter(), dj.oracle_circuit(oracle))
        self.assertFalse(failed.passed)
        self.assertEqual(len(failed.failing_inputs), 8)


class TestReferenceSolutionPassesAll72OnTheBackend(unittest.TestCase):
    def test_aer_sweep(self) -> None:
        started = time.monotonic()
        report = dj.run_family_sweep(AerAdapter())
        elapsed = time.monotonic() - started
        self.assertEqual((report.total, report.constant, report.balanced), (72, 2, 70))
        self.assertEqual(report.oracle_failures, [])
        self.assertEqual(report.passed, 72)
        self.assertTrue(report.all_passed)
        self.assertEqual(report.counterexamples, [])
        for verdict in report.verdicts:
            self.assertEqual(verdict.decision, verdict.kind, verdict.truth_table)
            if verdict.kind == "constant":
                self.assertAlmostEqual(verdict.probability_000, 1.0, places=9)
            else:
                self.assertAlmostEqual(verdict.probability_000, 0.0, places=9)
        self.assertEqual(report.backend, "qiskit-aer")
        self.assertLess(elapsed, 120, "72 oracles x (8 basis inputs + 1 algorithm run) should take seconds, not minutes")

    def test_cirq_agrees(self) -> None:
        report = dj.run_family_sweep(CirqAdapter(), check_oracles=False)
        self.assertEqual(report.passed, 72)
        self.assertEqual([v.decision for v in report.verdicts], [v.kind for v in report.verdicts])

    def test_each_run_is_recorded_with_its_own_circuit_hash(self) -> None:
        seen: list[str] = []

        def record(result, digest: str) -> str:
            seen.append(digest)
            return f"r{len(seen)}"

        report = dj.run_family_sweep(AerAdapter(), check_oracles=False, record_execution=record)
        self.assertEqual(len(seen), 72)
        self.assertEqual(len(set(seen)), 72)  # 72 different circuits
        self.assertEqual([v.circuit_hash for v in report.verdicts], seen)
        self.assertTrue(all(v.result_id for v in report.verdicts))


class TestABrokenOracleStructureFails(unittest.TestCase):
    def _ops_without(self, oracle: dj.DJOracle, drop: int) -> Circuit:
        ops = dj.oracle_ops(oracle)
        return Circuit(num_qubits=5, num_clbits=0, ops=[op for i, op in enumerate(ops) if i != drop])

    def test_dropping_a_toffoli_changes_the_behaviour_and_is_caught(self) -> None:
        oracle = _by_table("00001111")
        ops = dj.oracle_ops(oracle)
        index_of_ancilla_flip = next(i for i, op in enumerate(ops) if op.gate.value == "ccx" and op.targets == [dj.ANCILLA])
        report = dj.check_oracle_behaviour(oracle, AerAdapter(), self._ops_without(oracle, index_of_ancilla_flip))
        self.assertFalse(report.passed)
        self.assertEqual(report.failing_inputs, ["100"])  # the first minterm of f = q2 (x = 4)

    def test_forgetting_to_uncompute_the_work_qubit_is_caught(self) -> None:
        oracle = _by_table("00001111")
        ops = dj.oracle_ops(oracle)
        first_uncompute = next(i for i, op in enumerate(ops) if op.gate.value == "ccx" and op.targets == [dj.WORK] and i > 0 and ops[i - 1].targets == [dj.ANCILLA])
        report = dj.check_oracle_behaviour(oracle, AerAdapter(), self._ops_without(oracle, first_uncompute))
        self.assertFalse(report.passed)
        # the ancilla is right but the work qubit stays 1: the observed distribution has q4 = 1
        for distribution in report.observed.values():
            self.assertTrue(all(bits[0] == "1" for bits in distribution), distribution)

    def test_a_wrong_control_wire_is_caught(self) -> None:
        oracle = _by_table("01010101")
        ops = dj.oracle_ops(oracle)
        broken = [GateOp(gate=op.gate, targets=op.targets, controls=[0, 2]) if op.controls == [0, 1] else op for op in ops]
        report = dj.check_oracle_behaviour(oracle, AerAdapter(), Circuit(num_qubits=5, num_clbits=0, ops=broken))
        self.assertFalse(report.passed)

    def test_the_sweep_reports_the_broken_oracle_by_index_and_not_the_others(self) -> None:
        target = _by_table("00110011")

        def build_oracle(o: dj.DJOracle) -> Circuit:
            if o.index == target.index:
                ops = dj.oracle_ops(o)
                return Circuit(num_qubits=5, num_clbits=0, ops=ops[:-3])  # lose the last minterm's ladder
            return dj.oracle_circuit(o)

        report = dj.run_family_sweep(AerAdapter(), build_oracle=build_oracle)
        self.assertEqual(report.oracle_failures, [target.index])
        self.assertFalse(report.all_passed)


class TestChangingAnExpectedResultFails(unittest.TestCase):
    def test_an_oracle_whose_declared_truth_table_differs_in_one_input_fails_on_that_input(self) -> None:
        oracle = _by_table("01010101")
        flipped = list(oracle.outputs)
        flipped[5] ^= 1  # claim f(101) is different from what the circuit does
        claimed = dj.DJOracle(index=oracle.index, kind=oracle.kind, outputs=tuple(flipped))
        report = dj.check_oracle_behaviour(claimed, AerAdapter(), dj.oracle_circuit(oracle))
        self.assertFalse(report.passed)
        self.assertEqual(report.failing_inputs, ["101"])

    def test_expecting_balanced_where_the_backend_says_constant_is_a_counterexample(self) -> None:
        # Feed oracle 0 (constant 0) the circuit of a balanced oracle: the algorithm correctly says "balanced", which
        # is wrong for oracle 0, so exactly that verdict fails and carries the measured distribution.
        balanced = _by_table("00001111")
        report = dj.run_family_sweep(
            AerAdapter(),
            check_oracles=False,
            build_algorithm=lambda o: dj.reference_algorithm(balanced if o.index == 0 else o),
        )
        self.assertEqual(report.passed, 71)
        [counterexample] = report.counterexamples
        self.assertEqual(counterexample.index, 0)
        self.assertEqual(counterexample.truth_table, "00000000")
        self.assertEqual(counterexample.kind, "constant")
        self.assertEqual(counterexample.decision, "balanced")
        self.assertNotIn("000", counterexample.input_distribution)

    def test_the_decision_thresholds(self) -> None:
        self.assertEqual(dj.decide(1.0), "constant")
        self.assertEqual(dj.decide(0.0), "balanced")
        self.assertEqual(dj.decide(0.125), "ambiguous")
        self.assertEqual(dj.decide(1 - 1e-6), "ambiguous")


class TestKnownBuggyAlgorithmsFail(unittest.TestCase):
    def test_no_final_hadamards_fails_every_oracle_as_ambiguous(self) -> None:
        def build(o: dj.DJOracle) -> Circuit:
            ref = dj.reference_algorithm(o)
            return Circuit(num_qubits=5, num_clbits=0, ops=ref.ops[: len(ref.ops) - 3])

        report = dj.run_family_sweep(AerAdapter(), check_oracles=False, build_algorithm=build)
        self.assertEqual(report.passed, 0)
        self.assertEqual({v.decision for v in report.verdicts}, {"ambiguous"})
        for verdict in report.verdicts:
            self.assertAlmostEqual(verdict.probability_000, 1 / 8, places=9)

    def test_ancilla_left_in_zero_never_sees_a_balanced_function(self) -> None:
        def build(o: dj.DJOracle) -> Circuit:
            ref = dj.reference_algorithm(o)
            return Circuit(num_qubits=5, num_clbits=0, ops=ref.ops[1:])  # drop the X on the ancilla: no phase kickback

        report = dj.run_family_sweep(AerAdapter(), check_oracles=False, build_algorithm=build)
        self.assertEqual(report.passed, 2)  # only the two constants survive: everything is called constant
        self.assertTrue(all(v.decision == "constant" for v in report.verdicts))
        self.assertEqual({v.kind for v in report.counterexamples}, {"balanced"})
        self.assertEqual(len(report.counterexamples), 70)


class TestResultsComeFromTheBackendNotFromTheSweep(unittest.TestCase):
    def test_a_backend_that_always_returns_the_zero_state_makes_the_balanced_cases_fail(self) -> None:
        zero_state = [[1.0, 0.0]] + [[0.0, 0.0]] * 31
        adapter = ScriptedAdapter(lambda i, c: make_result(zero_state))
        report = dj.run_family_sweep(adapter, check_oracles=False)
        self.assertEqual(report.passed, 2)
        self.assertEqual(len(report.counterexamples), 70)

    def test_a_backend_that_cannot_run_is_reported_as_an_error_never_a_pass(self) -> None:
        def unavailable(i, c):
            raise AdapterUnavailable("no backend here")

        report = dj.run_family_sweep(ScriptedAdapter(unavailable), check_oracles=False)
        self.assertEqual(report.passed, 0)
        self.assertFalse(report.all_passed)
        self.assertTrue(all(v.decision is None and v.error and "no backend here" in v.error for v in report.verdicts))


if __name__ == "__main__":
    unittest.main()
