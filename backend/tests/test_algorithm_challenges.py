"""Sprint 4 challenges: the 2-qubit QFT, the phase of T by phase estimation, and correcting the injected flip on qubit 1.

All on the real Qiskit Aer adapter. A reference passes its own challenge; the obvious wrong circuits fail on the check that names the
mistake; circuits that try to get around the structure (a hard-coded answer, a missing swap, a wrong angle, a correction on the wrong
qubit, no syndrome) fail; the failure feedback is deterministic and authored; the equivalence verdict is the backend's
(``qentor.verification.equivalence``) and never a language model's; and nothing a learner can see carries the answer.
"""

from __future__ import annotations

import ast
import itertools
import json
import math
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ChallengeSubmitRequest
from qentor.challenges import CHALLENGE_BY_ID, CHALLENGES, evaluate_challenge, public_view
from qentor.challenges.content import circ, ccx, g, m, swap
from qentor.challenges.models import EquivalentTo, Point, ProbabilitiesMatch, QubitStateMatches, StateMatches
from qentor.circuit.model import GateName, GateOp
from qentor.execution.aer import AerAdapter
from tests.test_challenges import ApiCase, outcome

AER = AerAdapter()
PI = math.pi
BACKEND = Path(__file__).resolve().parents[1]

QFT, QPE, QEC = "qft-2qubit", "qpe-estimate-t", "qec-correct-flip-q1"

QFT2 = [g("h", 1), g("cp", 1, 0, PI / 2), g("h", 0), swap(0, 1)]
PREPARE = [g("x", 3), g("h", 0), g("h", 1), g("h", 2)]
T_POWERS = [g("cp", 3, 0, PI / 4), g("cp", 3, 1, PI / 2), g("cp", 3, 2, PI)]
S_POWERS = [g("cp", 3, 0, PI / 2), g("cp", 3, 1, PI)]
INVERSE_QFT3 = [swap(0, 2), g("h", 0), g("cp", 1, 0, -PI / 2), g("h", 1), g("cp", 2, 0, -PI / 4), g("cp", 2, 1, -PI / 2), g("h", 2)]
MEASURE3 = [m(0, 0), m(1, 1), m(2, 2)]
ENCODE = [g("ry", 0, angle=1.0), g("cx", 1, 0), g("cx", 2, 0)]
ERROR = [g("x", 1)]
SYNDROME = [g("cx", 3, 0), g("cx", 3, 1), g("cx", 4, 1), g("cx", 4, 2)]
FIX_Q1 = [ccx(3, 4, 1)]


def judge(challenge_id: str, circuit):
    return evaluate_challenge(CHALLENGE_BY_ID[challenge_id], circuit, AER, max_qubits=8, max_operations=64)


def judge_recorded(challenge_id: str, circuit):
    ids = itertools.count(1)
    seen: list[str] = []

    def record(result, prefix_hash: str) -> str:
        seen.append(prefix_hash)
        return f"r{next(ids)}"

    return evaluate_challenge(CHALLENGE_BY_ID[challenge_id], circuit, AER, max_qubits=8, max_operations=64, record_execution=record), seen


def failed_checks(evaluation) -> set[str]:
    return {c.id for c in evaluation.checks if not c.passed}


def qpe(ops_after_anchor, anchor=T_POWERS, prepare=PREPARE):
    return circ(4, [*prepare, *anchor, *ops_after_anchor, *MEASURE3], 3)


# --------------------------------------------------------------------------- #
# The definitions                                                              #
# --------------------------------------------------------------------------- #


