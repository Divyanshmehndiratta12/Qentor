"""Quality and trust tests for the three advanced lessons
(``qentor.lessons.content_advanced``): Phase Kickback, Deutsch–Jozsa and
Bernstein–Vazirani.

Four groups:

1. Structure and concept-check integrity (the same standard as the foundation
   lessons, ``test_lesson_content.py``).
2. Prose trust: no decimal or percentage, no claimed outcome, one fixed example
   stated as one, and the bit-order caveats the circuits need.
3. The physics the lessons state, checked on the REAL Aer backend: each linked
   circuit, the variants the lessons ask the learner to build, and every concept
   check's answer key (a wrong key fails a test). Test-only; nothing here ships as
   a result.
4. The tutor on every section of the three lessons: explain / simpler / hint work,
   answers stay compact, no quiz answer or rationale leaks, hi/kn keep their
   wrapper, and no tutor source file contains lesson prose.
"""

from __future__ import annotations

import re
import unittest

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.trace import trace_circuit
from qentor.lessons import LESSONS, ConceptCheckSection, ExplanationSection, InteractiveLabSection, ReflectionSection, get_lesson
from qentor.tutor import answer_lesson_aware_question, resolve_lesson_context
from tests.test_tutor_lesson import DECIMAL, EXPLAIN, HI_EXPLAIN, HINT, KN_EXPLAIN, SIMPLER, ask

ADVANCED_IDS = ["phase-kickback", "deutsch-jozsa", "bernstein-vazirani"]
ADVANCED = [get_lesson(lesson_id) for lesson_id in ADVANCED_IDS]

DECIMAL_OR_PERCENT = re.compile(r"\d+\.\d+|\d+\s?%")
EXPECTED_SHAPE = {
    "phase-kickback": ["explanation"] * 4 + ["concept_check", "interactive_lab", "concept_check"] + ["explanation"] * 2 + ["reflection"],
    "deutsch-jozsa": ["explanation"] * 4 + ["concept_check", "interactive_lab", "concept_check"] + ["explanation"] * 2 + ["reflection"],
    "bernstein-vazirani": ["explanation"] * 5 + ["concept_check", "interactive_lab", "concept_check", "explanation", "reflection"],
}
# The correct option of each concept check, by (lesson, section) — pinned so a
# reordering is a deliberate act; the physics tests below check each one is TRUE.
ANSWER_KEYS = {
    ("phase-kickback", "s5"): "c",
    ("phase-kickback", "s7"): "b",
    ("deutsch-jozsa", "s5"): "a",
    ("deutsch-jozsa", "s7"): "d",
    ("bernstein-vazirani", "s6"): "b",
    ("bernstein-vazirani", "s8"): "c",
}
# ... and what each correct option SAYS, pinned for the same reason: the physics tests
# below verify these very statements against Aer, so a reworded or swapped answer must
# be a deliberate, re-verified change.
ANSWER_TEXT = {
    ("phase-kickback", "s5"): "the sign of the control's |1⟩ part has flipped",
    ("phase-kickback", "s7"): "|1⟩ is an equal mix of two X eigenstates",
    ("deutsch-jozsa", "s5"): "the oracle's flip turns into a sign on the input qubits",
    ("deutsch-jozsa", "s7"): "constant, but the run cannot say which constant value",
    ("bernstein-vazirani", "s6"): "q0 reads 1 and q1 reads 0",
    ("bernstein-vazirani", "s8"): "Both input qubits read 1",
}


def _checks(lesson):
    return [s for s in lesson.sections if isinstance(s, ConceptCheckSection) and s.question is not None]


def _all_checks():
    return [(lesson, s) for lesson in ADVANCED for s in _checks(lesson)]


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


# --------------------------------------------------------------------------- #
# 1. Structure                                                                #
# --------------------------------------------------------------------------- #


