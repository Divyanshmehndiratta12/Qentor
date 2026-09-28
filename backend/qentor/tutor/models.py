"""Tutor fact-sheet shapes.

Per docs/AI_BOUNDARY.md §4 step 1, every number the tutor ever states — to a
learner directly (this milestone) or to an LLM (a later one) — must be a
reference to a fact built from the provenance log, never a bare number typed
into a string. A ``TutorFact`` is that atomic, citable unit.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

FactKind = Literal["circuit_summary", "execution_status", "probability", "amplitude"]


class TutorFact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: FactKind
    description: str
    result_id: str