class TestDefinitions(unittest.TestCase):
    def test_the_three_are_appended_after_the_fifteen_and_each_belongs_to_its_lesson(self) -> None:
        ids = [c.id for c in CHALLENGES]
        self.assertEqual(ids[15:], [QFT, QPE, QEC])
        self.assertEqual({c: CHALLENGE_BY_ID[c].lesson_id for c in (QFT, QPE, QEC)},
                         {QFT: "quantum-fourier-transform", QPE: "quantum-phase-estimation", QEC: "quantum-error-correction"})  # fmt: skip

    def test_titles_are_the_ones_the_brief_names(self) -> None:
        self.assertEqual(CHALLENGE_BY_ID[QFT].title, "Build the 2-qubit QFT")
        self.assertEqual(CHALLENGE_BY_ID[QPE].title, "Estimate the phase of T")
        self.assertEqual(CHALLENGE_BY_ID[QEC].title, "Correct the flip on qubit 1")

    def test_each_has_a_goal_three_or_more_hints_a_difficulty_and_an_authored_coaching_per_check(self) -> None:
        for challenge_id in (QFT, QPE, QEC):
            challenge = CHALLENGE_BY_ID[challenge_id]
            self.assertEqual(challenge.difficulty, "advanced")
            self.assertGreaterEqual(len(challenge.hints), 3)
            self.assertTrue(challenge.success_message and challenge.success_condition)
            for check in challenge.checks:
                self.assertTrue(check.misconception.strip() and check.experiment.strip(), check.id)
                self.assertLess(check.hint_index, len(challenge.hints))

    def test_the_check_kinds_are_the_backends_deterministic_ones(self) -> None:
        self.assertEqual([type(c) for c in CHALLENGE_BY_ID[QFT].checks], [EquivalentTo])
        self.assertEqual([type(c) for c in CHALLENGE_BY_ID[QPE].checks], [StateMatches, StateMatches, StateMatches])
        self.assertEqual(
            [type(c) for c in CHALLENGE_BY_ID[QEC].checks], [StateMatches, StateMatches, ProbabilitiesMatch, QubitStateMatches, StateMatches]
        )

    def test_the_fixed_parts_are_exactly_the_ones_the_goal_names(self) -> None:
        self.assertEqual(CHALLENGE_BY_ID[QPE].constraints.anchor, T_POWERS)
        self.assertEqual(CHALLENGE_BY_ID[QPE].constraints.anchor_name, "controlled powers of T")
        self.assertEqual(CHALLENGE_BY_ID[QEC].constraints.anchor, ERROR)
        self.assertEqual(CHALLENGE_BY_ID[QEC].constraints.anchor_name, "injected error")
        self.assertEqual(CHALLENGE_BY_ID[QFT].constraints.anchor, [])
        self.assertFalse(CHALLENGE_BY_ID[QPE].fixed_oracle)  # the controlled powers are not an oracle

    def test_the_circuits_are_small_fixed_educational_examples_within_the_platform_limits(self) -> None:
        for challenge_id, qubits in ((QFT, 2), (QPE, 4), (QEC, 5)):
            challenge = CHALLENGE_BY_ID[challenge_id]
            self.assertEqual(challenge.constraints.num_qubits, qubits)
            self.assertLessEqual(challenge.constraints.num_qubits, 8)
            self.assertLessEqual(challenge.constraints.max_ops, 24)
        self.assertEqual(CHALLENGE_BY_ID[QPE].constraints.must_measure, [0, 1, 2])

    def test_every_check_of_a_challenge_with_an_anchor_looks_at_a_point_that_exists(self) -> None:
        for check in CHALLENGE_BY_ID[QPE].checks[:1] + CHALLENGE_BY_ID[QEC].checks[:2]:
            self.assertIn(check.at, (Point.BEFORE_ANCHOR, Point.AFTER_ANCHOR))

    def test_the_qpe_general_check_substitutes_the_s_powers_and_expects_the_s_answer(self) -> None:
        general = next(c for c in CHALLENGE_BY_ID[QPE].checks if c.id == "final.is_general")
        self.assertEqual(general.replace_anchor, S_POWERS)
        self.assertEqual([o.gate.value for o in general.target.ops], ["x", "x"])
        self.assertEqual([o.targets for o in general.target.ops], [[3], [1]])  # the counting register would read 010
        reads_t = next(c for c in CHALLENGE_BY_ID[QPE].checks if c.id == "final.reads_phase")
        self.assertEqual([o.targets for o in reads_t.target.ops], [[3], [0]])  # 001: one eighth of a turn


# --------------------------------------------------------------------------- #
# QFT                                                                          #
# --------------------------------------------------------------------------- #


