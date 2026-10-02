"""Quality, trust and physics tests for lessons 14-16: the Quantum Fourier Transform, Quantum Phase Estimation and Quantum Error
Correction (Sprint 4).

Same four groups as ``test_batch1_lessons.py``:

1. Structure and concept-check integrity (registration, prerequisites, ten sections, unique ids, answer keys, no leakage).
2. Prose trust: no decimal or percentage, no claimed outcome, no multi-qubit ket, textbook reasoning labelled, and the explicit
   honesty statements this sprint requires (fixed small educational examples, no scalable-QFT claim, exact example versus general QPE,
   injected error versus physical noise, deferred correction).
3. The physics each lesson states, checked on the REAL Aer backend: the linked circuits, the variants the lessons mention, the
   per-qubit states the visual sections describe, and every concept check's answer key (a wrong key fails a test). Test-only.
4. The tutor on every section, the server-side grading of every check, and the challenge and progression links.
"""

from __future__ import annotations

import cmath
import json
import math
import re
import unittest
from pathlib import Path

from qentor.challenges import CHALLENGE_BY_ID, CHALLENGES
from qentor.circuit.model import Circuit, GateOp
from qentor.content.validation import validate_content
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.trace import trace_circuit
from qentor.lessons import (
    LESSONS,
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    ReflectionSection,
    get_lesson,
    public_lesson,
)
from qentor.lessons.grading import GradeError, grade_concept_check
from qentor.tutor import answer_lesson_aware_question, resolve_lesson_context
from tests.test_batch1_lessons import _Backend, _complex, _g, _overlap, _purity
from tests.test_tutor_lesson import DECIMAL, EXPLAIN, HI_EXPLAIN, HINT, KN_EXPLAIN, SIMPLER, ask

QFT, QPE, QEC = "quantum-fourier-transform", "quantum-phase-estimation", "quantum-error-correction"
IDS = [QFT, QPE, QEC]
ALGO = [get_lesson(i) for i in IDS]
PI = math.pi

DECIMAL_OR_PERCENT = re.compile(r"\d+\.\d+|\d+\s?%")
SHAPE = ["explanation"] * 4 + ["concept_check", "interactive_lab", "concept_check"] + ["explanation"] * 2 + ["reflection"]
ANSWER_KEYS = {(QFT, "s5"): "b", (QFT, "s7"): "c", (QPE, "s5"): "c", (QPE, "s7"): "d", (QEC, "s5"): "a", (QEC, "s7"): "c"}
ANSWER_TEXT = {
    (QFT, "s5"): "equally often",
    (QFT, "s7"): "reverse qubit order",
    (QPE, "s5"): "turns the phase pattern into a basis state",
    (QPE, "s7"): "spread of strings",
    (QEC, "s5"): "Which data qubit disagrees",
    (QEC, "s7"): "A phase flip on a data qubit, or two bit flips at once",
}


def _checks(lesson):
    return [s for s in lesson.sections if isinstance(s, ConceptCheckSection) and s.question is not None]


def _all_checks():
    return [(lesson, s) for lesson in ALGO for s in _checks(lesson)]


def _all_text(lesson) -> list[str]:
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


def _section(lesson_id: str, section_id: str):
    return next(s for s in get_lesson(lesson_id).sections if s.id == section_id)


def _gate(gate, targets, controls=(), params=()):
    return GateOp(gate=gate, targets=list(targets), controls=list(controls), params=list(params))


def _ops(lesson_id):
    return [(o.gate.value, list(o.controls), list(o.targets), list(o.params), list(o.clbits)) for o in get_lesson(lesson_id).linked_circuit.ops]


# --------------------------------------------------------------------------- #
# 1. Structure                                                                #
# --------------------------------------------------------------------------- #


