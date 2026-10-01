"""Optimization as a learning workflow: the operation-level diff, the sentence behind each rule, the report the learner sees, and the
challenge "Shorten it without changing it".

The rule that runs through all of it: whether a shorter circuit is the same circuit is decided by the backend's operator-equivalence
checker, never by the optimizer's own rules, a language model or the browser. A rewrite rule that is wrong is caught and discarded;
a learner's shorter circuit that is not equivalent does not pass.
"""

from __future__ import annotations

import ast
import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ChallengeSubmitRequest, OptimizeRequest
from qentor.challenges import CHALLENGE_BY_ID, CHALLENGES, evaluate_challenge, public_view
from qentor.challenges.content import circ, g
from qentor.challenges.models import Challenge, Constraints, EquivalentTo
from qentor.circuit.describe import describe_op
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.aer import AerAdapter
from qentor.verification import optimizer as optimizer_module
from qentor.verification.equivalence import EquivalenceReport, EquivalenceStatus
from qentor.verification.optimizer import OpChange, OptimizationStatus, diff_ops, explain_rule, generate_candidate, optimize_circuit
from tests.test_challenges import ApiCase, outcome

AER = AerAdapter()
BACKEND = Path(__file__).resolve().parents[1]
CHALLENGE = CHALLENGE_BY_ID["optimize-redundant"]
STARTER = CHALLENGE.starter_circuit
REFERENCE = [g("h", 0), g("cx", 1, 0), g("rz", 1, angle=0.75)]


def judge(circuit: Circuit):
    return evaluate_challenge(CHALLENGE, circuit, AER, max_qubits=8, max_operations=64)


def circuit_of(*ops: GateOp, n: int = 2) -> Circuit:
    return Circuit(num_qubits=n, num_clbits=0, ops=list(ops))


H0, H1, X0, X1, Z0 = g("h", 0), g("h", 1), g("x", 0), g("x", 1), g("z", 0)


class TestDescribeOp(unittest.TestCase):
    def test_structure_only_for_every_kind_of_gate(self) -> None:
        cases = {
            "h on q[0]": g("h", 0),
            "cx control q[0], target q[1]": g("cx", 1, 0),
            "cz control q[2], target q[0]": g("cz", 0, 2),
            "rz(0.5) on q[1]": g("rz", 1, angle=0.5),
            "cp(0.25) control q[0], target q[1]": GateOp(gate=GateName.CP, controls=[0], targets=[1], params=[0.25]),
            "ccx controls q[0], q[1], target q[2]": GateOp(gate=GateName.CCX, controls=[0, 1], targets=[2]),
            "swap q[0] and q[2]": GateOp(gate=GateName.SWAP, targets=[0, 2]),
            "measure q[1] into c[0]": GateOp(gate=GateName.MEASURE, targets=[1], clbits=[0]),
        }
        for expected, op in cases.items():
            self.assertEqual(describe_op(op), expected)

    def test_it_says_nothing_about_an_effect(self) -> None:
        special = {
            GateName.CX: g("cx", 1, 0), GateName.CZ: g("cz", 1, 0), GateName.RX: g("rx", 0, angle=1.0), GateName.RY: g("ry", 0, angle=1.0),
            GateName.RZ: g("rz", 0, angle=1.0), GateName.CP: GateOp(gate=GateName.CP, controls=[0], targets=[1], params=[1.0]),
            GateName.SWAP: GateOp(gate=GateName.SWAP, targets=[0, 1]), GateName.CCX: GateOp(gate=GateName.CCX, controls=[0, 1], targets=[2]),
            GateName.MEASURE: GateOp(gate=GateName.MEASURE, targets=[0], clbits=[0]),
        }
        for gate in GateName:
            op = special.get(gate) or GateOp(gate=gate, targets=[0])
            self.assertNotRegex(describe_op(op), r"(?i)verif|equivalent|correct|probab|state of")


