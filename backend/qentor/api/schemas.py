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
    # Defaults to the original, only-ever-existed backend so a request that
    # predates this field behaves identically. Each value matches the
    # selected adapter's own `.name` exactly (qentor.api.app's registry).
    backend: Literal["qiskit-aer", "cirq", "pennylane"] = "qiskit-aer"


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


class TutorRequest(BaseModel):
    """``circuit`` is the same canonical shape ``ExecuteRequest``/
    ``VerifyBellStateRequest`` take — the client's current circuit context,
    never a probability, count, amplitude or verdict. ``result_id`` names the
    already-persisted execution the tutor grounds its answer in; a circuit
    that doesn't hash to that record's own ``circuit_hash`` is rejected
    outright (HTTP 422), not silently answered against the wrong result.
    """

    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit: Circuit
    question: str = Field(min_length=1)


class TutorFactResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: str
    description: str
    result_id: str


class TutorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: str
    result_id: str
    circuit_hash: str
    provenance_class: str
    verification_status: str
    used_fallback_template: bool
    facts: list[TutorFactResponse]