class TestAlgorithmStructure(unittest.TestCase):
    def test_they_are_lessons_fourteen_to_sixteen_after_the_original_thirteen_with_stable_ids(self) -> None:
        self.assertEqual([lesson.id for lesson in LESSONS][13:16], IDS)  # lessons 17 and 18 follow (test_variational_lesson.py, test_shor_lesson.py)
        self.assertEqual(len(LESSONS), 18)
        self.assertEqual(len({lesson.id for lesson in LESSONS}), 18)
        self.assertEqual(
            [lesson.id for lesson in LESSONS][:13],
            ["qubits-measurement", "bloch-sphere", "superposition", "phase", "interference", "entanglement", "bell-state",
             "phase-kickback", "deutsch-jozsa", "bernstein-vazirani", "superdense-coding", "quantum-teleportation", "grovers-search"],
        )  # fmt: skip

    def test_prerequisites_are_the_ones_the_brief_names_and_all_resolve(self) -> None:
        self.assertEqual(
            {lesson.id: lesson.prerequisite_lesson_ids for lesson in ALGO},
            {QFT: ["phase", "interference"], QPE: [QFT, "phase-kickback"], QEC: ["entanglement"]},
        )
        known = {lesson.id for lesson in LESSONS}
        for lesson in ALGO:
            self.assertTrue(set(lesson.prerequisite_lesson_ids) <= known, lesson.id)
            self.assertNotIn(lesson.id, lesson.prerequisite_lesson_ids)

    def test_the_prerequisite_graph_is_acyclic_and_qpe_comes_after_qft(self) -> None:
        order = [lesson.id for lesson in LESSONS]
        for lesson in LESSONS:
            for prerequisite in lesson.prerequisite_lesson_ids:
                self.assertLess(order.index(prerequisite), order.index(lesson.id), f"{lesson.id} <- {prerequisite}")

    def test_each_lesson_has_ten_sections_in_the_agreed_shape_with_unique_ids(self) -> None:
        for lesson in ALGO:
            self.assertEqual([s.type for s in lesson.sections], SHAPE, lesson.id)
            self.assertEqual([s.id for s in lesson.sections], [f"s{i}" for i in range(1, 11)], lesson.id)

    def test_difficulty_and_metadata(self) -> None:
        self.assertEqual({l.id: l.difficulty for l in ALGO}, {QFT: "advanced", QPE: "advanced", QEC: "advanced"})
        for lesson in ALGO:
            self.assertTrue(3 <= len(lesson.learning_objectives) <= 5, lesson.id)
            self.assertTrue(10 <= lesson.estimated_minutes <= 30, lesson.id)
            self.assertTrue(lesson.concept.strip())
            self.assertIsNone(lesson.no_challenge_reason, lesson.id)

    def test_explanations_are_short_paragraphs(self) -> None:
        for lesson in ALGO:
            for s in lesson.sections:
                if isinstance(s, ExplanationSection):
                    self.assertTrue(120 <= len(s.body) <= 680, f"{lesson.id}/{s.id}: {len(s.body)} chars")
                    self.assertNotIn("\n", s.body, f"{lesson.id}/{s.id}")

    def test_the_lab_points_at_the_backend_execute_capability_and_names_the_trace(self) -> None:
        for lesson in ALGO:
            (lab,) = [s for s in lesson.sections if isinstance(s, InteractiveLabSection)]
            self.assertEqual(lab.capability, "execute", lesson.id)
            self.assertIn("backend", lab.instructions.lower(), lesson.id)
            self.assertIn("trace", lab.instructions.lower(), lesson.id)
            self.assertIn("shots mode", lab.instructions, lesson.id)  # the measured result is read from sampled shots, not a collapsed statevector

    def test_the_linked_circuits_are_the_fixed_examples(self) -> None:
        pi2, pi4 = PI / 2, PI / 4
        self.assertEqual(
            _ops(QFT),
            [
                ("x", [], [0], [], []),
                ("h", [], [2], [], []), ("cp", [1], [2], [pi2], []), ("cp", [0], [2], [pi4], []),
                ("h", [], [1], [], []), ("cp", [0], [1], [pi2], []),
                ("h", [], [0], [], []), ("swap", [], [0, 2], [], []),
                ("measure", [], [0], [], [0]), ("measure", [], [1], [], [1]), ("measure", [], [2], [], [2]),
            ],
        )  # fmt: skip
        self.assertEqual(
            _ops(QPE),
            [
                ("x", [], [3], [], []), ("h", [], [0], [], []), ("h", [], [1], [], []), ("h", [], [2], [], []),
                ("cp", [0], [3], [pi2], []), ("cp", [1], [3], [PI], []),
                ("swap", [], [0, 2], [], []), ("h", [], [0], [], []), ("cp", [0], [1], [-pi2], []), ("h", [], [1], [], []),
                ("cp", [0], [2], [-pi4], []), ("cp", [1], [2], [-pi2], []), ("h", [], [2], [], []),
                ("measure", [], [0], [], [0]), ("measure", [], [1], [], [1]), ("measure", [], [2], [], [2]),
            ],
        )  # fmt: skip
        qec = _ops(QEC)
        self.assertEqual(len(qec), 20)
        self.assertEqual(
            qec[:8],
            [("ry", [], [0], [1.0], []), ("cx", [0], [1], [], []), ("cx", [0], [2], [], []), ("x", [], [1], [], []),
             ("cx", [0], [3], [], []), ("cx", [1], [3], [], []), ("cx", [1], [4], [], []), ("cx", [2], [4], [], [])],
        )  # fmt: skip
        self.assertEqual(
            [(get_lesson(i).linked_circuit.num_qubits, get_lesson(i).linked_circuit.num_clbits) for i in IDS], [(3, 3), (4, 3), (5, 5)]
        )

    def test_the_qpe_lab_uses_exactly_two_controlled_phases_because_s_four_times_is_the_identity(self) -> None:
        controlled = [o for o in get_lesson(QPE).linked_circuit.ops if o.gate.value == "cp" and o.targets == [3]]
        self.assertEqual(len(controlled), 2)
        self.assertIn("only two controlled-phase gates", _section(QPE, "s3").body)

    def test_the_circuits_use_no_mid_circuit_measurement_and_only_gates_the_model_supports(self) -> None:
        for lesson in ALGO:
            ops = lesson.linked_circuit.ops
            first_measure = next((i for i, o in enumerate(ops) if o.gate.value == "measure"), len(ops))
            self.assertTrue(all(o.gate.value == "measure" for o in ops[first_measure:]), lesson.id)
            self.assertEqual(ops[-1].gate.value, "measure", lesson.id)

    def test_every_check_has_exactly_one_correct_option_pinned_to_its_answer(self) -> None:
        self.assertEqual(len(_all_checks()), 6)
        self.assertEqual({(lesson.id, s.id) for lesson, s in _all_checks()}, set(ANSWER_KEYS))
        for lesson, s in _all_checks():
            ConceptCheckSection.model_validate(s.model_dump())
            self.assertEqual(sorted(o.id for o in s.options), ["a", "b", "c", "d"], f"{lesson.id}/{s.id}")
            self.assertEqual(s.correct_option_id, ANSWER_KEYS[(lesson.id, s.id)])
            correct = next(o.text for o in s.options if o.id == s.correct_option_id)
            self.assertIn(ANSWER_TEXT[(lesson.id, s.id)], correct, f"{lesson.id}/{s.id}")
            self.assertEqual(s.concept, lesson.concept)

    def test_options_are_real_distinct_and_the_answer_is_not_a_tell(self) -> None:
        for lesson, s in _all_checks():
            texts = [o.text.strip() for o in s.options]
            self.assertTrue(all(len(t) >= 8 for t in texts), f"{lesson.id}/{s.id}")
            self.assertEqual(len({t.lower() for t in texts}), 4, f"{lesson.id}/{s.id}")
            correct = next(o.text for o in s.options if o.id == s.correct_option_id)
            self.assertNotIn(correct.lower(), (s.question + " " + s.prompt).lower())
            self.assertTrue(s.question.strip().endswith("?"))
            self.assertGreaterEqual(len(s.explanation), 160)
            self.assertGreaterEqual(s.explanation.count("."), 2)
        self.assertGreaterEqual(len({s.correct_option_id for _, s in _all_checks()}), 4)
        longest = sum(1 for _, s in _all_checks() if len(next(o.text for o in s.options if o.id == s.correct_option_id)) == max(len(o.text) for o in s.options))
        self.assertLessEqual(longest, 3, "the correct option is the longest too often")

    def test_the_two_checks_of_a_lesson_test_different_things(self) -> None:
        for lesson in ALGO:
            first, second = _checks(lesson)
            self.assertNotEqual(first.question, second.question)
            self.assertFalse({o.text for o in first.options} & {o.text for o in second.options}, lesson.id)

    def test_the_served_catalog_carries_the_new_lessons_without_keys_or_explanations(self) -> None:
        from qentor.api import app as app_module

        served = {lesson.id: lesson for lesson in app_module.list_lessons().lessons}
        self.assertEqual(len(served), 18)
        for lesson in ALGO:
            self.assertEqual([s.model_dump() for s in served[lesson.id].sections], [s.model_dump() for s in public_lesson(lesson).sections])
            blob = json.dumps(served[lesson.id].model_dump(mode="json"))
            self.assertNotIn("correct_option_id", blob)
            for check in _checks(lesson):
                self.assertNotIn(check.explanation, blob)


# --------------------------------------------------------------------------- #
# 2. Prose trust                                                              #
# --------------------------------------------------------------------------- #