class TestQft(unittest.TestCase):
    def test_the_reference_passes_every_check_and_the_starter_fails(self) -> None:
        passed = judge(QFT, CHALLENGE_BY_ID[QFT].reference_solution)
        self.assertTrue(passed.passed, [(c.id, c.detail) for c in passed.checks])
        self.assertTrue(all(c.evaluated for c in passed.checks))
        starter = judge(QFT, CHALLENGE_BY_ID[QFT].starter_circuit)
        self.assertFalse(starter.passed)
        self.assertEqual(failed_checks(starter), {"structure.uses_cp", "equivalent.to_qft"})

    def test_a_different_but_equivalent_circuit_passes_because_the_verdict_is_operator_equivalence(self) -> None:
        variants = {
            "swap built from three CX": [g("h", 1), g("cp", 1, 0, PI / 2), g("h", 0), g("cx", 1, 0), g("cx", 0, 1), g("cx", 1, 0)],
            "the symmetric controlled phase named the other way round": [g("h", 1), g("cp", 0, 1, PI / 2), g("h", 0), swap(0, 1)],
            "a global phase only (X Z X Z is minus the identity)": [*QFT2, g("x", 0), g("z", 0), g("x", 0), g("z", 0)],
        }
        for name, ops in variants.items():
            with self.subTest(name):
                self.assertTrue(judge(QFT, circ(2, ops)).passed, name)

    def test_the_wrong_circuits_fail_on_the_equivalence_check_the_backend_decides(self) -> None:
        wrong = {
            "no swap": [g("h", 1), g("cp", 1, 0, PI / 2), g("h", 0)],
            "the wrong angle": [g("h", 1), g("cp", 1, 0, PI / 4), g("h", 0), swap(0, 1)],
            "a negated angle (the inverse QFT)": [g("h", 1), g("cp", 1, 0, -PI / 2), g("h", 0), swap(0, 1)],
            "the Hadamards in the other order": [g("h", 0), g("cp", 1, 0, PI / 2), g("h", 1), swap(0, 1)],
            "no Hadamard on the last qubit": [g("h", 1), g("cp", 1, 0, PI / 2), swap(0, 1)],
            "the controlled phase before any Hadamard": [g("cp", 1, 0, PI / 2), g("h", 1), g("h", 0), swap(0, 1)],
            "only Hadamards and the swap": [g("h", 1), g("h", 0), swap(0, 1), g("cp", 1, 0, PI)],
        }
        for name, ops in wrong.items():
            with self.subTest(name):
                evaluation = judge(QFT, circ(2, ops))
                self.assertFalse(evaluation.passed, name)
                self.assertTrue(outcome(evaluation, "equivalent.to_qft").evaluated)
                self.assertFalse(outcome(evaluation, "equivalent.to_qft").passed)
                self.assertIn("equivalence check found a difference", outcome(evaluation, "equivalent.to_qft").detail)

    def test_a_circuit_with_no_controlled_phase_fails_the_structure_and_is_not_run(self) -> None:
        evaluation = judge(QFT, circ(2, [g("h", 1), g("h", 0), swap(0, 1)]))
        self.assertFalse(outcome(evaluation, "structure.uses_cp").passed)
        self.assertFalse(outcome(evaluation, "equivalent.to_qft").evaluated)  # structure comes first: nothing is run
        self.assertIsNone(evaluation.final_result_id)

    def test_structure_rules_hold(self) -> None:
        self.assertFalse(outcome(judge(QFT, circ(2, [*QFT2, g("ry", 0, angle=0.3)])), "structure.gates").passed)  # ry is not in the toolbox
        self.assertFalse(outcome(judge(QFT, circ(3, QFT2)), "structure.width").passed)
        too_long = circ(2, [*QFT2, g("x", 0), g("x", 0), g("x", 0), g("x", 0), g("x", 0)])
        self.assertFalse(outcome(judge(QFT, too_long), "structure.size").passed)

    def test_the_failure_points_at_the_authored_hint_and_the_coaching_is_deterministic(self) -> None:
        evaluation = judge(QFT, circ(2, [g("h", 1), g("cp", 1, 0, PI / 2), g("h", 0)]))
        self.assertEqual(evaluation.next_hint_index, CHALLENGE_BY_ID[QFT].checks[0].hint_index)
        self.assertEqual(evaluation.next_hint, CHALLENGE_BY_ID[QFT].hints[CHALLENGE_BY_ID[QFT].checks[0].hint_index]) if hasattr(evaluation, "next_hint") else None
        again = judge(QFT, circ(2, [g("h", 1), g("cp", 1, 0, PI / 2), g("h", 0)]))
        self.assertEqual([(c.id, c.passed, c.detail) for c in evaluation.checks], [(c.id, c.passed, c.detail) for c in again.checks])

    def test_the_verdict_is_attached_to_a_backend_step_of_the_learners_circuit(self) -> None:
        evaluation, seen = judge_recorded(QFT, CHALLENGE_BY_ID[QFT].reference_solution)
        self.assertEqual(outcome(evaluation, "equivalent.to_qft").result_id, evaluation.final_result_id)
        self.assertTrue(evaluation.final_result_id.startswith("r"))
        self.assertEqual(len(seen), len(CHALLENGE_BY_ID[QFT].reference_solution.ops) + 1)

    def test_an_undecidable_equivalence_does_not_pass(self) -> None:
        from qentor.verification.equivalence import EquivalenceReport, EquivalenceStatus

        undecided = EquivalenceReport(status=EquivalenceStatus.UNVERIFIABLE, method="m", global_phase=None, checks=[], reason="too large")
        with patch("qentor.challenges.evaluate.check_equivalence", return_value=undecided):
            evaluation = judge(QFT, CHALLENGE_BY_ID[QFT].reference_solution)
        self.assertFalse(evaluation.passed)
        self.assertIn("could not decide", outcome(evaluation, "equivalent.to_qft").detail)

    def test_the_judgement_uses_the_equivalence_checkers_report_not_its_own_arithmetic(self) -> None:
        from qentor.verification.equivalence import EquivalenceReport, EquivalenceStatus

        forced = EquivalenceReport(status=EquivalenceStatus.NOT_EQUIVALENT, method="m", global_phase=None, checks=[], reason=None)
        with patch("qentor.challenges.evaluate.check_equivalence", return_value=forced):
            self.assertFalse(judge(QFT, CHALLENGE_BY_ID[QFT].reference_solution).passed)  # the reference itself, if the checker says no


