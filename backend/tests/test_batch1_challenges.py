"""Sprint 2 challenges: Bloch direction, entanglement, superdense coding, teleportation (deferred corrections) and Grover.

All on the real Qiskit Aer adapter. A reference passes its own challenge; obvious wrong circuits fail; circuits that try to
get around the structure (hard-coded answers, a SWAP in place of teleportation, an encoding on the wrong qubit) fail; and
the verdict is computed by ``qentor.challenges.evaluate`` from backend statevectors, never by a language model.
"""

from __future__ import annotations

import itertools
import json
import unittest

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ChallengeSubmitRequest
from qentor.challenges import CHALLENGE_BY_ID, CHALLENGES, evaluate_challenge, public_view
from qentor.challenges.content import RAW_CHALLENGES, circ, g, m
from qentor.challenges.evaluate import _find_anchor, _same_op
from qentor.challenges.models import Challenge, Constraints, Point, QubitStateMatches, StateMatches
from qentor.circuit.model import GateName
from qentor.execution.aer import AerAdapter
from tests.test_challenges import ApiCase, outcome

AER = AerAdapter()

BATCH1 = ["bloch-plus-direction", "entangle-bell-pair", "superdense-encode-10", "teleport-ry-fixed", "grover-find-01"]

BELL = [g("h", 0), g("cx", 1, 0)]
DECODER = [g("cx", 1, 0), g("h", 0)]
TP_PREPARE = [g("ry", 0, angle=1.0), g("h", 1), g("cx", 2, 1), g("cx", 1, 0), g("h", 0)]
TP_CORRECTIONS = [g("cx", 2, 1), g("cz", 2, 0)]
ORACLE_01 = [g("x", 1), g("cz", 1, 0), g("x", 1)]
ORACLE_10 = [g("x", 0), g("cz", 1, 0), g("x", 0)]
DIFFUSION = [g("h", 0), g("h", 1), g("x", 0), g("x", 1), g("cz", 1, 0), g("x", 0), g("x", 1), g("h", 0), g("h", 1)]


def judge(challenge_id: str, circuit):
    return evaluate_challenge(CHALLENGE_BY_ID[challenge_id], circuit, AER, max_qubits=8, max_operations=64)


def judge_recorded(challenge_id: str, circuit):
    """Like ``judge`` but with a fixture recorder standing in for the provenance store, so each backend run gets a result id."""
    ids = itertools.count(1)
    seen: list[str] = []

    def record(result, prefix_hash: str) -> str:
        seen.append(prefix_hash)
        return f"r{next(ids)}"

    evaluation = evaluate_challenge(CHALLENGE_BY_ID[challenge_id], circuit, AER, max_qubits=8, max_operations=64, record_execution=record)
    return evaluation, seen


def failed_ids(evaluation) -> set[str]:
    return {c.id for c in evaluation.checks if c.evaluated and not c.passed}


