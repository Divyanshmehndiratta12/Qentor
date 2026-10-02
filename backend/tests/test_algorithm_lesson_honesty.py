"""Final quality sprint: every algorithm lesson says, in its own words, that it is a FIXED educational example, what the general
algorithm is that it is not, and that it makes no claim about scaling.

The lessons already do this; this pins it so a later edit cannot quietly drop the sentence. Each lesson has the statement that fits
its subject, and every one of them opens (first explanation section) by saying how small and fixed it is.
"""

from __future__ import annotations

import unittest

from qentor.lessons import get_lesson

# lesson id -> phrases (lower-case) that must appear somewhere in the lesson's text
REQUIRED: dict[str, list[str]] = {
    "grovers-search": ["one small educational example", "not a general search tool", "does not show a scalable speed-up"],
    "quantum-teleportation": ["one fixed 3-qubit example", "not the full dynamic protocol"],
    "quantum-fourier-transform": ["one fixed 3-qubit example", "does not claim that the qft is fast", "nothing about how a larger qft scales"],
    "quantum-phase-estimation": ["one exact fixed example, not the general algorithm", "not of phase estimation in general", "is not a general tool"],
    "quantum-error-correction": ["one fixed 5-qubit example", "not a realistic noise model", "does not model physical noise"],
    "variational-vqe": ["one fixed one-parameter example", "it is not a chemistry calculation", "it is not a scalable vqe"],
    "shors-algorithm": ["one fixed small educational instance", "not a general factoring implementation", "not a scalable shor's algorithm"],
}


def lesson_text(lesson_id: str) -> str:
    lesson = get_lesson(lesson_id)
    assert lesson is not None, lesson_id
    parts = [lesson.short_description, *lesson.learning_objectives]
    for section in lesson.sections:
        for field in ("body", "prompt", "instructions", "question", "explanation"):
            value = getattr(section, field, None)
            if value:
                parts.append(value)
    return "\n".join(parts).lower().replace("’", "'")


class TestAlgorithmLessonsStateTheirLimits(unittest.TestCase):
    def test_each_lesson_carries_its_own_fixed_example_and_not_general_statements(self) -> None:
        for lesson_id, phrases in REQUIRED.items():
            text = lesson_text(lesson_id)
            for phrase in phrases:
                with self.subTest(lesson=lesson_id, phrase=phrase):
                    self.assertIn(phrase, text)

    def test_each_lesson_opens_by_saying_it_is_fixed_and_small(self) -> None:
        for lesson_id in REQUIRED:
            lesson = get_lesson(lesson_id)
            first = next(s for s in lesson.sections if s.type == "explanation")
            with self.subTest(lesson=lesson_id):
                body = first.body.lower()
                self.assertTrue("fixed" in body or "exact" in body, body[:120])
                self.assertTrue("educational" in body or "small" in body, body[:120])

    def test_no_lesson_in_the_set_claims_hardware_or_speed(self) -> None:
        for lesson_id in REQUIRED:
            text = lesson_text(lesson_id)
            with self.subTest(lesson=lesson_id):
                self.assertNotIn("runs on real hardware", text)
                self.assertNotIn("exponential speed-up", text)
                self.assertNotIn("quantum advantage", text.replace("no quantum advantage", ""))


if __name__ == "__main__":
    unittest.main()