class TestDiff(unittest.TestCase):
    def kinds(self, a: Circuit, b: Circuit) -> list[str]:
        return [c.kind for c in diff_ops(a, b)]

    def test_identical_circuits_are_all_kept(self) -> None:
        c = circuit_of(H0, g("cx", 1, 0), X1)
        self.assertEqual(self.kinds(c, c), ["kept", "kept", "kept"])
        self.assertEqual([(c.original_index, c.candidate_index) for c in diff_ops(c, c)], [(0, 0), (1, 1), (2, 2)])

    def test_a_cancelled_pair_shows_as_two_removed(self) -> None:
        changes = diff_ops(circuit_of(H0, H0, X1), circuit_of(X1))
        self.assertEqual([(c.kind, c.description) for c in changes], [("removed", "h on q[0]"), ("removed", "h on q[0]"), ("kept", "x on q[1]")])

    def test_a_merged_rotation_shows_as_the_two_removed_and_the_one_added(self) -> None:
        a = circuit_of(g("rz", 0, angle=0.5), g("rz", 0, angle=0.25))
        b = circuit_of(g("rz", 0, angle=0.75))
        self.assertEqual(sorted((c.kind, c.description) for c in diff_ops(a, b)), [("added", "rz(0.75) on q[0]"), ("removed", "rz(0.25) on q[0]"), ("removed", "rz(0.5) on q[0]")])

    def test_everything_removed_and_everything_added(self) -> None:
        self.assertEqual(self.kinds(circuit_of(H0, X1), circuit_of()), ["removed", "removed"])
        self.assertEqual(self.kinds(circuit_of(), circuit_of(H0, X1)), ["added", "added"])
        self.assertEqual(diff_ops(circuit_of(), circuit_of()), [])

    def test_indexes_name_the_operations_they_describe(self) -> None:
        a, b = circuit_of(H0, X1, Z0), circuit_of(H0, Z0)
        for change in diff_ops(a, b):
            if change.kind == "kept":
                self.assertEqual(a.ops[change.original_index], b.ops[change.candidate_index])
            elif change.kind == "removed":
                self.assertIsNone(change.candidate_index)
                self.assertEqual(describe_op(a.ops[change.original_index]), change.description)
            else:
                self.assertIsNone(change.original_index)
                self.assertEqual(describe_op(b.ops[change.candidate_index]), change.description)

    def test_the_diff_always_reconstructs_both_circuits_exactly(self) -> None:
        """Property: for any two circuits, kept+removed in order is the original and kept+added in order is the candidate."""
        palette = [H0, H1, X0, X1, Z0, g("cx", 1, 0), g("cx", 0, 1), g("rz", 0, angle=0.5), g("s", 1)]
        seed = 7

        def rand(n: int) -> int:
            nonlocal seed
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            return seed % n

        for _ in range(300):
            a = circuit_of(*[palette[rand(len(palette))] for _ in range(rand(9))])
            b = circuit_of(*[palette[rand(len(palette))] for _ in range(rand(9))])
            changes = diff_ops(a, b)
            original = [a.ops[c.original_index] for c in changes if c.kind in ("kept", "removed")]
            candidate = [b.ops[c.candidate_index] for c in changes if c.kind in ("kept", "added")]
            self.assertEqual(original, a.ops)
            self.assertEqual(candidate, b.ops)
            kept = [c for c in changes if c.kind == "kept"]
            self.assertEqual([c.original_index for c in kept], sorted(c.original_index for c in kept))  # kept operations keep their order
            self.assertEqual([c.candidate_index for c in kept], sorted(c.candidate_index for c in kept))

    def test_the_diff_keeps_as_much_as_possible(self) -> None:
        """It must not report an operation as removed-and-added when it is in both circuits: the kept count is the longest common
        subsequence, computed here independently by a different (memoised, recursive) method."""
        from functools import lru_cache

        def longest_common(a: list[GateOp], b: list[GateOp]) -> int:
            @lru_cache(maxsize=None)
            def go(i: int, j: int) -> int:
                if i == len(a) or j == len(b):
                    return 0
                if a[i] == b[j]:
                    return 1 + go(i + 1, j + 1)
                return max(go(i + 1, j), go(i, j + 1))

            return go(0, 0)

        # the cases a greedy or length-based walk gets wrong
        a, b = circuit_of(H0, X1), circuit_of(X1, Z0, H1, X0)
        self.assertEqual(sum(c.kind == "kept" for c in diff_ops(a, b)), 1)
        self.assertEqual([c.description for c in diff_ops(a, b) if c.kind == "kept"], ["x on q[1]"])
        palette = [H0, H1, X0, X1, Z0, g("cx", 1, 0), g("rz", 0, angle=0.5)]
        seed = 11

        def rand(n: int) -> int:
            nonlocal seed
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            return seed % n

        for _ in range(300):
            a = circuit_of(*[palette[rand(len(palette))] for _ in range(rand(9))])
            b = circuit_of(*[palette[rand(len(palette))] for _ in range(rand(9))])
            self.assertEqual(sum(c.kind == "kept" for c in diff_ops(a, b)), longest_common(a.ops, b.ops))

    def test_the_diff_is_deterministic(self) -> None:
        a, b = circuit_of(H0, H0, X1, g("cx", 1, 0)), circuit_of(X1, g("cx", 1, 0))
        self.assertEqual(diff_ops(a, b), diff_ops(a, b))


