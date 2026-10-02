"""Tests for the Learn engine's domain model and registry
(``qentor.lessons``): per-lesson validation (pydantic), cross-lesson
validation (``qentor.lessons.registry``), and the real content module.
"""

from __future__ import annotations

import unittest

from pydantic import ValidationError

from qentor.circuit.model import Circuit, GateOp
from qentor.lessons import LESSONS, Lesson, get_lesson
from qentor.lessons.registry import LessonRegistryError, build_registry

_SIMPLE_CIRCUIT = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])

EXPECTED_LESSON_IDS = {
    "qubits-measurement",
    "bloch-sphere",
    "superposition",
    "phase",
    "interference",
    "entanglement",
    "bell-state",
    "phase-kickback",
    "deutsch-jozsa",
    "bernstein-vazirani",
    "superdense-coding",
    "quantum-teleportation",
    "grovers-search",
    "quantum-fourier-transform",
    "quantum-phase-estimation",
    "quantum-error-correction",
    "variational-vqe",
    "shors-algorithm",
}


def _minimal_lesson(**overrides) -> Lesson:
    defaults = dict(
        id="test-lesson",
        title="Test",
        short_description="Test lesson.",
        concept="test",
        difficulty="beginner",
        estimated_minutes=5,
        learning_objectives=["Learn a thing."],
        sections=[{"type": "explanation", "id": "s1", "title": "Intro", "body": "Body text."}],
    )
    defaults.update(overrides)
    return Lesson.model_validate(defaults)


class TestRealRegistryLoadsCleanly(unittest.TestCase):
    def test_all_eighteen_planned_lessons_are_registered(self) -> None:
        self.assertEqual({lesson.id for lesson in LESSONS}, EXPECTED_LESSON_IDS)

    def test_lesson_ids_are_unique(self) -> None:
        ids = [lesson.id for lesson in LESSONS]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_prerequisite_id_resolves_to_a_real_lesson(self) -> None:
        known = {lesson.id for lesson in LESSONS}
        for lesson in LESSONS:
            for prereq in lesson.prerequisite_lesson_ids:
                self.assertIn(prereq, known, f"{lesson.id} references unknown prerequisite {prereq!r}")

    def test_get_lesson_returns_the_matching_lesson(self) -> None:
        lesson = get_lesson("bell-state")
        self.assertIsNotNone(lesson)
        assert lesson is not None  # narrow for type checkers
        self.assertEqual(lesson.title, "Bell State")

    def test_get_lesson_returns_none_for_an_unknown_id(self) -> None:
        self.assertIsNone(get_lesson("does-not-exist"))

    def test_every_interactive_lab_lesson_carries_a_linked_circuit(self) -> None:
        for lesson in LESSONS:
            has_lab = any(section.type == "interactive_lab" for section in lesson.sections)
            if has_lab:
                self.assertIsNotNone(lesson.linked_circuit, f"{lesson.id} has a lab but no linked_circuit")

    def test_exactly_the_eighteen_planned_lessons_have_a_real_concept_check_question(self) -> None:
        expected = {
            "qubits-measurement",
            "bloch-sphere",
            "superposition",
            "phase",
            "interference",
            "entanglement",
            "bell-state",
            "phase-kickback",
            "deutsch-jozsa",
            "bernstein-vazirani",
            "superdense-coding",
            "quantum-teleportation",
            "grovers-search",
            "quantum-fourier-transform",
            "quantum-phase-estimation",
            "quantum-error-correction",
            "variational-vqe",
            "shors-algorithm",
        }
        with_question = {
            lesson.id
            for lesson in LESSONS
            if any(s.type == "concept_check" and s.question is not None for s in lesson.sections)
        }
        self.assertEqual(with_question, expected)

    def test_every_real_concept_check_options_contain_the_correct_answer(self) -> None:
        for lesson in LESSONS:
            for section in lesson.sections:
                if section.type == "concept_check" and section.question is not None:
                    assert section.options is not None
                    option_ids = [o.id for o in section.options]
                    self.assertIn(section.correct_option_id, option_ids, lesson.id)
                    self.assertGreaterEqual(len(section.options), 2, lesson.id)

    def test_registry_loading_is_deterministic(self) -> None:
        first = build_registry()
        second = build_registry()
        self.assertEqual([lesson.id for lesson in first], [lesson.id for lesson in second])
        self.assertEqual(
            [lesson.model_dump(mode="json") for lesson in first],
            [lesson.model_dump(mode="json") for lesson in second],
        )


class TestCrossLessonValidation(unittest.TestCase):
    def test_duplicate_lesson_id_is_rejected(self) -> None:
        a = _minimal_lesson(id="dup")
        b = _minimal_lesson(id="dup")
        with self.assertRaises(LessonRegistryError):
            build_registry([a, b])

    def test_unknown_prerequisite_id_is_rejected(self) -> None:
        lesson = _minimal_lesson(id="only-lesson", prerequisite_lesson_ids=["ghost-lesson"])
        with self.assertRaises(LessonRegistryError):
            build_registry([lesson])

    def test_valid_prerequisite_chain_is_accepted(self) -> None:
        first = _minimal_lesson(id="first")
        second = _minimal_lesson(id="second", prerequisite_lesson_ids=["first"])
        result = build_registry([first, second])
        self.assertEqual([lesson.id for lesson in result], ["first", "second"])