class TestTheFiveChallengesAreDefinedAndLinked(unittest.TestCase):
    def test_they_are_in_the_catalog_after_the_original_nine_and_name_real_lessons(self) -> None:
        self.assertEqual([c.id for c in CHALLENGES][9:14], BATCH1)  # the optimisation challenge follows (test_optimization_learning)
        expected = {
            "bloch-plus-direction": "bloch-sphere",
            "entangle-bell-pair": "entanglement",
            "superdense-encode-10": "superdense-coding",
            "teleport-ry-fixed": "quantum-teleportation",
            "grover-find-01": "grovers-search",
        }
        self.assertEqual({cid: CHALLENGE_BY_ID[cid].lesson_id for cid in BATCH1}, expected)

    def test_each_has_a_goal_constraints_success_condition_hints_checks_and_a_reference(self) -> None:
        for cid in BATCH1:
            c = CHALLENGE_BY_ID[cid]
            with self.subTest(challenge=cid):
                self.assertTrue(c.goal.strip() and c.success_condition.strip() and c.success_message.strip())
                self.assertGreaterEqual(len(c.hints), 3)
                self.assertGreaterEqual(len(c.checks), 2)
                self.assertEqual(c.reference_solution.num_qubits, c.constraints.num_qubits)
                for check in c.checks:
                    self.assertTrue(check.misconception.strip() and check.experiment.strip(), check.id)
                    self.assertLess(check.hint_index, len(c.hints))

    def test_every_lesson_has_at_least_one_challenge(self) -> None:
        from qentor.lessons import LESSONS

        self.assertEqual({l.id for l in LESSONS} - {c.lesson_id for c in CHALLENGES}, set())

    def test_the_titles_are_the_ones_the_brief_asked_for(self) -> None:
        self.assertEqual(CHALLENGE_BY_ID["superdense-encode-10"].title, "Encode message 10")
        self.assertEqual(CHALLENGE_BY_ID["teleport-ry-fixed"].title, "Teleport the fixed ry(1.0) state")
        self.assertEqual(CHALLENGE_BY_ID["grover-find-01"].title, "Find |01⟩")
        self.assertEqual(CHALLENGE_BY_ID["bloch-plus-direction"].title, "Create |+⟩ and verify its Bloch direction")
        # the entanglement one extends the requested name: "Create a Bell state" is already the Bell State lesson's challenge
        self.assertIn("Create a Bell state", CHALLENGE_BY_ID["entangle-bell-pair"].title)
        self.assertEqual(CHALLENGE_BY_ID["create-bell"].title, "Create a Bell state")

    def test_the_locked_parts_are_named_in_the_brief(self) -> None:
        self.assertEqual(CHALLENGE_BY_ID["superdense-encode-10"].constraints.anchor_name, "decoder")
        self.assertEqual(CHALLENGE_BY_ID["teleport-ry-fixed"].constraints.anchor_name, "corrections")
        self.assertEqual(CHALLENGE_BY_ID["grover-find-01"].constraints.anchor_name, "oracle")
        self.assertEqual(CHALLENGE_BY_ID["deutsch-jozsa-fixed"].constraints.anchor_name, "oracle")

    def test_the_public_view_leaks_no_target_reference_or_substitution(self) -> None:
        for cid in BATCH1:
            blob = json.dumps(public_view(CHALLENGE_BY_ID[cid]).model_dump(mode="json"))
            for forbidden in ("reference_solution", "target", "replace_anchor", "misconception", "experiment", "other"):
                self.assertNotIn(f'"{forbidden}"', blob, f"{cid} leaks {forbidden}")

    def test_the_teleportation_goal_says_the_corrections_are_deferred(self) -> None:
        goal = CHALLENGE_BY_ID["teleport-ry-fixed"].goal.lower()
        self.assertIn("no mid-circuit measurement", goal)
        self.assertIn("deferred", goal)


class TestEveryReferenceSolutionPassesItsOwnChallenge(unittest.TestCase):
    def test_all_five(self) -> None:
        for cid in BATCH1:
            with self.subTest(challenge=cid):
                result = judge(cid, CHALLENGE_BY_ID[cid].reference_solution)
                self.assertTrue(result.passed, [(c.id, c.passed, c.detail) for c in result.checks])
                self.assertTrue(all(c.evaluated and c.passed for c in result.checks))
                self.assertEqual(result.backend, "qiskit-aer")
                self.assertIsNone(result.next_hint_index)

    def test_every_state_check_names_a_backend_step(self) -> None:
        for cid in BATCH1:
            result = judge(cid, CHALLENGE_BY_ID[cid].reference_solution)
            for check in result.checks:
                if not check.id.startswith("structure."):
                    self.assertTrue(check.evidence or check.result_id, f"{cid}/{check.id}")


class TestBlochDirection(unittest.TestCase):
    def test_h_passes_both_checks(self) -> None:
        result = judge("bloch-plus-direction", circ(1, [g("h", 0)]))
        self.assertTrue(result.passed)
        self.assertEqual([c.id for c in result.checks if not c.id.startswith("structure.")], ["odds.equator", "bloch.points_plus_x"])
        direction = outcome(result, "bloch.points_plus_x")
        self.assertLess(next(e.value for e in direction.evidence if e.name == "bloch_vector_distance"), 1e-9)

    def test_other_equator_directions_pass_the_odds_but_not_the_direction(self) -> None:
        for name, ops in (("-x", [g("x", 0), g("h", 0)]), ("+y", [g("h", 0), g("s", 0)]), ("-y", [g("h", 0), g("sdg", 0)]), ("+x then z", [g("h", 0), g("z", 0)])):
            with self.subTest(direction=name):
                result = judge("bloch-plus-direction", circ(1, ops))
                self.assertFalse(result.passed)
                self.assertTrue(outcome(result, "odds.equator").passed)
                self.assertFalse(outcome(result, "bloch.points_plus_x").passed)
                self.assertEqual(result.next_hint_index, 2)

    def test_a_pole_or_nothing_fails_both(self) -> None:
        for ops in ([], [g("x", 0)]):
            result = judge("bloch-plus-direction", circ(1, ops))
            self.assertFalse(result.passed)
            self.assertEqual(failed_ids(result), {"odds.equator", "bloch.points_plus_x"})
            self.assertEqual(result.next_hint_index, 1)

    def test_a_global_phase_does_not_change_the_direction(self) -> None:
        # Z X Z X is minus the identity: a global sign only, so H followed by it is still +x
        result = judge("bloch-plus-direction", circ(1, [g("h", 0), g("z", 0), g("x", 0), g("z", 0), g("x", 0)]))
        self.assertTrue(result.passed, [(c.id, c.detail) for c in result.checks])

    def test_the_verdict_is_judged_on_a_trace_step_of_the_learners_circuit(self) -> None:
        result, runs = judge_recorded("bloch-plus-direction", circ(1, [g("h", 0)]))
        self.assertTrue(outcome(result, "bloch.points_plus_x").result_id.startswith("r"))
        self.assertEqual(len(runs), 2)  # the initial state and the state after H: one record per step of the learner's circuit


