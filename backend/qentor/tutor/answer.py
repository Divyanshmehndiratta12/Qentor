"""Top-level answer orchestration: try the LLM (if configured), guard its
output, and fall back to the deterministic template whenever it isn't
available, fails, or can't be trusted — docs/AI_BOUNDARY.md's "Fallback":
"With no API key, a timeout ... or two guard failures, the server builds a
template explanation from the same facts ... labelled 'Explanation generated
without AI'."

This is the only place that decides whether an answer came from the LLM or
the template; the API layer just reports whatever this returns.
"""

from __future__ import annotations

from qentor.provenance.models import ProvenanceRecord, VerificationStatus

from .deterministic import answer_failed_execution, answer_question
from .guard import GuardRejection, validate_llm_draft
from .lesson_answers import answer_lesson_question, is_lesson_route, route_question
from .lesson_context import LessonContext
from .llm import LLMAdapter, LLMUnavailable
from .models import TutorFact


def answer_question_with_llm(
    question: str,
    facts: list[TutorFact],
    record: ProvenanceRecord,
    llm: LLMAdapter | None,
    language: str = "en",
) -> tuple[str, bool]:
    """Returns ``(answer, used_fallback_template)``.

    Only called for a successfully executed result — a failed execution is
    handled entirely by ``answer_failed_execution``, never sent to the LLM.
    ``language`` selects which language the answer is written in — LLM or
    deterministic template — and never changes which facts are built or what
    numbers they contain.
    """
    if llm is not None:
        try:
            draft = llm.generate(question, facts, language)
            answer = validate_llm_draft(draft, facts)
            return answer, False
        except (LLMUnavailable, GuardRejection):
            pass  # fall through to the deterministic template below

    return answer_question(question, facts, record, language), True


def answer_lesson_aware_question(
    question: str,
    lesson: LessonContext,
    facts: list[TutorFact],
    record: ProvenanceRecord | None,
    llm: LLMAdapter | None,
    language: str = "en",
) -> tuple[str, bool]:
    """Returns ``(answer, used_fallback_template)`` for a request that carries
    lesson context, with or without an attached quantum result.

    Fact precedence (docs/AI_BOUNDARY.md): lesson explanation comes from the
    lesson facts (``L#``, the lesson registry); every quantum number comes from
    the result facts (``F#``, the provenance log). The two lists are validated
    together by the guard — a draft may cite either, but may state no number
    that appears in neither.

    ``record`` is ``None`` for a lesson-only request. A record whose execution
    did not succeed is never sent to the LLM and never explained: a lesson
    question is still answered from the lesson, anything else gets the same
    honest failed-execution message the lesson-free path gives.
    """
    result_usable = record is not None and record.verification_status == VerificationStatus.VERIFIED
    result_facts = facts if result_usable else []

    if record is not None and not result_usable:
        if is_lesson_route(route_question(question)):
            return answer_lesson_question(question, lesson, [], None, language), True
        return answer_failed_execution(record, language), True

    if llm is not None:
        try:
            draft = llm.generate(question, result_facts, language, lesson_facts=list(lesson.facts))
            answer = validate_llm_draft(draft, [*lesson.facts, *result_facts])
            return answer, False
        except (LLMUnavailable, GuardRejection):
            pass  # fall through to the deterministic answer below

    return answer_lesson_question(question, lesson, result_facts, record if result_usable else None, language), True