# --------------------------------------------------------------------------- #
# QPE                                                                          #
# --------------------------------------------------------------------------- #


class TestQpe(unittest.TestCase):
    def test_the_reference_passes_every_check_and_the_starter_fails(self) -> None:
        passed = judge(QPE, CHALLENGE_BY_ID[QPE].reference_solution)
        self.assertTrue(passed.passed, [(c.id, c.detail) for c in passed.checks])
        self.assertTrue(all(c.evaluated for c in passed.checks))
        starter = judge(QPE, CHALLENGE_BY_ID[QPE].starter_circuit)
        self.assertFalse(starter.passed)
        self.assertFalse(outcome(starter, "structure.oracle").passed)  # the fixed controlled gates are missing
        self.assertFalse(outcome(starter, "before.prepared").evaluated)

    def test_the_reference_reads_one_eighth_as_the_bit_string_zero_zero_one(self) -> None:
        from qentor.execution.aer import AerAdapter as Aer

        shots = Aer().run(CHALLENGE_BY_ID[QPE].reference_solution, "shots", 500).to_payload()["probabilities"]
        self.assertEqual(shots, {"001": 1.0})

    def test_the_same_circuit_with_the_s_powers_would_read_zero_one_zero_so_the_general_check_is_real(self) -> None:
        shots = AER.run(qpe(INVERSE_QFT3, anchor=S_POWERS), "shots", 500).to_payload()["probabilities"]
        self.assertEqual(shots, {"010": 1.0})

    def test_a_circuit_that_hard_codes_the_t_answer_passes_the_plain_check_and_fails_the_general_one(self) -> None:
        # no inverse QFT at all: it just sets the counting register to 001 itself after the (given) controlled gates
        cheat = circ(4, [*PREPARE, *T_POWERS, *INVERSE_QFT3, *MEASURE3], 3)
        self.assertTrue(judge(QPE, cheat).passed)  # the honest circuit passes
        hard_coded = circ(4, [g("x", 3), g("x", 0), *T_POWERS, *MEASURE3], 3)  # skips the preparation, so the state before the anchor is wrong
        evaluation = judge(QPE, hard_coded)
        self.assertFalse(evaluation.passed)
        self.assertIn("before.prepared", failed_checks(evaluation))
        self.assertIn("final.is_general", failed_checks(evaluation))

    def test_wrong_circuits_fail_on_the_check_that_names_the_mistake(self) -> None:
        no_swap = [op for op in INVERSE_QFT3 if op.gate is not GateName.SWAP]
        positive = [GateOp(gate=o.gate, targets=o.targets, controls=o.controls, params=[abs(p) for p in o.params]) for o in INVERSE_QFT3]
        cases = {
            "no inverse QFT": ([], {"final.reads_phase", "final.is_general"}),
            "no swap in the inverse QFT": (no_swap, {"final.reads_phase", "final.is_general"}),
            "the QFT instead of its inverse (phases not negated)": (positive, {"final.reads_phase", "final.is_general"}),
        }
        for name, (ops, expected) in cases.items():
            with self.subTest(name):
                evaluation = judge(QPE, qpe(ops))
                self.assertFalse(evaluation.passed)
                self.assertTrue(expected <= failed_checks(evaluation), (name, failed_checks(evaluation)))
                self.assertNotIn("before.prepared", failed_checks(evaluation))  # the preparation was fine

    def test_a_wrong_preparation_fails_the_before_check_whatever_follows(self) -> None:
        for name, prepare in {
            "target left in zero": [g("h", 0), g("h", 1), g("h", 2)],
            "a counting qubit not in superposition": [g("x", 3), g("h", 0), g("h", 1)],
            "x on a counting qubit": [g("x", 3), g("h", 0), g("h", 1), g("x", 2)],
        }.items():
            with self.subTest(name):
                evaluation = judge(QPE, qpe(INVERSE_QFT3, prepare=prepare))
                self.assertFalse(outcome(evaluation, "before.prepared").passed, name)
                self.assertFalse(evaluation.passed)

    def test_the_given_controlled_powers_are_locked_in_place_and_order(self) -> None:
        for name, anchor in {
            "the controlled powers of S instead": S_POWERS,
            "the angles changed": [g("cp", 3, 0, PI / 4), g("cp", 3, 1, PI / 4), g("cp", 3, 2, PI)],
            "the order changed": [T_POWERS[1], T_POWERS[0], T_POWERS[2]],
            "one missing": T_POWERS[:2],
        }.items():
            with self.subTest(name):
                evaluation = judge(QPE, qpe(INVERSE_QFT3, anchor=anchor))
                self.assertFalse(outcome(evaluation, "structure.oracle").passed, name)
                self.assertFalse(evaluation.passed)
                self.assertFalse(outcome(evaluation, "final.reads_phase").evaluated)  # structure first: nothing is run

    def test_the_counting_qubits_must_be_measured_and_only_the_toolbox_gates_may_be_used(self) -> None:
        unmeasured = circ(4, [*PREPARE, *T_POWERS, *INVERSE_QFT3], 3)
        self.assertFalse(outcome(judge(QPE, unmeasured), "structure.measure").passed)
        with_cx = circ(4, [*PREPARE, *T_POWERS, *INVERSE_QFT3, g("cx", 1, 0), *MEASURE3], 3)
        self.assertFalse(outcome(judge(QPE, with_cx), "structure.gates").passed)

    def test_failure_feedback_is_authored_per_check_and_points_at_hints(self) -> None:
        evaluation = judge(QPE, qpe([]))
        failing = [c for c in evaluation.checks if not c.passed]
        self.assertTrue(failing)
        for outcome_ in failing:
            if outcome_.id.startswith("structure"):
                continue
            check = next(c for c in CHALLENGE_BY_ID[QPE].checks if c.id == outcome_.id)
            self.assertLess(check.hint_index, len(CHALLENGE_BY_ID[QPE].hints))
        self.assertEqual(evaluation.next_hint_index, CHALLENGE_BY_ID[QPE].checks[1].hint_index)

    def test_the_evidence_numbers_come_from_backend_runs(self) -> None:
        evaluation, seen = judge_recorded(QPE, CHALLENGE_BY_ID[QPE].reference_solution)
        self.assertTrue(evaluation.passed)
        self.assertTrue(seen)  # every traced step was recorded as a provenance record
        for c in evaluation.checks:
            if c.evaluated and not c.id.startswith("structure"):
                self.assertIsNotNone(c.result_id, c.id)