class TestRuleNotes(unittest.TestCase):
    def test_every_rule_the_optimizer_can_log_has_a_sentence(self) -> None:
        rules = {
            "cancelled adjacent h pair on qubit(s) [0]": "Applying H twice",
            "cancelled adjacent x pair on qubit(s) [1]": "Applying X twice",
            "cancelled adjacent cx pair on qubit(s) [0, 1]": "Applying CX twice",
            "cancelled adjacent sdg pair on qubit(s) [1]": "followed by its inverse",
            "cancelled adjacent tdg pair on qubit(s) [0]": "followed by its inverse",
            "merged adjacent rz ops on qubit(s) [1]": "add their angles",
            "merged adjacent rx ops on qubit(s) [0]": "Two RX rotations",
            "removed zero-angle ry on qubit 0": "angle of zero",
        }
        for rule, fragment in rules.items():
            with self.subTest(rule=rule):
                self.assertIn(fragment, explain_rule(rule) or "")

    def test_the_rules_that_really_fire_are_all_explained(self) -> None:
        circuits = [
            circuit_of(H0, H0, X1, X1, g("s", 0), g("sdg", 0), g("t", 1), g("tdg", 1)),
            circuit_of(g("rx", 0, angle=0.5), g("rx", 0, angle=0.5), g("ry", 1, angle=0.0), g("cx", 1, 0), g("cx", 1, 0), g("cz", 1, 0), g("cz", 0, 1)),
        ]
        for c in circuits:
            _, rules = generate_candidate(c)
            self.assertTrue(rules)
            for rule in rules:
                self.assertIsNotNone(explain_rule(rule), rule)

    def test_a_string_that_is_not_one_of_ours_gets_no_invented_explanation(self) -> None:
        for text in ("", "did something clever", "cancelled adjacent frobnicate pair", "merged adjacent h ops", "removed zero-angle h on qubit 0"):
            self.assertIsNone(explain_rule(text), text)

    def test_the_sentences_never_claim_a_verdict_a_result_or_a_number_about_the_circuit(self) -> None:
        for rule in ("cancelled adjacent h pair on qubit(s) [0]", "cancelled adjacent sdg pair on qubit(s) [0]", "merged adjacent rz ops on qubit(s) [1]", "removed zero-angle rx on qubit 0"):
            sentence = explain_rule(rule)
            self.assertNotRegex(sentence, r"(?i)verified|equivalent|correct|passes|probab|amplitude|\d")


