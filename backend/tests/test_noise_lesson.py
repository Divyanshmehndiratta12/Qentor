"""Lesson 19 (Understanding Quantum Noise): structure, prose trust, the physics the text states (checked on the real Aer backend, test-only),
the server-graded checks, the tutor in three languages and the challenge link."""

from __future__ import annotations

import json
import re
import unittest

from qentor.api import app as app_module
from qentor.challenges import CHALLENGE_BY_ID
from qentor.circuit.model import Circuit, GateOp
from qentor.content.validation import CAPABILITY_ROUTES, validate_content
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.noise import NOISE_MODEL_SPECS, NoiseModelName, make_noise_config, run_noisy_shots
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
from qentor.tutor import answer_lesson_aware_question, resolve_lesson_context
from tests.test_tutor_lesson import DECIMAL, EXPLAIN, HI_EXPLAIN, HINT, KN_EXPLAIN, SIMPLER

ID = "quantum-noise"
LESSON = get_lesson(ID)
AER = AerAdapter()
SHAPE = ["explanation"] * 4 + ["concept_check", "explanation", "concept_check", "explanation", "interactive_lab", "reflection"]
DECIMAL_OR_PERCENT = re.compile(r"\d+\.\d+|\d+\s?%")


def g(name, targets, controls=(), clbits=()):
    return GateOp(gate=name, targets=list(targets), controls=list(controls), params=[], clbits=list(clbits))


