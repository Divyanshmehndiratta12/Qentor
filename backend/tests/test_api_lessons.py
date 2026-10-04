"""Tests for GET /api/lessons.

Calls the FastAPI route function directly, same convention as every other
endpoint test in this suite (httpx/TestClient is not a project dependency).
"""

from __future__ import annotations

import unittest

from qentor.api import app as app_module
from qentor.lessons import LESSONS

# The only fields a lesson may ever surface — this is metadata/structure, and
# per CLAUDE.md/docs/PRODUCT_CONTRACT.md no learner progress or state exists
# yet. A field appearing here that isn't in this set would be an undocumented,
# untested addition to the trust boundary.
_ALLOWED_LESSON_FIELDS = {
    "id",
    "title",
    "short_description",
    "concept",
    "difficulty",
    "estimated_minutes",
    "learning_objectives",
    "sections",
    "linked_circuit",
    "prerequisite_lesson_ids",
}

_FORBIDDEN_PROGRESS_FIELDS = {
    "mastery_fraction",
    "completed",
    "progress",
    "streak",
    "score",
    "attempts",
    "last_visited_at",
}


class TestListLessonsEndpoint(unittest.TestCase):
    def test_returns_every_registered_lesson(self) -> None:
        response = app_module.list_lessons()

        self.assertEqual({lesson.id for lesson in response.lessons}, {lesson.id for lesson in LESSONS})
        self.assertEqual(len(response.lessons), len(LESSONS))

    def test_response_contains_only_metadata_and_section_structure(self) -> None:
        response = app_module.list_lessons()

        for lesson in response.lessons:
            dumped = lesson.model_dump(mode="json")
            self.assertEqual(set(dumped.keys()), _ALLOWED_LESSON_FIELDS)
            for forbidden in _FORBIDDEN_PROGRESS_FIELDS:
                self.assertNotIn(forbidden, dumped)

    def test_sections_preserve_their_declared_order_and_type(self) -> None:
        response = app_module.list_lessons()
        bell_state = next(lesson for lesson in response.lessons if lesson.id == "bell-state")

        # Exactly the declared order in the registry (no reordering by the API)…
        declared = next(lesson for lesson in LESSONS if lesson.id == "bell-state")
        self.assertEqual([s.id for s in bell_state.sections], [s.id for s in declared.sections])
        self.assertEqual([s.type for s in bell_state.sections], [s.type for s in declared.sections])
        # …which for a foundation lesson is: four explanations, a check, the lab, a
        # second check, a connecting explanation, then a reflection.
        self.assertEqual(
            [section.type for section in bell_state.sections],
            [
                "explanation", "explanation", "explanation", "explanation",
                "concept_check", "interactive_lab", "concept_check", "explanation", "reflection",
            ],
        )

    def test_interactive_lab_sections_only_ever_name_an_existing_capability(self) -> None:
        # Mirrors the trust boundary this endpoint must respect: a lab section
        # can only point at a real, already-existing backend endpoint, never
        # carry a computed result or invent a new capability.
        known_capabilities = {"execute", "verify_bell_state", "multi_input_test", "optimize", "variational_sweep", "noise_compare"}
        response = app_module.list_lessons()

        for lesson in response.lessons:
            for section in lesson.sections:
                if section.type == "interactive_lab":
                    self.assertIn(section.capability, known_capabilities)
                    self.assertIsNotNone(lesson.linked_circuit)

    def test_repeated_calls_return_the_same_catalog(self) -> None:
        first = app_module.list_lessons()
        second = app_module.list_lessons()

        self.assertEqual(
            [lesson.model_dump(mode="json") for lesson in first.lessons],
            [lesson.model_dump(mode="json") for lesson in second.lessons],
        )


if __name__ == "__main__":
    unittest.main()
