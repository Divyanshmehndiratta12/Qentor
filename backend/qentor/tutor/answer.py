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
from .step_answers import answer_step_question, step_intent, step_not_recognised_answer
from .trace_context import TraceStepContext


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


def answer_step_aware_question(
    question: str,
    step: TraceStepContext,
    lesson: LessonContext | None,
    facts: list[TutorFact],
    record: ProvenanceRecord | None,
    llm: LLMAdapter | None,
    language: str = "en",
) -> tuple[str, bool]:
    """Returns ``(answer, used_fallback_template)`` for a request that carries a
    selected trace step (with or without lesson context and a Lab result).

    Three sources, three authorities, one guard:
    ``S#`` (the step's facts, from its verified provenance record), ``F#`` (a
    result's facts), ``L#`` (lesson material). The LLM sees them as separate
    blocks and a draft is validated against all of them together, so a number
    that appears in none of them is rejected. A step whose record is unusable is
    never sent to the LLM.

    Without an LLM (or when it fails or is rejected) a recognised step question
    is answered by quoting the step's facts (``step_answers``). A question that
    is not about the step falls back to exactly what it would have got without
    one: the lesson router, the result answer, or — with only a step to go on —
    a pointer to what can be asked.
    """
    result_usable = record is not None and record.verification_status == VerificationStatus.VERIFIED
    result_facts = facts if result_usable else []

    if llm is not None and step.usable:
        kwargs: dict = {"trace_facts": list(step.facts)}
        if lesson is not None:
            kwargs["lesson_facts"] = list(lesson.facts)
        try:
            draft = llm.generate(question, result_facts, language, **kwargs)
            answer = validate_llm_draft(draft, [*(lesson.facts if lesson else ()), *step.facts, *result_facts])
            return answer, False
        except (LLMUnavailable, GuardRejection):
            pass  # fall through to the deterministic answer below

    intent = step_intent(question)
    if intent is not None:
        return answer_step_question(intent, step, language), True

    if lesson is not None:
        if record is not None and not result_usable and not is_lesson_route(route_question(question)):
            return answer_failed_execution(record, language), True
        return answer_lesson_question(question, lesson, result_facts, record if result_usable else None, language), True
    if record is not None:
        if not result_usable:
            return answer_failed_execution(record, language), True
        return answer_question(question, facts, record, language), True
    return step_not_recognised_answer(language), True


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
