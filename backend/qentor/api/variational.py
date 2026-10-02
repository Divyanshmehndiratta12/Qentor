"""``POST /api/variational/sweep`` and ``POST /api/variational/optimize``: the one-parameter variational (VQE-style) demonstration.

The server runs the one-qubit ansatz ``RY(theta)`` on a backend, reads ``<Z>`` from each statevector it gets back and, for the optimiser,
combines three runs per step into a parameter-shift gradient (``qentor.verification.variational``). The request carries angles and loop
settings (inputs the learner chose) and nothing that could be a result; the response carries, for every point, the ``<Z>`` the backend's
state gave, the Bloch vector of that state and the provenance of the run, and the whole sweep is stored as one more provenance record.

Every response says what it is: an educational one-parameter demonstration, not a chemistry calculation, not a scalable VQE, no hardware.
Structured errors (``detail = {"code", "message"}``): 422 for an angle, a range, a point count, a step count or a rate outside what the
demonstration runs; 502 for a backend state that fails the state check; 503 when the backend is unavailable.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionResult
from qentor.execution.expectation import EXPECTATION_METHOD
from qentor.execution.trace import TraceBackendFault
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.verification.variational import (
    ANSATZ,
    LABEL,
    MAX_POINTS,
    MAX_STEPS,
    METHOD,
    MIN_LEARNING_RATE,
    MAX_LEARNING_RATE,
    MIN_POINTS,
    OBSERVABLE,
    SHIFT,
    THETA_LIMIT,
    EvaluatedPoint,
    VariationalError,
    run_optimization,
    run_sweep,
)

from . import reasoning as reasoning_api
from .schemas import TraceProvenanceResponse

router = APIRouter(prefix="/api/variational")

Backend = Literal["qiskit-aer", "cirq", "pennylane"]


class SweepRequest(BaseModel):
    """An angle range and how many points to take: inputs the learner chose. No ``<Z>``, probability or "expected" curve has a field here."""

    model_config = ConfigDict(extra="forbid")

    theta_min: float = Field(default=0.0, ge=-THETA_LIMIT, le=THETA_LIMIT, allow_inf_nan=False)
    theta_max: float = Field(default=2 * math.pi, ge=-THETA_LIMIT, le=THETA_LIMIT, allow_inf_nan=False)
    points: int = Field(default=25, ge=MIN_POINTS, le=MAX_POINTS)
    backend: Backend = "qiskit-aer"

    @model_validator(mode="after")
    def _ordered(self) -> "SweepRequest":
        if not self.theta_min < self.theta_max:
            raise ValueError("theta_min must be below theta_max")
        return self


class OptimizeRequest(BaseModel):
    """Where to start and how the classical loop behaves. The loop's gradients and costs are the server's."""

    model_config = ConfigDict(extra="forbid")

    theta_start: float = Field(ge=-THETA_LIMIT, le=THETA_LIMIT, allow_inf_nan=False)
    steps: int = Field(default=15, ge=1, le=MAX_STEPS)
    learning_rate: float = Field(default=0.6, ge=MIN_LEARNING_RATE, le=MAX_LEARNING_RATE, allow_inf_nan=False)
    backend: Backend = "qiskit-aer"


class BlochResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    z: float


class PointResponse(BaseModel):
    """One run of the ansatz: its angle, the ``<Z>`` read from the backend's state, that state's Bloch vector and probabilities (``q[0]``
    reads 0 or 1), and the provenance record of the run all of it was read from."""

    model_config = ConfigDict(extra="forbid")

    theta: float
    expectation_z: float
    bloch: BlochResponse
    probabilities: dict[str, float]
    result_id: str
    execution_id: str
    circuit_hash: str
    provenance: TraceProvenanceResponse


class VariationalCommon(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: str = METHOD
    expectation_method: str = EXPECTATION_METHOD
    ansatz: str = ANSATZ
    observable: str = OBSERVABLE
    label: str = LABEL
    backend: str
    backend_version: str
    # The whole demonstration as one provenance record (``backend = variational-demo``), naming every run in its payload.
    provenance: TraceProvenanceResponse


class SweepResponse(VariationalCommon):
    points: list[PointResponse]
    # Positions in ``points`` of the lowest and highest ``<Z>``, found by comparing the backend's values.
    minimum_index: int
    maximum_index: int


class StepResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step: int
    point: PointResponse
    # (<Z>(theta + pi/2) - <Z>(theta - pi/2)) / 2, from two more backend runs (the parameter-shift rule).
    gradient: float
    plus: PointResponse
    minus: PointResponse


class OptimizeResponse(VariationalCommon):
    steps: list[StepResponse]
    lowest_index: int
    converged: bool
    learning_rate: float
    shift: float
    notes: list[str]


def _provenance(record: ProvenanceRecord) -> TraceProvenanceResponse:
    return reasoning_api.provenance_of(record)


def _point(deps: reasoning_api.ReasoningDeps, p: EvaluatedPoint) -> PointResponse:
    record = deps.store.get(p.result_id)
    assert record is not None  # written a moment ago by the same request
    return PointResponse(
        theta=p.theta,
        expectation_z=p.expectation_z,
        bloch=BlochResponse(x=p.bloch[0], y=p.bloch[1], z=p.bloch[2]),
        probabilities=p.probabilities,
        result_id=p.result_id,
        execution_id=p.execution_id,
        circuit_hash=p.circuit_hash,
        provenance=_provenance(record),
    )


def _store_summary(deps: reasoning_api.ReasoningDeps, kind: str, request: BaseModel, points: list[EvaluatedPoint]) -> ProvenanceRecord:
    """The demonstration as one record: what was asked and the runs it rests on (their ids and the ``<Z>`` read from each)."""
    key = hashlib.sha256(json.dumps([kind, request.model_dump(mode="json")], sort_keys=True).encode()).hexdigest()
    record = ProvenanceRecord.new(
        circuit_hash=f"var_{key}",
        backend="variational-demo",
        backend_version=METHOD,
        execution_mode="variational",
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.STATE_CHECKED,
        payload={
            "method": METHOD,
            "kind": kind,
            "ansatz": ANSATZ,
            "observable": OBSERVABLE,
            "request": request.model_dump(mode="json"),
            "runs": [{"theta": p.theta, "expectation_z": p.expectation_z, "result_id": p.result_id} for p in points],
        },
    )
    deps.store.insert(record)
    return record


def _recorder(deps: reasoning_api.ReasoningDeps):
    def record_execution(result: ExecutionResult, chash: str) -> str:
        return deps.record_run(result, chash, 1).result_id

    return record_execution


def _structured(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _guard(call):
    """Map the demonstration's own refusals and a backend's faults to structured errors; nothing is substituted."""
    try:
        return call()
    except VariationalError as exc:
        raise _structured(422, exc.code, exc.message) from exc
    except TraceBackendFault as exc:
        raise _structured(502, exc.code, exc.message) from exc
    except AdapterUnavailable as exc:
        raise _structured(503, "VARIATIONAL_BACKEND_UNAVAILABLE", f"the backend is unavailable in this environment: {exc}") from exc
    except AdapterExecutionError as exc:
        raise _structured(400, "VARIATIONAL_BACKEND_EXECUTION_FAILED", str(exc)) from exc


@router.post("/sweep", response_model=SweepResponse)
def sweep_endpoint(request: SweepRequest) -> SweepResponse:
    """The cost ``<Z>`` of the ansatz at evenly spaced angles, each read from its own backend run."""
    deps = reasoning_api.deps()
    adapter = deps.adapters[request.backend]
    report = _guard(lambda: run_sweep(request.theta_min, request.theta_max, request.points, adapter, _recorder(deps)))
    summary = _store_summary(deps, "sweep", request, report.points)
    first = report.points[0]
    return SweepResponse(
        backend=first.backend,
        backend_version=first.backend_version,
        provenance=_provenance(summary),
        points=[_point(deps, p) for p in report.points],
        minimum_index=report.minimum_index,
        maximum_index=report.maximum_index,
    )


@router.post("/optimize", response_model=OptimizeResponse)
def optimize_endpoint(request: OptimizeRequest) -> OptimizeResponse:
    """A fixed-length gradient-descent loop on ``<Z>``: three backend runs per step, the angle moving downhill."""
    deps = reasoning_api.deps()
    adapter = deps.adapters[request.backend]
    report = _guard(lambda: run_optimization(request.theta_start, request.steps, request.learning_rate, adapter, _recorder(deps)))
    every_point = [p for s in report.steps for p in (s.point, s.plus, s.minus)]
    summary = _store_summary(deps, "optimize", request, every_point)
    first = report.steps[0].point
    return OptimizeResponse(
        backend=first.backend,
        backend_version=first.backend_version,
        provenance=_provenance(summary),
        steps=[
            StepResponse(step=s.step, point=_point(deps, s.point), gradient=s.gradient, plus=_point(deps, s.plus), minus=_point(deps, s.minus))
            for s in report.steps
        ],
        lowest_index=report.lowest_index,
        converged=report.converged,
        learning_rate=report.learning_rate,
        shift=SHIFT,
        notes=report.notes,
    )