class TestAdvancedLessonStructure(unittest.TestCase):
    def test_they_are_lessons_eight_to_ten_with_unchanged_ids_and_prerequisites(self) -> None:
        self.assertEqual([lesson.id for lesson in LESSONS][7:10], ADVANCED_IDS)  # batch 1 follows them (test_batch1_lessons.py)
        self.assertEqual(len(LESSONS), 19)  # lessons 17, 18 and 19 follow (test_variational_lesson.py, test_shor_lesson.py, test_noise_lesson.py)
        self.assertEqual(
            {lesson.id: lesson.prerequisite_lesson_ids for lesson in ADVANCED},
            {
                "phase-kickback": ["bell-state", "phase"],
                "deutsch-jozsa": ["phase-kickback"],
                "bernstein-vazirani": ["deutsch-jozsa"],
            },
        )
        for lesson in ADVANCED:
            self.assertEqual(lesson.difficulty, "advanced", lesson.id)

    def test_the_linked_circuits_are_the_fixed_examples(self) -> None:
        def ops(lesson_id):
            return [(o.gate.value, list(o.controls), list(o.targets), list(o.clbits)) for o in get_lesson(lesson_id).linked_circuit.ops]

        self.assertEqual(
            ops("phase-kickback"),
            [("h", [], [0], []), ("x", [], [1], []), ("h", [], [1], []), ("cx", [0], [1], []), ("h", [], [0], [])],
        )
        self.assertEqual(
            ops("deutsch-jozsa"),
            [("x", [], [1], []), ("h", [], [0], []), ("h", [], [1], []), ("cx", [0], [1], []), ("h", [], [0], []), ("measure", [], [0], [0])],
        )
        self.assertEqual(
            ops("bernstein-vazirani"),
            [
                ("x", [], [2], []), ("h", [], [0], []), ("h", [], [1], []), ("h", [], [2], []),
                ("cx", [0], [2], []), ("h", [], [0], []), ("h", [], [1], []),
                ("measure", [], [0], [0]), ("measure", [], [1], [1]),
            ],
        )  # fmt: skip
        self.assertEqual(
            [(get_lesson(i).linked_circuit.num_qubits, get_lesson(i).linked_circuit.num_clbits) for i in ADVANCED_IDS],
            [(2, 0), (2, 1), (3, 2)],
        )

    def test_every_lesson_has_the_agreed_section_shape_and_ids(self) -> None:
        for lesson in ADVANCED:
            self.assertEqual([s.type for s in lesson.sections], EXPECTED_SHAPE[lesson.id], lesson.id)
            self.assertEqual([s.id for s in lesson.sections], [f"s{i}" for i in range(1, 11)], lesson.id)

    def test_the_required_topics_are_covered_by_section_type(self) -> None:
        for lesson in ADVANCED:
            kinds = [s.type for s in lesson.sections]
            self.assertTrue(4 <= kinds.count("explanation") <= 7, lesson.id)
            self.assertEqual(kinds.count("concept_check"), 2, lesson.id)
            self.assertEqual(kinds.count("interactive_lab"), 1, lesson.id)
            self.assertEqual(kinds.count("reflection"), 1, lesson.id)
            self.assertEqual(lesson.sections[-1].type, "reflection", lesson.id)

    def test_each_lesson_covers_its_own_named_topics(self) -> None:
        titles = {lesson.id: " | ".join(s.title.lower() for s in lesson.sections) for lesson in ADVANCED}
        text = {lesson.id: " ".join(_all_text(lesson)).lower() for lesson in ADVANCED}
        # Phase Kickback: eigenstate intuition, target preparation, CX, phase on the control, oracle link
        for needle in ("eigenstate", "preparing the target", "cx", "control", "oracle"):
            self.assertIn(needle, titles["phase-kickback"] + " " + text["phase-kickback"], needle)
        # Deutsch–Jozsa: promise, ancilla prep, oracle, interference, measurement reading, limitations
        for needle in ("constant or balanced", "ancilla", "oracle", "interference", "measurement", "does not show"):
            self.assertIn(needle, titles["deutsch-jozsa"], needle)
        # Bernstein–Vazirani: hidden bitstring, oracle encoding, kickback, one query, fixed example
        for needle in ("hidden bit string", "gates", "kickback", "one fixed example", "one query"):
            self.assertIn(needle, titles["bernstein-vazirani"], needle)

    def test_explanations_are_short_paragraphs_not_walls_of_text(self) -> None:
        for lesson in ADVANCED:
            for s in lesson.sections:
                if isinstance(s, ExplanationSection):
                    self.assertTrue(120 <= len(s.body) <= 680, f"{lesson.id}/{s.id}: {len(s.body)} chars")
                    self.assertNotIn("\n", s.body, f"{lesson.id}/{s.id}")

    def test_metadata_is_present_and_sensible(self) -> None:
        for lesson in ADVANCED:
            self.assertTrue(3 <= len(lesson.learning_objectives) <= 5, lesson.id)
            self.assertTrue(10 <= lesson.estimated_minutes <= 25, lesson.id)
            for text in [lesson.title, lesson.short_description, *lesson.learning_objectives]:
                self.assertTrue(text.strip(), lesson.id)
            for s in lesson.sections:
                self.assertTrue(s.title.strip(), f"{lesson.id}/{s.id}")

    def test_the_lab_points_at_the_backend_execute_capability_and_quotes_no_outcome(self) -> None:
        for lesson in ADVANCED:
            (lab,) = [s for s in lesson.sections if isinstance(s, InteractiveLabSection)]
            self.assertEqual(lab.capability, "execute", lesson.id)
            self.assertIn("backend", lab.instructions.lower(), lesson.id)
            self.assertFalse(DECIMAL_OR_PERCENT.search(lab.instructions), lesson.id)

    def test_the_lessons_are_served_through_the_api_unchanged(self) -> None:
        from qentor.api import app as app_module

        from qentor.lessons import public_lesson

        served = {lesson.id: lesson for lesson in app_module.list_lessons().lessons}
        for lesson in ADVANCED:
            self.assertEqual([s.model_dump() for s in served[lesson.id].sections], [s.model_dump() for s in public_lesson(lesson).sections])
            for shown, authored in zip(served[lesson.id].sections, lesson.sections):
                self.assertEqual((shown.id, shown.type), (authored.id, authored.type))
                if authored.type != "concept_check":  # a concept check is served without its key and explanation
                    self.assertEqual(shown.model_dump(), authored.model_dump())
            self.assertEqual(served[lesson.id].linked_circuit, lesson.linked_circuit)


