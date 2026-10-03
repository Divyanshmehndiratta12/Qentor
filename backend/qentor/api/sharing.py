"""Read-only shared experiments: ``POST /api/experiments`` creates an immutable snapshot, ``GET /api/experiments/{id}`` serves it.

What a share holds (and everything the public page shows): the canonical circuit, its OpenQASM 3 and generated Qiskit/Cirq/PennyLane text (written by
the server from the circuit, never run), the backend and run mode, an optional lesson or challenge it belongs to, an optional short title as plain
text, and, if the owner had run it, ONE provenance record of this very circuit (its metadata and its stored, authoritative result).

What it never holds or shows: a learner token, a class, an address, a path, a key or any other detail of the server or the owner. The request schema
forbids extra fields; the backend, mode and shot count of a shared run come from the provenance record, not from the request; a record is attached
only when it is a checked run of exactly the circuit being shared. There is no endpoint to list, search, edit or delete shares, and a share is
never changed after it is created: "fork into my Lab" copies the circuit in the browser.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from qentor.challenges import get_challenge
from qentor.circuit.codegen import CODEGEN_VERSION, generate_all
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit
from qentor.circuit.qasm import to_qasm3
from qentor.execution.limits import MAX_OPERATIONS
from qentor.lessons import get_lesson
from qentor.provenance.models import ExecutionStatus
from qentor.sharing import is_experiment_id

from .classroom import client_key, enforce_limit, hook_experiment_shared
from .schemas import ExecuteResponse
from .state_view import final_state_qubit_states

router = APIRouter(prefix="/api")

EXPERIMENT_NOT_FOUND = "EXPERIMENT_NOT_FOUND"
SHARE_INVALID = "SHARE_INVALID"
READ_ONLY_NOTE = (
    "A read-only snapshot. Everything below comes from the circuit and from the run it names; nothing here can be edited. "
    "Fork it into your Lab to change it, which makes a copy and leaves this page as it is."
)


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExperimentCreateRequest(_Body):
    circuit: Circuit
    result_id: str | None = Field(default=None, min_length=1, max_length=100)
    backend: Literal["qiskit-aer", "cirq", "pennylane"] = "qiskit-aer"
    mode: Literal["statevector", "shots"] = "statevector"
    lesson_id: str | None = Field(default=None, min_length=1, max_length=100)
    challenge_id: str | None = Field(default=None, min_length=1, max_length=100)
    title: str | None = Field(default=None, max_length=300)


class ExperimentCreateResponse(_Body):
    experiment_id: str
    path: str
    created_at: str


class NamedRef(_Body):
    id: str
    title: str


class SharedExperimentResponse(_Body):
    experiment_id: str
    created_at: str
    title: str | None
    read_only: Literal[True] = True
    note: str
    circuit_hash: str
    circuit: Circuit
    qasm: str
    generator: str
    code: dict[str, str]
    backend: str
    mode: str
    shots: int | None
    lesson: NamedRef | None
    challenge: NamedRef | None
    result: ExecuteResponse | None
    result_note: str


def _app():
    from qentor.api import app as app_module

    return app_module


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


@router.post("/experiments", response_model=ExperimentCreateResponse, status_code=201)
def create_experiment(
    request: ExperimentCreateRequest,
    http: Request,
    x_qentor_learner: Annotated[str | None, Header(alias="X-Qentor-Learner")] = None,
) -> ExperimentCreateResponse:
    """Share a circuit (and, optionally, one run of it) as a read-only page. Returns the page's id and path."""
    enforce_limit("experiments", client_key(http))
    app_module = _app()
    circuit = request.circuit
    if len(circuit.ops) > MAX_OPERATIONS:
        raise _error(422, SHARE_INVALID, f"{len(circuit.ops)} operations is over the {MAX_OPERATIONS}-operation limit")
    app_module._enforce_run_limits(circuit, request.backend)  # a shared circuit is one the platform can run
    chash = circuit_hash(circuit)

    backend, mode, shots = request.backend, request.mode, None
    if request.result_id is not None:
        record = app_module._store.get(request.result_id)
        if record is None:
            raise _error(404, SHARE_INVALID, f"no run found with result id {request.result_id!r}")
        if record.circuit_hash != chash:
            raise _error(422, SHARE_INVALID, "that run is not a run of this circuit")
        if record.verification_status is not ExecutionStatus.STATE_CHECKED:
            raise _error(422, SHARE_INVALID, "only a run that passed its state check can be shared")
        backend, mode = record.backend, record.execution_mode  # the run says how it was run; the request does not
        raw_shots = record.payload.get("shots")
        shots = raw_shots if isinstance(raw_shots, int) and not isinstance(raw_shots, bool) else None
    if request.lesson_id is not None and get_lesson(request.lesson_id) is None:
        raise _error(422, SHARE_INVALID, f"no lesson {request.lesson_id!r}")
    if request.challenge_id is not None and get_challenge(request.challenge_id) is None:
        raise _error(422, SHARE_INVALID, f"no challenge {request.challenge_id!r}")

    saved = app_module._experiments.create(
        circuit=circuit,
        circuit_hash=chash,
        backend=backend,
        mode=mode,
        shots=shots,
        result_id=request.result_id,
        lesson_id=request.lesson_id,
        challenge_id=request.challenge_id,
        title=request.title,
    )
    hook_experiment_shared(x_qentor_learner, saved.experiment_id)
    return ExperimentCreateResponse(experiment_id=saved.experiment_id, path=f"/shared/{saved.experiment_id}", created_at=saved.created_at)


