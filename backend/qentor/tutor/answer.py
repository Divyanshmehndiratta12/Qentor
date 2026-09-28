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

from qentor.provenance.models import ProvenanceRecord

from .deterministic import answer_question
from .guard import GuardRejection, validate_llm_draft
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
