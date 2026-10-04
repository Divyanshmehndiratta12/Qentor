"""``GET /api/noise/models`` and ``POST /api/noise/compare``: the Noise Lab, an ideal-versus-noisy comparison of ONE circuit.

The server runs the circuit twice on Qiskit Aer, once ideally and once under a named noise model (``qentor.execution.noise``), stores each
run as an ordinary provenance record (the noisy one says ``noisy_shots`` and carries the model, the strength and the seed), compares the two
count tables (``qentor.verification.noise_compare``) and stores that comparison as one more record. The request carries a circuit and the
learner's choices (model, strength, shots, an optional seed) and nothing that could be a result: there is no field for a count, a
probability, a distance or a verdict, and an unknown field is refused. Every number in the response comes from the simulator or from
arithmetic on its counts, and every one is wrapped with the provenance of the record it was read from.

The Noise Lab is an Aer simulation feature. Another backend is refused, not emulated, and no result of any kind is labelled hardware.

Structured errors (``detail = {"code", "message", ...}``): 422 for a model, strength, seed, shot count, qubit count or circuit outside
what is run (or a circuit with no measurement); 502 when a backend's output fails the state check; 503 when Aer is unavailable; 400 when the
simulator itself fails.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionResult
from qentor.execution.limits import MAX_OPERATIONS
from qentor.execution.noise import (
    NOISE_MAX_QUBITS,
    NOISE_MAX_SHOTS,
    NOISE_MODEL_SPECS,
    NOISE_SIMULATION_METHOD,
    NoiseConfig,
    NoiseError,
    SEED_MAX,
    check_noise_limits,
    make_noise_config,
    run_noisy_shots,
)
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.verification.noise_compare import (
    METHOD as COMPARISON_METHOD,
    NOTE as COMPARISON_NOTE,
    ExplanationLine,
    NoiseComparison,
    NoiseComparisonError,
    NoiseMetrics,
    NoiseOutcomeRow,
    compare_noise,
)

from . import reasoning as reasoning_api
from .schemas import TraceProvenanceResponse

router = APIRouter(prefix="/api/noise")

LABEL = "Simulated noise on Qiskit Aer. Not a real device: no hardware was used and no calibration data."
DEFAULT_SHOTS = 1024

# Every noise model name a request may use. A Literal, so an unknown name is refused by the schema itself.
NoiseModelLiteral = Literal["none", "depolarizing", "bit_flip", "phase_flip", "amplitude_damping", "readout_error"]


# ------------------------------------------------------------------------------------------------ catalog


class NoiseModelInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    label: str
    applies_to: str
    parameter: str
    parameter_description: str
    min_strength: float
    max_strength: float
    default_strength: float
    step: float
    summary: str
    how_applied: str
    expect: list[str]


class NoiseLimits(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_qubits: int
    max_shots: int
    max_operations: int
    default_shots: int
    max_seed: int
    simulation_method: str


class NoiseModelsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    backend: str
    models: list[NoiseModelInfo]
    limits: NoiseLimits


@router.get("/models", response_model=NoiseModelsResponse)
def noise_models() -> NoiseModelsResponse:
    """The closed set of noise models, with each one's range and what it means: the browser draws its controls from this, never from its own copy."""
    return NoiseModelsResponse(
        label=LABEL,
        backend="qiskit-aer",
        models=[
            NoiseModelInfo(
                name=spec.name.value,
                label=spec.label,
                applies_to=spec.applies_to,
                parameter=spec.parameter,
                parameter_description=spec.parameter_description,
                min_strength=spec.min_strength,
                max_strength=spec.max_strength,
                default_strength=spec.default_strength,
                step=spec.step,
                summary=spec.summary,
                how_applied=spec.how_applied,
                expect=list(spec.expect),
            )
            for spec in NOISE_MODEL_SPECS.values()
        ],
        limits=NoiseLimits(
            max_qubits=NOISE_MAX_QUBITS,
            max_shots=NOISE_MAX_SHOTS,
            max_operations=MAX_OPERATIONS,
            default_shots=DEFAULT_SHOTS,
            max_seed=SEED_MAX,
            simulation_method=NOISE_SIMULATION_METHOD,
        ),
    )