def measured(n, *ops):
    return Circuit(num_qubits=n, num_clbits=n, ops=[*ops, *[g("measure", [q], clbits=[q]) for q in range(n)]])


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
    def test_it_is_lesson_nineteen_after_the_shor_lesson(self) -> None:
        self.assertEqual(len(LESSONS), 19)
        self.assertEqual(LESSONS[-1].id, ID)
        self.assertEqual(LESSONS[-2].id, "shors-algorithm")

    def test_its_prerequisite_is_the_bell_state_lesson_and_it_exists(self) -> None:
        self.assertEqual(LESSON.prerequisite_lesson_ids, ["bell-state"])
        self.assertIsNotNone(get_lesson("bell-state"))

    def test_ten_sections_in_the_agreed_shape_with_unique_ids(self) -> None:
        self.assertEqual([s.type for s in LESSON.sections], SHAPE)
        self.assertEqual([s.id for s in LESSON.sections], [f"s{i}" for i in range(1, 11)])

    def test_metadata(self) -> None:
        self.assertEqual((LESSON.title, LESSON.difficulty, LESSON.concept), ("Understanding Quantum Noise", "intermediate", "quantum-noise"))
        self.assertGreaterEqual(len(LESSON.learning_objectives), 4)
        self.assertGreater(LESSON.estimated_minutes, 0)

    def test_explanations_are_short_single_paragraphs(self) -> None:
        for s in LESSON.sections:
            if isinstance(s, ExplanationSection):
                self.assertTrue(120 <= len(s.body) <= 680, f"{s.id}: {len(s.body)} chars")
                self.assertNotIn("\n", s.body)

    def test_two_concept_checks_each_with_one_correct_option_and_an_explanation(self) -> None:
        checks = [s for s in LESSON.sections if isinstance(s, ConceptCheckSection)]
        self.assertEqual([c.id for c in checks], ["s5", "s7"])
        self.assertEqual([c.correct_option_id for c in checks], ["b", "a"])
        for check in checks:
            self.assertEqual(len(check.options), 4)
            self.assertEqual(len({o.text for o in check.options}), 4)
            self.assertTrue(check.explanation.strip())
            self.assertEqual(check.concept, "quantum-noise")
            lengths = sorted(len(o.text) for o in check.options)
            correct = len(next(o for o in check.options if o.id == check.correct_option_id).text)
            self.assertLess(correct, lengths[-1] * 1.35, "the correct answer is not a tell")
        self.assertIn("Readout error", checks[0].options[1].text)
        self.assertIn("each extra gate", checks[1].options[0].text)

    def test_the_lab_names_the_noise_capability_and_the_route(self) -> None:
        (lab,) = [s for s in LESSON.sections if isinstance(s, InteractiveLabSection)]
        self.assertEqual(lab.capability, "noise_compare")
        self.assertEqual(CAPABILITY_ROUTES["noise_compare"], ("POST", "/api/noise/compare"))
        for word in ("Noise Lab", "simulator", "server", "simulated"):
            self.assertIn(word, lab.instructions)

    def test_the_linked_circuit_is_a_measured_bell_pair(self) -> None:
        circuit = LESSON.linked_circuit
        self.assertEqual((circuit.num_qubits, circuit.num_clbits), (2, 2))
        self.assertEqual([(o.gate.value, o.targets, o.controls) for o in circuit.ops], [("h", [0], []), ("cx", [1], [0]), ("measure", [0], []), ("measure", [1], [])])

    def test_the_served_catalog_carries_it_without_keys_or_explanations(self) -> None:
        served = {l.id: l for l in app_module.list_lessons().lessons}[ID]
        self.assertEqual([s.model_dump() for s in served.sections], [s.model_dump() for s in public_lesson(LESSON).sections])
        blob = json.dumps(served.model_dump(mode="json"))
        self.assertNotIn("correct_option_id", blob)
        for s in LESSON.sections:
            if isinstance(s, ConceptCheckSection):
                self.assertNotIn(s.explanation, blob)

    def test_the_challenge_is_linked_and_the_validator_passes(self) -> None:
        self.assertEqual(CHALLENGE_BY_ID["noise-shorten-circuit"].lesson_id, ID)
        try:
            AER.run(LESSON.linked_circuit, "shots", 10)
        except AdapterUnavailable as exc:
            self.skipTest(str(exc))
        pairs = {(m, r.path) for r in app_module.app.routes for m in getattr(r, "methods", ())}
        self.assertIn(("POST", "/api/noise/compare"), pairs)
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
        for sid in ("s2", "s3", "s4", "s6"):
            self.assertIn("textbook", section(sid).body.lower(), sid)

    def test_it_says_the_noise_is_simulated_and_not_a_device_at_the_start_and_again_at_the_end(self) -> None:
        s1 = section("s1").body
        for needle in ("The noise here is simulated", "not a model of any real device", "no hardware is used"):
            self.assertIn(needle, s1, needle)
        self.assertIn("simulated", section("s9").instructions)
        self.assertIn("finite samples", section("s8").body)

    def test_it_claims_no_hardware_speedup_advantage_or_calibration(self) -> None:
        text = " ".join(all_text(LESSON)).lower()
        for claim in ("on real hardware", "ibm", "qpu", "recorded run", "speedup", "speed-up", "quantum advantage", "fidelity", "calibrat", "error correction fixes", "noise-free"):
            self.assertNotIn(claim, text, claim)

    def test_the_deck_illustrative_numbers_never_appear(self) -> None:
        for forbidden in ("71 of 72", "71/72"):
            self.assertNotIn(forbidden, " ".join(all_text(LESSON)))

    def test_the_tutor_topics_are_in_the_section_titles(self) -> None:
        titles = " | ".join(s.title.lower() for s in LESSON.sections)
        for needle in ("ideal and noisy", "a run is a sample", "gate noise", "readout error", "deeper circuits", "reading a comparison"):
            self.assertIn(needle, titles, needle)