class TestAdvancedConceptChecks(unittest.TestCase):
    def test_two_real_checks_per_lesson_at_the_pinned_sections(self) -> None:
        self.assertEqual(len(_all_checks()), 6)
        self.assertEqual({(lesson.id, s.id) for lesson, s in _all_checks()}, set(ANSWER_KEYS))

    def test_every_check_validates_and_has_exactly_one_correct_option(self) -> None:
        for lesson, s in _all_checks():
            ConceptCheckSection.model_validate(s.model_dump())
            ids = [o.id for o in s.options]
            self.assertEqual(sorted(ids), ["a", "b", "c", "d"], f"{lesson.id}/{s.id}")
            self.assertEqual(ids.count(s.correct_option_id), 1, f"{lesson.id}/{s.id}")
            self.assertEqual(s.correct_option_id, ANSWER_KEYS[(lesson.id, s.id)])
            correct = next(o.text for o in s.options if o.id == s.correct_option_id)
            self.assertIn(ANSWER_TEXT[(lesson.id, s.id)], correct, f"{lesson.id}/{s.id}")

    def test_no_empty_or_duplicate_option_text_and_no_filler(self) -> None:
        for lesson, s in _all_checks():
            texts = [o.text.strip() for o in s.options]
            self.assertTrue(all(len(t) >= 8 for t in texts), f"{lesson.id}/{s.id}")
            self.assertEqual(len({t.lower() for t in texts}), 4, f"{lesson.id}/{s.id}")
            for t in texts:
                self.assertFalse(re.fullmatch(r"(none|all) of the above|n/a|\.\.\.", t.lower()), f"{lesson.id}/{s.id}")

    def test_the_question_does_not_give_the_answer_away(self) -> None:
        for lesson, s in _all_checks():
            correct = next(o.text for o in s.options if o.id == s.correct_option_id)
            self.assertNotIn(correct.lower(), s.question.lower(), f"{lesson.id}/{s.id}")
            self.assertNotIn(correct.lower(), s.prompt.lower(), f"{lesson.id}/{s.id}")
            for tell in ("correct answer", "the answer is", "right answer", "correct_option"):
                self.assertNotIn(tell, (s.question + " " + s.prompt).lower(), f"{lesson.id}/{s.id}")
            self.assertTrue(s.question.strip().endswith("?"), f"{lesson.id}/{s.id}")

    def test_the_explanation_teaches_why(self) -> None:
        for lesson, s in _all_checks():
            self.assertGreaterEqual(len(s.explanation), 160, f"{lesson.id}/{s.id}")
            self.assertGreaterEqual(s.explanation.count("."), 2, f"{lesson.id}/{s.id}")
            # it does not merely restate the correct option
            correct = next(o.text for o in s.options if o.id == s.correct_option_id)
            self.assertNotEqual(s.explanation.strip().lower(), correct.strip().lower())

    def test_the_answer_is_not_always_in_the_same_place_or_always_the_longest(self) -> None:
        keys = [s.correct_option_id for _, s in _all_checks()]
        self.assertGreaterEqual(len(set(keys)), 4, keys)
        longest = sum(
            1
            for _, s in _all_checks()
            if len(next(o.text for o in s.options if o.id == s.correct_option_id)) == max(len(o.text) for o in s.options)
        )
        self.assertLessEqual(longest, 3, "the correct option is the longest too often — a tell-tale")

    def test_each_check_carries_its_lessons_concept(self) -> None:
        for lesson, s in _all_checks():
            self.assertEqual(s.concept, lesson.concept, f"{lesson.id}/{s.id}")

    def test_the_two_checks_of_a_lesson_test_different_things(self) -> None:
        for lesson in ADVANCED:
            first, second = _checks(lesson)
            self.assertNotEqual(first.question, second.question)
            self.assertFalse(set(o.text for o in first.options) & set(o.text for o in second.options), lesson.id)


# --------------------------------------------------------------------------- #
# 2. Prose trust                                                              #
# --------------------------------------------------------------------------- #


class TestAdvancedProseNeverLooksLikeAResult(unittest.TestCase):
    def test_no_lesson_text_contains_a_decimal_or_a_percentage(self) -> None:
        for lesson in ADVANCED:
            for text in _all_text(lesson):
                self.assertFalse(DECIMAL_OR_PERCENT.search(text), f"{lesson.id}: {text[:80]!r}")

    def test_no_lesson_text_claims_a_run_produced_a_particular_outcome(self) -> None:
        pattern = re.compile(r"(the backend (returned|reported|measured)|you (got|measured|saw) (a |an )?\d|our run|in our experiment)", re.I)
        for lesson in ADVANCED:
            for text in _all_text(lesson):
                self.assertIsNone(pattern.search(text), f"{lesson.id}: {text[:80]!r}")

    def test_worked_examples_are_labelled_as_textbook_algebra(self) -> None:
        for lesson_id, section_id in [("phase-kickback", "s3"), ("deutsch-jozsa", "s4"), ("bernstein-vazirani", "s5")]:
            self.assertIn("textbook", _section(lesson_id, section_id).body.lower(), f"{lesson_id}/{section_id}")

    def test_dj_and_bv_are_explicit_that_they_are_one_fixed_example(self) -> None:
        self.assertIn("ONE fixed example", _section("deutsch-jozsa", "s3").body)
        self.assertIn("does not generate oracles", _section("deutsch-jozsa", "s3").body)
        self.assertIn("ONE fixed example", _section("bernstein-vazirani", "s4").body)
        self.assertIn("not an oracle generator", _section("bernstein-vazirani", "s4").body)
        for lesson_id in ("deutsch-jozsa", "bernstein-vazirani"):
            self.assertIn("one example oracle", get_lesson(lesson_id).short_description)

    def test_the_phase_kickback_lesson_describes_the_clean_lab_circuit_and_a_contrast_case_to_build(self) -> None:
        body = _section("phase-kickback", "s4").body
        self.assertIn("X then H on q1", body)
        self.assertIn("clean kickback", body)
        self.assertIn("contrast case", body)
        self.assertIn("delete the H on q1", body)
        self.assertIn("not an eigenstate", body)
        lab = _section("phase-kickback", "s6").instructions
        self.assertIn("X then H on q1", lab)
        self.assertIn("delete the H on q1", lab)
        # the old wording that called the lab circuit the contrast case is gone
        text = " ".join(_all_text(get_lesson("phase-kickback")))
        self.assertNotIn("It has no H on q1", text)
        self.assertNotIn("Run the contrast case, then the clean one", text)
        self.assertNotIn("In the lab circuit the target q1 is prepared in |1⟩", text)

    def test_bv_states_the_bit_order_and_which_way_the_secret_reads(self) -> None:
        body = _section("bernstein-vazirani", "s4").body
        self.assertIn("highest-numbered qubit on the left", body)
        self.assertIn("a 1 on q0 and a 0 on q1", body)
        self.assertIn("01", body)
        # the old, ambiguous "secret string 10" wording is gone
        self.assertNotIn("secret string 10", " ".join(_all_text(get_lesson("bernstein-vazirani"))))

    def test_kets_are_single_qubit_or_named_so_no_two_qubit_ket_needs_a_bit_order(self) -> None:
        # A multi-qubit ket like |01⟩ or |10⟩ would need Qentor's order stated beside it.
        for lesson in ADVANCED:
            for text in _all_text(lesson):
                self.assertIsNone(re.search(r"\|[01]{2,}⟩", text), f"{lesson.id}: {text[:80]!r}")

    def test_the_lessons_never_present_the_deck_illustrative_numbers(self) -> None:
        for lesson in ADVANCED:
            joined = " ".join(_all_text(lesson))
            for forbidden in ("71 of 72", "71/72"):
                self.assertNotIn(forbidden, joined)


