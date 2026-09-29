"""Tutor fact-sheet shapes.

Per docs/AI_BOUNDARY.md §4 step 1, every number the tutor ever states — to a
learner directly (this milestone) or to an LLM (a later one) — must be a
reference to a fact built from the provenance log, never a bare number typed
into a string. A ``TutorFact`` is that atomic, citable unit.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

FactKind = Literal[
    # Quantum-result facts (``F#`` ids), built from a persisted ProvenanceRecord.
    "circuit_summary",
    "execution_status",
    "probability",
    "amplitude",
    # Lesson facts (``L#`` ids), read from the authoritative lesson registry
    # (``qentor.lessons``). Course material, not a quantum result: they carry no
    # ``result_id`` and never a verification status.
    "lesson_overview",
    "lesson_objective",
    "lesson_prerequisite",
    "lesson_section",
    "lesson_material",
    # Trace-step facts (``S#`` ids): what the backend's execution trace produced
    # for the step the learner has selected (``qentor.tutor.trace_context``).
    # Every one is tied to that step's provenance record via ``result_id``.
    "trace_step",
    "trace_operation",
    "trace_gate_note",
    "trace_status",
    "trace_amplitude",
    "trace_bloch",
    "trace_note",
]


class TutorFact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: FactKind
    description: str
    # ``None`` for a lesson fact: it is not grounded in any execution.
    result_id: str | None = None