class TestAlgorithmProseNeverLooksLikeAResult(unittest.TestCase):
    def test_no_decimal_or_percentage_anywhere_in_a_lesson(self) -> None:
        for lesson in ALGO:
            for text in _all_text(lesson):
                self.assertFalse(DECIMAL_OR_PERCENT.search(text), f"{lesson.id}: {text[:80]!r}")

    def test_no_text_claims_a_run_produced_a_particular_outcome(self) -> None:
        pattern = re.compile(r"(the backend (returned|reported|measured)|you (got|measured|saw) (a |an )?\d|our run|in our experiment)", re.I)
        for lesson in ALGO:
            for text in _all_text(lesson):
                self.assertIsNone(pattern.search(text), f"{lesson.id}: {text[:80]!r}")

    def test_no_multi_qubit_ket_so_no_bit_order_is_left_unstated(self) -> None:
        for lesson in ALGO:
            for text in _all_text(lesson):
                self.assertIsNone(re.search(r"\|[01]{2,}⟩", text), f"{lesson.id}: {text[:80]!r}")

    def test_bit_strings_are_stated_in_qentors_order_where_they_are_used(self) -> None:
        self.assertIn("highest-numbered qubit on the left", _section(QFT, "s2").body)
        self.assertIn("q2 q1 q0", _section(QFT, "s2").body)
        self.assertIn("q2 q1 q0", _section(QPE, "s6").instructions)
        self.assertIn("q2 q1 q0", _section(QPE, "s8").body)
        self.assertIn("q4 q3", _section(QEC, "s6").instructions)
        self.assertIn("q2 q1 q0", _section(QEC, "s6").instructions)

    def test_the_deck_illustrative_numbers_never_appear(self) -> None:
        for lesson in ALGO:
            for forbidden in ("71 of 72", "71/72"):
                self.assertNotIn(forbidden, " ".join(_all_text(lesson)))

    def test_worked_reasoning_is_labelled_textbook(self) -> None:
        for lesson_id, section_id in ((QFT, "s2"), (QFT, "s3"), (QFT, "s4"), (QPE, "s2"), (QPE, "s3"), (QPE, "s4"), (QEC, "s2"), (QEC, "s4")):
            self.assertIn("textbook", _section(lesson_id, section_id).body.lower(), f"{lesson_id}/{section_id}")

    def test_each_lesson_says_it_is_one_small_fixed_educational_example(self) -> None:
        self.assertIn("ONE fixed 3-qubit example", _section(QFT, "s1").body)
        self.assertIn("small educational example", _section(QFT, "s1").body)
        self.assertIn("ONE exact fixed example", _section(QPE, "s1").body)
        self.assertIn("small educational example", _section(QPE, "s1").body)
        self.assertIn("ONE fixed 5-qubit example", _section(QEC, "s1").body)
        self.assertIn("small educational example", _section(QEC, "s1").body)

    def test_the_qft_lesson_does_not_claim_scalable_performance(self) -> None:
        body = _section(QFT, "s1").body
        self.assertIn("does not claim that the QFT is fast", body)
        text = " ".join(_all_text(get_lesson(QFT))).lower()
        for claim in ("exponential speed", "exponentially faster", "faster than the classical", "speed-up on", "quantum advantage"):
            self.assertNotIn(claim, text)

    def test_the_qpe_lesson_separates_the_exact_fixed_example_from_the_general_algorithm(self) -> None:
        self.assertIn("not the general algorithm", _section(QPE, "s1").body)
        s9 = _section(QPE, "s9").body
        for needle in ("need not be a whole number of eighths", "has to be supplied", "does not show a speed-up", "not a general tool"):
            self.assertIn(needle, s9, needle)
        self.assertIn("exact", get_lesson(QPE).short_description)
        self.assertIn("not the general algorithm", get_lesson(QPE).short_description)
        self.assertIn("general algorithm", _section(QPE, "s7").title)  # the second check tests exactly this

    def test_the_qec_lesson_says_the_injected_error_is_not_a_noise_model_everywhere_it_matters(self) -> None:
        self.assertIn("NOT a realistic noise model", _section(QEC, "s1").body)
        s3 = _section(QEC, "s3").body
        for needle in ("fixed X gate on q1", "Physical noise is nothing like that", "does not model physical noise", "shows no error rate"):
            self.assertIn(needle, s3, needle)
        self.assertIn("injected", get_lesson(QEC).short_description)
        self.assertIn("fixed", _section(QEC, "s9").body)
        self.assertIn("not a claim about fault tolerance", _section(QEC, "s9").body)

    def test_the_qec_lesson_says_the_correction_is_deferred_and_not_the_full_protocol(self) -> None:
        body = _section(QEC, "s8").body
        for needle in ("deferred correction", "NO mid-circuit measurement", "NO classical control", "not the full protocol"):
            self.assertIn(needle, body, needle)

    def test_no_lesson_claims_a_hardware_or_real_noise_result(self) -> None:
        for lesson in ALGO:
            text = " ".join(_all_text(lesson)).lower()
            for claim in ("on real hardware", "ibm", "recorded run", "error rate of", "threshold theorem shows"):
                self.assertNotIn(claim, text, lesson.id)

    def test_the_tutor_topics_each_lesson_must_cover_are_in_its_section_titles(self) -> None:
        titles = {lesson.id: " | ".join(s.title.lower() for s in lesson.sections) for lesson in ALGO}
        for needle in ("controlled phases matter", "basis change means", "final swaps are required"):
            self.assertIn(needle, titles[QFT], needle)
        for needle in ("eigenstates", "phase kickback", "inverse qft", "result becomes a bit string", "exact example versus the general algorithm"):
            self.assertIn(needle, titles[QPE], needle)
        for needle in ("syndrome represents", "redundancy", "injected error versus physical noise", "deferred correction"):
            self.assertIn(needle, titles[QEC], needle)

    def test_the_visual_sections_say_how_the_per_qubit_spheres_should_be_read(self) -> None:
        self.assertIn("not entangled", _section(QFT, "s9").body)
        self.assertIn("arrow of full length", _section(QFT, "s9").body)
        self.assertIn("backend's trace", _section(QFT, "s9").body)
        self.assertIn("shorter arrow on its sphere", _section(QEC, "s2").body)  # the entangled data qubits, honestly
        self.assertIn("sphere of q1", _section(QEC, "s9").body)


# --------------------------------------------------------------------------- #
# 3. The physics the lessons state, on the real backend                       #
# --------------------------------------------------------------------------- #

QFT3 = [_gate("h", [2]), _gate("cp", [2], [1], [PI / 2]), _gate("cp", [2], [0], [PI / 4]), _gate("h", [1]), _gate("cp", [1], [0], [PI / 2]), _gate("h", [0])]
SWAP02 = _gate("swap", [0, 2])
INVERSE_QFT3 = [
    SWAP02, _gate("h", [0]), _gate("cp", [1], [0], [-PI / 2]), _gate("h", [1]), _gate("cp", [2], [0], [-PI / 4]), _gate("cp", [2], [1], [-PI / 2]), _gate("h", [2]),
]  # fmt: skip
ENC = [_g("ry", 0, params=[1.0]), _g("cx", 1, [0]), _g("cx", 2, [0])]
SYNDROME = [_g("cx", 3, [0]), _g("cx", 3, [1]), _g("cx", 4, [1]), _g("cx", 4, [2])]
DECODER = [
    _gate("ccx", [1], [3, 4]),
    _g("x", 4), _gate("ccx", [0], [3, 4]), _g("x", 4),
    _g("x", 3), _gate("ccx", [2], [3, 4]), _g("x", 3),
]  # fmt: skip


def _basis_prep(x: int, n: int) -> list[GateOp]:
    return [_g("x", q) for q in range(n) if (x >> q) & 1]


def _probabilities(state) -> dict[str, float]:
    n = int(math.log2(len(state)))
    return {format(i, f"0{n}b"): abs(a) ** 2 for i, a in enumerate(state) if abs(a) ** 2 > 1e-12}