# --------------------------------------------------------------------------- #
# 3. The physics the lessons state, on the real backend                       #
# --------------------------------------------------------------------------- #


def _g(gate, target, controls=(), clbits=()):
    return GateOp(gate=gate, targets=[target], controls=list(controls), clbits=list(clbits))


class _Backend(unittest.TestCase):
    def setUp(self) -> None:
        self.aer = AerAdapter()
        try:
            self.aer.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        except Exception:
            pass

    def sv(self, circuit: Circuit) -> list[complex]:
        return [complex(re_, im) for re_, im in self.aer.run(circuit, "statevector").to_payload()["statevector"]]

    def final_traced_state(self, circuit: Circuit) -> list[complex]:
        """The last traced state (before any terminal measurement)."""
        trace = trace_circuit(circuit, self.aer, mode="statevector", max_qubits=4, max_operations=16)
        return [complex(re_, im) for re_, im in trace.steps[-1].statevector]

    def shots(self, circuit: Circuit) -> dict[str, float]:
        return self.aer.run(circuit, "shots", 2000).to_payload()["probabilities"]

    @staticmethod
    def circuit(n, c, *ops) -> Circuit:
        return Circuit(num_qubits=n, num_clbits=c, ops=list(ops))

    def assertStatesEqualUpToPhase(self, a, b, msg=None) -> None:
        overlap = sum(x.conjugate() * y for x, y in zip(a, b))
        self.assertAlmostEqual(abs(overlap), 1.0, places=9, msg=msg)

    def assertRegisterProduct(self, state, n, msg=None) -> None:
        """Every qubit has a state of its own (no entanglement anywhere)."""
        for qubit in range(n):
            self.assertAlmostEqual(_purity(state, n, qubit), 1.0, places=9, msg=f"{msg} qubit {qubit}")


def _reduced(state, n, qubit):
    """Reduced 2x2 density matrix of ``qubit`` (little-endian basis index)."""
    rho = [[0j, 0j], [0j, 0j]]
    for i, amp_i in enumerate(state):
        for j, amp_j in enumerate(state):
            if all(((i >> q) & 1) == ((j >> q) & 1) for q in range(n) if q != qubit):
                rho[(i >> qubit) & 1][(j >> qubit) & 1] += amp_i * amp_j.conjugate()
    return rho


def _purity(state, n, qubit) -> float:
    rho = _reduced(state, n, qubit)
    return sum((rho[i][j] * rho[j][i]).real for i in range(2) for j in range(2))


def _qubit_value_support(state, qubit, tol=1e-9):
    """The set of values qubit takes over basis states with non-zero amplitude."""
    return {(i >> qubit) & 1 for i, amp in enumerate(state) if abs(amp) > tol}