# ------------------------------------------------------------------------------------------------ compare


class NoiseCompareRequest(BaseModel):
    """A circuit and the learner's choices. Nothing here can carry a result."""

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    noise_model: NoiseModelLiteral = "none"
    # Bounds the schema can state for every model; each model's own range is checked next (structured, with the limit).
    noise_strength: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    shots: int = Field(default=DEFAULT_SHOTS, ge=1, le=NOISE_MAX_SHOTS)
    seed: int | None = Field(default=None, ge=0, le=SEED_MAX)
    # Only Aer simulates noise here. Another name is refused with a structured error rather than rejected as a type error.
    backend: str = "qiskit-aer"


class NoiseInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str
    label: str
    strength: float
    parameter: str
    applies_to: str
    how_applied: str
    simulation_method: str
    seed: int


class RunBlock(BaseModel):
    """One stored run: its counts and sampled frequencies (bitstrings ``q[n-1] ... q[0]``) and the provenance record they were read from."""

    model_config = ConfigDict(extra="forbid")

    provenance: TraceProvenanceResponse
    execution_id: str
    shots: int
    counts: dict[str, int]
    probabilities: dict[str, float]
    # The noise this run was made under; ``None`` for the ideal run.
    noise: NoiseInfo | None = None


class ComparisonBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provenance: TraceProvenanceResponse
    method: str
    rows: list[NoiseOutcomeRow]
    metrics: NoiseMetrics
    explanation: list[ExplanationLine]
    note: str


class NoiseCompareResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    backend: str
    noise: NoiseInfo
    ideal: RunBlock
    noisy: RunBlock | None = None
    comparison: ComparisonBlock | None = None


