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


class VerifyBellStateRequest(BaseModel):
    """``circuit`` is the canonical circuit the client already built (the same shape
    ``ExecuteRequest.circuit`` takes) — never a probability, count or verdict. The
    verifier itself checks this circuit's hash against the persisted provenance
    record's ``circuit_hash`` before trusting it; a mismatch is reported as an ERROR
    verification report, not silently accepted.
    """

    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit: Circuit


class VerificationCheckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    status: str
    detail: str


class VerifyBellStateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit_hash: str
    verifier: str
    verification_status: str
    checks: list[VerificationCheckResponse]
    expected_support: list[str]
    observed_support: list[str]
