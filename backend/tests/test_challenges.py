"""Challenge system (Phase B): definitions, deterministic backend evaluation, and the submit endpoint.

Everything here runs on the real Qiskit Aer adapter. Pass/fail must come from backend statevectors and structural rules,
never from a language model and never from anything a client says.
"""

from __future__ import annotations

import ast
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ChallengeSubmitRequest
from qentor.challenges import CHALLENGE_BY_ID, CHALLENGES, evaluate_challenge, public_view
from qentor.challenges.content import RAW_CHALLENGES, circ, g, m
from qentor.challenges.evaluate import fidelity, marginal
from qentor.challenges.registry import ChallengeRegistryError, build_registry
from qentor.circuit.model import Circuit
from qentor.execution.adapter import AdapterUnavailable, ExecutionResult
from qentor.execution.aer import AerAdapter
from qentor.lessons import LESSONS
from qentor.provenance.attempts import AttemptStore
from qentor.provenance.store import ProvenanceStore

AER = AerAdapter()
BACKEND_ROOT = Path(__file__).resolve().parents[1]

DJ_ORACLE = [g("cx", 2, 0), g("cx", 2, 1)]
BV_ORACLE = [g("cx", 3, 1), g("cx", 3, 2)]


def judge(challenge_id: str, circuit: Circuit):
    return evaluate_challenge(CHALLENGE_BY_ID[challenge_id], circuit, AER, max_qubits=8, max_operations=64)


def outcome(evaluation, check_id: str):
    return next(c for c in evaluation.checks if c.id == check_id)


class TestCatalog(unittest.TestCase):
    def test_the_nine_required_challenges_exist(self) -> None:
        self.assertEqual(
            [c.id for c in CHALLENGES],
            [
                "create-one",
                "create-plus",
                "create-minus",
                "create-bell",
                "phase-change",
                "interference",
                "phase-kickback",
                "deutsch-jozsa-fixed",
                "bernstein-vazirani-fixed",
            ],
        )

    def test_every_challenge_belongs_to_a_real_lesson(self) -> None:
        lessons = {lesson.id for lesson in LESSONS}
        for challenge in CHALLENGES:
            self.assertIn(challenge.lesson_id, lessons, challenge.id)

    def test_every_challenge_has_a_goal_hints_and_a_difficulty(self) -> None:
        for challenge in CHALLENGES:
            with self.subTest(challenge=challenge.id):
                self.assertTrue(challenge.goal.strip())
                self.assertGreaterEqual(len(challenge.hints), 3)
                self.assertIn(challenge.difficulty, ("beginner", "intermediate", "advanced"))
                self.assertTrue(challenge.success_condition.strip())

    def test_only_the_two_oracle_challenges_are_fixed_oracle(self) -> None:
        self.assertEqual({c.id for c in CHALLENGES if c.fixed_oracle}, {"deutsch-jozsa-fixed", "bernstein-vazirani-fixed"})
        for challenge in CHALLENGES:
            self.assertEqual(bool(challenge.constraints.anchor) and challenge.fixed_oracle, challenge.fixed_oracle)

    def test_every_reference_solution_passes_its_own_spec(self) -> None:
        for challenge in CHALLENGES:
            with self.subTest(challenge=challenge.id):
                evaluation = judge(challenge.id, challenge.reference_solution)
                self.assertTrue(evaluation.passed, [(c.id, c.detail) for c in evaluation.checks if not c.passed])
                self.assertIsNone(evaluation.next_hint_index)

    def test_the_starter_circuit_alone_never_passes(self) -> None:
        for challenge in CHALLENGES:
            with self.subTest(challenge=challenge.id):
                self.assertFalse(judge(challenge.id, challenge.starter_circuit).passed)

    def test_reference_circuits_named_by_checks_have_no_measurements(self) -> None:
        for challenge in CHALLENGES:
            for check in challenge.checks:
                for name in ("target", "other"):
                    ref = getattr(check, name, None)
                    if ref is not None:
                        self.assertFalse([op for op in ref.ops if op.gate.value == "measure"], f"{challenge.id}/{check.id}")

    def test_registry_rejects_duplicates_and_unknown_lessons(self) -> None:
        with self.assertRaises(ChallengeRegistryError):
            build_registry([RAW_CHALLENGES[0], RAW_CHALLENGES[0]])
        broken = RAW_CHALLENGES[0].model_copy(update={"lesson_id": "no-such-lesson"})
        with self.assertRaises(ChallengeRegistryError):
            build_registry([broken])

    def test_a_check_cannot_point_at_a_missing_hint(self) -> None:
        data = RAW_CHALLENGES[0].model_dump(by_alias=True)
        data["checks"][0]["hint_index"] = 99
        with self.assertRaises(ValidationError):
            type(RAW_CHALLENGES[0]).model_validate(data)

    def test_a_check_on_the_anchor_requires_an_anchor(self) -> None:
        data = RAW_CHALLENGES[0].model_dump(by_alias=True)
        data["checks"][0]["at"] = "before_anchor"
        with self.assertRaises(ValidationError):
            type(RAW_CHALLENGES[0]).model_validate(data)


