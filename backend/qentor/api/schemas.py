"""API request/response shapes.

``ExecuteRequest`` is built directly on the canonical ``Circuit`` model, which has
``extra="forbid"``. A client literally cannot include a ``probabilities``,
``counts``, ``statevector`` or ``pass``/``fail`` field in the request body — there
is no field for it, and an unknown field is a validation error, not a silently
ignored one.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from qentor.circuit.model import Circuit


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    mode: Literal["statevector", "shots"]
    shots: int | None = Field(default=None, gt=0)


class ExecuteResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit_hash: str
    backend: str
    backend_version: str
    execution_mode: str
    provenance_class: str
    verification_status: str
    created_at: str
    payload: dict[str, Any]
