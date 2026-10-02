"""Shared shapes of the quantum reasoning engine (``qentor.reasoning``).

The engine is a server-side analysis layer ABOVE execution, trace, optimisation and comparison: it takes a structured
intent plus circuit and result context the server already holds, and returns structured facts that were computed by the
execution and verification layers. It is never a second simulator and a model is never its authority.

Every analysis names the backend runs it rests on (``Source``: result id, execution id, circuit hash, backend and version,
mode, provenance class, status), so a number can always be followed back to a provenance record. The request side has no
field that could carry a probability, an expected result, a counterfactual circuit or a verdict (``extra="forbid"`` on
every request model), so nothing of the kind can arrive from a client.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict

from qentor.provenance.models import ProvenanceRecord

METHOD = "qentor.reasoning/1"

# The one backend-name string every analysis record carries: an analysis is stored as one more provenance record, the way an
# experiment comparison is, so the tutor can be asked about it by id and read its facts back from the log.
REASONING_BACKEND = "reasoning-engine"
REASONING_MODE = "analysis"


class Intent(str, Enum):
    PROBABILITY = "PROBABILITY"
    OPTIMIZE = "OPTIMIZE"
    WHAT_IF = "WHAT_IF"
    TRACE_CHANGE = "TRACE_CHANGE"
    COMPARE = "COMPARE"
    DEBUG = "DEBUG"


class ReasoningError(Exception):
    """A request the engine refuses, with a stable ``code`` and an HTTP status. Nothing is guessed or substituted."""

    def __init__(self, code: str, message: str, *, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class Source(BaseModel):
    """One backend run an analysis rests on."""

    model_config = ConfigDict(extra="forbid")

    role: str
    result_id: str
    execution_id: str | None
    circuit_hash: str
    backend: str
    backend_version: str
    execution_mode: str
    provenance_class: str
    verification_status: str


def source_of(role: str, record: ProvenanceRecord) -> Source:
    return Source(
        role=role,
        result_id=record.result_id,
        execution_id=record.payload.get("execution_id"),
        circuit_hash=record.circuit_hash,
        backend=record.backend,
        backend_version=record.backend_version,
        execution_mode=record.execution_mode,
        provenance_class=record.provenance_class.value,
        verification_status=record.verification_status.value,
    )


class Analysis(BaseModel):
    """What the engine returns for any intent, and what is stored as the analysis record's payload."""

    model_config = ConfigDict(extra="forbid")

    method: str = METHOD
    intent: Intent
    # OK: an answer was computed. NO_IMPROVEMENT / NOT_APPLICABLE / INITIAL_STATE: an honest "there is nothing to report", with a reason.
    status: str
    reason: str | None = None
    circuit_hash: str
    sources: list[Source]
    data: dict[str, Any]