class TestPublicView(unittest.TestCase):
    """A learner is never sent how the answer is judged."""

    def test_no_reference_solution_or_target_circuit_in_the_public_json(self) -> None:
        for challenge in CHALLENGES:
            dumped = json.dumps(public_view(challenge).model_dump(mode="json"))
            for forbidden in ("reference_solution", '"target"', '"other"', "hint_index"):
                self.assertNotIn(forbidden, dumped, f"{challenge.id} leaks {forbidden}")

    def test_the_public_view_keeps_what_the_learner_needs(self) -> None:
        view = public_view(CHALLENGE_BY_ID["deutsch-jozsa-fixed"]).model_dump(mode="json")
        self.assertEqual(view["constraints"]["num_qubits"], 3)
        self.assertEqual(len(view["constraints"]["anchor"]), 2)
        self.assertTrue(view["fixed_oracle"])
        self.assertTrue(view["checks"])


class TestStateMath(unittest.TestCase):
    S = 0.5**0.5

    def test_fidelity_ignores_global_phase(self) -> None:
        plus = [[self.S, 0.0], [self.S, 0.0]]
        i_plus = [[0.0, self.S], [0.0, self.S]]
        self.assertAlmostEqual(fidelity(plus, i_plus), 1.0, places=12)

    def test_fidelity_of_orthogonal_states_is_zero(self) -> None:
        plus = [[self.S, 0.0], [self.S, 0.0]]
        minus = [[self.S, 0.0], [-self.S, 0.0]]
        self.assertAlmostEqual(fidelity(plus, minus), 0.0, places=12)

    def test_marginal_orders_bits_highest_qubit_first(self) -> None:
        # basis state index 0b10 == q[1]=1, q[0]=0
        state = [[0.0, 0.0], [0.0, 0.0], [1.0, 0.0], [0.0, 0.0]]
        self.assertEqual(marginal(state, None, 2), {"10": 1.0})
        self.assertEqual(marginal(state, [1], 2), {"1": 1.0})
        self.assertEqual(marginal(state, [0], 2), {"0": 1.0})


