"""Deterministic, no-LLM tutor answers (docs/AI_BOUNDARY.md's "Fallback").

This milestone has no LLM adapter yet — the provider-agnostic adapter in
docs/ARCHITECTURE.md §8 is not built here. Every answer this module produces
is the template path AI_BOUNDARY.md describes for "no API key, a timeout, or
two guard failures": "the server builds a template explanation from the same
facts... labelled 'Explanation generated without AI'." When an LLM adapter is
added later, this module remains that fallback, not dead code — and the fact
sheet it reads from (``qentor.tutor.facts``) is exactly what the LLM step
would also be given as grounding context.
"""

from __future__ import annotations

from qentor.provenance.models import ProvenanceRecord

from .models import TutorFact

UNSUPPORTED_QUESTION_ANSWER = (
    "I don't have a deterministic answer for that question yet. Try asking "
    '"what does this circuit do" or "what was the result".'
)

_CIRCUIT_KEYWORDS = ("circuit", "gate", "qubit", "does this do", "what does")
_RESULT_KEYWORDS = (
    "result",
    "probability",
    "probabilities",
    "outcome",
    "count",
    "counts",
    "measure",
    "measured",
    "statevector",
    "amplitude",
)


def answer_question(question: str, facts: list[TutorFact], record: ProvenanceRecord) -> str:
    """Only meaningful for a successful execution — see ``answer_failed_execution``
    for the case where ``record``'s own execution did not succeed."""
    q = question.lower()

    if any(keyword in q for keyword in _CIRCUIT_KEYWORDS):
        circuit_fact = next(f for f in facts if f.kind == "circuit_summary")
        return f"{circuit_fact.description} ({circuit_fact.id})."

    if any(keyword in q for keyword in _RESULT_KEYWORDS):
        return _answer_result_summary(facts)

    return UNSUPPORTED_QUESTION_ANSWER


def answer_failed_execution(record: ProvenanceRecord) -> str:
    return (
        f"The execution for result {record.result_id} did not succeed "
        f"(status: {record.verification_status.value}), so there is nothing verified to explain."
    )


def _answer_result_summary(facts: list[TutorFact]) -> str:
    value_facts = [f for f in facts if f.kind in ("probability", "amplitude")]
    if not value_facts:
        return "This execution recorded no probability or amplitude data to report."
    citations = "; ".join(f"{f.description} ({f.id})" for f in value_facts)
    return f"For this result: {citations}."
