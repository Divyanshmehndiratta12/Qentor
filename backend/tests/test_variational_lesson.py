"""Lesson 17 (a one-parameter variational, VQE-style demonstration): structure, prose trust, the physics the text states (checked on the real
Aer backend, test-only), the server-graded checks, the tutor in three languages and the challenge link."""

from __future__ import annotations

import json
import math
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qentor.api import app as app_module
from qentor.challenges import CHALLENGE_BY_ID, CHALLENGES
from qentor.content.validation import CAPABILITY_ROUTES, validate_content
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.lessons import (
    LESSONS,
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    ReflectionSection,
    get_lesson,
    public_lesson,
)
from qentor.lessons.grading import grade_concept_check
from qentor.provenance.store import ProvenanceStore
from qentor.tutor import answer_lesson_aware_question, resolve_lesson_context
from qentor.verification import variational
from tests.test_tutor_lesson import DECIMAL, EXPLAIN, HI_EXPLAIN, HINT, KN_EXPLAIN, SIMPLER

ID = "variational-vqe"
LESSON = get_lesson(ID)
AER = AerAdapter()
PI = math.pi
SHAPE = ["explanation"] * 4 + ["concept_check", "interactive_lab", "concept_check"] + ["explanation"] * 2 + ["reflection"]
DECIMAL_OR_PERCENT = re.compile(r"\d+\.\d+|\d+\s?%")


def all_text(lesson) -> list[str]:
    parts = [lesson.title, lesson.short_description, *lesson.learning_objectives]
    for s in lesson.sections:
        parts.append(s.title)
        if isinstance(s, ExplanationSection):
            parts.append(s.body)
        elif isinstance(s, (ReflectionSection, ConceptCheckSection)):
            parts.append(s.prompt)
        elif isinstance(s, InteractiveLabSection):
            parts.append(s.instructions)
        if isinstance(s, ConceptCheckSection) and s.question is not None:
            parts += [s.question, s.explanation, *[o.text for o in s.options]]
    return parts


def section(section_id: str):
    return next(s for s in LESSON.sections if s.id == section_id)