@router.get("/experiments/{experiment_id}", response_model=SharedExperimentResponse)
def get_experiment(experiment_id: str) -> SharedExperimentResponse:
    """The read-only public view of a shared experiment."""
    app_module = _app()
    saved = app_module._experiments.get(experiment_id) if is_experiment_id(experiment_id) else None
    if saved is None:
        raise _error(404, EXPERIMENT_NOT_FOUND, "No shared experiment has that id.")

    result: ExecuteResponse | None = None
    result_note = "This experiment was shared without a result. Fork it into your Lab and run it to see what the backend computes."
    if saved.result_id is not None:
        record = app_module._store.get(saved.result_id)
        if record is None or record.circuit_hash != saved.circuit_hash or record.verification_status is not ExecutionStatus.STATE_CHECKED:
            result_note = "The run this experiment pointed to is no longer available, so no result is shown. Fork it into your Lab and run it again."
        else:
            result = ExecuteResponse(
                result_id=record.result_id,
                circuit_hash=record.circuit_hash,
                backend=record.backend,
                backend_version=record.backend_version,
                execution_mode=record.execution_mode,
                provenance_class=record.provenance_class.value,
                verification_status=record.verification_status.value,
                created_at=record.created_at,
                payload=record.payload,
                qubit_states=final_state_qubit_states(record, saved.circuit),
            )
            result_note = (
                "The result shown is the stored record of one run of this circuit, with its provenance. The per-qubit spheres, where it has a state, are "
                "derived by the server from that record. For a step-by-step trace, fork it into your Lab and run one."
            )
    lesson = get_lesson(saved.lesson_id) if saved.lesson_id else None
    challenge = get_challenge(saved.challenge_id) if saved.challenge_id else None
    return SharedExperimentResponse(
        experiment_id=saved.experiment_id,
        created_at=saved.created_at,
        title=saved.title,
        note=READ_ONLY_NOTE,
        circuit_hash=saved.circuit_hash,
        circuit=saved.circuit,
        qasm=to_qasm3(saved.circuit),
        generator=f"qentor.codegen/{CODEGEN_VERSION}",
        code=generate_all(saved.circuit),
        backend=saved.backend,
        mode=saved.mode,
        shots=saved.shots,
        lesson=NamedRef(id=lesson.id, title=lesson.title) if lesson else None,
        challenge=NamedRef(id=challenge.id, title=challenge.title) if challenge else None,
        result=result,
        result_note=result_note,
    )
