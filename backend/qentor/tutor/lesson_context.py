"""Lesson context for the tutor (docs/AI_BOUNDARY.md).

The browser never sends lesson text. It sends a ``lesson_id`` and optionally a
``section_id``; this module resolves both against the authoritative lesson
registry (``qentor.lessons``) and turns the result into a small list of
``TutorFact``s with ``L#`` ids — the same citable unit the quantum-result facts
(``F#``, ``qentor.tutor.facts``) use, so the LLM guard can validate citations
against one combined sheet.

Two authorities, kept apart:

- lesson explanation -> the lesson registry (these ``L#`` facts);
- quantum numbers, probabilities, verdicts -> the provenance log (``F#`` facts).

A lesson fact is course material. It carries no ``result_id``, no provenance
and no verification status, and is never presented as a quantum result.

Only what the current section needs is included: the lesson overview and
objectives, the current section, and — when the current section is a quiz,
lab or reflection — the lesson's explanatory text as supporting material. The
other sections are not dumped. A concept check's ``correct_option_id`` and
answer ``explanation`` are never included, so a hint cannot give the answer
away.
"""

from __future__ import annotations

from dataclasses import dataclass

from qentor.lessons import (
    LESSONS,
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    Lesson,
    ReflectionSection,
    get_lesson,
)

from .models import FactKind, TutorFact

LESSON_NOT_FOUND = "TUTOR_LESSON_NOT_FOUND"
SECTION_NOT_FOUND = "TUTOR_SECTION_NOT_FOUND"
SECTION_MISMATCH = "TUTOR_SECTION_MISMATCH"

# Section ids are lesson-local ("s1", "s2", ...), so a stray one can belong to
# most of the catalog; the error names a few owners, not all of them.
_MAX_OWNERS_IN_MESSAGE = 3


class LessonContextError(Exception):
    """The lesson/section ids do not resolve. ``code`` is a stable machine
    identifier the API layer forwards; ``message`` is safe to show a person."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class LessonContext:
    lesson_id: str
    lesson_title: str
    section_id: str | None
    section_title: str | None
    # "explanation" | "concept_check" | "interactive_lab" | "reflection" | None
    section_type: str | None
    facts: tuple[TutorFact, ...]
    # The lesson's own prose for this context (title, description, concept,
    # objectives, prerequisite titles, current section and its supporting
    # material) and NOTHING else: no fact-sheet scaffolding words such as
    # "objective" or "explanation". It is what a free-text question is checked
    # against to decide whether it is about this lesson (see lesson_answers).
    topic_text: str = ""

    def of_kind(self, kind: FactKind) -> list[TutorFact]:
        return [f for f in self.facts if f.kind == kind]


def resolve_lesson_context(lesson_id: str, section_id: str | None = None) -> LessonContext:
    """Resolve ids against the registry, or raise ``LessonContextError``.

    Section ids are lesson-local (``s1``, ``s2``, ...), so a section id that
    the requested lesson does not have but *another* lesson does is reported
    as a mismatch; one that no lesson has is simply not found.
    """
    lesson = get_lesson(lesson_id)
    if lesson is None:
        raise LessonContextError(LESSON_NOT_FOUND, f"no lesson with id '{lesson_id}'")

    section = None
    if section_id is not None:
        section = next((s for s in lesson.sections if s.id == section_id), None)
        if section is None:
            owners = [other.id for other in LESSONS if other.id != lesson.id and _has_section(other, section_id)]
            if owners:
                shown = ", ".join(owners[:_MAX_OWNERS_IN_MESSAGE]) + (
                    ", …" if len(owners) > _MAX_OWNERS_IN_MESSAGE else ""
                )
                raise LessonContextError(
                    SECTION_MISMATCH,
                    f"section '{section_id}' does not belong to lesson '{lesson.id}' "
                    f"(it belongs to: {shown})",
                )
            raise LessonContextError(
                SECTION_NOT_FOUND, f"lesson '{lesson.id}' has no section with id '{section_id}'"
            )

    return LessonContext(
        lesson_id=lesson.id,
        lesson_title=lesson.title,
        section_id=section.id if section else None,
        section_title=section.title if section else None,
        section_type=section.type if section else None,
        facts=tuple(_build_facts(lesson, section)),
        topic_text=_topic_text(lesson, section),
    )


def _has_section(lesson: Lesson, section_id: str) -> bool:
    return any(s.id == section_id for s in lesson.sections)


def _build_facts(lesson: Lesson, section) -> list[TutorFact]:
    facts: list[TutorFact] = []

    def add(kind: FactKind, description: str) -> None:
        facts.append(TutorFact(id=f"L{len(facts) + 1}", kind=kind, description=description))

    add(
        "lesson_overview",
        f'lesson "{lesson.title}" ({lesson.id}, {lesson.difficulty}): {lesson.short_description}',
    )
    for objective in lesson.learning_objectives:
        add("lesson_objective", f"objective: {objective}")

    prerequisites = [p.title for pid in lesson.prerequisite_lesson_ids if (p := get_lesson(pid)) is not None]
    if prerequisites:
        add("lesson_prerequisite", f"prerequisites: {', '.join(prerequisites)}")

    if section is None:
        return facts

    add("lesson_section", _describe_section(section))

    # A quiz, lab or reflection has little teaching text of its own; the
    # lesson's explanatory sections are what it is testing. Explanation text
    # only — never a quiz's correct option or its answer rationale.
    if not isinstance(section, ExplanationSection):
        for other in lesson.sections:
            if isinstance(other, ExplanationSection):
                add("lesson_material", f'material — "{other.title}": {other.body}')

    return facts


def _section_prose(section) -> list[str]:
    """The teaching/prompt text of a section — never a quiz's answer or rationale."""
    if isinstance(section, ExplanationSection):
        return [section.title, section.body]
    if isinstance(section, ConceptCheckSection):
        return [section.title, section.prompt]
    if isinstance(section, InteractiveLabSection):
        return [section.title, section.instructions]
    if isinstance(section, ReflectionSection):
        return [section.title, section.prompt]
    raise TypeError(f"unhandled lesson section type: {type(section).__name__}")  # pragma: no cover


def _topic_text(lesson: Lesson, section) -> str:
    parts = [lesson.title, lesson.short_description, lesson.concept, *lesson.learning_objectives]
    parts += [p.title for pid in lesson.prerequisite_lesson_ids if (p := get_lesson(pid)) is not None]
    if section is not None:
        parts += _section_prose(section)
        if not isinstance(section, ExplanationSection):
            for other in lesson.sections:
                if isinstance(other, ExplanationSection):
                    parts += _section_prose(other)
    return " ".join(parts)


def _describe_section(section) -> str:
    head = f'section {section.id} "{section.title}"'
    if isinstance(section, ExplanationSection):
        return f"{head} (explanation): {section.body}"
    if isinstance(section, ConceptCheckSection):
        return f"{head} (concept check): {section.prompt}"
    if isinstance(section, InteractiveLabSection):
        return f"{head} (interactive lab, uses the {section.capability} tool): {section.instructions}"
    if isinstance(section, ReflectionSection):
        return f"{head} (reflection): {section.prompt}"
    raise TypeError(f"unhandled lesson section type: {type(section).__name__}")  # pragma: no cover