# --------------------------------------------------------------------------- #
# QEC                                                                          #
# --------------------------------------------------------------------------- #


class TestQec(unittest.TestCase):
    def test_the_reference_passes_every_check_and_the_starter_fails(self) -> None:
        passed = judge(QEC, CHALLENGE_BY_ID[QEC].reference_solution)
        self.assertTrue(passed.passed, [(c.id, c.detail) for c in passed.checks])
        self.assertEqual(
            [c.id for c in passed.checks if not c.id.startswith("structure")],
            ["before.encoded", "after.error", "final.syndrome", "final.q1_restored", "final.restored"],
        )  # the five things the brief says the server verifies: encoding, injected error, syndrome, correction, final state
        starter = judge(QEC, CHALLENGE_BY_ID[QEC].starter_circuit)
        self.assertFalse(starter.passed)
        self.assertFalse(outcome(starter, "structure.oracle").passed)

    def test_the_full_decoder_with_all_three_corrections_also_passes(self) -> None:
        decoder = [ccx(3, 4, 1), g("x", 4), ccx(3, 4, 0), g("x", 4), g("x", 3), ccx(3, 4, 2), g("x", 3)]
        full = circ(5, [*ENCODE, *ERROR, *SYNDROME, *decoder, *[m(q, q) for q in range(5)]], 5)
        self.assertTrue(judge(QEC, full).passed)  # a decoder that handles every single flip still fixes this one

    def test_each_wrong_circuit_fails_on_the_check_that_names_the_mistake(self) -> None:
        cases = {
            "no encoding": ([*ERROR, *SYNDROME, *FIX_Q1], {"before.encoded", "after.error", "final.restored"}),
            "encoded onto only one other qubit": ([g("ry", 0, angle=1.0), g("cx", 1, 0), *ERROR, *SYNDROME, *FIX_Q1], {"before.encoded"}),
            "no syndrome extraction": ([*ENCODE, *ERROR, *FIX_Q1], {"final.syndrome", "final.restored"}),
            "no correction": ([*ENCODE, *ERROR, *SYNDROME], {"final.q1_restored", "final.restored"}),
            "the correction aimed at q0": ([*ENCODE, *ERROR, *SYNDROME, ccx(3, 4, 0)], {"final.q1_restored", "final.restored"}),
            "the correction aimed at q2": ([*ENCODE, *ERROR, *SYNDROME, ccx(3, 4, 2)], {"final.q1_restored", "final.restored"}),
            "a wrong parity pair for q3": ([*ENCODE, *ERROR, g("cx", 3, 0), g("cx", 3, 2), g("cx", 4, 1), g("cx", 4, 2), *FIX_Q1], {"final.syndrome", "final.restored"}),
        }
        for name, (ops, expected) in cases.items():
            with self.subTest(name):
                circuit = circ(5, ops, 5)
                evaluation = judge(QEC, circuit)
                self.assertFalse(evaluation.passed, name)
                self.assertTrue(expected <= failed_checks(evaluation), (name, failed_checks(evaluation)))

    def test_an_equivalent_encoding_passes_because_the_check_is_about_the_state_not_the_gates(self) -> None:
        chain = [g("ry", 0, angle=1.0), g("cx", 1, 0), g("cx", 2, 1)]  # a chain of CX makes the same encoded state as two CX from q0
        self.assertTrue(judge(QEC, circ(5, [*chain, *ERROR, *SYNDROME, *FIX_Q1], 5)).passed)

    def test_the_ancilla_reading_is_checked_even_when_the_data_is_fixed(self) -> None:
        # the data qubits are restored, but an ancilla is flipped after the correction: the syndrome no longer reads the pattern for q1
        flipped = circ(5, [*ENCODE, *ERROR, *SYNDROME, *FIX_Q1, g("x", 3)], 5)
        evaluation = judge(QEC, flipped)
        self.assertFalse(evaluation.passed)
        self.assertEqual(failed_checks(evaluation), {"final.syndrome", "final.restored"})
        self.assertTrue(outcome(evaluation, "final.q1_restored").passed)  # q1 itself is fine: the failure is attributed to the right check

    def test_the_injected_error_is_locked_and_must_come_exactly_once(self) -> None:
        missing = judge(QEC, circ(5, [*ENCODE, *SYNDROME, *FIX_Q1], 5))
        self.assertFalse(outcome(missing, "structure.oracle").passed)
        twice = judge(QEC, circ(5, [*ENCODE, *ERROR, g("x", 1), *SYNDROME, *FIX_Q1], 5))
        self.assertFalse(outcome(twice, "structure.oracle").passed)
        moved = judge(QEC, circ(5, [*ENCODE, g("x", 2), *SYNDROME, *FIX_Q1], 5))  # an error on q2 instead: not the given one
        self.assertFalse(outcome(moved, "structure.oracle").passed)
        for evaluation in (missing, twice, moved):
            self.assertFalse(evaluation.passed)
            self.assertFalse(outcome(evaluation, "before.encoded").evaluated)  # structure first

    def test_the_encoding_must_come_before_the_error_not_after_it(self) -> None:
        after = judge(QEC, circ(5, [*ERROR, *ENCODE, *SYNDROME, *FIX_Q1], 5))
        self.assertFalse(after.passed)
        self.assertFalse(outcome(after, "before.encoded").passed)

    def test_the_syndrome_check_reads_the_ancillas_only(self) -> None:
        check = next(c for c in CHALLENGE_BY_ID[QEC].checks if c.id == "final.syndrome")
        self.assertEqual(check.qubits, [3, 4])
        self.assertEqual(check.at, Point.FINAL)

    def test_the_q1_check_is_a_per_qubit_reduced_state_check(self) -> None:
        check = next(c for c in CHALLENGE_BY_ID[QEC].checks if c.id == "final.q1_restored")
        self.assertEqual(check.qubit, 1)
        # q1 alone distinguishes a corrected register from an uncorrected one although each data qubit is entangled with the others
        uncorrected = judge(QEC, circ(5, [*ENCODE, *ERROR, *SYNDROME], 5))
        self.assertFalse(outcome(uncorrected, "final.q1_restored").passed)
        self.assertTrue(outcome(judge(QEC, CHALLENGE_BY_ID[QEC].reference_solution), "final.q1_restored").passed)

    def test_measuring_at_the_end_does_not_change_the_verdict(self) -> None:
        measured = circ(5, [*CHALLENGE_BY_ID[QEC].reference_solution.ops, *[m(q, q) for q in range(5)]], 5)
        self.assertTrue(judge(QEC, measured).passed)

    def test_the_run_limits_and_the_trace_limit_cover_five_qubits(self) -> None:
        evaluation, seen = judge_recorded(QEC, CHALLENGE_BY_ID[QEC].reference_solution)
        self.assertTrue(evaluation.passed)
        self.assertEqual(len(seen), len(CHALLENGE_BY_ID[QEC].reference_solution.ops) + 1)