class TestEntanglement(unittest.TestCase):
    def test_the_bell_state_passes_all_four(self) -> None:
        result = judge("entangle-bell-pair", circ(2, BELL))
        self.assertTrue(result.passed)
        ids = [c.id for c in result.checks if not c.id.startswith("structure.")]
        self.assertEqual(ids, ["odds.correlated", "q0.mixed", "q1.mixed", "state.is_bell"])
        for qubit_check in ("q0.mixed", "q1.mixed"):
            purity = next(e.value for e in outcome(result, qubit_check).evidence if e.name == "qubit_purity")
            self.assertAlmostEqual(purity, 0.5, places=9)  # a maximally mixed qubit, from the backend's own state

    def test_two_independent_superpositions_are_not_entangled(self) -> None:
        result = judge("entangle-bell-pair", circ(2, [g("h", 0), g("h", 1)]))
        self.assertFalse(result.passed)
        self.assertEqual(failed_ids(result), {"odds.correlated", "q0.mixed", "q1.mixed", "state.is_bell"})

    def test_a_cx_with_nothing_to_copy_does_not_entangle(self) -> None:
        result = judge("entangle-bell-pair", circ(2, [g("h", 0), g("cx", 0, 1)]))  # control q1 is |0>
        self.assertFalse(result.passed)
        self.assertIn("q0.mixed", failed_ids(result))

    def test_the_other_bell_state_is_entangled_with_the_right_odds_but_is_not_this_state(self) -> None:
        result = judge("entangle-bell-pair", circ(2, [*BELL, g("z", 0)]))
        self.assertFalse(result.passed)
        self.assertEqual(failed_ids(result), {"state.is_bell"})  # entanglement and odds are fine; only the sign differs
        self.assertEqual(result.next_hint_index, 2)

    def test_a_correlated_but_not_entangled_circuit_is_not_enough(self) -> None:
        # |11> is perfectly correlated and has no entanglement: odds pass nothing here, the state checks catch it
        result = judge("entangle-bell-pair", circ(2, [g("x", 0), g("x", 1)]))
        self.assertFalse(result.passed)
        self.assertIn("q0.mixed", failed_ids(result))


