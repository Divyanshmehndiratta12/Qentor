"""The educational rewrite examples (fixtures/optimizer_examples.json) against the REAL optimiser and equivalence checker.

The examples are circuits plus words; what the optimiser does with each is decided here by running it, so a description that promises a
rewrite the optimiser does not make (or a rule that stops matching) fails this test. Only rules the optimiser already implements are used.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.aer import AerAdapter
from qentor.verification.equivalence import EquivalenceStatus, check_equivalence
from qentor.verification.optimizer import OptimizationStatus, generate_candidate, optimize_circuit

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "optimizer_examples.json"
EXAMPLES = json.loads(FIXTURE.read_text(encoding="utf-8"))["examples"]
AER = AerAdapter()


def circuit(example: dict) -> Circuit:
    return Circuit.model_validate(example["circuit"])


class TestTheExamplesDoWhatTheyPromise(unittest.TestCase):
    def test_there_are_three_examples_with_distinct_ids(self) -> None:
        self.assertEqual([e["id"] for e in EXAMPLES], ["two-hadamards-cancel", "rotations-merge", "no-rule-matches"])

    def test_each_runs_through_the_real_optimiser_to_the_stated_status_counts_and_rule(self) -> None:
        for example in EXAMPLES:
            report = optimize_circuit(circuit(example), adapter=AER, record_execution=None)
            self.assertEqual(report.status.value, example["expected_status"], example["id"])
            self.assertEqual([report.original_op_count, report.candidate_op_count], example["expected_op_counts"], example["id"])
            if example["expected_rule_contains"]:
                self.assertTrue(any(example["expected_rule_contains"] in rule for rule in report.rules_applied), (example["id"], report.rules_applied))
            else:
                self.assertEqual(report.rules_applied, [], example["id"])

    def test_the_two_rewrites_are_verified_by_the_equivalence_checker_not_by_their_rule(self) -> None:
        for example in EXAMPLES[:2]:
            original = circuit(example)
            report = optimize_circuit(original)
            self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER, example["id"])
            self.assertEqual(report.equivalence.status, EquivalenceStatus.EQUIVALENT)
            # recompute the verdict independently of the optimiser's own report
            self.assertEqual(check_equivalence(original, report.candidate_circuit).status, EquivalenceStatus.EQUIVALENT)
            self.assertLess(len(report.candidate_circuit.ops), len(original.ops))
            self.assertTrue(report.changes and any(c.kind == "removed" for c in report.changes))
            self.assertTrue(all(note.explanation for note in report.rule_notes), "each rule that fired has a sentence")

    def test_h_then_h_removes_exactly_the_two_hadamards_and_keeps_the_cx(self) -> None:
        report = optimize_circuit(circuit(EXAMPLES[0]))
        self.assertEqual([op.gate.value for op in report.candidate_circuit.ops], ["cx"])
        self.assertEqual([c.kind for c in report.changes], ["removed", "removed", "kept"])

    def test_two_rz_become_one_rz_with_the_summed_angle(self) -> None:
        report = optimize_circuit(circuit(EXAMPLES[1]))
        self.assertEqual([op.gate.value for op in report.candidate_circuit.ops], ["h", "rz", "cx"])
        merged = report.candidate_circuit.ops[1]
        self.assertAlmostEqual(merged.params[0], 0.5 + 0.25, places=12)  # angle arithmetic, the rule's own statement

    def test_the_no_rule_example_really_is_reducible_so_the_lesson_is_honest(self) -> None:
        # H X H has a shorter equivalent (Z): the optimiser proposes nothing because it has no rule, not because there is nothing to find.
        original = circuit(EXAMPLES[2])
        shorter = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="z", targets=[0])])
        self.assertEqual(check_equivalence(original, shorter).status, EquivalenceStatus.EQUIVALENT)
        candidate, rules = generate_candidate(original)
        self.assertEqual((candidate.ops, rules), (original.ops, []))
        report = optimize_circuit(original)
        self.assertEqual(report.status, OptimizationStatus.NO_OPTIMIZATION_FOUND)
        self.assertIsNone(report.candidate_circuit)
        self.assertIsNone(report.equivalence)


class TestTheOtherVerdictsAreStillReachedHonestly(unittest.TestCase):
    """The panel explains four outcomes. Two come from the examples; these pin the other two paths on the real checker."""

    def test_a_rewrite_the_checker_cannot_vouch_for_is_unverifiable_and_withholds_the_candidate(self) -> None:
        # a measurement followed by gates: the optimiser finds X X to cancel, the equivalence checker refuses a mid-circuit measurement
        original = Circuit(
            num_qubits=2,
            num_clbits=1,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="x", targets=[1]),
                GateOp(gate="x", targets=[1]),
            ],
        )
        report = optimize_circuit(original)
        self.assertEqual(report.status, OptimizationStatus.UNVERIFIABLE)
        self.assertIsNone(report.candidate_circuit)
        self.assertEqual(report.changes, [])
        self.assertTrue(report.reason)

    def test_a_wrong_rewrite_is_not_equivalent_so_it_could_never_be_accepted(self) -> None:
        # what the REJECTED path guards against: a candidate that drops a gate that mattered
        original = circuit(EXAMPLES[0])
        wrong = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])  # lost the CX
        self.assertEqual(check_equivalence(original, wrong).status, EquivalenceStatus.NOT_EQUIVALENT)

    def test_an_unchanged_circuit_is_not_reported_as_improved(self) -> None:
        report = optimize_circuit(Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0])]))
        self.assertEqual(report.status, OptimizationStatus.NO_OPTIMIZATION_FOUND)
        self.assertEqual((report.original_op_count, report.candidate_op_count), (1, 1))


if __name__ == "__main__":
    unittest.main()