class TestQftPhysics(_Backend):
    def test_the_ladder_with_its_swap_is_the_textbook_qft_for_every_basis_input(self) -> None:
        for x in range(8):
            state = self.sv(3, *_basis_prep(x, 3), *QFT3, SWAP02)
            want = [cmath.exp(2j * PI * x * y / 8) / math.sqrt(8) for y in range(8)]
            self.assertAlmostEqual(_overlap(state, want), 1.0, places=9, msg=f"input {x}")

    def test_s2_for_the_input_one_every_outcome_has_the_same_size_and_the_phase_grows_by_one_eighth_of_a_turn(self) -> None:
        state = self.sv(3, _g("x", 0), *QFT3, SWAP02)
        for amplitude in state:
            self.assertAlmostEqual(abs(amplitude) ** 2, 1 / 8, places=9)
        steps = [cmath.phase(state[y + 1] / state[y]) for y in range(7)]
        for step in steps:
            self.assertAlmostEqual(step, 2 * PI / 8, places=9)

    def test_s2_the_phase_of_outcome_y_for_input_x_is_x_times_y_eighths_of_a_turn(self) -> None:
        for x in (1, 2, 5):
            state = self.sv(3, *_basis_prep(x, 3), *QFT3, SWAP02)
            for y in range(1, 8):
                relative = cmath.phase(state[y] / state[0]) % (2 * PI)
                self.assertAlmostEqual(relative, (2 * PI * x * y / 8) % (2 * PI), places=9, msg=f"x={x} y={y}")

    def test_s5_every_basis_input_gives_even_measurement_odds_so_the_input_cannot_be_read_off(self) -> None:
        for x in range(8):
            probabilities = _probabilities(self.sv(3, *_basis_prep(x, 3), *QFT3, SWAP02))
            self.assertEqual(len(probabilities), 8)
            for value in probabilities.values():
                self.assertAlmostEqual(value, 1 / 8, places=9)

    def test_s5_the_lab_circuit_sampled_shows_all_eight_outcomes_about_equally_often(self) -> None:
        lab = get_lesson(QFT).linked_circuit
        shots = self.shots(lab)
        self.assertEqual(len(shots), 8)
        for value in shots.values():
            self.assertTrue(0.07 <= value <= 0.18, shots)

    def test_s5_the_input_is_not_lost_the_inverse_qft_recovers_it(self) -> None:
        for x in range(8):
            state = self.sv(3, *_basis_prep(x, 3), *QFT3, SWAP02, *INVERSE_QFT3)
            probabilities = _probabilities(state)
            self.assertEqual(list(probabilities), [format(x, "03b")], f"input {x}")
            self.assertAlmostEqual(probabilities[format(x, "03b")], 1.0, places=9)

    def test_s7_without_the_swap_the_output_is_the_mirror_image_not_the_qft(self) -> None:
        for x in (1, 3):
            unswapped = self.sv(3, *_basis_prep(x, 3), *QFT3)
            qft = self.sv(3, *_basis_prep(x, 3), *QFT3, SWAP02)
            self.assertLess(_overlap(unswapped, qft), 1 - 1e-6, f"input {x}")
            self.assertAlmostEqual(_overlap(self.sv(3, *_basis_prep(x, 3), *QFT3, SWAP02), qft), 1.0, places=9)
            # the swap puts every part in its place: it is the mirror of the unswapped output
            mirrored = [unswapped[int(format(i, "03b")[::-1], 2)] for i in range(8)]
            self.assertAlmostEqual(_overlap(mirrored, qft), 1.0, places=9, msg=f"input {x}")

    def test_s7_the_swap_does_not_measure_and_does_not_cancel_the_phases(self) -> None:
        before = self.sv(3, _g("x", 0), *QFT3)
        after = self.sv(3, _g("x", 0), *QFT3, SWAP02)
        self.assertEqual(sorted(round(p, 9) for p in _probabilities(before).values()), sorted(round(p, 9) for p in _probabilities(after).values()))  # nothing collapsed
        phases = {round(cmath.phase(a / after[0]) % (2 * PI), 6) for a in after}
        self.assertGreater(len(phases), 2)  # the phases are all still there

    def test_s3_without_the_controlled_phases_the_output_is_not_the_qft_and_has_no_input_dependent_phases(self) -> None:
        h_only = [_gate("h", [q]) for q in (2, 1, 0)]
        qft = self.sv(3, _g("x", 0), *QFT3, SWAP02)
        plain = self.sv(3, _g("x", 0), *h_only)
        self.assertLess(_overlap(plain, qft), 1 - 1e-6)
        for amplitude in plain:  # only signs: a phase of nothing or half a turn
            phase = cmath.phase(amplitude) % PI
            self.assertTrue(min(phase, PI - phase) < 1e-9)

    def test_s3_the_controlled_phases_are_the_ones_that_make_the_phase_depend_on_the_other_qubits(self) -> None:
        # the output phase pattern for two different inputs differs only because of the controlled gates: with H alone the inputs one and
        # five (which differ only in q2, a control of two of the phases) give the same sign pattern on q0's digit
        for x in (1, 5):
            self.assertEqual(len(_probabilities(self.sv(3, *_basis_prep(x, 3), *QFT3, SWAP02))), 8)
        a = self.sv(3, _g("x", 0), *QFT3, SWAP02)
        b = self.sv(3, _g("x", 0), _g("x", 2), *QFT3, SWAP02)
        self.assertLess(_overlap(a, b), 1 - 1e-6)

    def test_s9_the_trace_shows_a_product_state_each_qubit_pure_on_the_equator_with_different_arrows(self) -> None:
        trace = trace_circuit(get_lesson(QFT).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64)
        self.assertEqual(len(trace.steps), 1 + 8)  # the initial state, then x, the ladder's six gates and the swap
        self.assertEqual(len(trace.terminal_measurements), 3)
        last = trace.steps[-1]
        angles = []
        for q in range(3):
            state = last.qubit_states[q]
            self.assertEqual(state.status, "OK")
            self.assertAlmostEqual(state.bloch_length, 1.0, places=9)  # a full-length arrow: not entangled
            self.assertAlmostEqual(state.purity, 1.0, places=9)
            self.assertFalse(state.entangled_with_rest)
            self.assertAlmostEqual(state.bloch.z, 0.0, places=9)  # on the equator
            angles.append(round(math.degrees(math.atan2(state.bloch.y, state.bloch.x)) % 360, 6))
        self.assertEqual(angles, [45.0, 90.0, 180.0])  # a different direction on each qubit, one phase per digit of the input

    def test_s9_the_amplitude_view_has_eight_rows_of_equal_size_with_stepping_phases(self) -> None:
        trace = trace_circuit(get_lesson(QFT).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64)
        view = trace.steps[-1].amplitude_view
        self.assertEqual(len(view), 8)
        for row in view:
            self.assertAlmostEqual(row.magnitude ** 2, 1 / 8, places=9)
        for y in range(7):
            step = (view[y + 1].phase - view[y].phase) % (2 * PI)
            self.assertAlmostEqual(step, PI / 4, places=9)

    def test_s9_before_the_swap_the_same_phases_sit_on_the_mirrored_qubits(self) -> None:
        trace = trace_circuit(get_lesson(QFT).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64)
        def angle(step, q):
            b = trace.steps[step].qubit_states[q].bloch
            return round(math.degrees(math.atan2(b.y, b.x)) % 360, 6)
        before_swap = [angle(7, q) for q in range(3)]  # initial, x, h, cp, cp, h, cp, h -> index 7 is the last gate of the ladder
        self.assertEqual(before_swap, [180.0, 90.0, 45.0])  # q0 and q2 exchanged
        self.assertEqual([angle(8, q) for q in range(3)], [45.0, 90.0, 180.0])

    def test_every_step_of_the_qft_trace_reconciles_with_an_independent_simulation(self) -> None:
        trace = trace_circuit(get_lesson(QFT).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64)
        ops = get_lesson(QFT).linked_circuit.ops[:-3]
        for index, step in enumerate(trace.steps):
            want = self.sv(3, *ops[:index])
            self.assertAlmostEqual(_overlap(_complex(step.statevector), want), 1.0, places=9, msg=f"step {index}")

    def test_the_cp_gate_is_symmetric_which_is_why_the_ladder_may_name_either_qubit_as_the_control(self) -> None:
        a = self.sv(2, _g("h", 0), _g("h", 1), _gate("cp", [1], [0], [PI / 2]))
        b = self.sv(2, _g("h", 0), _g("h", 1), _gate("cp", [0], [1], [PI / 2]))
        self.assertAlmostEqual(_overlap(a, b), 1.0, places=9)