class TestSuperdenseEncode10(unittest.TestCase):
    def protocol(self, encoding, *, measure=True):
        ops = [*BELL, *encoding, *DECODER]
        if measure:
            ops += [m(0, 0), m(1, 1)]
        return circ(2, ops, 2)

    def test_x_on_alices_qubit_encodes_10_and_passes(self) -> None:
        result = judge("superdense-encode-10", self.protocol([g("x", 0)]))
        self.assertTrue(result.passed)
        names = [c.id for c in result.checks]
        self.assertIn("structure.gate_qubits", names)
        self.assertIn("structure.oracle", names)  # the locked part keeps its id; its label says "decoder"
        self.assertEqual(outcome(result, "structure.oracle").label, "Keeps the fixed decoder exactly as given")

    def test_the_other_three_messages_do_not_pass(self) -> None:
        for name, encoding in (("00", []), ("01", [g("z", 0)]), ("11", [g("z", 0), g("x", 0)])):
            with self.subTest(message=name):
                result = judge("superdense-encode-10", self.protocol(encoding))
                self.assertFalse(result.passed)
                self.assertEqual(failed_ids(result), {"before.encoded_pair", "final.decoded"})

    def test_encoding_on_bobs_qubit_is_refused_by_structure_and_nothing_runs(self) -> None:
        # X on q1 reaches the same Bell state as X on q0, so only the structure rule can tell Alice's move from Bob's
        result = judge("superdense-encode-10", self.protocol([g("x", 1)]))
        self.assertFalse(result.passed)
        self.assertEqual(failed_ids(result) - {"structure.gate_qubits"}, set())
        self.assertIn("q[0]", outcome(result, "structure.gate_qubits").detail)
        self.assertIsNone(result.final_result_id)
        self.assertTrue(all(not c.evaluated for c in result.checks if not c.id.startswith("structure.")))

    def test_fixing_the_answer_after_decoding_is_refused(self) -> None:
        # the message is not read from the decoder if a gate on Bob's qubit forces it: X after the decoder is only allowed on q0
        cheat = circ(2, [*BELL, *DECODER, g("x", 1), m(0, 0), m(1, 1)], 2)
        result = judge("superdense-encode-10", cheat)
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.gate_qubits").passed)

    def test_skipping_the_bell_pair_cannot_pass(self) -> None:
        # no entanglement: the state before the decoder is not the encoded pair, so the check refuses it
        cheat = circ(2, [g("h", 0), g("h", 1), g("cx", 1, 0), g("x", 0), *DECODER, m(0, 0), m(1, 1)], 2)
        result = judge("superdense-encode-10", cheat)
        self.assertFalse(result.passed)
        self.assertTrue(outcome(result, "structure.uses_cx").passed)  # it has the gate counts: only the state check can tell
        self.assertIn("before.encoded_pair", failed_ids(result))

    def test_a_missing_decoder_a_changed_decoder_or_a_missing_measurement_fail_structure(self) -> None:
        for name, circuit in (
            ("no decoder", circ(2, [*BELL, g("x", 0), m(0, 0), m(1, 1)], 2)),
            ("decoder with the H dropped", circ(2, [*BELL, g("x", 0), g("cx", 1, 0), g("h", 1), m(0, 0), m(1, 1)], 2)),
            ("not measured", self.protocol([g("x", 0)], measure=False)),
        ):
            with self.subTest(case=name):
                result = judge("superdense-encode-10", circuit)
                self.assertFalse(result.passed)
                self.assertTrue(any(not c.passed and c.id.startswith("structure.") for c in result.checks), name)

    def test_the_decoder_given_twice_is_refused(self) -> None:
        result = judge("superdense-encode-10", circ(2, [*BELL, g("x", 0), *DECODER, *DECODER, m(0, 0), m(1, 1)], 2))
        self.assertFalse(outcome(result, "structure.oracle").passed)
        self.assertIn("more than once", outcome(result, "structure.oracle").detail)