class TestPhaseKickbackPhysics(_Backend):
    def test_the_eigenstate_facts_in_s1_and_s2(self) -> None:
        plus = self.sv(self.circuit(1, 0, _g("h", 0)))  # |+>
        self.assertStatesEqualUpToPhase(self.sv(self.circuit(1, 0, _g("h", 0), _g("x", 0))), plus)
        # ... and X leaves it exactly alone (no phase at all)
        for a, b in zip(self.sv(self.circuit(1, 0, _g("h", 0), _g("x", 0))), plus):
            self.assertAlmostEqual(abs(a - b), 0.0, places=9)
        # |-> = X then H, and X sends it to -|->: same state, opposite sign
        minus = self.sv(self.circuit(1, 0, _g("x", 0), _g("h", 0)))
        flipped = self.sv(self.circuit(1, 0, _g("x", 0), _g("h", 0), _g("x", 0)))
        for a, b in zip(flipped, minus):
            self.assertAlmostEqual(abs(a + b), 0.0, places=9)
        # |1> is not an X eigenstate: X turns it into |0>, a different state
        one_state = self.sv(self.circuit(1, 0, _g("x", 0)))
        zero_state = self.sv(self.circuit(1, 0, _g("x", 0), _g("x", 0)))
        self.assertAlmostEqual(abs(sum(a.conjugate() * b for a, b in zip(one_state, zero_state))), 0.0, places=9)

    def test_s3_cx_on_plus_and_minus_leaves_the_target_and_puts_the_sign_on_the_control(self) -> None:
        # control q0 in |+>, target q1 in |->; after the CX: |-> on q0 and |-> on q1
        state = self.sv(self.circuit(2, 0, _g("h", 0), _g("x", 1), _g("h", 1), _g("cx", 1, [0])))
        expected = self.sv(self.circuit(2, 0, _g("x", 0), _g("h", 0), _g("x", 1), _g("h", 1)))  # |-> |->
        self.assertStatesEqualUpToPhase(state, expected)
        self.assertRegisterProduct(state, 2, "eigenstate target: nothing is entangled")

    def test_answer_key_s5_c_is_true_and_the_distractors_are_false(self) -> None:
        state = self.sv(self.circuit(2, 0, _g("h", 0), _g("x", 1), _g("h", 1), _g("cx", 1, [0])))
        minus_minus = self.sv(self.circuit(2, 0, _g("x", 0), _g("h", 0), _g("x", 1), _g("h", 1)))
        plus_minus = self.sv(self.circuit(2, 0, _g("h", 0), _g("x", 1), _g("h", 1)))  # control |+>, target |->
        # c (correct): target still |->, control now |-> (its |1> part gained a sign)
        self.assertStatesEqualUpToPhase(state, minus_minus)
        self.assertLess(abs(sum(a.conjugate() * b for a, b in zip(state, plus_minus))), 1e-9, "the control's state did change")
        # a: target flipped to |+> — false, the target is not in |+>
        target_plus = self.sv(self.circuit(2, 0, _g("h", 0), _g("h", 1)))
        self.assertLess(abs(sum(a.conjugate() * b for a, b in zip(state, target_plus))), 1e-9)
        # b: entangled — false
        self.assertAlmostEqual(_purity(state, 2, 0), 1.0, places=9)
        # d: control flipped to |1> — false, it is |->, which measures 0 or 1 equally (support on both)
        self.assertEqual(_qubit_value_support(state, 0), {0, 1})

    def contrast(self) -> Circuit:
        """The lab circuit with the H on q1 deleted, as the lesson tells the learner to build."""
        lab = get_lesson("phase-kickback").linked_circuit
        ops = [o for o in lab.ops if not (o.gate.value == "h" and o.targets == [1])]
        self.assertEqual(len(ops), len(lab.ops) - 1)
        return lab.model_copy(update={"ops": ops})

    def test_the_lab_circuit_is_a_clean_kickback_q0_ends_definitely_in_1_and_nothing_is_entangled(self) -> None:
        lab = get_lesson("phase-kickback").linked_circuit
        state = self.sv(lab)
        self.assertEqual(_qubit_value_support(state, 0), {1})  # "non-zero only where q0 is 1"
        self.assertEqual(_qubit_value_support(state, 1), {0, 1})  # the target is still |->
        self.assertRegisterProduct(state, 2, "clean kickback")
        expected = self.sv(self.circuit(2, 0, _g("x", 0), _g("x", 1), _g("h", 1)))  # q0 |1>, q1 |->
        self.assertStatesEqualUpToPhase(state, expected)
        measured = self.circuit(2, 1, *lab.ops, _g("measure", 0, clbits=[0]))
        self.assertEqual(self.shots(measured), {"1": 1.0})

    def test_the_lab_circuit_prepares_the_target_in_minus_which_is_an_x_eigenstate(self) -> None:
        lab = get_lesson("phase-kickback").linked_circuit
        after_prep = self.final_traced_state(self.circuit(2, 0, *[o for o in lab.ops if 1 in o.targets and not o.controls]))
        minus = self.sv(self.circuit(2, 0, _g("x", 1), _g("h", 1)))
        self.assertStatesEqualUpToPhase(after_prep, minus)
        # ... and X leaves it unchanged apart from a sign
        after_x = self.sv(self.circuit(2, 0, _g("x", 1), _g("h", 1), _g("x", 1)))
        self.assertStatesEqualUpToPhase(after_x, minus)

    def test_the_contrast_case_the_lesson_asks_for_leaves_q0_undefinite_and_entangled(self) -> None:
        state = self.sv(self.contrast())
        self.assertEqual(_qubit_value_support(state, 0), {0, 1})  # "amplitudes for both values of q0"
        self.assertLess(_purity(state, 2, 0), 0.99)  # entangled: q0 has no state of its own
        # the target is |1> right after the X, which is not |->
        after_x = self.final_traced_state(self.circuit(2, 0, _g("x", 1)))
        self.assertEqual(_qubit_value_support(after_x, 1), {1})

    def test_answer_key_s7_b_the_target_1_is_an_equal_mix_of_the_x_eigenstates_and_that_entangles(self) -> None:
        # |1> = (|+> - |->)/sqrt(2): equal-size components
        one = self.sv(self.circuit(1, 0, _g("x", 0)))
        plus = self.sv(self.circuit(1, 0, _g("h", 0)))
        minus = self.sv(self.circuit(1, 0, _g("x", 0), _g("h", 0)))
        c_plus = sum(p.conjugate() * o for p, o in zip(plus, one))
        c_minus = sum(m.conjugate() * o for m, o in zip(minus, one))
        self.assertAlmostEqual(abs(c_plus), abs(c_minus), places=9)
        self.assertAlmostEqual(abs(c_plus) ** 2 + abs(c_minus) ** 2, 1.0, places=9)
        # ... and the result is entangled with q0 sharing no definite state
        state = self.sv(self.contrast())
        self.assertAlmostEqual(_purity(state, 2, 0), 0.5, places=9)
        # a: CX does act on a target in |1> (it flips it when the control is 1)
        cx_on_one = self.sv(self.circuit(2, 0, _g("x", 0), _g("x", 1), _g("cx", 1, [0])))
        self.assertEqual(_qubit_value_support(cx_on_one, 1), {0})
        # c: the X on q1 does not touch q0
        self.assertEqual(_qubit_value_support(self.sv(self.circuit(2, 0, _g("x", 1))), 0), {0})

    def test_s8_a_final_h_turns_the_sign_into_a_bit_and_without_it_the_bit_is_random(self) -> None:
        no_h = self.circuit(2, 1, _g("x", 1), _g("h", 1), _g("h", 0), _g("cx", 1, [0]), _g("measure", 0, clbits=[0]))
        self.assertEqual(set(self.shots(no_h)), {"0", "1"})

    def test_the_reflection_a_target_in_plus_leaves_the_control_alone(self) -> None:
        plus_target = self.circuit(2, 1, _g("h", 1), _g("h", 0), _g("cx", 1, [0]), _g("h", 0), _g("measure", 0, clbits=[0]))
        self.assertEqual(set(self.shots(plus_target)), {"0"})