class TestQpePhysics(_Backend):
    S_CONTROLLED = [_gate("cp", [3], [0], [PI / 2]), _gate("cp", [3], [1], [PI])]
    PREPARE = [_g("x", 3), _g("h", 0), _g("h", 1), _g("h", 2)]

    def lab_ops(self):
        return get_lesson(QPE).linked_circuit.ops[:-3]

    def test_s2_the_s_gate_multiplies_the_state_one_by_a_quarter_of_a_full_turn_and_nothing_else(self) -> None:
        state = self.sv(1, _g("h", 0), _g("s", 0))
        self.assertAlmostEqual(cmath.phase(state[1] / state[0]), PI / 2, places=9)  # a relative phase of a quarter turn on the one
        one = self.sv(1, _g("x", 0), _g("s", 0))
        self.assertAlmostEqual(abs(one[1]), 1.0, places=9)  # the state one is still the state one
        self.assertAlmostEqual(cmath.phase(one[1]), PI / 2, places=9)

    def test_s3_s_twice_is_a_half_turn_and_s_four_times_is_the_identity(self) -> None:
        self.assertAlmostEqual(cmath.phase(self.sv(1, _g("h", 0), _g("s", 0), _g("s", 0))[1] / self.sv(1, _g("h", 0))[1]) % (2 * PI), PI, places=9)
        four = self.sv(1, _g("h", 0), _g("s", 0), _g("s", 0), _g("s", 0), _g("s", 0))
        self.assertAlmostEqual(_overlap(four, self.sv(1, _g("h", 0))), 1.0, places=9)
        self.assertAlmostEqual(four[1] / four[0], self.sv(1, _g("h", 0))[1] / self.sv(1, _g("h", 0))[0], places=9)  # exactly, even the phase

    def test_s3_after_the_kickbacks_each_counting_qubit_carries_the_phase_of_its_power_of_s_and_q2_none(self) -> None:
        trace = trace_circuit(get_lesson(QPE).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64)
        index = 4 + 2  # initial, x, h, h, h, then the two controlled phases
        counting = []
        for q in range(3):
            state = trace.steps[index].qubit_states[q]
            self.assertAlmostEqual(state.bloch_length, 1.0, places=9)
            self.assertAlmostEqual(state.bloch.z, 0.0, places=9)
            counting.append(round(math.degrees(math.atan2(state.bloch.y, state.bloch.x)) % 360, 6))
        self.assertEqual(counting, [90.0, 180.0, 0.0])  # a quarter turn, a half turn, and no turn

    def test_s3_the_target_is_never_changed_by_any_step_and_never_entangled_with_the_counting_qubits(self) -> None:
        trace = trace_circuit(get_lesson(QPE).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64)
        self.assertEqual(len(trace.steps), 1 + 13)
        for index, step in enumerate(trace.steps):
            target = step.qubit_states[3]
            if index == 0:
                continue  # the initial state, before the X
            self.assertAlmostEqual(target.bloch.z, -1.0, places=9, msg=f"step {index}")  # the state one, at every step after the X
            self.assertAlmostEqual(target.bloch_length, 1.0, places=9)
            self.assertFalse(target.entangled_with_rest)

    def test_s4_before_the_inverse_qft_the_counting_register_holds_the_qft_pattern_of_the_number_two(self) -> None:
        before = self.sv(4, *self.PREPARE, *self.S_CONTROLLED)
        qft_of_two = self.sv(4, _g("x", 3), *_basis_prep(2, 3), *QFT3, SWAP02)
        self.assertAlmostEqual(_overlap(before, qft_of_two), 1.0, places=9)

    def test_s4_the_inverse_qft_is_the_qft_run_backwards(self) -> None:
        for x in range(8):
            state = self.sv(3, *_basis_prep(x, 3), *QFT3, SWAP02, *INVERSE_QFT3)
            self.assertAlmostEqual(_overlap(state, self.sv(3, *_basis_prep(x, 3))), 1.0, places=9)

    def test_s5_a_the_target_is_not_changed_by_the_inverse_qft_so_it_does_not_undo_the_kickback(self) -> None:
        trace = trace_circuit(get_lesson(QPE).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64)
        self.assertAlmostEqual(trace.steps[6].qubit_states[3].bloch.z, trace.steps[-1].qubit_states[3].bloch.z, places=9)

    def test_s5_b_d_the_counting_qubits_never_become_entangled_with_the_target_and_end_in_one_definite_state_not_an_even_mix(self) -> None:
        final = self.sv(4, *self.lab_ops())
        probabilities = _probabilities(final)
        self.assertEqual(list(probabilities), ["1010"])  # the target one, the counting register q2 q1 q0 = 010
        self.assertAlmostEqual(probabilities["1010"], 1.0, places=9)

    def test_s5_c_the_phase_pattern_becomes_a_basis_state_whose_bits_spell_the_phase(self) -> None:
        before = self.sv(4, *self.PREPARE, *self.S_CONTROLLED)
        self.assertEqual(len(_probabilities(before)), 8)  # before: every counting outcome equally likely (a measurement cannot read the phase)
        after = _probabilities(self.sv(4, *self.lab_ops()))
        self.assertEqual(len(after), 1)

    def test_s6_the_lab_reads_the_counting_register_zero_one_zero_every_time(self) -> None:
        shots = self.shots(get_lesson(QPE).linked_circuit)
        self.assertEqual(shots, {"010": 1.0})  # three counting bits, written c2 c1 c0 = q2 q1 q0

    def test_s8_the_bit_string_zero_one_zero_is_two_eighths_which_is_the_phase_of_s_on_its_eigenstate(self) -> None:
        number = int("010", 2)
        self.assertEqual(number, 2)
        self.assertAlmostEqual(number / 8, 0.25)
        one = self.sv(1, _g("x", 0), _g("s", 0))
        self.assertAlmostEqual(cmath.phase(one[1]) / (2 * PI), number / 8, places=9)

    def test_s7_d_a_phase_that_is_not_a_whole_number_of_eighths_gives_a_spread_near_the_true_phase(self) -> None:
        phi = 1 / 3
        controlled = [_gate("cp", [3], [j], [2 * PI * phi * 2**j]) for j in range(3)]
        final = _probabilities(self.sv(4, *self.PREPARE, *controlled, *INVERSE_QFT3))
        counting = {}
        for bits, p in final.items():
            counting[bits[1:]] = counting.get(bits[1:], 0) + p
        self.assertGreaterEqual(len(counting), 4)  # a spread, not one string
        top = max(counting, key=counting.get)
        self.assertIn(int(top, 2), (2, 3))  # the two eighths either side of a third of a turn
        self.assertEqual(int(top, 2), 3)
        self.assertTrue(0.4 < counting[top] < 0.95)
        near = counting[format(2, "03b")] + counting[format(3, "03b")]
        self.assertGreater(near, 0.7)  # most of the weight is on the two nearest

    def test_s7_a_b_c_the_wrong_options_are_wrong_even_for_a_non_eighth_phase(self) -> None:
        phi = 1 / 3
        controlled = [_gate("cp", [3], [j], [2 * PI * phi * 2**j]) for j in range(3)]
        measured = Circuit(num_qubits=4, num_clbits=3, ops=[*self.PREPARE, *controlled, *INVERSE_QFT3, GateOp(gate="measure", targets=[0], clbits=[0]), GateOp(gate="measure", targets=[1], clbits=[1]), GateOp(gate="measure", targets=[2], clbits=[2])])
        sampled = self.shots(measured)
        self.assertGreater(len(sampled), 3)  # (a) not one string every time
        self.assertTrue(all(len(bits) == 3 for bits in sampled))  # (c) it is the counting qubits that were measured

    def test_the_qpe_trace_has_the_lab_circuits_thirteen_operations_and_reconciles_step_by_step(self) -> None:
        trace = trace_circuit(get_lesson(QPE).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64)
        ops = self.lab_ops()
        for index, step in enumerate(trace.steps):
            self.assertAlmostEqual(_overlap(_complex(step.statevector), self.sv(4, *ops[:index])), 1.0, places=9, msg=f"step {index}")

    def test_after_the_inverse_qft_each_counting_qubit_sits_on_a_pole_so_the_bit_string_is_definite(self) -> None:
        final = trace_circuit(get_lesson(QPE).linked_circuit, self.aer, mode="statevector", max_qubits=8, max_operations=64).steps[-1]
        z = [round(final.qubit_states[q].bloch.z, 9) for q in range(4)]
        self.assertEqual(z, [1.0, -1.0, 1.0, -1.0])  # q0 = 0, q1 = 1, q2 = 0, target = 1