class TestTeleportation(unittest.TestCase):
    def teleport(self, prepare=None, corrections=None, measure=True):
        ops = [*(TP_PREPARE if prepare is None else prepare), *(TP_CORRECTIONS if corrections is None else corrections)]
        if measure:
            ops.append(m(2, 0))
        return circ(3, ops, 1)

    def test_the_reference_delivers_the_state_and_bob_was_blind_before_the_corrections(self) -> None:
        result = judge("teleport-ry-fixed", self.teleport())
        self.assertTrue(result.passed, [(c.id, c.detail) for c in result.checks])
        blind = outcome(result, "before.bob_blind")
        self.assertAlmostEqual(next(e.value for e in blind.evidence if e.name == "qubit_purity"), 0.5, places=9)
        delivered = outcome(result, "final.delivered")
        self.assertAlmostEqual(next(e.value for e in delivered.evidence if e.name == "qubit_purity"), 1.0, places=9)
        self.assertLess(next(e.value for e in delivered.evidence if e.name == "bloch_vector_distance"), 1e-9)

    def test_the_before_and_after_checks_read_different_backend_steps(self) -> None:
        result, _ = judge_recorded("teleport-ry-fixed", self.teleport())
        self.assertNotEqual(outcome(result, "before.bob_blind").result_id, outcome(result, "final.delivered").result_id)
        self.assertNotEqual(outcome(result, "before.protocol_state").result_id, outcome(result, "final.delivered").result_id)

    def test_leaving_out_the_corrections_is_a_structure_failure(self) -> None:
        result = judge("teleport-ry-fixed", self.teleport(corrections=[]))
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.oracle").passed)
        self.assertIn("corrections", outcome(result, "structure.oracle").detail)

    def test_the_corrections_in_the_other_order_are_not_the_given_corrections(self) -> None:
        result = judge("teleport-ry-fixed", self.teleport(corrections=[g("cz", 2, 0), g("cx", 2, 1)]))
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.oracle").passed)

    def test_the_cz_may_name_its_qubits_either_way_round(self) -> None:
        result = judge("teleport-ry-fixed", self.teleport(corrections=[g("cx", 2, 1), g("cz", 0, 2)]))
        self.assertTrue(result.passed, [(c.id, c.detail) for c in result.checks])

    def test_a_wrong_message_state_fails_before_the_corrections(self) -> None:
        prepare = [g("ry", 0, angle=0.5), *TP_PREPARE[1:]]
        result = judge("teleport-ry-fixed", self.teleport(prepare=prepare))
        self.assertFalse(result.passed)
        self.assertIn("before.protocol_state", failed_ids(result))
        self.assertIn("final.delivered", failed_ids(result))

    def test_missing_alices_step_leaves_bob_with_the_wrong_state(self) -> None:
        prepare = [TP_PREPARE[0], TP_PREPARE[1], TP_PREPARE[2]]  # message and pair only: no CX(q0,q1), no H(q0)
        result = judge("teleport-ry-fixed", self.teleport(prepare=prepare))
        self.assertFalse(result.passed)
        self.assertIn("before.protocol_state", failed_ids(result))
        self.assertIn("final.delivered", failed_ids(result))

    def test_no_entanglement_means_no_teleportation(self) -> None:
        prepare = [TP_PREPARE[0], g("h", 1), g("cx", 1, 0), g("h", 0)]  # no pair between q1 and q2
        result = judge("teleport-ry-fixed", self.teleport(prepare=prepare))
        self.assertFalse(result.passed)
        self.assertIn("final.delivered", failed_ids(result))

    def test_preparing_the_message_directly_on_bobs_qubit_is_caught(self) -> None:
        # a hard-coded answer: RY straight onto q2, then the given corrections
        result = judge("teleport-ry-fixed", self.teleport(prepare=[g("ry", 2, angle=1.0)]))
        self.assertFalse(result.passed)
        self.assertIn("before.protocol_state", failed_ids(result))
        self.assertIn("before.bob_blind", failed_ids(result))
        # Bob ends up with the right state, so the delivered check alone would be fooled: the checks BEFORE the corrections are
        # what show nothing was teleported (here Bob's qubit already holds the message, with no entanglement behind it)
        self.assertTrue(outcome(result, "final.delivered").passed)

    def test_a_swap_in_place_of_teleportation_does_not_pass(self) -> None:
        # three CX gates swap q0 and q2: Bob's qubit holds the message BEFORE the corrections, which teleportation never allows
        swap = [g("cx", 2, 0), g("cx", 0, 2), g("cx", 2, 0)]
        result = judge("teleport-ry-fixed", self.teleport(prepare=[TP_PREPARE[0], *swap]))
        self.assertFalse(result.passed)
        self.assertIn("before.bob_blind", failed_ids(result))
        self.assertIn("before.protocol_state", failed_ids(result))

    def test_a_missing_measurement_is_refused(self) -> None:
        result = judge("teleport-ry-fixed", self.teleport(measure=False))
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.measure").passed)

    def test_a_gate_outside_the_toolbox_is_refused(self) -> None:
        result = judge("teleport-ry-fixed", circ(3, [*TP_PREPARE, g("x", 2), *TP_CORRECTIONS, m(2, 0)], 1))
        self.assertFalse(outcome(result, "structure.gates").passed)

    def test_the_circuit_model_has_no_mid_circuit_measurement_and_a_measure_before_a_gate_is_refused(self) -> None:
        # the lesson says the corrections are deferred because of this; the evaluator enforces it rather than guessing
        mid = circ(3, [*TP_PREPARE, m(0, 0), *TP_CORRECTIONS], 1)
        result = judge("teleport-ry-fixed", mid)
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.measure").passed)