class TestDeutschJozsaPhysics(_Backend):
    def dj(self, *oracle_ops, measure=True) -> Circuit:
        ops = [_g("x", 1), _g("h", 0), _g("h", 1), *oracle_ops, _g("h", 0)]
        if measure:
            ops.append(_g("measure", 0, clbits=[0]))
        return self.circuit(2, 1 if measure else 0, *ops)

    def test_the_lab_circuit_is_the_one_the_lesson_describes_and_reads_balanced(self) -> None:
        self.assertEqual(get_lesson("deutsch-jozsa").linked_circuit.ops, self.dj(_g("cx", 1, [0])).ops)
        self.assertEqual(set(self.shots(get_lesson("deutsch-jozsa").linked_circuit)), {"1"})

    def test_s4_the_oracle_writes_the_sign_on_the_input_and_leaves_the_ancilla_alone(self) -> None:
        after_oracle = self.final_traced_state(self.circuit(2, 0, _g("x", 1), _g("h", 0), _g("h", 1), _g("cx", 1, [0])))
        minus_minus = self.sv(self.circuit(2, 0, _g("x", 0), _g("h", 0), _g("x", 1), _g("h", 1)))
        self.assertStatesEqualUpToPhase(after_oracle, minus_minus)  # input became |->, ancilla still |->
        self.assertRegisterProduct(after_oracle, 2, "dj after oracle")

    def test_s4_a_constant_oracle_leaves_the_input_in_plus_and_ends_at_0(self) -> None:
        for name, oracle in (("f=0", []), ("f=1", [_g("x", 1)])):
            with self.subTest(oracle=name):
                after_oracle = self.final_traced_state(self.circuit(2, 0, _g("x", 1), _g("h", 0), _g("h", 1), *oracle))
                plus_minus_input = self.sv(self.circuit(2, 0, _g("h", 0), _g("x", 1), _g("h", 1)))
                self.assertStatesEqualUpToPhase(after_oracle, plus_minus_input)
                self.assertEqual(set(self.shots(self.dj(*oracle))), {"0"})

    def test_answer_key_s5_a_is_true_the_target_is_unchanged_and_carries_no_answer(self) -> None:
        state = self.final_traced_state(self.circuit(2, 0, _g("x", 1), _g("h", 0), _g("h", 1), _g("cx", 1, [0])))
        # b false: the target does not hold f(x) - it is |-> whatever f is (equal support on both values)
        self.assertEqual(_qubit_value_support(state, 1), {0, 1})
        self.assertAlmostEqual(_purity(state, 2, 1), 1.0, places=9)
        # c false: the input qubits are not entangled with each other (here: with the ancilla either)
        self.assertRegisterProduct(state, 2, "dj")
        # d false: a CX is fine on a target that is not in |->
        self.assertEqual(_qubit_value_support(self.sv(self.circuit(2, 0, _g("x", 0), _g("cx", 1, [0]))), 1), {1})

    def test_answer_key_s7_d_constant_f0_and_f1_give_the_same_reading(self) -> None:
        readings = {name: self.shots(self.dj(*oracle)) for name, oracle in (("f=0", []), ("f=1", [_g("x", 1)]))}
        self.assertEqual({k: set(v) for k, v in readings.items()}, {"f=0": {"0"}, "f=1": {"0"}})  # d: cannot say which
        # the two final states differ by a global sign only
        zero = self.final_traced_state(self.dj(measure=False))
        one = self.final_traced_state(self.dj(_g("x", 1), measure=False))
        self.assertStatesEqualUpToPhase(zero, one)
        # a false / b false: an all-zero reading is not what a balanced oracle gives
        self.assertNotIn("0", self.shots(self.dj(_g("cx", 1, [0]))))

    def test_removing_the_cx_changes_the_result_for_q0_as_the_lab_says(self) -> None:
        self.assertEqual(set(self.shots(self.dj(_g("cx", 1, [0])))), {"1"})
        self.assertEqual(set(self.shots(self.dj())), {"0"})

    def test_a_promise_keeping_run_gives_the_same_verdict_every_time(self) -> None:
        self.assertEqual(self.shots(self.dj(_g("cx", 1, [0]))), {"1": 1.0})
        self.assertEqual(self.shots(self.dj()), {"0": 1.0})