class TestTheReport(unittest.TestCase):
    def test_the_challenge_starter_is_shortened_and_the_difference_is_the_servers(self) -> None:
        report = optimize_circuit(STARTER, adapter=AER, record_execution=lambda result, h: "res_x")
        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertEqual((report.original_op_count, report.candidate_op_count, report.operations_removed), (10, 3, 7))
        self.assertEqual(report.equivalence.status, EquivalenceStatus.EQUIVALENT)
        kinds = [c.kind for c in report.changes]
        self.assertEqual((kinds.count("kept"), kinds.count("removed"), kinds.count("added")), (2, 8, 1))  # H and CX kept; 7 gone, 2 rotations merged into 1
        self.assertTrue(all(note.explanation for note in report.rule_notes))
        self.assertEqual(len(report.rule_notes), len(report.rules_applied))

    def test_what_changed_adds_up(self) -> None:
        report = optimize_circuit(STARTER)
        removed = sum(c.kind == "removed" for c in report.changes)
        added = sum(c.kind == "added" for c in report.changes)
        kept = sum(c.kind == "kept" for c in report.changes)
        self.assertEqual(kept + removed, report.original_op_count)
        self.assertEqual(kept + added, report.candidate_op_count)

    def test_a_circuit_with_nothing_to_shorten_has_no_changes_and_no_notes(self) -> None:
        report = optimize_circuit(circuit_of(H0, g("cx", 1, 0)))
        self.assertEqual(report.status, OptimizationStatus.NO_OPTIMIZATION_FOUND)
        self.assertEqual((report.operations_removed, report.changes, report.rule_notes, report.candidate_circuit), (0, [], [], None))

    def test_a_candidate_the_checker_rejects_is_withheld_with_no_diff(self) -> None:
        def wrong(circuit: Circuit):
            return circuit_of(X0), ["cancelled adjacent h pair on qubit(s) [0]"]  # a "rewrite" that changes the circuit

        with patch.object(optimizer_module, "generate_candidate", wrong):
            report = optimize_circuit(circuit_of(H0, H0))
        self.assertEqual(report.status, OptimizationStatus.REJECTED)
        self.assertIsNone(report.candidate_circuit)
        self.assertEqual((report.changes, report.operations_removed), ([], 0))  # the discarded candidate is never described
        self.assertTrue(report.rule_notes)  # the rule's sentence is not a result, so it may stay

    def test_a_candidate_that_cannot_be_checked_is_withheld_with_no_diff(self) -> None:
        wide = Circuit(num_qubits=11, num_clbits=0, ops=[g("h", 0), g("h", 0)])
        report = optimize_circuit(wide)
        self.assertEqual(report.status, OptimizationStatus.UNVERIFIABLE)
        self.assertIsNone(report.candidate_circuit)
        self.assertEqual(report.changes, [])


class TestTheEndpoint(ApiCase):
    def optimize(self, circuit: Circuit):
        return app_module.optimize_endpoint(OptimizeRequest(circuit=circuit))

    def test_a_verified_shorter_answer_carries_the_diff_the_notes_the_count_and_the_provenance(self) -> None:
        response = self.optimize(STARTER)
        self.assertEqual(response.status, "VERIFIED_SHORTER")
        self.assertEqual((response.original_op_count, response.candidate_op_count, response.operations_removed), (10, 3, 7))
        self.assertEqual(response.equivalence.status, "EQUIVALENT")
        self.assertTrue(response.changes)
        self.assertTrue(all(n.explanation for n in response.rule_notes))
        provenance = response.candidate_provenance
        self.assertEqual(provenance.result_id, response.result_id)
        self.assertEqual((provenance.provenance_class, provenance.backend), ("SIMULATION", "qiskit-aer"))
        self.assertEqual(provenance.circuit_hash, response.candidate_circuit_hash)
        record = self.store.get(response.result_id)
        self.assertIsNotNone(record)
        self.assertEqual(record.circuit_hash, response.candidate_circuit_hash)

    def test_every_other_status_has_no_candidate_no_diff_and_no_provenance(self) -> None:
        response = self.optimize(circuit_of(H0, g("cx", 1, 0)))
        self.assertEqual(response.status, "NO_OPTIMIZATION_FOUND")
        self.assertEqual((response.candidate_circuit, response.changes, response.candidate_provenance, response.operations_removed), (None, [], None, 0))

    def test_the_response_has_no_field_through_which_anyone_else_could_decide_equivalence(self) -> None:
        payload = self.optimize(STARTER).model_dump(mode="json")
        for forbidden in ("passed", "verdict", "llm", "ai_says", "model"):
            self.assertNotIn(forbidden, payload)
        self.assertEqual(payload["verifier_name"], "qentor.verification.optimizer")
        with self.assertRaises(ValidationError):
            OptimizeRequest.model_validate({"circuit": STARTER.model_dump(by_alias=True), "equivalent": True})

    def test_the_wire_shape_for_the_browser(self) -> None:
        from tests.asgi_driver import http

        status, body = http("POST", "/api/optimize", json.dumps({"circuit": STARTER.model_dump(by_alias=True, mode="json")}).encode())
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["operations_removed"], 7)
        self.assertEqual({c["kind"] for c in data["changes"]}, {"kept", "removed", "added"})
        self.assertEqual(data["candidate_provenance"]["provenance_class"], "SIMULATION")