class TestGrover(unittest.TestCase):
    def search(self, oracle=None, diffusion=None, prepare=None, measure=True):
        ops = [*(prepare if prepare is not None else [g("h", 0), g("h", 1)]), *(ORACLE_01 if oracle is None else oracle), *(DIFFUSION if diffusion is None else diffusion)]
        if measure:
            ops += [m(0, 0), m(1, 1)]
        return circ(2, ops, 2)

    def test_one_iteration_finds_the_marked_item_and_it_generalises(self) -> None:
        result = judge("grover-find-01", self.search())
        self.assertTrue(result.passed, [(c.id, c.detail) for c in result.checks])
        self.assertEqual([c.id for c in result.checks if not c.id.startswith("structure.")], ["before.uniform", "final.finds_01", "final.is_general"])

    def test_the_generalisation_check_runs_the_circuit_again_with_another_oracle_and_records_it(self) -> None:
        result, runs = judge_recorded("grover-find-01", self.search())
        plain, general = outcome(result, "final.finds_01"), outcome(result, "final.is_general")
        self.assertNotEqual(plain.result_id, general.result_id)  # a second, separate backend run, not the first one relabelled
        # 14 gates give 15 traced states for the learner's circuit and 15 more for the swapped-oracle circuit
        self.assertEqual(len(runs), 30)
        self.assertAlmostEqual(next(e.value for e in general.evidence if e.name == "fidelity"), 1.0, places=9)

    def test_without_the_diffusion_the_item_is_not_found(self) -> None:
        result = judge("grover-find-01", self.search(diffusion=[]))
        self.assertFalse(result.passed)
        self.assertIn("final.finds_01", failed_ids(result))
        self.assertIn("final.is_general", failed_ids(result))

    def test_a_second_iteration_overshoots(self) -> None:
        result = judge("grover-find-01", self.search(diffusion=[*DIFFUSION, *ORACLE_01, *DIFFUSION]))
        self.assertFalse(result.passed)
        self.assertIn("structure.oracle", {c.id for c in result.checks if not c.passed})  # the oracle now appears twice

    def test_no_uniform_start_fails_before_the_oracle(self) -> None:
        result = judge("grover-find-01", self.search(prepare=[g("h", 0)]))
        self.assertFalse(result.passed)
        self.assertIn("before.uniform", failed_ids(result))

    def test_an_oracle_that_marks_another_item_is_not_the_fixed_oracle(self) -> None:
        result = judge("grover-find-01", self.search(oracle=ORACLE_10))
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.oracle").passed)
        self.assertIn("x q[1]", outcome(result, "structure.oracle").detail)

    def test_the_oracle_with_its_cz_written_the_other_way_round_is_the_same_oracle(self) -> None:
        result = judge("grover-find-01", self.search(oracle=[g("x", 1), g("cz", 0, 1), g("x", 1)]))
        self.assertTrue(result.passed, [(c.id, c.detail) for c in result.checks])

    def test_a_circuit_that_only_ever_produces_the_one_answer_fails_the_generalisation_check(self) -> None:
        # real diffusion, then a gate that fixes the 01 answer but moves every other one: right for this oracle, hard-coded to it
        cheat = self.search(diffusion=[*DIFFUSION, g("cx", 0, 1)])  # CX with control q1, target q0: leaves 01, changes 10
        result = judge("grover-find-01", cheat)
        self.assertFalse(result.passed)
        self.assertTrue(outcome(result, "final.finds_01").passed)  # it does find 01 ...
        self.assertTrue(outcome(result, "before.uniform").passed)
        self.assertFalse(outcome(result, "final.is_general").passed)  # ... but it is not a search
        self.assertEqual(result.next_hint_index, 2)

    def test_pre_loading_the_answer_fails(self) -> None:
        # X on q0 before everything, then H: the circuit never has the uniform start the oracle needs
        result = judge("grover-find-01", self.search(prepare=[g("x", 0)]))
        self.assertFalse(result.passed)
        self.assertIn("before.uniform", failed_ids(result))

    def test_not_measuring_both_qubits_is_refused(self) -> None:
        result = judge("grover-find-01", circ(2, [g("h", 0), g("h", 1), *ORACLE_01, *DIFFUSION, m(0, 0)], 2))
        self.assertFalse(outcome(result, "structure.measure").passed)
        self.assertIn("q[1]", outcome(result, "structure.measure").detail)