class TestQecPhysics(_Backend):
    def lab(self):
        return get_lesson(QEC).linked_circuit

    def test_s2_the_encoding_gives_all_data_qubits_agreeing_not_three_copies(self) -> None:
        state = self.sv(5, *ENC)
        self.assertEqual(sorted(_probabilities(state)), ["00000", "00111"])
        self.assertAlmostEqual(_probabilities(state)["00111"], math.sin(0.5) ** 2, places=9)
        copies = self.sv(3, _g("ry", 0, params=[1.0]), _g("ry", 1, params=[1.0]), _g("ry", 2, params=[1.0]))
        encoded = self.sv(3, *ENC[:3])
        self.assertLess(_overlap(encoded, copies), 0.9)  # not three copies of the state

    def test_s2_each_data_qubit_alone_has_a_shorter_arrow_than_a_qubit_in_a_state_of_its_own(self) -> None:
        trace = trace_circuit(self.lab(), self.aer, mode="statevector", max_qubits=8, max_operations=64)
        after_encoding = trace.steps[3]
        for q in range(3):
            state = after_encoding.qubit_states[q]
            self.assertLess(state.bloch_length, 0.99)
            self.assertTrue(state.entangled_with_rest)
        for q in (3, 4):
            self.assertAlmostEqual(after_encoding.qubit_states[q].bloch_length, 1.0, places=9)  # the ancillas have not done anything yet

    def test_s4_the_syndrome_pattern_names_the_flipped_qubit_and_is_silent_without_an_error(self) -> None:
        patterns = {}
        for error in (None, 0, 1, 2):
            ops = [*ENC, *([_g("x", error)] if error is not None else []), *SYNDROME]
            probabilities = _probabilities(self.sv(5, *ops))
            ancillas = {bits[:2] for bits in probabilities}  # written q4 q3
            self.assertEqual(len(ancillas), 1, f"error {error}: the ancillas are definite")
            patterns[error] = ancillas.pop()
        self.assertEqual(patterns, {None: "00", 0: "01", 1: "11", 2: "10"})  # q0: only the first parity; q1: both; q2: only the second

    def test_s5_a_the_syndrome_does_not_depend_on_the_encoded_state(self) -> None:
        for angle in (0.3, 1.0, 2.0, 3.0):
            ops = [_g("ry", 0, params=[angle]), _g("cx", 1, [0]), _g("cx", 2, [0]), _g("x", 1), *SYNDROME]
            self.assertEqual({bits[:2] for bits in _probabilities(self.sv(5, *ops))}, {"11"}, f"angle {angle}")

    def test_s5_b_the_ancillas_are_in_a_definite_state_so_they_hold_no_copy_of_the_encoded_state(self) -> None:
        trace = trace_circuit(Circuit(num_qubits=5, num_clbits=0, ops=[*ENC, _g("x", 1), *SYNDROME]), self.aer, mode="statevector", max_qubits=8, max_operations=64)
        last = trace.steps[-1]
        for q in (3, 4):
            self.assertAlmostEqual(last.qubit_states[q].bloch_length, 1.0, places=9)
            self.assertAlmostEqual(last.qubit_states[q].bloch.z, -1.0, places=9)  # the state one: a flag, not the encoded state

    def test_s6_the_lab_reads_the_syndrome_one_one_and_the_data_qubits_agree_every_time(self) -> None:
        shots = self.shots(self.lab())
        self.assertGreater(len(shots), 1)
        for bits, p in shots.items():  # written c4 c3 c2 c1 c0
            self.assertEqual(bits[:2], "11", bits)  # ancillas q4 q3
            self.assertIn(bits[2:], ("000", "111"), bits)  # q2 q1 q0 all agree
        self.assertAlmostEqual(shots.get("11111", 0), math.sin(0.5) ** 2, delta=0.05)

    def test_s6_the_injected_x_turns_q1s_arrow_around_and_the_correction_turns_it_back(self) -> None:
        trace = trace_circuit(self.lab(), self.aer, mode="statevector", max_qubits=8, max_operations=64)
        z = [trace.steps[i].qubit_states[1].bloch.z for i in range(len(trace.steps))]
        encoded_z = math.cos(1.0)
        self.assertAlmostEqual(z[3], encoded_z, places=9)  # after the encoding
        self.assertAlmostEqual(z[4], -encoded_z, places=9)  # after the injected X: the arrow has turned around
        self.assertAlmostEqual(z[-1], encoded_z, places=9)  # after the correction: back
        self.assertEqual(len(trace.terminal_measurements), 5)

    def test_s6_without_the_ccx_on_q1_the_result_is_uncorrected(self) -> None:
        ops = list(self.lab().ops)
        index = next(i for i, o in enumerate(ops) if o.gate.value == "ccx" and o.targets == [1])
        broken = Circuit(num_qubits=5, num_clbits=5, ops=ops[:index] + ops[index + 1 :])
        shots = self.shots(broken)
        for bits in shots:
            self.assertEqual(bits[2:], "010" if bits[2:] == "010" else "101", bits)  # data q2 q1 q0: q1 disagrees with the other two
        self.assertTrue(all(bits[2:] in ("010", "101") for bits in shots))

    def test_s7_each_single_bit_flip_is_corrected_and_the_whole_register_returns_to_the_encoded_state(self) -> None:
        patterns = {0: "01", 1: "11", 2: "10"}
        for error, pattern in patterns.items():
            final = self.sv(5, *ENC, _g("x", error), *SYNDROME, *DECODER)
            flags = [_g("x", 3 + i) for i, bit in enumerate(reversed(pattern)) if bit == "1"]  # pattern is written q4 q3
            want = self.sv(5, *ENC, *flags)
            self.assertAlmostEqual(_overlap(final, want), 1.0, places=9, msg=f"error on q{error}")

    def test_s7_without_an_error_the_decoder_does_nothing(self) -> None:
        final = self.sv(5, *ENC, *SYNDROME, *DECODER)
        self.assertAlmostEqual(_overlap(final, self.sv(5, *ENC)), 1.0, places=9)

    def test_s7_c_a_phase_flip_is_not_noticed_and_not_corrected(self) -> None:
        final = self.sv(5, *ENC, _g("z", 1), *SYNDROME, *DECODER)
        self.assertEqual({bits[:2] for bits in _probabilities(final)}, {"00"})  # the syndrome is silent
        self.assertLess(_overlap(final, self.sv(5, *ENC)), 1 - 1e-6)  # and the encoded state is damaged
        alpha, beta = math.cos(0.5), math.sin(0.5)
        signed = [0j] * 32
        signed[0b00000], signed[0b00111] = alpha, -beta  # the encoded state with its sign flipped
        self.assertAlmostEqual(_overlap(final, signed), 1.0, places=9)

    def test_s7_c_two_bit_flips_are_corrected_the_wrong_way_and_the_encoded_state_ends_up_flipped(self) -> None:
        final = self.sv(5, *ENC, _g("x", 0), _g("x", 1), *SYNDROME, *DECODER)
        probabilities = _probabilities(final)
        self.assertEqual({bits[:2] for bits in probabilities}, {"10"})  # the syndrome of a flip on q2: the decoder was fooled
        self.assertAlmostEqual(probabilities["10111"], math.cos(0.5) ** 2, places=9)  # data 111 with the odds of the other value
        self.assertAlmostEqual(probabilities["10000"], math.sin(0.5) ** 2, places=9)  # the logical value is flipped

    def test_s8_each_correction_gate_acts_only_on_its_own_syndrome_pattern(self) -> None:
        for error, fixed in ((0, "q0"), (1, "q1"), (2, "q2")):
            with_error = self.sv(5, *ENC, _g("x", error), *SYNDROME)
            corrected = self.sv(5, *ENC, _g("x", error), *SYNDROME, *DECODER)
            self.assertLess(_overlap(with_error, corrected), 1 - 1e-6, fixed)  # the decoder did something
            data_before = {bits[2:] for bits in _probabilities(with_error)}
            data_after = {bits[2:] for bits in _probabilities(corrected)}
            self.assertEqual(data_after, {"000", "111"}, fixed)
            self.assertNotEqual(data_before, data_after)

    def test_s9_after_the_correction_the_data_is_the_encoded_state_and_the_ancillas_still_hold_the_syndrome(self) -> None:
        final = self.sv(5, *self.lab().ops[:-5])
        want = self.sv(5, *ENC, _g("x", 3), _g("x", 4))
        self.assertAlmostEqual(_overlap(final, want), 1.0, places=9)
        last = trace_circuit(self.lab(), self.aer, mode="statevector", max_qubits=8, max_operations=64).steps[-1]
        for q in (3, 4):
            self.assertAlmostEqual(last.qubit_states[q].bloch.z, -1.0, places=9)
        for q in range(3):
            self.assertTrue(last.qubit_states[q].entangled_with_rest)  # each data qubit alone still looks undetermined

    def test_the_qec_trace_reconciles_step_by_step_and_is_within_the_trace_limit(self) -> None:
        trace = trace_circuit(self.lab(), self.aer, mode="statevector", max_qubits=8, max_operations=64)
        ops = self.lab().ops[:-5]
        self.assertEqual(len(trace.steps), 1 + 15)
        for index, step in enumerate(trace.steps):
            self.assertAlmostEqual(_overlap(_complex(step.statevector), self.sv(5, *ops[:index])), 1.0, places=9, msg=f"step {index}")
            self.assertEqual(len(step.qubit_states), 5)
            self.assertEqual(len(step.amplitude_view), 32)

    def test_no_mid_circuit_measurement_exists_in_the_model_so_the_deferred_correction_is_what_it_must_be(self) -> None:
        from qentor.circuit.model import GateName

        self.assertEqual(sorted(g.value for g in GateName if "reset" in g.value or "if" == g.value), [])
        for lesson in ALGO:
            ops = lesson.linked_circuit.ops
            first = next(i for i, o in enumerate(ops) if o.gate.value == "measure")
            self.assertTrue(all(o.gate.value == "measure" for o in ops[first:]))


