"""Tutor layer (docs/ARCHITECTURE.md §8, docs/AI_BOUNDARY.md).

This milestone builds the fact-sheet builder and the deterministic, no-LLM
answer path only — the LLM adapter, output guard and claim re-simulation from
docs/AI_BOUNDARY.md §4 are not built yet. Nothing here writes to the
provenance log or re-executes a circuit: every function takes an
already-fetched ``ProvenanceRecord`` as a plain argument, and the API layer
(``qentor.api.app``) is the only caller that touches ``ProvenanceStore``. See
``backend/tests/test_architecture_rule.py`` for the import-graph guard that
keeps this package from ever reaching ``ProvenanceStore`` itself.
"""

from __future__ import annotations

from .deterministic import UNSUPPORTED_QUESTION_ANSWER, answer_failed_execution, answer_question
from .facts import build_fact_sheet
from .models import FactKind, TutorFact

__all__ = [
    "UNSUPPORTED_QUESTION_ANSWER",
    "answer_failed_execution",
    "answer_question",
    "build_fact_sheet",
    "FactKind",
    "TutorFact",
]