class TestSingleQubitChallenges(unittest.TestCase):
    def test_create_one(self) -> None:
        self.assertTrue(judge("create-one", circ(1, [g("x", 0)])).passed)
        # A different route to the same state is accepted: the state is what is judged, not the gate list.
        self.assertTrue(judge("create-one", circ(1, [g("h", 0), g("z", 0), g("h", 0)])).passed)
        bad = judge("create-one", circ(1, [g("h", 0)]))
        self.assertFalse(bad.passed)
        self.assertFalse(outcome(bad, "state.is_one").passed)
        self.assertEqual(bad.next_hint_index, 1)

    def test_create_plus_and_minus_are_told_apart(self) -> None:
        self.assertTrue(judge("create-plus", circ(1, [g("h", 0)])).passed)
        self.assertFalse(judge("create-plus", circ(1, [g("x", 0), g("h", 0)])).passed, "|−⟩ is not |+⟩")
        self.assertTrue(judge("create-minus", circ(1, [g("x", 0), g("h", 0)])).passed)
        self.assertTrue(judge("create-minus", circ(1, [g("h", 0), g("z", 0)])).passed, "H then Z also makes |−⟩")
        self.assertFalse(judge("create-minus", circ(1, [g("h", 0)])).passed)

    def test_a_global_phase_is_not_a_difference(self) -> None:
        # Y|0> = i|1>: the same state as |1> up to global phase.
        self.assertTrue(judge("create-one", circ(1, [g("y", 0)])).passed)

    def test_near_miss_is_reported_with_its_fidelity(self) -> None:
        # T after H is a different state from |+>; its fidelity is a real number strictly between 0 and 1.
        result = judge("create-plus", circ(1, [g("h", 0), g("t", 0)]))
        fid = outcome(result, "state.is_plus").evidence[0]
        self.assertEqual(fid.name, "fidelity")
        self.assertTrue(0.0 < fid.value < 1.0)
        self.assertFalse(result.passed)

    def test_phase_change(self) -> None:
        for gate in ("z", "s", "t", "sdg", "tdg", "y"):
            with self.subTest(gate=gate):
                self.assertTrue(judge("phase-change", circ(1, [g("h", 0), g(gate, 0)])).passed)
        h_only = judge("phase-change", circ(1, [g("h", 0)]))
        self.assertTrue(outcome(h_only, "odds.match_plus").passed, "the odds match |+⟩ ...")
        self.assertFalse(outcome(h_only, "state.not_plus").passed, "... but the state IS |+⟩, so nothing changed")
        self.assertFalse(judge("phase-change", circ(1, [g("x", 0)])).passed)
        self.assertFalse(judge("phase-change", circ(1, [])).passed)

    def test_interference(self) -> None:
        self.assertTrue(judge("interference", circ(1, [g("h", 0), g("h", 0)])).passed)
        self.assertTrue(judge("interference", circ(1, [g("h", 0), g("z", 0), g("h", 0)])).passed)
        # One H: superposition but no definite end.
        one_h = judge("interference", circ(1, [g("h", 0)]))
        self.assertFalse(one_h.passed)
        self.assertFalse(outcome(one_h, "structure.uses_h").passed)
        self.assertFalse(outcome(one_h, "end.definite").evaluated, "state checks wait for the structure")
        # Two H's but broken up by a gate that keeps it superposed at the end.
        broken = judge("interference", circ(1, [g("h", 0), g("s", 0), g("h", 0)]))
        self.assertFalse(broken.passed)
        self.assertFalse(outcome(broken, "end.definite").passed)
        # Every route to a definite end must genuinely pass through a superposition: X X H H does (after its first H).
        self.assertTrue(judge("interference", circ(1, [g("x", 0), g("x", 0), g("h", 0), g("h", 0)])).passed)


class TestMultiQubitChallenges(unittest.TestCase):
    def test_bell(self) -> None:
        self.assertTrue(judge("create-bell", circ(2, [g("h", 0), g("cx", 1, 0)])).passed)
        self.assertTrue(judge("create-bell", circ(2, [g("h", 1), g("cx", 0, 1)])).passed, "either qubit may lead")
        self.assertFalse(judge("create-bell", circ(2, [g("h", 0)])).passed, "superposition alone is not entanglement")
        self.assertFalse(judge("create-bell", circ(2, [g("h", 0), g("h", 1)])).passed, "a product state is not Bell")
        self.assertFalse(judge("create-bell", circ(2, [g("x", 0), g("h", 0), g("cx", 1, 0)])).passed, "that is the other Bell state")

    def test_kickback(self) -> None:
        good = circ(2, [g("x", 1), g("h", 1), g("h", 0), g("cx", 1, 0), g("h", 0)])
        self.assertTrue(judge("phase-kickback", good).passed, "the order of the preparation gates does not matter")
        no_control_h = judge("phase-kickback", circ(2, [g("x", 1), g("h", 1), g("cx", 1, 0), g("h", 0)]))
        self.assertFalse(no_control_h.passed)
        self.assertFalse(outcome(no_control_h, "before.eigenstate").passed)
        no_cx = judge("phase-kickback", circ(2, [g("h", 0), g("x", 1), g("h", 1)]))
        self.assertFalse(no_cx.passed)
        self.assertFalse(outcome(no_cx, "structure.oracle").passed)
        # Without the closing H the phase is still on q0 but not readable as |1>.
        unfinished = judge("phase-kickback", circ(2, [g("h", 0), g("x", 1), g("h", 1), g("cx", 1, 0)]))
        self.assertTrue(outcome(unfinished, "before.eigenstate").passed)
        self.assertFalse(outcome(unfinished, "final.kicked_back").passed)

    def test_kickback_cannot_be_faked_by_building_the_end_state_directly(self) -> None:
        # |1>|−> reached without kickback, with a CX pair that cancels: the state before the (first) CX is wrong.
        fake = circ(2, [g("x", 0), g("x", 1), g("h", 1), g("cx", 1, 0), g("cx", 1, 0)])
        result = judge("phase-kickback", fake)
        self.assertFalse(result.passed)