# --------------------------------------------------------------------------- #
# 4. The tutor, grading, and the links to challenges and progression          #
# --------------------------------------------------------------------------- #


class TestAlgorithmLessonsWithTheTutor(unittest.TestCase):
    def _ask(self, question, lesson_id, section_id, language="en"):
        ctx = resolve_lesson_context(lesson_id, section_id)
        return answer_lesson_aware_question(question, ctx, [], None, None, language)[0]

    @staticmethod
    def _teaching(lesson) -> str:
        return " ".join(s.body for s in lesson.sections if isinstance(s, ExplanationSection))

    def test_every_section_resolves_and_explain_simpler_and_hint_work_everywhere(self) -> None:
        swept = 0
        for lesson in ALGO:
            for section in lesson.sections:
                for question, marker in ((EXPLAIN, "About this part of the lesson:"), (SIMPLER, "In short:"), (HINT, "A hint:")):
                    answer = self._ask(question, lesson.id, section.id)
                    swept += 1
                    self.assertTrue(answer.startswith(marker), f"{lesson.id}/{section.id}/{question}: {answer[:60]}")
                    self.assertFalse(DECIMAL.search(answer), f"{lesson.id}/{section.id}/{question}")
        self.assertEqual(swept, 3 * 10 * 3)

    def test_answers_stay_compact(self) -> None:
        for lesson in ALGO:
            for section in lesson.sections:
                for question in (EXPLAIN, SIMPLER, HINT):
                    limit = 2200 if question == EXPLAIN else 1500
                    self.assertLess(len(self._ask(question, lesson.id, section.id)), limit, f"{lesson.id}/{section.id}/{question}")

    def test_a_hint_on_a_check_points_at_the_nearest_explanation_and_the_first_objective(self) -> None:
        for lesson in ALGO:
            for index, section in enumerate(lesson.sections):
                if isinstance(section, ConceptCheckSection):
                    nearest = [s for s in lesson.sections[:index] if isinstance(s, ExplanationSection)][-1]
                    answer = self._ask(HINT, lesson.id, section.id)
                    self.assertIn(nearest.body, answer, f"{lesson.id}/{section.id}")
                    self.assertIn(lesson.learning_objectives[0], answer, f"{lesson.id}/{section.id}")

    def test_the_section_local_supporting_material_is_selected_correctly(self) -> None:
        for lesson in ALGO:
            for index, section in enumerate(lesson.sections):
                if isinstance(section, (ConceptCheckSection, InteractiveLabSection, ReflectionSection)):
                    material = [f for f in resolve_lesson_context(lesson.id, section.id).facts if f.kind == "lesson_material"]
                    nearest = [s for s in lesson.sections[:index] if isinstance(s, ExplanationSection)][-2:]
                    self.assertEqual(len(material), len(nearest), f"{lesson.id}/{section.id}")

    def test_no_answer_fact_or_response_leaks_a_correct_option_or_rationale(self) -> None:
        checked = 0
        for lesson in ALGO:
            teaching = self._teaching(lesson)
            for check in _checks(lesson):
                self.assertNotIn(check.explanation, teaching, f"{lesson.id}/{check.id}")
                correct = next(o.text for o in check.options if o.id == check.correct_option_id)
                for section in lesson.sections:
                    ctx = resolve_lesson_context(lesson.id, section.id)
                    facts = " ".join(f.description for f in ctx.facts)
                    self.assertNotIn(check.explanation, facts, f"{lesson.id}/{section.id}")
                    self.assertNotIn(check.explanation, ctx.topic_text, f"{lesson.id}/{section.id}")
                    if correct not in teaching:
                        self.assertNotIn(correct, facts, f"{lesson.id}/{section.id}")
                    for question in (EXPLAIN, SIMPLER, HINT):
                        answer = self._ask(question, lesson.id, section.id)
                        self.assertNotIn(check.explanation, answer, f"{lesson.id}/{section.id}/{question}")
                        if correct not in teaching:
                            self.assertNotIn(correct, answer, f"{lesson.id}/{section.id}/{question}")
                checked += 1
        self.assertEqual(checked, 6)

    def test_the_whole_endpoint_response_for_a_check_carries_no_answer_key(self) -> None:
        for lesson in ALGO:
            for check in _checks(lesson):
                blob = ask(question=HINT, lesson_id=lesson.id, section_id=check.id).model_dump_json()
                self.assertNotIn(check.explanation, blob, f"{lesson.id}/{check.id}")
                self.assertNotIn("correct_option", blob)
                self.assertNotIn("correctOption", blob)
                for option in check.options:
                    if option.text not in self._teaching(lesson):
                        self.assertNotIn(option.text, blob, f"{lesson.id}/{check.id}/{option.id}")

    def test_the_endpoint_answers_carry_the_lesson_and_no_quantum_provenance(self) -> None:
        for lesson in ALGO:
            response = ask(question=EXPLAIN, lesson_id=lesson.id, section_id="s2")
            self.assertEqual((response.lesson_id, response.section_id), (lesson.id, "s2"))
            self.assertIsNone(response.result_id)
            self.assertIsNone(response.provenance_class)
            self.assertIsNone(response.trace_step)
            self.assertTrue(all(f.id.startswith("L") for f in response.facts))

    def test_hindi_and_kannada_wrap_english_lesson_prose_quoted_verbatim(self) -> None:
        for lesson in ALGO:
            for section in (lesson.sections[0], lesson.sections[3], lesson.sections[8]):
                hi = self._ask(EXPLAIN, lesson.id, section.id, "hi")
                kn = self._ask(EXPLAIN, lesson.id, section.id, "kn")
                self.assertIn(HI_EXPLAIN, hi)
                self.assertIn(KN_EXPLAIN, kn)
                self.assertIn(section.body, hi, f"{lesson.id}/{section.id}")
                self.assertIn(section.body, kn, f"{lesson.id}/{section.id}")

    def test_the_topic_questions_the_brief_names_are_answered_from_the_matching_section(self) -> None:
        cases = [
            ("Why do controlled phases matter in the QFT?", QFT, "s3"),
            ("What does the basis change mean?", QFT, "s4"),
            ("Why are the final swaps required?", QFT, "s8"),
            ("What is an eigenstate and what is its phase?", QPE, "s2"),
            ("How does phase kickback work here?", QPE, "s3"),
            ("What does the inverse QFT do?", QPE, "s4"),
            ("Why does a phase turn into a bit string?", QPE, "s8"),
            ("Is this the general phase estimation algorithm?", QPE, "s9"),
            ("Why is redundancy useful here?", QEC, "s1"),
            ("What does the syndrome represent?", QEC, "s4"),
            ("How is an injected error different from physical noise?", QEC, "s3"),
            ("Why is the correction deferred?", QEC, "s8"),
        ]
        for question, lesson_id, section_id in cases:
            with self.subTest(question=question):
                answer = self._ask(question, lesson_id, section_id)
                self.assertTrue(answer.startswith("About this part of the lesson:"), answer[:80])
                self.assertIn(_section(lesson_id, section_id).body, answer)

    def test_a_lesson_question_never_carries_a_lab_result_or_a_trace_step(self) -> None:
        for lesson in ALGO:
            response = ask(question=HINT, lesson_id=lesson.id, section_id="s6")
            self.assertIsNone(response.trace_step)
            self.assertIsNone(response.result_id)

    def test_no_tutor_source_file_contains_any_algorithm_lesson_prose(self) -> None:
        tutor_dir = Path(__file__).resolve().parents[1] / "qentor" / "tutor"
        source = "\n".join(p.read_text(encoding="utf-8") for p in tutor_dir.glob("*.py"))
        for lesson in ALGO:
            for s in lesson.sections:
                if isinstance(s, ExplanationSection):
                    for start in range(0, len(s.body) - 45, 5):
                        self.assertNotIn(s.body[start : start + 45], source, f"{lesson.id}/{s.id}")
            for objective in lesson.learning_objectives:
                self.assertNotIn(objective[:40], source, lesson.id)