def _structured(status: int, code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def _noise_http(exc: NoiseError) -> HTTPException:
    return HTTPException(status_code=422, detail=exc.detail())


def _run_block(record: ProvenanceRecord, noise: NoiseInfo | None = None) -> RunBlock:
    payload = record.payload
    return RunBlock(
        provenance=reasoning_api.provenance_of(record),
        execution_id=str(payload.get("execution_id", "")),
        shots=int(payload["shots"]),
        counts={k: int(v) for k, v in payload["counts"].items()},
        probabilities={k: float(v) for k, v in payload["probabilities"].items()},
        noise=noise,
    )


def _ideal_run(deps: reasoning_api.ReasoningDeps, circuit: Circuit, chash: str, shots: int, seed: int) -> ProvenanceRecord:
    adapter = deps.adapters["qiskit-aer"]
    try:
        result: ExecutionResult = adapter.run(circuit, "shots", shots, seed_simulator=seed)  # type: ignore[call-arg]
    except AdapterUnavailable as exc:
        raise _structured(503, "NOISE_BACKEND_UNAVAILABLE", f"Backend 'qiskit-aer' is unavailable in this environment: {exc}") from exc
    except AdapterExecutionError as exc:
        deps.store.insert(
            ProvenanceRecord.new(
                circuit_hash=chash,
                backend=adapter.name,
                backend_version="unknown",
                execution_mode="shots",
                provenance_class=ProvenanceClass.SIMULATION,
                verification_status=ExecutionStatus.ERROR,
                payload={"error": str(exc)},
            )
        )
        raise _structured(400, "NOISE_IDEAL_RUN_FAILED", str(exc)) from exc
    return deps.record_run(result, chash, circuit.num_qubits, shots=shots)


def _noisy_run(deps: reasoning_api.ReasoningDeps, circuit: Circuit, chash: str, shots: int, config: NoiseConfig) -> ProvenanceRecord:
    try:
        result = run_noisy_shots(circuit, shots, config)
    except NoiseError as exc:
        raise _noise_http(exc) from exc
    except AdapterUnavailable as exc:
        raise _structured(503, "NOISE_BACKEND_UNAVAILABLE", f"Backend 'qiskit-aer' is unavailable in this environment: {exc}") from exc
    except AdapterExecutionError as exc:
        deps.store.insert(
            ProvenanceRecord.new(
                circuit_hash=chash,
                backend="qiskit-aer",
                backend_version="unknown",
                execution_mode="noisy_shots",
                provenance_class=ProvenanceClass.SIMULATION,
                verification_status=ExecutionStatus.ERROR,
                payload={"error": str(exc), "noise": config.describe()},
            )
        )
        raise _structured(400, "NOISE_NOISY_RUN_FAILED", str(exc)) from exc
    return deps.record_run(result, chash, circuit.num_qubits, shots=shots)


def _store_comparison(
    deps: reasoning_api.ReasoningDeps, chash: str, config: NoiseConfig, shots: int, ideal: ProvenanceRecord, noisy: ProvenanceRecord, comparison: NoiseComparison
) -> ProvenanceRecord:
    """The comparison as one record that names both runs and holds every number and sentence of it, so it can be read back by id."""
    key = hashlib.sha256(json.dumps([chash, config.describe(), shots], sort_keys=True).encode()).hexdigest()
    record = ProvenanceRecord.new(
        circuit_hash=f"noise_{key}",
        backend="noise-comparison",
        backend_version=COMPARISON_METHOD,
        execution_mode="noise_comparison",
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.STATE_CHECKED,
        payload={
            "method": COMPARISON_METHOD,
            "circuit_hash": chash,
            "shots": shots,
            "noise": config.describe(),
            "ideal_result_id": ideal.result_id,
            "noisy_result_id": noisy.result_id,
            "rows": [r.model_dump(mode="json") for r in comparison.rows],
            "metrics": comparison.metrics.model_dump(mode="json"),
            "explanation": [line.model_dump(mode="json") for line in comparison.explanation],
        },
    )
    deps.store.insert(record)
    return record


@router.post("/compare", response_model=NoiseCompareResponse)
def compare_endpoint(request: NoiseCompareRequest) -> NoiseCompareResponse:
    """Run the circuit ideally and, for a noise model other than ``none``, under that model; compare the two."""
    if request.backend != "qiskit-aer":
        raise _structured(
            422,
            "NOISE_BACKEND_UNSUPPORTED",
            f"the Noise Lab simulates noise on Qiskit Aer only; {request.backend!r} has no noisy mode here and nothing was run or substituted",
        )
    deps = reasoning_api.deps()
    try:
        config = make_noise_config(request.noise_model, request.noise_strength, request.seed)
        check_noise_limits(request.circuit, request.shots)
    except NoiseError as exc:
        raise _noise_http(exc) from exc
    # The ordinary request limits (operations, supported gates) apply to the ideal run exactly as they do to /api/execute.
    deps.enforce_limits(request.circuit, "qiskit-aer", shots=request.shots)

    chash = circuit_hash(request.circuit)
    ideal_record = _ideal_run(deps, request.circuit, chash, request.shots, config.seed)
    noise_info = NoiseInfo(**config.describe())
    ideal_block = _run_block(ideal_record)
    if not config.is_noisy:
        return NoiseCompareResponse(label=LABEL, backend="qiskit-aer", noise=noise_info, ideal=ideal_block)

    noisy_record = _noisy_run(deps, request.circuit, chash, request.shots, config)
    try:
        comparison = compare_noise(ideal_record.payload["counts"], noisy_record.payload["counts"], request.shots, config)
    except NoiseComparisonError as exc:  # two runs that disagree about their shots: refuse, never repair
        raise _structured(502, "NOISE_COMPARISON_INCONSISTENT", str(exc)) from exc
    comparison_record = _store_comparison(deps, chash, config, request.shots, ideal_record, noisy_record, comparison)
    return NoiseCompareResponse(
        label=LABEL,
        backend="qiskit-aer",
        noise=noise_info,
        ideal=ideal_block,
        noisy=_run_block(noisy_record, noise_info),
        comparison=ComparisonBlock(
            provenance=reasoning_api.provenance_of(comparison_record),
            method=comparison.method,
            rows=comparison.rows,
            metrics=comparison.metrics,
            explanation=comparison.explanation,
            note=COMPARISON_NOTE,
        ),
    )