class TestTheChallenge(unittest.TestCase):
    def test_it_is_defined_and_linked(self) -> None:
        self.assertEqual(CHALLENGE.lesson_id, "interference")
        self.assertEqual(CHALLENGE.title, "Shorten it without changing it")
        self.assertEqual(len(STARTER.ops), 10)
        self.assertEqual(CHALLENGE.constraints.max_ops, 3)
        self.assertIsInstance(CHALLENGE.checks[0], EquivalentTo)
        self.assertGreaterEqual(len(CHALLENGE.hints), 3)
        self.assertIn(CHALLENGE, CHALLENGES)

    def test_the_reference_solution_passes_and_so_does_what_the_optimizer_finds(self) -> None:
        result = judge(CHALLENGE.reference_solution)
        self.assertTrue(result.passed, [(c.id, c.detail) for c in result.checks])
        self.assertEqual(outcome(result, "equivalent.to_start").label, "Does exactly what the starting circuit does")
        found = optimize_circuit(STARTER).candidate_circuit
        self.assertTrue(judge(found).passed)

    def test_the_starting_circuit_itself_fails_on_size_and_nothing_is_run(self) -> None:
        result = judge(STARTER)
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.size").passed)
        self.assertFalse(outcome(result, "equivalent.to_start").evaluated)
        self.assertIsNone(result.final_result_id)

    def test_an_obvious_wrong_answer_the_empty_circuit_fails_on_equivalence(self) -> None:
        result = judge(circuit_of())
        self.assertFalse(result.passed)
        self.assertTrue(outcome(result, "equivalent.to_start").evaluated)
        self.assertFalse(outcome(result, "equivalent.to_start").passed)
        self.assertIn("not do what the starting circuit does", outcome(result, "equivalent.to_start").detail)
        self.assertEqual(result.next_hint_index, 1)

    def test_shorter_but_not_the_same_circuit_does_not_pass(self) -> None:
        for name, ops in (
            ("rotation dropped", [H0, g("cx", 1, 0)]),
            ("wrong angle", [H0, g("cx", 1, 0), g("rz", 1, angle=0.5)]),
            ("control and target swapped", [H0, g("cx", 0, 1), g("rz", 1, angle=0.75)]),
            ("an H too many", [H0, H0, g("cx", 1, 0)]),
            ("wrong axis", [H0, g("cx", 1, 0), g("rx", 1, angle=0.75)]),
            ("all on one qubit", [H0, g("rz", 0, angle=0.75), X0]),
        ):
            with self.subTest(case=name):
                result = judge(circuit_of(*ops))
                self.assertFalse(result.passed)
                self.assertFalse(outcome(result, "equivalent.to_start").passed)

    def test_the_same_circuit_but_too_long_fails_on_size_alone(self) -> None:
        result = judge(circuit_of(H0, g("cx", 1, 0), g("rz", 1, angle=0.5), g("rz", 1, angle=0.25)))  # equivalent, 4 operations
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.size").passed)
        self.assertFalse(outcome(result, "equivalent.to_start").evaluated)  # structure is judged first; no state is looked at yet

    def test_a_gate_outside_the_toolbox_fails_structure(self) -> None:
        result = judge(circuit_of(H0, GateOp(gate=GateName.SWAP, targets=[0, 1]), g("rz", 1, angle=0.75)))
        self.assertFalse(outcome(result, "structure.gates").passed)

    def test_the_wrong_width_fails_structure(self) -> None:
        result = judge(Circuit(num_qubits=3, num_clbits=0, ops=[H0]))
        self.assertFalse(outcome(result, "structure.width").passed)

    def test_a_check_the_backend_cannot_decide_does_not_pass(self) -> None:
        undecided = EquivalenceReport(status=EquivalenceStatus.UNVERIFIABLE, method="m", global_phase=None, checks=[], reason="too large to check")
        with patch("qentor.challenges.evaluate.check_equivalence", return_value=undecided):
            result = judge(CHALLENGE.reference_solution)
        self.assertFalse(result.passed)
        self.assertIn("could not decide", outcome(result, "equivalent.to_start").detail)
        self.assertIn("too large to check", outcome(result, "equivalent.to_start").detail)

    def test_the_verdict_names_a_backend_step_of_the_learners_circuit(self) -> None:
        ids = iter(f"r{i}" for i in range(100))
        result = evaluate_challenge(CHALLENGE, CHALLENGE.reference_solution, AER, max_qubits=8, max_operations=64, record_execution=lambda r, h: next(ids))
        self.assertTrue(outcome(result, "equivalent.to_start").result_id.startswith("r"))
        self.assertEqual(outcome(result, "equivalent.to_start").result_id, result.final_result_id)

    def test_the_public_view_hides_the_target_and_the_reference(self) -> None:
        blob = json.dumps(public_view(CHALLENGE).model_dump(mode="json"))
        for forbidden in ("reference_solution", '"target"', "misconception", "equivalent_to"):
            self.assertNotIn(forbidden, blob)
        self.assertIn('"rz"', blob)  # the starter is public: it IS the question

    def test_a_check_target_of_the_wrong_width_is_refused_when_the_challenge_is_built(self) -> None:
        with self.assertRaisesRegex(ValueError, "uses a 3-qubit circuit"):
            Challenge(
                id="x", lesson_id="interference", title="t", goal="g", difficulty="beginner", success_condition="s",
                constraints=Constraints(num_qubits=2, allowed_gates=[GateName.H], max_ops=3), starter_circuit=circ(2, []),
                checks=[EquivalentTo(id="c", label="l", hint_index=0, misconception="m", experiment="e", target=Circuit(num_qubits=3, num_clbits=0, ops=[]))],
                hints=["h"], success_message="ok", reference_solution=circ(2, []),
            )

    def test_the_equivalence_decision_is_never_made_by_a_model_or_the_browser(self) -> None:
        for module in ("qentor/challenges/evaluate.py", "qentor/challenges/models.py", "qentor/verification/optimizer.py"):
            tree = ast.parse((BACKEND / module).read_text(encoding="utf-8"))
            imported = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
            self.assertFalse({m for m in imported if m.startswith("qentor.tutor") or "llm" in m}, module)

    def test_the_optimizers_candidate_is_always_shown_only_after_the_checker_passed_it(self) -> None:
        source = (BACKEND / "qentor" / "verification" / "optimizer.py").read_text(encoding="utf-8")
        # the diff is attached in the one place a VERIFIED_SHORTER report is built, after check_equivalence said EQUIVALENT
        self.assertEqual(len(re.findall(r"changes=diff_ops\(", source)), 1)
        self.assertLess(source.index("check_equivalence(circuit, candidate)"), source.index("changes=diff_ops("))