class TestAlgorithmServerGrading(unittest.TestCase):
    def test_the_right_option_is_correct_with_the_explanation_and_every_wrong_option_is_not(self) -> None:
        for lesson, check in _all_checks():
            for option in check.options:
                outcome = grade_concept_check(lesson.id, check.id, option.id)
                self.assertEqual(outcome.correct, option.id == check.correct_option_id, f"{lesson.id}/{check.id}/{option.id}")
                self.assertEqual(outcome.explanation, check.explanation)

    def test_bad_input_is_a_structured_error_not_a_verdict(self) -> None:
        with self.assertRaises(GradeError) as unknown_option:
            grade_concept_check(QFT, "s5", "z")
        self.assertEqual(unknown_option.exception.status_code, 422)
        with self.assertRaises(GradeError) as unknown_check:
            grade_concept_check(QPE, "s4", "a")  # an explanation, not a check
        self.assertEqual(unknown_check.exception.status_code, 404)
        with self.assertRaises(GradeError):
            grade_concept_check(QEC, "s99", "a")

    def test_a_check_cannot_be_graded_through_another_lesson(self) -> None:
        self.assertTrue(grade_concept_check(QFT, "s5", "b").correct)
        self.assertFalse(grade_concept_check(QPE, "s5", "b").correct)  # same section id, different lesson, different key
        self.assertTrue(grade_concept_check(QEC, "s5", "a").correct)
        self.assertFalse(grade_concept_check(QFT, "s7", "a").correct)

    def test_the_http_grading_route_answers_for_the_new_lessons_and_leaks_no_key_otherwise(self) -> None:
        from qentor.api import app as app_module

        served = {lesson.id: lesson for lesson in app_module.list_lessons().lessons}
        for lesson_id in IDS:
            blob = json.dumps(served[lesson_id].model_dump(mode="json"))
            self.assertNotIn("explanation\": \"After", blob)
            for check in _checks(get_lesson(lesson_id)):
                for option in check.options:
                    self.assertIn(option.text, blob)  # the options are public
                self.assertNotIn(check.explanation, blob)  # the rationale is not


class TestAlgorithmChallengeAndProgressionLinks(unittest.TestCase):
    CHALLENGE_FOR = {QFT: "qft-2qubit", QPE: "qpe-estimate-t", QEC: "qec-correct-flip-q1"}

    def test_each_lesson_is_linked_to_its_challenge_and_the_challenge_to_the_lesson(self) -> None:
        by_lesson: dict[str, list[str]] = {}
        for challenge in CHALLENGES:
            by_lesson.setdefault(challenge.lesson_id, []).append(challenge.id)
        for lesson_id, challenge_id in self.CHALLENGE_FOR.items():
            self.assertEqual(by_lesson[lesson_id], [challenge_id])
        self.assertEqual(by_lesson["interference"], ["interference", "optimize-redundant"])  # not displaced
        self.assertEqual(by_lesson["bell-state"], ["create-bell"])
        self.assertEqual(by_lesson["grovers-search"], ["grover-find-01"])

    def test_every_one_of_the_fifteen_earlier_challenges_is_still_there_in_order(self) -> None:
        self.assertEqual(
            [c.id for c in CHALLENGES][:15],
            ["create-one", "create-plus", "create-minus", "create-bell", "phase-change", "interference", "phase-kickback", "deutsch-jozsa-fixed",
             "bernstein-vazirani-fixed", "bloch-plus-direction", "entangle-bell-pair", "superdense-encode-10", "teleport-ry-fixed", "grover-find-01",
             "optimize-redundant"],
        )  # fmt: skip
        self.assertEqual(len(CHALLENGES), 19)

    def test_the_challenge_register_size_matches_what_the_lab_circuits_use_where_the_brief_says_they_agree(self) -> None:
        self.assertEqual(CHALLENGE_BY_ID["qpe-estimate-t"].constraints.num_qubits, get_lesson(QPE).linked_circuit.num_qubits)
        self.assertEqual(CHALLENGE_BY_ID["qec-correct-flip-q1"].constraints.num_qubits, get_lesson(QEC).linked_circuit.num_qubits)
        self.assertEqual(CHALLENGE_BY_ID["qft-2qubit"].constraints.num_qubits, 2)  # one size down from the lesson's three-qubit lab, as its goal says

    def test_the_qpe_lab_and_challenge_share_the_inverse_qft_and_differ_only_in_the_unitary(self) -> None:
        lab = [(o.gate.value, o.controls, o.targets, o.params) for o in get_lesson(QPE).linked_circuit.ops]
        ref = [(o.gate.value, o.controls, o.targets, o.params) for o in CHALLENGE_BY_ID["qpe-estimate-t"].reference_solution.ops]
        self.assertEqual(lab[:4], ref[:4])  # the same preparation
        self.assertEqual(lab[-10:], ref[-10:])  # the same inverse QFT and measurements
        self.assertNotEqual(lab[4:6], ref[4:7])  # S then T: the controlled powers differ

    def test_the_qec_lab_starts_with_the_challenge_reference_solution(self) -> None:
        lab = [(o.gate.value, o.controls, o.targets, o.params) for o in get_lesson(QEC).linked_circuit.ops]
        ref = [(o.gate.value, o.controls, o.targets, o.params) for o in CHALLENGE_BY_ID["qec-correct-flip-q1"].reference_solution.ops]
        self.assertEqual(lab[: len(ref)], ref)

    def test_the_qft_lab_ladder_is_the_challenges_reference_one_size_up(self) -> None:
        ref = CHALLENGE_BY_ID["qft-2qubit"].reference_solution.ops
        self.assertEqual([o.gate.value for o in ref], ["h", "cp", "h", "swap"])
        lab = [o.gate.value for o in get_lesson(QFT).linked_circuit.ops]
        self.assertEqual(lab[1:8], ["h", "cp", "cp", "h", "cp", "h", "swap"])

    def test_the_content_validator_passes_with_the_new_content(self) -> None:
        aer = AerAdapter()
        try:
            aer.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(str(exc))
        report = validate_content()
        self.assertTrue(report.ok, "\n" + str(report))
        self.assertEqual(report.checked["lessons"], 18)
        self.assertEqual(report.checked["challenges"], 19)
        self.assertEqual(report.checked["concept_checks"], 36)
        self.assertEqual(report.checked["circuits_executed"], 18)

    def test_the_original_thirteen_lessons_are_unchanged(self) -> None:
        self.assertEqual([len(lesson.sections) for lesson in LESSONS[:13]], [9] * 7 + [10] * 6)
        for lesson in LESSONS[:13]:
            self.assertIsNone(lesson.no_challenge_reason, lesson.id)
            self.assertNotIn(QFT, lesson.prerequisite_lesson_ids)


if __name__ == "__main__":
    unittest.main()
