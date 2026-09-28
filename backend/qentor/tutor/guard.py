"""Guard for LLM-generated tutor drafts (docs/AI_BOUNDARY.md §4 step 3).

An ``LLMDraft`` is untrusted until it passes every check here. Any failure
raises ``GuardRejection`` with a human-readable reason — the caller falls back
to the deterministic template rather than repairing or partially trusting a
draft. Per docs/AI_BOUNDARY.md §2, the LLM must never be the source of a
statevector, probability, count or verdict; this guard is the code-level
enforcement of that for this milestone's structured (not free-text) output:

1. The answer must be a non-empty string.
2. Every id in ``cited_fact_ids`` must exist in the fact sheet the model was
   actually given — a citation to a fact that doesn't exist is either a
   hallucination or evidence the model ignored its grounding.
3. Every decimal or percentage in the answer text must already appear
   verbatim in some fact's description — the model may restate a real number
   from a fact, but cannot introduce a new one.
"""

from __future__ import annotations

import re

from .llm import LLMDraft
from .models import TutorFact

_MIN_ANSWER_LENGTH = 1
_NUMBER_PATTERN = re.compile(r"\d+\.\d+|\d+%")


class GuardRejection(Exception):
    """The draft failed validation; the message is the rejection reason."""


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

    ungrounded = _find_ungrounded_number(draft.answer, facts)
    if ungrounded is not None:
        raise GuardRejection(f"draft states a number not present in any fact description: {ungrounded!r}")

    return draft.answer.strip()


def _find_ungrounded_number(answer: str, facts: list[TutorFact]) -> str | None:
    fact_text = " ".join(f.description for f in facts)
    for match in _NUMBER_PATTERN.finditer(answer):
        number = match.group(0)
        if number not in fact_text:
            return number
    return None