class TestFixedOracleChallenges(unittest.TestCase):
    def dj(self, ops):
        return circ(3, ops, 3)

    def bv(self, ops):
        return circ(4, ops, 4)

    def test_dj_reference_and_an_equivalent_ordering(self) -> None:
        shuffled = self.dj([g("h", 2), g("x", 2), g("h", 2), g("h", 0), g("h", 1), *DJ_ORACLE, g("h", 1), g("h", 0), m(1, 1), m(0, 0)])
        # ancilla prep written differently (h, x, h gives |−⟩ up to global phase? H X H = Z, so use x then h)
        result = judge("deutsch-jozsa-fixed", shuffled)
        self.assertFalse(result.passed, "H X H on the ancilla is Z|0>, not |−⟩; the before-oracle check must catch it")
        self.assertFalse(outcome(result, "before.superposed_inputs").passed)
        ok = self.dj([g("h", 1), g("h", 0), g("x", 2), g("h", 2), *DJ_ORACLE, g("h", 1), g("h", 0), m(1, 1), m(0, 0)])
        self.assertTrue(judge("deutsch-jozsa-fixed", ok).passed)

    def test_dj_missing_final_hadamards_fails_the_answer_check(self) -> None:
        ops = [g("x", 2), g("h", 0), g("h", 1), g("h", 2), *DJ_ORACLE, m(0, 0), m(1, 1)]
        result = judge("deutsch-jozsa-fixed", self.dj(ops))
        self.assertTrue(outcome(result, "before.superposed_inputs").passed)
        self.assertFalse(outcome(result, "final.balanced_answer").passed)
        self.assertFalse(result.passed)
        self.assertEqual(result.next_hint_index, 2)

    def test_dj_cannot_be_solved_by_writing_the_answer_directly(self) -> None:
        cheat = self.dj([g("x", 0), g("x", 1), *DJ_ORACLE, m(0, 0), m(1, 1)])
        result = judge("deutsch-jozsa-fixed", cheat)
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "before.superposed_inputs").passed)

    def test_dj_oracle_must_be_kept_exactly(self) -> None:
        wrong_order = self.dj([g("x", 2), g("h", 0), g("h", 1), g("h", 2), g("cx", 2, 1), g("cx", 2, 0), g("h", 0), g("h", 1), m(0, 0), m(1, 1)])
        result = judge("deutsch-jozsa-fixed", wrong_order)
        self.assertFalse(outcome(result, "structure.oracle").passed)
        self.assertIn("cx q[0]→q[2], then cx q[1]→q[2]", outcome(result, "structure.oracle").detail)
        self.assertIsNone(result.final_result_id, "nothing ran, so no result is claimed")
        self.assertTrue(all(not c.evaluated for c in result.checks if c.id.startswith(("before.", "final."))))

        twice = self.dj([g("x", 2), g("h", 0), g("h", 1), g("h", 2), *DJ_ORACLE, *DJ_ORACLE, g("h", 0), g("h", 1), m(0, 0), m(1, 1)])
        self.assertFalse(outcome(judge("deutsch-jozsa-fixed", twice), "structure.oracle").passed)

        swapped_oracle = self.dj([g("x", 2), g("h", 0), g("h", 1), g("h", 2), g("cx", 2, 0), g("h", 0), g("h", 1), m(0, 0), m(1, 1)])
        self.assertFalse(outcome(judge("deutsch-jozsa-fixed", swapped_oracle), "structure.oracle").passed, "a different oracle is not the fixed one")

    def test_dj_must_measure_the_inputs(self) -> None:
        ops = [g("x", 2), g("h", 0), g("h", 1), g("h", 2), *DJ_ORACLE, g("h", 0), g("h", 1), m(0, 0)]
        result = judge("deutsch-jozsa-fixed", self.dj(ops))
        self.assertFalse(outcome(result, "structure.measure").passed)
        self.assertIn("q[1]", outcome(result, "structure.measure").detail)

    def test_bv_reference_and_reading_the_secret(self) -> None:
        reference = CHALLENGE_BY_ID["bernstein-vazirani-fixed"].reference_solution
        result = judge("bernstein-vazirani-fixed", reference)
        self.assertTrue(result.passed)
        answer = outcome(result, "final.hidden_string")
        self.assertEqual(answer.evidence[0].name, "largest_probability_difference")
        self.assertLess(answer.evidence[0].value, 1e-9)

    def test_bv_wrong_final_layer_fails(self) -> None:
        ops = [g("x", 3), g("h", 0), g("h", 1), g("h", 2), g("h", 3), *BV_ORACLE, g("h", 0), g("h", 1), m(0, 0), m(1, 1), m(2, 2)]
        result = judge("bernstein-vazirani-fixed", self.bv(ops))
        self.assertFalse(outcome(result, "final.hidden_string").passed, "q[2] never got its closing H")
        self.assertFalse(result.passed)

    def test_bv_cannot_be_solved_by_writing_the_secret_directly(self) -> None:
        cheat = self.bv([g("x", 1), g("x", 2), *BV_ORACLE, m(0, 0), m(1, 1), m(2, 2)])
        result = judge("bernstein-vazirani-fixed", cheat)
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "before.superposed_inputs").passed)


