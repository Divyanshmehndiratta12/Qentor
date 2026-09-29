"""Tutor layer (docs/ARCHITECTURE.md §8, docs/AI_BOUNDARY.md).

Fact-sheet builder, deterministic no-LLM answer path, and an optional,
server-only LLM layer with an output guard. Nothing here writes to the
provenance log or re-executes a circuit: every function takes an
already-fetched ``ProvenanceRecord`` as a plain argument, and the API layer
(``qentor.api.app``) is the only caller that touches ``ProvenanceStore``. See
``backend/tests/test_architecture_rule.py`` for the import-graph guard that
keeps this package from ever reaching ``ProvenanceStore`` itself.

Lesson-aware tutoring (``lesson_context.py``, ``lesson_answers.py``) adds a
second, separate fact source: ``L#`` facts read from the lesson registry by
``lesson_id``/``section_id``. Lesson explanation comes from those; quantum
numbers still come only from the ``F#`` result facts.

The LLM (``llm.py``) never runs anywhere but here, on the server, and only
ever sees the fact sheet and the question — never a client-supplied number.
Its raw output is untrusted (``guard.py``) until every cited fact id is
verified against the real fact sheet and every number in the answer traces
back to a fact description; a draft that fails either check is discarded and
``answer.py`` falls back to the deterministic template, the same one used
when the LLM is disabled, unreachable, or misconfigured.
"""

from __future__ import annotations

from .answer import answer_lesson_aware_question, answer_question_with_llm
from .config import build_default_llm_adapter, llm_enabled
from .deterministic import UNSUPPORTED_QUESTION_ANSWER, answer_failed_execution, answer_question
from .facts import build_fact_sheet
from .guard import GuardRejection, validate_llm_draft
from .lesson_context import LessonContext, LessonContextError, resolve_lesson_context
from .llm import AnthropicAdapter, LLMAdapter, LLMDraft, LLMUnavailable
from .models import FactKind, TutorFact

__all__ = [
    "UNSUPPORTED_QUESTION_ANSWER",
    "answer_failed_execution",
    "answer_lesson_aware_question",
    "answer_question",
    "answer_question_with_llm",
    "build_default_llm_adapter",
    "build_fact_sheet",
    "llm_enabled",
    "resolve_lesson_context",
    "validate_llm_draft",
    "AnthropicAdapter",
    "FactKind",
    "GuardRejection",
    "LLMAdapter",
    "LLMDraft",
    "LLMUnavailable",
    "LessonContext",
    "LessonContextError",
    "TutorFact",
]