class TestMalformedLessonDataIsRejected(unittest.TestCase):
    def test_missing_required_field_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            Lesson.model_validate(
                {
                    "id": "broken",
                    "short_description": "x",
                    "concept": "x",
                    "difficulty": "beginner",
                    "estimated_minutes": 5,
                    "learning_objectives": ["x"],
                    "sections": [{"type": "explanation", "id": "s1", "title": "t", "body": "b"}],
                }
            )

    def test_unknown_section_type_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(sections=[{"type": "quiz", "id": "s1", "title": "t", "prompt": "p"}])

    def test_non_positive_estimated_minutes_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(estimated_minutes=0)

    def test_empty_sections_list_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(sections=[])

    def test_empty_learning_objectives_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(learning_objectives=[])

    def test_duplicate_section_ids_within_a_lesson_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(
                sections=[
                    {"type": "explanation", "id": "s1", "title": "t", "body": "b"},
                    {"type": "reflection", "id": "s1", "title": "t2", "prompt": "p"},
                ]
            )

    def test_interactive_lab_without_a_linked_circuit_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(
                sections=[
                    {
                        "type": "interactive_lab",
                        "id": "s1",
                        "title": "Run it",
                        "instructions": "Do it.",
                        "capability": "execute",
                    }
                ]
            )

    def test_interactive_lab_with_a_linked_circuit_is_accepted(self) -> None:
        lesson = _minimal_lesson(
            sections=[
                {
                    "type": "interactive_lab",
                    "id": "s1",
                    "title": "Run it",
                    "instructions": "Do it.",
                    "capability": "execute",
                }
            ],
            linked_circuit=_SIMPLE_CIRCUIT,
        )
        self.assertEqual(lesson.linked_circuit, _SIMPLE_CIRCUIT)

    def test_invalid_capability_value_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(
                sections=[
                    {
                        "type": "interactive_lab",
                        "id": "s1",
                        "title": "Run it",
                        "instructions": "Do it.",
                        "capability": "run_arbitrary_python",
                    }
                ],
                linked_circuit=_SIMPLE_CIRCUIT,
            )

    def test_self_referential_prerequisite_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(id="self-ref", prerequisite_lesson_ids=["self-ref"])

    def test_extra_unknown_field_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _minimal_lesson(mastery_fraction=0.5)


class TestConceptCheckQuestionValidation(unittest.TestCase):
    """The optional question/options/correct_option_id/explanation/concept
    fields added for the concept-check milestone."""

    def _concept_check_lesson(self, section: dict) -> Lesson:
        return _minimal_lesson(sections=[{"type": "concept_check", "id": "s1", "title": "Check", "prompt": "p", **section}])

    def test_prompt_only_concept_check_is_still_valid(self) -> None:
        lesson = self._concept_check_lesson({})
        section = lesson.sections[0]
        assert section.type == "concept_check"
        self.assertIsNone(section.question)
        self.assertIsNone(section.options)

    def test_fully_specified_concept_check_is_valid(self) -> None:
        lesson = self._concept_check_lesson(
            {
                "question": "2+2?",
                "options": [{"id": "a", "text": "3"}, {"id": "b", "text": "4"}],
                "correct_option_id": "b",
                "explanation": "Basic arithmetic.",
                "concept": "arithmetic",
            }
        )
        section = lesson.sections[0]
        assert section.type == "concept_check"
        self.assertEqual(section.question, "2+2?")
        self.assertEqual(section.correct_option_id, "b")

    def test_question_without_options_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            self._concept_check_lesson({"question": "2+2?"})

    def test_options_without_correct_option_id_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            self._concept_check_lesson(
                {
                    "question": "2+2?",
                    "options": [{"id": "a", "text": "3"}, {"id": "b", "text": "4"}],
                    "explanation": "x",
                }
            )

    def test_correct_option_id_not_among_options_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            self._concept_check_lesson(
                {
                    "question": "2+2?",
                    "options": [{"id": "a", "text": "3"}, {"id": "b", "text": "4"}],
                    "correct_option_id": "z",
                    "explanation": "x",
                }
            )

    def test_duplicate_option_ids_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            self._concept_check_lesson(
                {
                    "question": "2+2?",
                    "options": [{"id": "a", "text": "3"}, {"id": "a", "text": "4"}],
                    "correct_option_id": "a",
                    "explanation": "x",
                }
            )

    def test_fewer_than_two_options_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            self._concept_check_lesson(
                {
                    "question": "2+2?",
                    "options": [{"id": "a", "text": "4"}],
                    "correct_option_id": "a",
                    "explanation": "x",
                }
            )


if __name__ == "__main__":
    unittest.main()