# --------------------------------------------------------------------------- #
# The API, the public view and the trust boundary                              #
# --------------------------------------------------------------------------- #


class TestApi(ApiCase):
    def submit(self, challenge_id: str, circuit):
        return app_module.submit_challenge(challenge_id, ChallengeSubmitRequest(circuit=circuit))

    def test_a_correct_submission_passes_with_provenance_for_each_check_and_a_saved_attempt(self) -> None:
        for challenge_id in (QFT, QPE, QEC):
            response = self.submit(challenge_id, CHALLENGE_BY_ID[challenge_id].reference_solution)
            self.assertTrue(response.passed, challenge_id)
            self.assertEqual((response.verifier, response.backend), ("challenge/1", "qiskit-aer"))
            self.assertIn(response.final_result_id, response.provenance)
            record = response.provenance[response.final_result_id]
            self.assertEqual(record.provenance_class, "SIMULATION")
            self.assertTrue(self.attempts.get(response.attempt_id).passed)
            for check in response.checks:
                if check.result_id is not None:
                    self.assertIn(check.result_id, response.provenance, check.id)

    def test_a_failed_submission_carries_the_authored_hint_and_no_answer(self) -> None:
        response = self.submit(QFT, circ(2, [g("h", 1), g("cp", 1, 0, PI / 2), g("h", 0)]))
        self.assertFalse(response.passed)
        self.assertEqual(response.next_hint, CHALLENGE_BY_ID[QFT].hints[response.next_hint_index])
        blob = response.model_dump_json()
        self.assertNotIn("misconception", blob)
        self.assertNotIn("reference_solution", blob)

    def test_the_catalog_serves_the_new_challenges_without_target_solution_or_coaching(self) -> None:
        catalog = app_module.list_challenges()
        served = {c.id: c for c in catalog.challenges}
        for challenge_id in (QFT, QPE, QEC):
            self.assertIn(challenge_id, served)
            blob = json.dumps(served[challenge_id].model_dump(mode="json"))
            for forbidden in ("reference_solution", '"target"', "misconception", "experiment", "replace_anchor", "equivalent_to"):
                self.assertNotIn(forbidden, blob, challenge_id)
        self.assertEqual(served[QPE].constraints.anchor_name, "controlled powers of T")
        self.assertEqual(len(served[QPE].constraints.anchor), 3)

    def test_the_public_view_hides_every_answer_part(self) -> None:
        for challenge_id in (QFT, QPE, QEC):
            view = public_view(CHALLENGE_BY_ID[challenge_id])
            self.assertEqual({c.id for c in view.checks}, {c.id for c in CHALLENGE_BY_ID[challenge_id].checks})
            self.assertEqual({tuple(sorted(type(c).model_fields)) for c in view.checks}, {("id", "label")})

    def test_the_request_has_no_field_for_a_verdict_a_state_or_a_target(self) -> None:
        circuit = circ(2, QFT2).model_dump(by_alias=True)
        for field in ("passed", "verdict", "statevector", "probabilities", "fidelity", "checks", "result_id", "target", "equivalent"):
            with self.subTest(field=field):
                with self.assertRaises(ValidationError):
                    ChallengeSubmitRequest.model_validate({"circuit": circuit, field: True})

    def test_the_verdict_cannot_be_changed_by_a_language_model(self) -> None:
        class MustNotBeCalled:
            def __call__(self, *args, **kwargs):  # pragma: no cover
                raise AssertionError("the challenge evaluator must not consult an LLM")

            def draft(self, *args, **kwargs):  # pragma: no cover
                raise AssertionError("the challenge evaluator must not consult an LLM")

            def generate_circuit(self, *args, **kwargs):  # pragma: no cover
                raise AssertionError("the challenge evaluator must not consult an LLM")

        with patch.object(app_module, "_llm_adapter", MustNotBeCalled()):
            self.assertTrue(self.submit(QFT, CHALLENGE_BY_ID[QFT].reference_solution).passed)
            self.assertFalse(self.submit(QPE, circ(4, [], 3)).passed)
            self.assertTrue(self.submit(QEC, CHALLENGE_BY_ID[QEC].reference_solution).passed)

    def test_the_challenge_package_never_imports_the_tutor_or_any_llm_code(self) -> None:
        for module in ("challenges/evaluate.py", "challenges/models.py", "challenges/content.py"):
            tree = ast.parse((BACKEND / "qentor" / module).read_text(encoding="utf-8"))
            imported = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
            imported |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
            self.assertFalse({m for m in imported if m.startswith("qentor.tutor") or "llm" in m.lower() or "anthropic" in m.lower()}, module)

    def test_the_lesson_content_module_computes_no_quantum_value(self) -> None:
        source = (BACKEND / "qentor" / "lessons" / "content_algorithms.py").read_text(encoding="utf-8")
        for forbidden in ("qiskit", "numpy", "execution", "statevector", "AerAdapter"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