class TestThePhysicsTheTextStates(unittest.TestCase):
    """Checked on the real backend. Test-only: nothing here is shipped."""

    def setUp(self) -> None:
        try:
            AER.run(measured(1), "shots", 10)
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")

    def run_noisy(self, circuit, model, strength, seed=5, shots=4000):
        return run_noisy_shots(circuit, shots, make_noise_config(model, strength, seed)).counts

    def test_s2_an_ideal_equal_superposition_gives_a_spread_and_two_runs_differ_a_little(self) -> None:
        one_qubit = measured(1, g("h", [0]))
        a = AER.run(one_qubit, "shots", 4000, seed_simulator=1).counts
        b = AER.run(one_qubit, "shots", 4000, seed_simulator=2).counts
        self.assertEqual(set(a), {"0", "1"})
        self.assertNotEqual(a, b)
        for counts in (a, b):
            self.assertTrue(0.45 < counts["0"] / 4000 < 0.55)

    def test_s3_a_phase_flip_cannot_be_seen_by_a_plain_zero_or_one_measurement_of_a_basis_state(self) -> None:
        self.assertEqual(set(self.run_noisy(measured(1, g("x", [0])), "phase_flip", 0.5)), {"1"})

    def test_s3_amplitude_damping_lets_a_one_decay_towards_zero(self) -> None:
        counts = self.run_noisy(measured(1, g("x", [0])), "amplitude_damping", 0.5)
        self.assertGreater(counts.get("0", 0), 1000)
        self.assertGreater(counts.get("1", 0), 1000)

    def test_s3_a_bit_flip_swaps_zero_and_one(self) -> None:
        counts = self.run_noisy(measured(1, g("x", [0])), "bit_flip", 0.5)
        self.assertTrue(1500 < counts.get("0", 0) < 2500)

    def test_s3_depolarizing_noise_acts_on_every_qubit_a_gate_touched(self) -> None:
        # CX touches both qubits: both bits of an outcome can be disturbed, so all four outcomes appear
        counts = self.run_noisy(measured(2, g("x", [0]), g("cx", [1], [0])), "depolarizing", 0.3)
        self.assertEqual(set(counts), {"00", "01", "10", "11"})

    def test_s4_readout_error_acts_with_no_gates_at_all_and_gate_noise_cannot(self) -> None:
        nothing = measured(1)
        self.assertEqual(set(self.run_noisy(nothing, "readout_error", 0.3)), {"0", "1"})
        for model in ("depolarizing", "bit_flip", "phase_flip", "amplitude_damping"):
            self.assertEqual(set(self.run_noisy(nothing, model, 0.3)), {"0"}, model)

    def test_s5_only_readout_error_acts_at_measurement_the_others_act_after_gates(self) -> None:
        acts_at = {name.value: spec.applies_to for name, spec in NOISE_MODEL_SPECS.items() if name is not NoiseModelName.NONE}
        self.assertEqual(acts_at, {"depolarizing": "gates", "bit_flip": "gates", "phase_flip": "gates", "amplitude_damping": "gates", "readout_error": "measurement"})

    def test_s6_s7_a_circuit_padded_with_cancelling_gates_collects_more_noise(self) -> None:
        short = measured(1, g("x", [0]))
        long = measured(1, *[g("x", [0]) for _ in range(9)])  # nine X gates: still "1" in an ideal run
        self.assertEqual(set(AER.run(long, "shots", 500).counts), {"1"})
        wrong = lambda c: 1 - self.run_noisy(c, "depolarizing", 0.05).get("1", 0) / 4000
        self.assertLess(wrong(short), wrong(long))

    def test_s8_some_noise_leaves_a_measurement_unchanged(self) -> None:
        bell = measured(2, g("h", [0]), g("cx", [1], [0]))
        self.assertEqual(set(self.run_noisy(bell, "phase_flip", 0.4)), {"00", "11"})

    def test_the_lab_circuit_runs_ideally_and_noisily(self) -> None:
        self.assertEqual(set(AER.run(LESSON.linked_circuit, "shots", 500, seed_simulator=1).counts), {"00", "11"})
        self.assertTrue({"01", "10"} & set(self.run_noisy(LESSON.linked_circuit, "depolarizing", 0.2)))


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
            self.assertIn(section("s3").body.split(".")[0], answer)

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