class TestBernsteinVaziraniPhysics(_Backend):
    def bv(self, *cx_controls: int, measure=True) -> Circuit:
        ops = [_g("x", 2), _g("h", 0), _g("h", 1), _g("h", 2), *[_g("cx", 2, [c]) for c in cx_controls], _g("h", 0), _g("h", 1)]
        if measure:
            ops += [_g("measure", 0, clbits=[0]), _g("measure", 1, clbits=[1])]
        return self.circuit(3, 2 if measure else 0, *ops)

    def test_the_lab_circuit_is_the_one_the_lesson_describes(self) -> None:
        self.assertEqual(get_lesson("bernstein-vazirani").linked_circuit.ops, self.bv(0).ops)

    def test_the_fixed_example_reads_1_on_q0_and_0_on_q1_which_qentor_prints_as_01(self) -> None:
        readout = self.shots(get_lesson("bernstein-vazirani").linked_circuit)
        self.assertEqual(readout, {"01": 1.0})  # q[1] q[0]: q1's bit on the left, q0's on the right
        # by qubit, as the lab and answer key say: c0 is q0
        state = self.final_traced_state(get_lesson("bernstein-vazirani").linked_circuit)
        self.assertEqual(_qubit_value_support(state, 0), {1})
        self.assertEqual(_qubit_value_support(state, 1), {0})

    def test_s5_after_the_oracle_q0_is_minus_and_q1_is_plus_and_the_second_h_layer_makes_bits(self) -> None:
        after_oracle = self.final_traced_state(
            self.circuit(3, 0, _g("x", 2), _g("h", 0), _g("h", 1), _g("h", 2), _g("cx", 2, [0]))
        )
        expected = self.sv(self.circuit(3, 0, _g("x", 0), _g("h", 0), _g("h", 1), _g("x", 2), _g("h", 2)))  # q0 |->, q1 |+>, q2 |->
        self.assertStatesEqualUpToPhase(after_oracle, expected)
        self.assertRegisterProduct(after_oracle, 3, "bv after oracle")

    def test_answer_key_s6_b_is_true_and_the_other_options_are_not_what_happens(self) -> None:
        shots = self.shots(self.bv(0))
        self.assertEqual(set(shots), {"01"})  # b: q0 reads 1, q1 reads 0
        # a (q0=0,q1=1), c (both 1) and d (all four combinations) are not what a run shows
        self.assertNotIn("10", shots)
        self.assertNotIn("11", shots)
        self.assertEqual(len(shots), 1)

    def test_answer_key_s8_c_a_second_cx_makes_both_bits_read_1(self) -> None:
        shots = self.shots(self.bv(0, 1))
        self.assertEqual(shots, {"11": 1.0})  # c
        self.assertNotEqual(set(shots), set(self.shots(self.bv(0))))  # a false: the readout changed
        self.assertNotEqual(set(shots), {"10"})  # b false
        self.assertEqual(len(shots), 1)  # d false: not random

    def test_the_readout_follows_the_gate_pattern_for_every_secret_of_two_bits(self) -> None:
        # the lesson's claim: the qubit with a CX in the oracle reads 1, the others read 0
        for controls, expected in (((), "00"), ((0,), "01"), ((1,), "10"), ((0, 1), "11")):
            with self.subTest(cx_from=controls):
                self.assertEqual(self.shots(self.bv(*controls)), {expected: 1.0})

    def test_the_ancilla_is_left_in_minus_the_kick_lands_on_the_controls(self) -> None:
        state = self.final_traced_state(self.bv(0, 1, measure=False))
        self.assertAlmostEqual(_purity(state, 3, 2), 1.0, places=9)
        self.assertEqual(_qubit_value_support(state, 2), {0, 1})  # |-> has both values


# --------------------------------------------------------------------------- #
# 4. The tutor on the advanced lessons                                        #
# --------------------------------------------------------------------------- #


