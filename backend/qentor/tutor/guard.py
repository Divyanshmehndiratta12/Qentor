"""Guard for LLM-generated tutor drafts (docs/AI_BOUNDARY.md §4 step 3).

An ``LLMDraft`` is untrusted until it passes every check here. Any failure
raises ``GuardRejection`` with a human-readable reason (and the structured list
of violations) — the caller falls back to the deterministic template rather than
repairing or partially trusting a draft. Per docs/AI_BOUNDARY.md §2, the LLM must
never be the source of a statevector, probability, count or verdict; this guard is
the code-level enforcement of that for the structured (not free-text) output:

1. The answer must be a non-empty string.
2. Every id in ``cited_fact_ids`` must exist in the fact sheet the model was
   actually given — a citation to a fact that doesn't exist is either a
   hallucination or evidence the model ignored its grounding.
3. Every quantum-derived claim in the answer must be supported by the facts.
   "Claim" is structured, not textual: an integer count, a decimal, a
   percentage, a fraction, a ratio, a square-root expression, a number in
   scientific notation, a signed number, a bitstring or ket, a qualitative
   probability statement ("always", "equally likely"), or a verdict ("verified",
   "equivalent", "this circuit passes"). See ``qentor.tutor.claims`` for what each
   means and for the limits of the check. The model may restate what a fact says,
   in any equivalent notation; it cannot introduce something the facts do not say.
"""

from __future__ import annotations

from .claims import Violation, find_violations
from .llm import LLMDraft
from .models import TutorFact

_MIN_ANSWER_LENGTH = 1


class GuardRejection(Exception):
    """The draft failed validation; the message is the rejection reason."""

    def __init__(self, message: str, violations: list[Violation] | None = None) -> None:
        super().__init__(message)
        self.violations: list[Violation] = violations or []


def validate_llm_draft(draft: LLMDraft, facts: list[TutorFact]) -> str:
    """Return the validated answer text, or raise ``GuardRejection``."""
    if not isinstance(draft.answer, str) or len(draft.answer.strip()) < _MIN_ANSWER_LENGTH:
        raise GuardRejection("draft answer is empty or not a string")
    if not isinstance(draft.cited_fact_ids, list):
        raise GuardRejection("cited_fact_ids is not a list")

    known_ids = {f.id for f in facts}
    unknown = [fid for fid in draft.cited_fact_ids if fid not in known_ids]
    if unknown:
        raise GuardRejection(f"draft cites fact id(s) not in the fact sheet: {unknown}")

    violations = find_violations(draft.answer, facts)
    if violations:
        shown = "; ".join(str(v) for v in violations[:3])
        more = f" (+{len(violations) - 3} more)" if len(violations) > 3 else ""
        raise GuardRejection(f"draft makes claim(s) not supported by the facts: {shown}{more}", violations)
    return draft.answer.strip()