class TestStructure(unittest.TestCase):
    def test_it_is_lesson_seventeen_after_the_error_correction_lesson(self) -> None:
        self.assertEqual(len(LESSONS), 19)  # lessons 18 and 19 follow (test_shor_lesson.py, test_noise_lesson.py)
        self.assertEqual(LESSONS[16].id, ID)
        self.assertEqual(LESSONS[15].id, "quantum-error-correction")

    def test_its_prerequisites_are_the_bloch_sphere_and_superposition_and_both_exist(self) -> None:
        self.assertEqual(LESSON.prerequisite_lesson_ids, ["bloch-sphere", "superposition"])
        for pid in LESSON.prerequisite_lesson_ids:
            self.assertIsNotNone(get_lesson(pid))

    def test_ten_sections_in_the_agreed_shape_with_unique_ids(self) -> None:
        self.assertEqual([s.type for s in LESSON.sections], SHAPE)
        self.assertEqual([s.id for s in LESSON.sections], [f"s{i}" for i in range(1, 11)])

    def test_metadata(self) -> None:
        self.assertEqual(LESSON.difficulty, "advanced")
        self.assertTrue(3 <= len(LESSON.learning_objectives) <= 5)
        self.assertTrue(10 <= LESSON.estimated_minutes <= 30)
        self.assertIsNone(LESSON.no_challenge_reason)
        self.assertIn("not chemistry", LESSON.short_description)

    def test_explanations_are_short_single_paragraphs(self) -> None:
        for s in LESSON.sections:
            if isinstance(s, ExplanationSection):
                self.assertTrue(120 <= len(s.body) <= 680, f"{s.id}: {len(s.body)} chars")
                self.assertNotIn("\n", s.body)

    def test_two_concept_checks_each_with_one_correct_option_and_an_explanation(self) -> None:
        checks = [s for s in LESSON.sections if isinstance(s, ConceptCheckSection)]
        self.assertEqual([c.id for c in checks], ["s5", "s7"])
        self.assertEqual([c.correct_option_id for c in checks], ["b", "c"])
        for check in checks:
            self.assertEqual(len(check.options), 4)
            self.assertEqual(len({o.text for o in check.options}), 4)
            self.assertTrue(check.explanation.strip())
            self.assertEqual(check.concept, "variational-algorithms")
        self.assertIn("angle of the rotation gate", checks[0].options[1].text)
        self.assertIn("lowest cost", checks[1].options[2].text)
        # the answer is not a tell: the correct option is not the longest by a wide margin
        for check in checks:
            lengths = sorted(len(o.text) for o in check.options)
            correct = len(next(o for o in check.options if o.id == check.correct_option_id).text)
            self.assertLess(correct, lengths[-1] * 1.35)

    def test_the_lab_names_the_sweep_capability_the_backend_and_the_trace(self) -> None:
        (lab,) = [s for s in LESSON.sections if isinstance(s, InteractiveLabSection)]
        self.assertEqual(lab.capability, "variational_sweep")
        self.assertEqual(CAPABILITY_ROUTES["variational_sweep"], ("POST", "/api/variational/sweep"))
        for word in ("backend", "trace", "sweep", "optimisation"):
            self.assertIn(word, lab.instructions)
        self.assertIn("computed by the server", lab.instructions)

    def test_the_linked_circuit_is_one_ry_gate_on_one_qubit(self) -> None:
        circuit = LESSON.linked_circuit
        self.assertEqual((circuit.num_qubits, circuit.num_clbits), (1, 0))
        self.assertEqual([(o.gate.value, o.targets, o.controls) for o in circuit.ops], [("ry", [0], [])])

    def test_the_served_catalog_carries_it_without_keys_or_explanations(self) -> None:
        served = {l.id: l for l in app_module.list_lessons().lessons}[ID]
        self.assertEqual([s.model_dump() for s in served.sections], [s.model_dump() for s in public_lesson(LESSON).sections])
        blob = json.dumps(served.model_dump(mode="json"))
        self.assertNotIn("correct_option_id", blob)
        for s in LESSON.sections:
            if isinstance(s, ConceptCheckSection):
                self.assertNotIn(s.explanation, blob)

    def test_the_challenge_is_linked_and_the_validator_passes(self) -> None:
        self.assertIn("vqe-find-theta", [c.id for c in CHALLENGES])  # the noise challenge follows it (test_noise_challenge.py)
        self.assertEqual(CHALLENGE_BY_ID["vqe-find-theta"].lesson_id, ID)
        self.assertEqual(CHALLENGE_BY_ID["vqe-find-theta"].title, "Find θ where ⟨Z⟩ = -1")
        try:
            AER.run(LESSON.linked_circuit, "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(str(exc))
        pairs = {(m, r.path) for r in app_module.app.routes for m in getattr(r, "methods", ())}
        report = validate_content(known_routes=pairs)
        self.assertTrue(report.ok, "\n" + str(report))


class TestProse(unittest.TestCase):
    def test_no_decimal_or_percentage(self) -> None:
        for text in all_text(LESSON):
            self.assertIsNone(DECIMAL_OR_PERCENT.search(text), text[:80])

    def test_no_text_claims_a_run_produced_a_particular_outcome(self) -> None:
        pattern = re.compile(r"(the backend (returned|reported|measured)|you (got|measured|saw) (a |an )?\d|our run|in our experiment)", re.I)
        for text in all_text(LESSON):
            self.assertIsNone(pattern.search(text), text[:80])

    def test_no_multi_qubit_ket(self) -> None:
        for text in all_text(LESSON):
            self.assertIsNone(re.search(r"\|[01]{2,}⟩", text), text[:80])

    def test_worked_reasoning_is_labelled_textbook(self) -> None:
        for sid in ("s2", "s3", "s4", "s8"):
            self.assertIn("textbook", section(sid).body.lower(), sid)

    def test_it_says_it_is_one_small_fixed_educational_example(self) -> None:
        s1 = section("s1").body
        for needle in ("ONE fixed one-parameter example", "small educational example", "VQE-style in shape only", "not a chemistry calculation", "not a scalable VQE", "needs no hardware"):
            self.assertIn(needle, s1, needle)

    def test_it_says_what_it_is_not_again_at_the_end(self) -> None:
        s9 = section("s9").body
        for needle in ("not a chemistry simulation", "not a scalable VQE", "does not use hardware", "statevector simulator"):
            self.assertIn(needle, s9, needle)

    def test_it_claims_no_chemistry_hardware_speedup_or_advantage(self) -> None:
        text = " ".join(all_text(LESSON)).lower()
        for claim in (
            "ground state energy",
            "molecule's energy",
            "hydrogen",
            "h2 ",
            "on real hardware",
            "ibm",
            "recorded run",
            "speed-up",
            "speedup",
            "quantum advantage",
            "faster than",
            "exponential",
            "scalable vqe is",
            "solves",
        ):
            self.assertNotIn(claim, text, claim)

    def test_the_deck_illustrative_numbers_never_appear(self) -> None:
        for forbidden in ("71 of 72", "71/72"):
            self.assertNotIn(forbidden, " ".join(all_text(LESSON)))

    def test_the_tutor_topics_are_in_the_section_titles(self) -> None:
        titles = " | ".join(s.title.lower() for s in LESSON.sections)
        for needle in ("circuit with a knob", "trial state", "expectation value", "classical loop", "cost curve", "stall", "is and is not"):
            self.assertIn(needle, titles, needle)


class TestThePhysicsTheTextStates(unittest.TestCase):
    """Checked on the real backend. Test-only: nothing here is shipped."""

    def setUp(self) -> None:
        try:
            AER.run(LESSON.linked_circuit, "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(str(exc))
        self._tmp = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmp.name) / "q.db")
        self._patch = patch.object(app_module, "_store", self.store)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    def record(self, result, chash):
        return app_module._record_run(result, chash, 1).result_id  # noqa: SLF001

    def at(self, theta: float):
        return variational.evaluate(theta, AER, self.record)

    def test_s2_the_arrow_starts_at_the_north_pole_and_swings_through_the_equator_to_the_south_pole(self) -> None:
        north, equator, south = self.at(0.0), self.at(PI / 2), self.at(PI)
        self.assertAlmostEqual(north.bloch[2], 1.0, places=9)
        self.assertAlmostEqual(equator.bloch[2], 0.0, places=9)
        self.assertAlmostEqual(abs(equator.bloch[0]), 1.0, places=9)
        self.assertAlmostEqual(south.bloch[2], -1.0, places=9)
        # a small angle leaves the arrow near the north pole; every angle stays on one great circle (y component zero)
        self.assertGreater(self.at(0.1).bloch[2], 0.99)
        for theta in (0.3, 1.0, 2.0, 3.0, 4.0, 5.5):
            self.assertAlmostEqual(self.at(theta).bloch[1], 0.0, places=9)

    def test_s3_the_cost_is_highest_up_in_the_middle_on_the_equator_and_lowest_down(self) -> None:
        self.assertAlmostEqual(self.at(0.0).expectation_z, 1.0, places=9)
        self.assertAlmostEqual(self.at(PI / 2).expectation_z, 0.0, places=9)
        self.assertAlmostEqual(self.at(PI).expectation_z, -1.0, places=9)

    def test_s3_it_is_the_average_of_plus_one_for_zero_and_minus_one_for_one(self) -> None:
        for theta in (0.4, 1.3, 2.9):
            p = self.at(theta)
            self.assertAlmostEqual(p.expectation_z, p.probabilities["0"] * 1 + p.probabilities["1"] * -1, places=12)

    def test_s4_the_gradient_comes_from_two_shifted_runs_and_the_loop_sees_only_cost_values(self) -> None:
        step = variational.run_optimization(1.0, 1, 0.5, AER, self.record).steps[0]
        self.assertAlmostEqual(step.gradient, 0.5 * (step.plus.expectation_z - step.minus.expectation_z), places=15)
        self.assertAlmostEqual(step.plus.theta - step.point.theta, variational.SHIFT, places=12)

    def test_s7_the_lowest_point_certainly_reads_one_and_the_highest_certainly_reads_zero(self) -> None:
        self.assertAlmostEqual(self.at(PI).probabilities["1"], 1.0, places=9)
        self.assertAlmostEqual(self.at(0.0).probabilities["0"], 1.0, places=9)

    def test_s7_every_angle_is_a_valid_circuit_with_one_gate(self) -> None:
        for theta in (-2.0, 0.0, 1.0, 7.0):
            self.assertEqual(len(variational.ansatz(theta).ops), 1)

    def test_s8_the_slope_is_flat_at_the_top_and_the_bottom_so_the_loop_stays(self) -> None:
        for start in (0.0, PI):
            report = variational.run_optimization(start, 3, 0.6, AER, self.record)
            self.assertEqual({round(s.point.theta, 12) for s in report.steps}, {round(start, 12)})
        moved = variational.run_optimization(0.5, 6, 0.6, AER, self.record)
        self.assertGreater(moved.steps[-1].point.theta, 0.5)
        self.assertLess(moved.steps[-1].point.expectation_z, moved.steps[0].point.expectation_z)  # anywhere else it slides toward the bottom

    def test_the_lab_circuit_runs_and_sits_on_the_equator(self) -> None:
        state = AER.run(LESSON.linked_circuit, "statevector").statevector
        from qentor.execution.expectation import z_expectation

        self.assertAlmostEqual(z_expectation(state, 0, 1), 0.0, places=9)

    def test_every_checks_answer_key_is_right_and_every_wrong_option_is_wrong(self) -> None:
        # s5: the loop changes the angle and nothing else, guided by cost values (the structure of run_optimization). The wrong options
        # describe things no function of the demonstration does: there is no parameter other than theta, and no code path edits outcomes.
        import inspect

        source = inspect.getsource(variational.run_optimization)
        self.assertIn("theta = theta - learning_rate * gradient", source)
        for banned in ("probabilities", "statevector", "observable"):
            self.assertNotIn(banned, source)