class TestAdvancedLessonsWithTheTutor(unittest.TestCase):
    def _ask(self, question, lesson_id, section_id, language="en"):
        ctx = resolve_lesson_context(lesson_id, section_id)
        return answer_lesson_aware_question(question, ctx, [], None, None, language)[0]

    @staticmethod
    def _teaching(lesson) -> str:
        return " ".join(s.body for s in lesson.sections if isinstance(s, ExplanationSection))

    def test_every_section_resolves_and_explain_simpler_and_hint_work_everywhere(self) -> None:
        swept = 0
        for lesson in ADVANCED:
            for section in lesson.sections:
                for question, marker in ((EXPLAIN, "About this part of the lesson:"), (SIMPLER, "In short:"), (HINT, "A hint:")):
                    answer = self._ask(question, lesson.id, section.id)
                    swept += 1
                    self.assertTrue(answer.startswith(marker), f"{lesson.id}/{section.id}/{question}: {answer[:60]}")
                    self.assertFalse(DECIMAL.search(answer), f"{lesson.id}/{section.id}/{question}")
        self.assertEqual(swept, 3 * 10 * 3)

    def test_answers_stay_compact(self) -> None:
        for lesson in ADVANCED:
            for section in lesson.sections:
                for question in (EXPLAIN, SIMPLER, HINT):
                    limit = 2200 if question == EXPLAIN else 1500
                    answer = self._ask(question, lesson.id, section.id)
                    self.assertLess(len(answer), limit, f"{lesson.id}/{section.id}/{question}: {len(answer)} chars")

    def test_the_section_local_supporting_material_is_selected_correctly(self) -> None:
        for lesson in ADVANCED:
            for index, section in enumerate(lesson.sections):
                if not isinstance(section, (ConceptCheckSection, InteractiveLabSection, ReflectionSection)):
                    continue
                ctx = resolve_lesson_context(lesson.id, section.id)
                material = [f for f in ctx.facts if f.kind == "lesson_material"]
                nearest = [s for s in lesson.sections[:index] if isinstance(s, ExplanationSection)][-2:]
                self.assertEqual(len(material), len(nearest), f"{lesson.id}/{section.id}")
                joined = " ".join(f.description for f in material)
                for explanation in nearest:
                    self.assertIn(explanation.body, joined, f"{lesson.id}/{section.id}")

    def test_a_hint_on_a_check_points_at_the_nearest_explanation_and_the_first_objective(self) -> None:
        for lesson in ADVANCED:
            for index, section in enumerate(lesson.sections):
                if not isinstance(section, ConceptCheckSection):
                    continue
                nearest = [s for s in lesson.sections[:index] if isinstance(s, ExplanationSection)][-1]
                answer = self._ask(HINT, lesson.id, section.id)
                self.assertIn(nearest.body, answer, f"{lesson.id}/{section.id}")
                self.assertIn(lesson.learning_objectives[0], answer, f"{lesson.id}/{section.id}")

    def test_no_answer_fact_or_response_leaks_a_correct_option_or_rationale(self) -> None:
        checked = 0
        for lesson in ADVANCED:
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
        for lesson in ADVANCED:
            for check in _checks(lesson):
                blob = ask(question=HINT, lesson_id=lesson.id, section_id=check.id).model_dump_json()
                self.assertNotIn(check.explanation, blob, f"{lesson.id}/{check.id}")
                self.assertNotIn("correct_option", blob)
                self.assertNotIn("correctOption", blob)
                # the option list itself never reaches the tutor
                for option in check.options:
                    if option.text not in self._teaching(lesson):
                        self.assertNotIn(option.text, blob, f"{lesson.id}/{check.id}/{option.id}")

    def test_the_endpoint_answers_carry_the_lesson_and_no_quantum_provenance(self) -> None:
        for lesson in ADVANCED:
            response = ask(question=EXPLAIN, lesson_id=lesson.id, section_id="s2")
            self.assertEqual((response.lesson_id, response.section_id), (lesson.id, "s2"))
            self.assertIsNone(response.result_id)
            self.assertIsNone(response.provenance_class)
            self.assertIsNone(response.trace_step)
            self.assertTrue(all(f.id.startswith("L") for f in response.facts))

    def test_hindi_and_kannada_wrap_english_lesson_prose_which_is_quoted_verbatim(self) -> None:
        for lesson in ADVANCED:
            first = lesson.sections[0]
            hi = self._ask(EXPLAIN, lesson.id, first.id, "hi")
            kn = self._ask(EXPLAIN, lesson.id, first.id, "kn")
            self.assertIn(HI_EXPLAIN, hi)
            self.assertIn(KN_EXPLAIN, kn)
            self.assertIn(first.body, hi, lesson.id)
            self.assertIn(first.body, kn, lesson.id)

    def test_free_text_questions_are_answered_from_the_advanced_lessons(self) -> None:
        cases = [
            ("What is an eigenstate?", "phase-kickback", "s1"),
            ("Why is the ancilla prepared in the minus state?", "deutsch-jozsa", "s2"),
            ("What is a balanced function?", "deutsch-jozsa", "s1"),
            ("How is the hidden string stored in the oracle?", "bernstein-vazirani", "s2"),
        ]
        for question, lesson_id, section_id in cases:
            with self.subTest(question=question):
                answer = self._ask(question, lesson_id, section_id)
                self.assertTrue(answer.startswith("About this part of the lesson:"), answer[:80])
                self.assertIn(_section(lesson_id, section_id).body, answer)

    def test_no_tutor_source_file_contains_any_advanced_lesson_prose(self) -> None:
        from pathlib import Path

        tutor_dir = Path(__file__).resolve().parents[1] / "qentor" / "tutor"
        source = "\n".join(p.read_text(encoding="utf-8") for p in tutor_dir.glob("*.py"))
        for lesson in ADVANCED:
            for s in lesson.sections:
                if isinstance(s, ExplanationSection):
                    for start in range(0, len(s.body) - 45, 5):
                        window = s.body[start : start + 45]
                        self.assertNotIn(window, source, f"{lesson.id}/{s.id}: {window!r}")
            for objective in lesson.learning_objectives:
                self.assertNotIn(objective[:40], source, lesson.id)
            self.assertNotIn(lesson.short_description, source, lesson.id)

    def test_a_lesson_question_never_carries_a_lab_result_or_a_trace_step(self) -> None:
        response = ask(question=HINT, lesson_id="bernstein-vazirani", section_id="s6")
        self.assertIsNone(response.trace_step)
        self.assertIsNone(response.result_id)


if __name__ == "__main__":
    unittest.main()