class TestTheNewCheckMachinery(unittest.TestCase):
    def test_cz_is_symmetric_and_nothing_else_is_interchangeable(self) -> None:
        self.assertTrue(_same_op(g("cz", 1, 0), g("cz", 0, 1)))
        self.assertFalse(_same_op(g("cx", 1, 0), g("cx", 0, 1)))
        self.assertFalse(_same_op(g("cz", 1, 0), g("cx", 1, 0)))
        self.assertEqual(_find_anchor([g("h", 0), g("cz", 0, 1)], [g("cz", 1, 0)]), [1])
        self.assertEqual(_find_anchor([g("h", 0)], []), [])

    def test_a_substituting_check_needs_an_anchor_and_the_final_state(self) -> None:
        base = dict(
            id="x", lesson_id="grovers-search", title="t", goal="g", difficulty="beginner", success_condition="s",
            starter_circuit=circ(2, []), hints=["h"], success_message="ok", reference_solution=circ(2, []),
        )
        check = dict(id="c", label="l", hint_index=0, misconception="m", experiment="e", target=circ(2, []), replace_anchor=[g("x", 0)])
        with self.assertRaisesRegex(ValueError, "replaces the anchor but the challenge has none"):
            Challenge(**base, constraints=Constraints(num_qubits=2, allowed_gates=[GateName.X], max_ops=4), checks=[StateMatches(**check)])
        anchored = Constraints(num_qubits=2, allowed_gates=[GateName.X], max_ops=4, anchor=[g("x", 1)])
        with self.assertRaisesRegex(ValueError, "can only judge the final state"):
            Challenge(**base, constraints=anchored, checks=[StateMatches(**check, at=Point.BEFORE_ANCHOR)])
        with self.assertRaisesRegex(ValueError, "outside the circuit"):
            Challenge(**base, constraints=anchored, checks=[StateMatches(**{**check, "replace_anchor": [g("x", 5)]})])
        Challenge(**base, constraints=anchored, checks=[StateMatches(**check)])  # and the valid one builds

    def test_a_qubit_check_must_name_a_qubit_inside_the_circuit(self) -> None:
        base = dict(
            id="x", lesson_id="bloch-sphere", title="t", goal="g", difficulty="beginner", success_condition="s",
            constraints=Constraints(num_qubits=1, allowed_gates=[GateName.H], max_ops=4), starter_circuit=circ(1, []),
            hints=["h"], success_message="ok", reference_solution=circ(1, []),
        )
        check = dict(id="c", label="l", hint_index=0, misconception="m", experiment="e", target=circ(1, []))
        with self.assertRaisesRegex(ValueError, "outside the circuit"):
            Challenge(**base, checks=[QubitStateMatches(**check, qubit=3)])

    def test_gate_qubit_rules_must_name_allowed_gates_and_real_qubits(self) -> None:
        base = dict(
            id="x", lesson_id="superdense-coding", title="t", goal="g", difficulty="beginner", success_condition="s",
            starter_circuit=circ(2, []), hints=["h"], success_message="ok", reference_solution=circ(2, []),
            checks=[StateMatches(id="c", label="l", hint_index=0, misconception="m", experiment="e", target=circ(2, []))],
        )
        with self.assertRaisesRegex(ValueError, "not an allowed gate"):
            Challenge(**base, constraints=Constraints(num_qubits=2, allowed_gates=[GateName.H], max_ops=4, gate_qubits={GateName.X: [0]}))
        with self.assertRaisesRegex(ValueError, "inside the circuit"):
            Challenge(**base, constraints=Constraints(num_qubits=2, allowed_gates=[GateName.X], max_ops=4, gate_qubits={GateName.X: [4]}))
        with self.assertRaisesRegex(ValueError, "inside the circuit"):
            Challenge(**base, constraints=Constraints(num_qubits=2, allowed_gates=[GateName.X], max_ops=4, gate_qubits={GateName.X: []}))

    def test_a_gate_qubit_rule_covers_the_controls_of_a_two_qubit_gate_too(self) -> None:
        # the shipped rules only restrict X and Z, so this is the case that proves a CX's CONTROL is held to the rule as well
        challenge = Challenge(
            id="x", lesson_id="superdense-coding", title="t", goal="g", difficulty="beginner", success_condition="s",
            constraints=Constraints(num_qubits=3, allowed_gates=[GateName.H, GateName.CX], max_ops=6, gate_qubits={GateName.CX: [0, 1]}),
            starter_circuit=circ(3, []), hints=["h"], success_message="ok", reference_solution=circ(3, [g("cx", 1, 0)]),
            checks=[StateMatches(id="c", label="l", hint_index=0, misconception="m", experiment="e", target=circ(3, [g("cx", 1, 0)]))],
        )

        def structure(ops):
            result = evaluate_challenge(challenge, circ(3, ops), AER, max_qubits=8, max_operations=64)
            return next(c for c in result.checks if c.id == "structure.gate_qubits")

        self.assertTrue(structure([g("cx", 1, 0)]).passed)  # both qubits allowed
        self.assertFalse(structure([g("cx", 0, 2)]).passed)  # the CONTROL q[2] is not allowed
        self.assertFalse(structure([g("cx", 2, 0)]).passed)  # the TARGET q[2] is not allowed
        self.assertIn("q[2]", structure([g("cx", 0, 2)]).detail)
        self.assertTrue(structure([g("h", 2)]).passed)  # an unrestricted gate may use any qubit

    def test_an_unknown_check_kind_is_rejected_so_a_typo_cannot_weaken_a_challenge(self) -> None:
        with self.assertRaises(ValidationError):
            Challenge.model_validate({**RAW_CHALLENGES[0].model_dump(mode="json"), "checks": [{"kind": "qubit_state_probably", "id": "c"}]})

    def test_dj_bv_and_the_original_challenges_are_unchanged(self) -> None:
        # Sprint 2 only added fields with defaults: the locked-oracle wording of DJ and BV is as before, and they still pass
        for cid in ("deutsch-jozsa-fixed", "bernstein-vazirani-fixed"):
            challenge = CHALLENGE_BY_ID[cid]
            self.assertEqual(challenge.constraints.gate_qubits, {})
            self.assertTrue(all(getattr(c, "replace_anchor", None) is None for c in challenge.checks), cid)
            result = judge(cid, challenge.reference_solution)
            self.assertTrue(result.passed, cid)
            self.assertEqual(outcome(result, "structure.oracle").label, "Keeps the fixed oracle exactly as given")
        self.assertEqual(
            [g_.gate.value for g_ in CHALLENGE_BY_ID["deutsch-jozsa-fixed"].constraints.anchor], ["cx", "cx"]
        )
        self.assertEqual(
            [(g_.targets, g_.controls) for g_ in CHALLENGE_BY_ID["bernstein-vazirani-fixed"].constraints.anchor], [([3], [1]), ([3], [2])]
        )
        self.assertEqual([c.id for c in CHALLENGES][:9], [c.id for c in RAW_CHALLENGES][:9])