class TestStructureRules(unittest.TestCase):
    def test_wrong_width(self) -> None:
        result = judge("create-one", circ(2, [g("x", 0)]))
        self.assertFalse(outcome(result, "structure.width").passed)
        self.assertFalse(result.passed)
        self.assertIsNone(result.final_result_id)

    def test_disallowed_gate(self) -> None:
        rotation = Circuit(num_qubits=1, num_clbits=0, ops=[{"gate": "rx", "targets": [0], "params": [3.141592653589793]}])
        result = judge("create-one", rotation)
        self.assertFalse(outcome(result, "structure.gates").passed)
        self.assertIn("rx", outcome(result, "structure.gates").detail)

    def test_too_many_operations(self) -> None:
        result = judge("create-one", circ(1, [g("x", 0)] * 7))
        self.assertFalse(outcome(result, "structure.size").passed)

    def test_a_gate_after_a_measurement_is_a_structure_failure_not_a_crash(self) -> None:
        # Kickback allows no measurement at all; use the Deutsch-Jozsa challenge, which does.
        ops = [g("x", 2), g("h", 0), g("h", 1), g("h", 2), *DJ_ORACLE, m(0, 0), g("h", 1), m(1, 1)]
        result = judge("deutsch-jozsa-fixed", circ(3, ops, 3))
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.measure").passed)
        self.assertIn("last thing", outcome(result, "structure.measure").detail)
        self.assertIsNone(result.final_result_id)

    def test_a_measurement_where_the_challenge_allows_none_is_refused_as_a_gate(self) -> None:
        result = judge("create-one", circ(1, [g("x", 0), m(0, 0)], 1))
        self.assertFalse(outcome(result, "structure.gates").passed)
        self.assertIn("measure", outcome(result, "structure.gates").detail)

    def test_a_late_gate_is_reported_even_when_no_measurement_is_required(self) -> None:
        result = judge("create-one", circ(1, [g("x", 0), m(0, 0), g("x", 0)], 1))
        self.assertFalse(result.passed)
        self.assertFalse(outcome(result, "structure.measure").passed)

    def test_evaluation_is_deterministic(self) -> None:
        circuit = circ(2, [g("h", 0), g("cx", 1, 0)])
        a, b = judge("create-bell", circuit), judge("create-bell", circuit)
        strip = lambda ev: [(c.id, c.passed, [(e.name, e.value) for e in c.evidence]) for c in ev.checks]  # noqa: E731
        self.assertEqual(strip(a), strip(b))
        self.assertEqual(a.circuit_hash, b.circuit_hash)


