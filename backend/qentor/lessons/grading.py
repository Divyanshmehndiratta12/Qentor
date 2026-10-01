"""Server-side grading of concept checks.

A client sends WHICH option it picked for WHICH check of WHICH lesson; the server decides whether that is right, from the
lesson's own answer key (``ConceptCheckSection.correct_option_id``), and answers with the verdict and the explanation.
The key and the explanation never travel to a client otherwise: ``GET /api/lessons`` serves ``PublicLesson``, which cannot
hold either (``qentor.lessons.models``).

This is course assessment, not a quantum result, so it needs no provenance record; it is still deterministic, it never
consults a model, and it accepts no number, verdict or key from the client (the request carries three ids).

Two entry points share one rule:

* ``grade_concept_check`` - one selection; raises ``GradeError`` (a stable ``code``, a message, an HTTP status) when the
  ids do not name a gradable check or the option is not one of its choices;
* ``regrade`` - many selections, each answered on its own (``GRADED`` with a verdict, or ``UNKNOWN_LESSON`` /
  ``UNKNOWN_CHECK`` / ``NOT_GRADED`` / ``UNKNOWN_OPTION`` with no verdict), so one stale entry from an old save cannot sink
  the rest. A browser uses it after a reload to rebuild its verdicts from the authority instead of trusting saved ones.

Nothing here reveals the key except by answering a submitted selection: a wrong answer does not say which option was right,
though its explanation, as course text, usually does.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import ConceptCheckSection
from .registry import LESSON_BY_ID

GRADER = "qentor.lessons.grading/1"

LESSON_NOT_FOUND = "LESSON_NOT_FOUND"
CONCEPT_CHECK_NOT_FOUND = "CONCEPT_CHECK_NOT_FOUND"
CONCEPT_CHECK_NOT_GRADED = "CONCEPT_CHECK_NOT_GRADED"
OPTION_NOT_FOUND = "OPTION_NOT_FOUND"

GradeStatus = Literal["GRADED", "UNKNOWN_LESSON", "UNKNOWN_CHECK", "NOT_GRADED", "UNKNOWN_OPTION"]

_STATUS_FOR_CODE: dict[str, GradeStatus] = {
    LESSON_NOT_FOUND: "UNKNOWN_LESSON",
    CONCEPT_CHECK_NOT_FOUND: "UNKNOWN_CHECK",
    CONCEPT_CHECK_NOT_GRADED: "NOT_GRADED",
    OPTION_NOT_FOUND: "UNKNOWN_OPTION",
}


class GradeError(Exception):
    """The selection cannot be graded. ``code`` is a stable machine id, ``message`` is safe to show a person, and
    ``status_code`` is the HTTP status the API answers with (404 for an id that names nothing, 422 for a well-formed id
    that is not gradable or not one of the choices)."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class GradeOutcome(BaseModel):
    """The verdict on one selection. Carries the explanation and nothing that names the key."""

    model_config = ConfigDict(extra="forbid")

    lesson_id: str
    check_id: str
    selected_option_id: str
    correct: bool
    explanation: str
    grader: str = GRADER


def grade_concept_check(lesson_id: str, check_id: str, selected_option_id: str) -> GradeOutcome:
    """Grade one selection against the lesson's answer key. Raises ``GradeError`` when it cannot be graded."""
    lesson = LESSON_BY_ID.get(lesson_id)
    if lesson is None:
        raise GradeError(LESSON_NOT_FOUND, f"no lesson {lesson_id!r}", 404)

    section = next((s for s in lesson.sections if s.id == check_id), None)
    if not isinstance(section, ConceptCheckSection):
        raise GradeError(CONCEPT_CHECK_NOT_FOUND, f"lesson {lesson_id!r} has no concept check {check_id!r}", 404)

    if section.options is None or section.correct_option_id is None or section.explanation is None:
        raise GradeError(
            CONCEPT_CHECK_NOT_GRADED,
            f"concept check {check_id!r} of lesson {lesson_id!r} is a prompt with no question to grade",
            422,
        )

    offered = [option.id for option in section.options]
    if selected_option_id not in offered:
        raise GradeError(
            OPTION_NOT_FOUND,
            f"{selected_option_id!r} is not one of the options of concept check {check_id!r} ({', '.join(offered)})",
            422,
        )

    return GradeOutcome(
        lesson_id=lesson_id,
        check_id=check_id,
        selected_option_id=selected_option_id,
        correct=selected_option_id == section.correct_option_id,
        explanation=section.explanation,
    )


class RegradeItem(BaseModel):
    """One answered selection, as a client holds it."""

    model_config = ConfigDict(extra="forbid")

    lesson_id: str = Field(min_length=1, max_length=200)
    check_id: str = Field(min_length=1, max_length=200)
    selected_option_id: str = Field(min_length=1, max_length=200)


class RegradeResult(BaseModel):
    """The server's answer for one ``RegradeItem``: a verdict and explanation when ``status == "GRADED"``, otherwise neither."""

    model_config = ConfigDict(extra="forbid")

    lesson_id: str
    check_id: str
    selected_option_id: str
    status: GradeStatus
    correct: bool | None = None
    explanation: str | None = None


def regrade(items: list[RegradeItem]) -> list[RegradeResult]:
    """Grade every item independently, in order. A selection that can no longer be graded is reported, never raised."""
    results: list[RegradeResult] = []
    for item in items:
        try:
            outcome = grade_concept_check(item.lesson_id, item.check_id, item.selected_option_id)
        except GradeError as exc:
            results.append(
                RegradeResult(
                    lesson_id=item.lesson_id,
                    check_id=item.check_id,
                    selected_option_id=item.selected_option_id,
                    status=_STATUS_FOR_CODE[exc.code],
                )
            )
            continue
        results.append(
            RegradeResult(
                lesson_id=item.lesson_id,
                check_id=item.check_id,
                selected_option_id=item.selected_option_id,
                status="GRADED",
                correct=outcome.correct,
                explanation=outcome.explanation,
            )
        )
    return results