class TestTheSubmitEndpointForTheNewChallenges(ApiCase):
    def submit(self, challenge_id, circuit):
        return app_module.submit_challenge(challenge_id, ChallengeSubmitRequest(circuit=circuit))

    def test_each_reference_passes_through_the_endpoint_with_linked_provenance(self) -> None:
        for cid in BATCH1:
            with self.subTest(challenge=cid):
                response = self.submit(cid, CHALLENGE_BY_ID[cid].reference_solution)
                self.assertTrue(response.passed)
                self.assertTrue(response.success_message)
                self.assertEqual(response.backend, "qiskit-aer")
                self.assertIsNotNone(self.store.get(response.final_result_id))
                self.assertEqual(self.store.get(response.final_result_id).provenance_class.value, "SIMULATION")
                for check in response.checks:
                    if check.result_id:
                        self.assertIn(check.result_id, response.provenance, f"{cid}/{check.id}")
                self.assertTrue(self.attempts.get(response.attempt_id).passed)

    def test_the_substituted_run_has_its_own_provenance_record_in_the_response(self) -> None:
        response = self.submit("grover-find-01", CHALLENGE_BY_ID["grover-find-01"].reference_solution)
        ids = {c.id: c.result_id for c in response.checks}
        self.assertIn(ids["final.is_general"], response.provenance)
        self.assertEqual(response.provenance[ids["final.is_general"]].provenance_class, "SIMULATION")
        self.assertNotEqual(ids["final.is_general"], ids["final.finds_01"])

    def test_a_wrong_submission_gets_a_deterministic_hint_and_is_logged(self) -> None:
        response = self.submit("superdense-encode-10", circ(2, [*BELL, g("z", 0), *DECODER, m(0, 0), m(1, 1)], 2))
        self.assertFalse(response.passed)
        self.assertEqual(response.next_hint, CHALLENGE_BY_ID["superdense-encode-10"].hints[response.next_hint_index])
        self.assertFalse(self.attempts.get(response.attempt_id).passed)

    def test_the_circuit_is_the_only_thing_a_client_can_send(self) -> None:
        for field in ("passed", "verdict", "target", "replace_anchor", "bloch", "statevector"):
            with self.subTest(field=field):
                with self.assertRaises(ValidationError):
                    ChallengeSubmitRequest.model_validate({"circuit": circ(1, [g("h", 0)]).model_dump(by_alias=True), field: True})

    def test_the_catalog_endpoint_carries_the_new_constraint_fields_and_no_answers(self) -> None:
        catalog = app_module.list_challenges()
        by_id = {c.id: c for c in catalog.challenges}
        self.assertEqual(len(by_id), 15)
        self.assertEqual(by_id["superdense-encode-10"].constraints.anchor_name, "decoder")
        self.assertEqual({k.value: v for k, v in by_id["superdense-encode-10"].constraints.gate_qubits.items()}, {"x": [0], "z": [0]})
        blob = json.dumps(catalog.model_dump(mode="json"))
        for forbidden in ("reference_solution", "replace_anchor", '"target"', "misconception"):
            self.assertNotIn(forbidden, blob)

    def test_an_unknown_challenge_is_still_a_404(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            self.submit("grover-find-10", circ(2, []))
        self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