class TestRecordingAndLinkage(unittest.TestCase):
    def test_each_step_is_recorded_and_checks_name_their_records(self) -> None:
        recorded: list[tuple[str, str]] = []

        def record(result: ExecutionResult, prefix_hash: str) -> str:
            rid = f"res_test_{len(recorded)}"
            recorded.append((rid, prefix_hash))
            return rid

        challenge = CHALLENGE_BY_ID["phase-kickback"]
        evaluation = evaluate_challenge(challenge, challenge.reference_solution, AER, max_qubits=8, max_operations=64, record_execution=record)
        self.assertEqual(len(recorded), len(challenge.reference_solution.ops) + 1)
        self.assertEqual(evaluation.final_result_id, recorded[-1][0])
        ids = {rid for rid, _ in recorded}
        for check in evaluation.checks:
            if check.id.startswith("structure."):
                self.assertIsNone(check.result_id)
            else:
                self.assertIn(check.result_id, ids)
        before = outcome(evaluation, "before.eigenstate").result_id
        self.assertEqual(before, recorded[3][0], "the state before the CX is the one after the 3 preparation gates (step 3)")

    def test_nothing_is_recorded_when_the_structure_fails(self) -> None:
        recorded: list[str] = []
        challenge = CHALLENGE_BY_ID["create-one"]
        evaluation = evaluate_challenge(
            challenge, circ(2, []), AER, max_qubits=8, max_operations=64, record_execution=lambda r, h: recorded.append(h) or "x"
        )
        self.assertEqual(recorded, [])
        self.assertIsNone(evaluation.final_result_id)
        self.assertIsNone(evaluation.backend)


class ApiCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        db = Path(self._tmp.name) / "challenges.db"
        self.store = ProvenanceStore(db)
        self.attempts = AttemptStore(db)
        self._patches = [
            patch.object(app_module, "_store", self.store),
            patch.object(app_module, "_attempts", self.attempts),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self.store.close()
        self.attempts.close()
        self._tmp.cleanup()


class TestSubmitEndpoint(ApiCase):
    def submit(self, challenge_id: str, circuit: Circuit):
        return app_module.submit_challenge(challenge_id, ChallengeSubmitRequest(circuit=circuit))

    def test_a_correct_submission_passes_and_is_linked_to_real_records(self) -> None:
        response = self.submit("create-bell", circ(2, [g("h", 0), g("cx", 1, 0)]))
        self.assertTrue(response.passed)
        self.assertEqual(response.verifier, "challenge/1")
        self.assertIsNone(response.next_hint)
        self.assertTrue(response.success_message)
        self.assertEqual(response.backend, "qiskit-aer")

        final = self.store.get(response.final_result_id)
        self.assertIsNotNone(final)
        self.assertEqual(final.provenance_class.value, "SIMULATION")
        self.assertEqual(final.circuit_hash, response.circuit_hash)
        self.assertIn(response.final_result_id, response.provenance)
        self.assertEqual(response.provenance[response.final_result_id].backend, "qiskit-aer")
        for check in response.checks:
            if check.result_id:
                self.assertIn(check.result_id, response.provenance)

        attempt = self.attempts.get(response.attempt_id)
        self.assertIsNotNone(attempt)
        self.assertTrue(attempt.passed)
        self.assertEqual(attempt.final_result_id, response.final_result_id)
        self.assertEqual(attempt.challenge_id, "create-bell")

    def test_a_wrong_submission_fails_with_a_deterministic_hint(self) -> None:
        response = self.submit("create-bell", circ(2, [g("h", 0)]))
        self.assertFalse(response.passed)
        self.assertIsNone(response.success_message)
        self.assertEqual(response.next_hint, CHALLENGE_BY_ID["create-bell"].hints[response.next_hint_index])
        again = self.submit("create-bell", circ(2, [g("h", 0)]))
        self.assertEqual(again.next_hint, response.next_hint)
        self.assertFalse(self.attempts.get(response.attempt_id).passed, "failures are logged too")

    def test_a_structure_failure_runs_nothing(self) -> None:
        before = len(self.store.list_by_circuit_hash("anything"))
        response = self.submit("deutsch-jozsa-fixed", circ(3, [g("h", 0)], 3))
        self.assertFalse(response.passed)
        self.assertIsNone(response.final_result_id)
        self.assertEqual(response.provenance, {})
        self.assertEqual(before, 0)

    def test_unknown_challenge_is_404(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            self.submit("no-such-challenge", circ(1, []))
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(caught.exception.detail["code"], "CHALLENGE_NOT_FOUND")

    def test_the_request_has_no_field_for_a_verdict_or_a_state(self) -> None:
        circuit = circ(1, [g("h", 0)]).model_dump(by_alias=True)
        for field in ("passed", "verdict", "statevector", "probabilities", "fidelity", "checks", "result_id"):
            with self.subTest(field=field):
                with self.assertRaises(ValidationError):
                    ChallengeSubmitRequest.model_validate({"circuit": circuit, field: True})

    def test_the_verdict_cannot_be_changed_by_a_language_model(self) -> None:
        class LyingLLM:
            def __call__(self, *args, **kwargs):  # pragma: no cover - must never be called
                raise AssertionError("the challenge evaluator must not consult an LLM")

            def draft(self, *args, **kwargs):  # pragma: no cover
                raise AssertionError("the challenge evaluator must not consult an LLM")

        with patch.object(app_module, "_llm_adapter", LyingLLM()):
            self.assertFalse(self.submit("create-one", circ(1, [g("h", 0)])).passed)
            self.assertTrue(self.submit("create-one", circ(1, [g("x", 0)])).passed)

    def test_an_unavailable_backend_is_503_and_no_verdict(self) -> None:
        class Down:
            name = "qiskit-aer"

            def run(self, *args, **kwargs):
                raise AdapterUnavailable("not installed")

        with patch.dict(app_module._adapters, {"qiskit-aer": Down()}):
            with self.assertRaises(HTTPException) as caught:
                self.submit("create-one", circ(1, [g("x", 0)]))
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail["code"], "CHALLENGE_BACKEND_UNAVAILABLE")

    def test_a_backend_returning_a_broken_state_is_502_and_no_pass(self) -> None:
        class Liar:
            name = "qiskit-aer"

            def run(self, circuit, mode, shots=None):
                size = 2**circuit.num_qubits
                bad = [[2.0, 0.0]] + [[0.0, 0.0]] * (size - 1)  # not normalised
                return ExecutionResult(
                    backend_name="qiskit-aer", backend_version="x", execution_mode="statevector", execution_id="e", statevector=bad
                )

        with patch.dict(app_module._adapters, {"qiskit-aer": Liar()}):
            with self.assertRaises(HTTPException) as caught:
                self.submit("create-one", circ(1, [g("x", 0)]))
        self.assertEqual(caught.exception.status_code, 502)

    def test_catalog_endpoint_lists_all_without_answers(self) -> None:
        catalog = app_module.list_challenges()
        self.assertEqual(len(catalog.challenges), 9)
        self.assertNotIn("reference_solution", json.dumps(catalog.model_dump(mode="json")))
        one = app_module.get_challenge_definition("create-one")
        self.assertEqual(one.id, "create-one")
        with self.assertRaises(HTTPException):
            app_module.get_challenge_definition("nope")


class TestChallengesAreOutsideTheTutor(unittest.TestCase):
    """Import graph: the evaluator can reach neither the tutor/LLM nor the provenance writers."""

    def imports(self, path: Path) -> set[str]:
        names: set[str] = set()
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names.update(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                names.add(node.module)
        return names

    def test_challenges_never_import_tutor_or_writers(self) -> None:
        files = list((BACKEND_ROOT / "qentor" / "challenges").rglob("*.py"))
        self.assertTrue(files)
        for file in files:
            imported = self.imports(file)
            for name in imported:
                self.assertFalse(name.startswith("qentor.tutor"), f"{file.name} imports {name}")
                self.assertFalse(name.startswith("qentor.provenance"), f"{file.name} imports {name}")
                self.assertNotIn("anthropic", name)


if __name__ == "__main__":
    unittest.main()
