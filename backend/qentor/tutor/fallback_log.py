"""One warning line for every tutor draft that is not used, so an operator can see WHY the template answered.

The tutor falls back to its deterministic template when the language model is unreachable, replies with something unusable, or writes a draft the
claim guard rejects. Those fallbacks were silent. ``log_llm_fallback`` records the exception type and message, on one line and at most
``MAX_DETAIL_CHARS`` characters, and nothing else: never the API key, the request headers, the question or the prompt. Exception messages raised here
and by the guard contain a reason only, not the request.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("qentor.tutor")

MAX_DETAIL_CHARS = 300


def one_line(text: object, limit: int = MAX_DETAIL_CHARS) -> str:
    """Collapse all whitespace (so the log stays one line) and cut to ``limit`` characters."""
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[:limit] + "..."


def log_llm_fallback(where: str, exc: BaseException, outcome: str = "using the deterministic template") -> None:
    """Log that ``where`` did not use the model's draft because of ``exc``."""
    logger.warning("tutor LLM draft not used in %s: %s: %s -> %s", where, type(exc).__name__, one_line(exc), outcome)