class TestTheChallengeThroughTheApi(ApiCase):
    def test_the_reference_passes_with_provenance_and_a_wrong_circuit_gets_a_hint(self) -> None:
        passed = app_module.submit_challenge("optimize-redundant", ChallengeSubmitRequest(circuit=CHALLENGE.reference_solution))
        self.assertTrue(passed.passed)
        self.assertEqual(passed.backend, "qiskit-aer")
        check = next(c for c in passed.checks if c.id == "equivalent.to_start")
        self.assertIn(check.result_id, passed.provenance)
        self.assertEqual(self.attempts.get(passed.attempt_id).passed, True)
        failed = app_module.submit_challenge("optimize-redundant", ChallengeSubmitRequest(circuit=circuit_of(H0, g("cx", 1, 0))))
        self.assertFalse(failed.passed)
        self.assertEqual(failed.next_hint, CHALLENGE.hints[1])

    def test_the_catalog_lists_it_with_the_redundant_starter_and_no_answer(self) -> None:
        catalog = app_module.list_challenges()
        served = next(c for c in catalog.challenges if c.id == "optimize-redundant")
        self.assertEqual(len(served.starter_circuit.ops), 10)
        self.assertNotIn("reference", json.dumps(catalog.model_dump(mode="json")))


class TestTheDebuggerCoachesTheNewCheck(unittest.TestCase):
    def test_a_failed_equivalence_check_has_its_authored_misconception_and_experiment(self) -> None:
        from qentor.tutor.debugger import _coaching

        misconception, experiment = _coaching(CHALLENGE, "equivalent.to_start")
        self.assertIn("still the same circuit", misconception)
        self.assertIn("Check equivalence", experiment)


if __name__ == "__main__":
    unittest.main()