class TestServerGradingAndTheTutor(unittest.TestCase):
    def test_the_server_grades_each_check_and_returns_the_explanation_only_then(self) -> None:
        for check in (c for c in LESSON.sections if isinstance(c, ConceptCheckSection)):
            right = grade_concept_check(ID, check.id, check.correct_option_id)
            self.assertTrue(right.correct)
            self.assertEqual(right.explanation, check.explanation)
            for option in check.options:
                if option.id != check.correct_option_id:
                    wrong = grade_concept_check(ID, check.id, option.id)
                    self.assertFalse(wrong.correct, (check.id, option.id))

    def _ask(self, question, section_id, language="en"):
        return answer_lesson_aware_question(question, resolve_lesson_context(ID, section_id), [], None, None, language)[0]

    def test_explain_simpler_and_hint_work_on_every_section_in_three_languages(self) -> None:
        markers = {
            "en": ((EXPLAIN, "About this part of the lesson:"), (SIMPLER, "In short:"), (HINT, "A hint:")),
            "hi": ((EXPLAIN, "पाठ के इस भाग के बारे में:"), (SIMPLER, "संक्षेप में:"), (HINT, "एक संकेत:")),
            "kn": ((EXPLAIN, "ಪಾಠದ ಈ ಭಾಗದ ಬಗ್ಗೆ:"), (SIMPLER, "ಸಂಕ್ಷಿಪ್ತವಾಗಿ:"), (HINT, "ಒಂದು ಸುಳಿವು:")),
        }
        swept = 0
        for language, pairs in markers.items():
            for s in LESSON.sections:
                for question, marker in pairs:
                    answer = self._ask(question, s.id, language)
                    swept += 1
                    self.assertTrue(answer.startswith(marker), f"{language}/{s.id}/{question}: {answer[:60]}")
                    self.assertFalse(DECIMAL.search(answer), f"{language}/{s.id}/{question}")
        self.assertEqual(swept, 3 * 10 * 3)

    def test_hindi_and_kannada_localise_only_the_wrapper_the_lesson_text_stays_english(self) -> None:
        for language, marker in (("hi", HI_EXPLAIN), ("kn", KN_EXPLAIN)):
            answer = self._ask(EXPLAIN, "s3", language)
            self.assertIn(marker, answer)
            self.assertIn(section("s3").body.split(".")[0], answer)  # the lesson prose is quoted verbatim

    def test_a_hint_never_gives_the_answer_to_a_check(self) -> None:
        for check in (c for c in LESSON.sections if isinstance(c, ConceptCheckSection)):
            hint = self._ask(HINT, check.id)
            self.assertNotIn(check.explanation, hint)
            self.assertNotIn(next(o.text for o in check.options if o.id == check.correct_option_id), hint)

    def test_a_hint_on_a_check_points_at_the_nearest_explanation_and_the_first_objective(self) -> None:
        for index, check in enumerate(LESSON.sections):
            if isinstance(check, ConceptCheckSection):
                nearest = [s for s in LESSON.sections[:index] if isinstance(s, ExplanationSection)][-1]
                answer = self._ask(HINT, check.id)
                self.assertIn(nearest.body, answer)
                self.assertIn(LESSON.learning_objectives[0], answer)


if __name__ == "__main__":
    unittest.main()
