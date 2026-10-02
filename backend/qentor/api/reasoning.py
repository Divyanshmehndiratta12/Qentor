"""``POST /api/reasoning/analyze`` and ``POST /api/reasoning/what-if/preview``: the quantum reasoning engine over HTTP.

This module is the only place that connects the engine (``qentor.reasoning``, which computes) to the provenance log (which this
layer reads and writes) and to the tutor (which reads each analysis back as ``R#`` facts and words the answer). The pieces:

* the request models: a discriminated union on ``intent``, every one ``extra="forbid"`` and with no field that could carry a
  probability, an expected optimisation, a counterfactual circuit or a comparison result, so none can arrive from a client;
* ``ReasoningDeps``: what this layer needs from ``qentor.api.app`` (the store, the adapters, the run recorder, the limit checks, the
  trace-step and comparison helpers). It is resolved per request, so a test that swaps ``app._store`` is honoured;
* one function per intent that fetches and checks the records the engine needs, calls the engine and stores the analysis as one more
  provenance record (``backend = reasoning-engine``), which is what the tutor reads its facts from.

Errors are structured (``detail = {"code", "message"}``): 404 for a record that does not exist, 409 ``REASONING_STALE_CIRCUIT`` for a
circuit that is not the one a preview or a result was made for, 422 for everything the engine refuses, 502/503 from the backend.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Callable, Literal, Union

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionAdapter, ExecutionResult
from qentor.execution.limits import LimitExceeded, check_equivalence_limits
from qentor.provenance.attempts import AttemptStore
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.provenance.store import ProvenanceStore
from qentor.reasoning import (
    METHOD,
    REASONING_BACKEND,
    REASONING_MODE,
    Analysis,
    Intent,
    Modification,
    ProbabilityTarget,
    ReasoningError,
    Source,
    WhatIfPreview,
    analyze_debug,
    analyze_optimization,
    analyze_probability,
    analyze_trace_change,
    analyze_what_if,
    preview_what_if,
    source_of,
)
from qentor.reasoning.whatif import WhatIfRejected
from qentor.tutor.llm import LLMAdapter
from qentor.tutor.models import TutorFact
from qentor.tutor.reasoning_facts import answer_reasoning, build_reasoning_facts
from qentor.tutor.trace_context import TraceStepRef

from .schemas import DebugRequest, DebugResponse, TraceProvenanceResponse, TutorFactResponse

router = APIRouter(prefix="/api/reasoning")

Backend = Literal["qiskit-aer", "cirq", "pennylane"]
Language = Literal["en", "hi", "kn"]


# ---------------------------------------------------------------------------------------------------- requests


class _Base(BaseModel):
    """What every analysis request carries. ``expected_circuit_hash`` is the hash the client was SHOWN for ``circuit``; the server
    compares it with the hash it computes and refuses (409) on a difference. It is a staleness token, never a value to believe."""

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    backend: Backend = "qiskit-aer"
    language: Language = "en"
    question: str | None = Field(default=None, min_length=1, max_length=400)
    expected_circuit_hash: str | None = Field(default=None, min_length=64, max_length=64)


class ProbabilityRequest(_Base):
    intent: Literal["PROBABILITY"] = "PROBABILITY"
    result_id: str = Field(min_length=1)
    target: ProbabilityTarget


class OptimizeRequest(_Base):
    intent: Literal["OPTIMIZE"] = "OPTIMIZE"


class WhatIfRequest(_Base):
    intent: Literal["WHAT_IF"] = "WHAT_IF"
    modification: Modification
    # The hash of the counterfactual the learner was shown in the preview; the server builds it again and compares.
    counterfactual_circuit_hash: str | None = Field(default=None, min_length=64, max_length=64)


class TraceChangeRequest(_Base):
    intent: Literal["TRACE_CHANGE"] = "TRACE_CHANGE"
    trace_step: TraceStepRef


class CompareRequest(_Base):
    intent: Literal["COMPARE"] = "COMPARE"
    circuit_b: Circuit
    result_id_a: str = Field(min_length=1)
    result_id_b: str = Field(min_length=1)


class DebugAnalysisRequest(_Base):
    intent: Literal["DEBUG"] = "DEBUG"
    result_id: str = Field(min_length=1)
    goal: str | None = Field(default=None, max_length=400)
    challenge_id: str | None = Field(default=None, min_length=1)
    attempt_id: str | None = Field(default=None, min_length=1)
    trace_step: TraceStepRef | None = None

    @model_validator(mode="after")
    def _coherent(self) -> "DebugAnalysisRequest":
        if (self.challenge_id is None) != (self.attempt_id is None):
            raise ValueError("challenge_id and attempt_id must be provided together")
        return self


AnalyzeRequest = Annotated[
    Union[ProbabilityRequest, OptimizeRequest, WhatIfRequest, TraceChangeRequest, CompareRequest, DebugAnalysisRequest],
    Field(discriminator="intent"),
]


class WhatIfPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    modification: Modification


class AnalysisResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analysis_id: str
    intent: str
    status: str
    reason: str | None
    method: str
    circuit_hash: str
    sources: list[Source]
    provenance: TraceProvenanceResponse
    data: dict[str, Any]
    facts: list[TutorFactResponse]
    answer: str
    used_fallback_template: bool
    # DEBUG only: the deterministic debugger's report, which was given this analysis's evidence.
    debug: DebugResponse | None = None


# ------------------------------------------------------------------------------------------------------ deps


@dataclass
class ReasoningDeps:
    store: ProvenanceStore
    adapters: dict[str, ExecutionAdapter]
    attempts: AttemptStore
    llm: LLMAdapter | None
    # (result, circuit hash, num_qubits) -> the persisted record; raises HTTPException 502 on a malformed result.
    record_run: Callable[..., ProvenanceRecord]
    # (circuit, backend) -> None, or HTTPException 422 over a size limit / unsupported gate.
    enforce_limits: Callable[..., None]
    verified_trace_context: Callable[..., Any]
    compare_runs: Callable[..., tuple[ProvenanceRecord, ProvenanceRecord, ProvenanceRecord]]
    run_debug: Callable[[DebugRequest], DebugResponse]


_deps_factory: Callable[[], ReasoningDeps] | None = None


def configure(factory: Callable[[], ReasoningDeps]) -> None:
    """Called once by ``qentor.api.app``: the factory reads the app's current module globals each time it is called."""
    global _deps_factory
    _deps_factory = factory


def deps() -> ReasoningDeps:
    if _deps_factory is None:  # pragma: no cover - app.py configures this at import
        raise RuntimeError("the reasoning API is not configured")
    return _deps_factory()


# ----------------------------------------------------------------------------------------------- helpers


def _http(exc: ReasoningError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail())


def _structured(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def check_fresh(circuit: Circuit, expected: str | None) -> str:
    """The circuit's hash, after refusing a request whose ``expected_circuit_hash`` is not it."""
    actual = circuit_hash(circuit)
    if expected is not None and expected != actual:
        raise _structured(
            409,
            "REASONING_STALE_CIRCUIT",
            "the circuit sent is not the one this request was made for (its hash differs from the one shown); refresh and ask again",
        )
    return actual


def make_runner(d: ReasoningDeps, backend: str) -> Callable[[Circuit], ProvenanceRecord]:
    """A statevector run of a circuit on ``backend``, persisted like any run. Limits first; a backend that cannot run is reported as
    such (503), never replaced."""
    adapter = d.adapters[backend]

    def run(circuit: Circuit) -> ProvenanceRecord:
        d.enforce_limits(circuit, backend)
        try:
            result = adapter.run(circuit, "statevector")
        except AdapterUnavailable as exc:
            raise _structured(503, "REASONING_BACKEND_UNAVAILABLE", f"Backend '{adapter.name}' is unavailable in this environment: {exc}") from exc
        except AdapterExecutionError as exc:
            raise _structured(400, "REASONING_BACKEND_EXECUTION_FAILED", str(exc)) from exc
        return d.record_run(result, circuit_hash(circuit), circuit.num_qubits)

    return run


def load_run(d: ReasoningDeps, result_id: str, circuit: Circuit) -> ProvenanceRecord:
    """A run to analyse: it exists and is of THIS circuit. (The engine checks that it is usable and a simulation.)"""
    record = d.store.get(result_id)
    if record is None:
        raise _structured(404, "REASONING_RESULT_NOT_FOUND", f"no provenance record found for result_id '{result_id}'")
    if record.circuit_hash != circuit_hash(circuit):
        raise _structured(
            422,
            "REASONING_RESULT_CIRCUIT_MISMATCH",
            f"circuit does not match provenance record '{result_id}': got circuit hash '{circuit_hash(circuit)}', expected '{record.circuit_hash}'",
        )
    return record


def store_analysis(d: ReasoningDeps, analysis: Analysis) -> ProvenanceRecord:
    """One analysis is one provenance record: what the tutor is later asked about, and what its facts are read from."""
    usable = all(s.verification_status == ExecutionStatus.STATE_CHECKED.value for s in analysis.sources)
    record = ProvenanceRecord.new(
        circuit_hash=analysis.circuit_hash,
        backend=REASONING_BACKEND,
        backend_version=METHOD,
        execution_mode=REASONING_MODE,
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.STATE_CHECKED if usable else ExecutionStatus.FAILED,
        payload=analysis.model_dump(mode="json"),
    )
    d.store.insert(record)
    return record


def provenance_of(record: ProvenanceRecord) -> TraceProvenanceResponse:
    return TraceProvenanceResponse(
        result_id=record.result_id,
        circuit_hash=record.circuit_hash,
        backend=record.backend,
        backend_version=record.backend_version,
        execution_mode=record.execution_mode,
        provenance_class=record.provenance_class.value,
        verification_status=record.verification_status.value,
        created_at=record.created_at,
    )


# ----------------------------------------------------------------------------------------- per intent


def probability(d: ReasoningDeps, circuit: Circuit, result_id: str, target: ProbabilityTarget, backend: str, expected: str | None = None) -> ProvenanceRecord:
    check_fresh(circuit, expected)
    record = load_run(d, result_id, circuit)
    # The theoretical values of a shots run are taken on the backend that made it, when it is one we can run.
    run_backend = record.backend if record.backend in d.adapters else backend
    try:
        analysis = analyze_probability(circuit, record, target, runner=make_runner(d, run_backend))
    except ReasoningError as exc:
        raise _http(exc) from exc
    return store_analysis(d, analysis)


def optimization_analysis(d: ReasoningDeps, circuit: Circuit, backend: str) -> Analysis:
    d.enforce_limits(circuit, backend)
    try:
        check_equivalence_limits(circuit.num_qubits, len(circuit.ops))
    except LimitExceeded as exc:
        raise HTTPException(status_code=422, detail=exc.detail()) from exc
    adapter = d.adapters[backend]

    def record_execution(result: ExecutionResult, candidate_hash: str) -> str:
        return d.record_run(result, candidate_hash, circuit.num_qubits).result_id

    try:
        return analyze_optimization(circuit, adapter=adapter, record_execution=record_execution, get_record=d.store.get)
    except ReasoningError as exc:
        raise _http(exc) from exc


def optimize(d: ReasoningDeps, circuit: Circuit, backend: str, expected: str | None = None) -> ProvenanceRecord:
    check_fresh(circuit, expected)
    return store_analysis(d, optimization_analysis(d, circuit, backend))


def what_if(
    d: ReasoningDeps,
    circuit: Circuit,
    modification: Modification,
    backend: str,
    expected: str | None = None,
    expected_counterfactual: str | None = None,
) -> ProvenanceRecord:
    try:
        analysis, _ = analyze_what_if(
            circuit,
            modification,
            runner=make_runner(d, backend),
            expected_original_hash=expected,
            expected_counterfactual_hash=expected_counterfactual,
        )
    except ReasoningError as exc:
        raise _http(exc) from exc
    return store_analysis(d, analysis)


def trace_change(d: ReasoningDeps, circuit: Circuit, ref: TraceStepRef, expected: str | None = None) -> ProvenanceRecord:
    chash = check_fresh(circuit, expected)
    # The identity is verified against the circuit and the records the server holds, exactly as for the tutor and the debugger.
    d.verified_trace_context(ref, circuit)
    record = d.store.get(ref.result_id)
    previous = d.store.get(ref.previous_result_id) if ref.previous_result_id is not None else None
    if record is None:  # pragma: no cover - verified_trace_context already refused a missing record
        raise _structured(404, "REASONING_RESULT_NOT_FOUND", f"no provenance record found for result_id '{ref.result_id}'")
    try:
        analysis = analyze_trace_change(circuit, ref.step_index, record, previous, chash)
    except ReasoningError as exc:
        raise _http(exc) from exc
    return store_analysis(d, analysis)


def compare(d: ReasoningDeps, circuit_a: Circuit, result_id_a: str, circuit_b: Circuit, result_id_b: str, expected: str | None = None) -> ProvenanceRecord:
    check_fresh(circuit_a, expected)
    comparison_record, rec_a, rec_b = d.compare_runs(circuit_a, result_id_a, circuit_b, result_id_b)
    data = dict(comparison_record.payload)
    data["comparison_id"] = comparison_record.result_id
    analysis = Analysis(
        intent=Intent.COMPARE,
        status="OK",
        circuit_hash=circuit_hash(circuit_a),
        sources=[source_of("run_a", rec_a), source_of("run_b", rec_b)],
        data=data,
    )
    return store_analysis(d, analysis)


def debug_analysis(d: ReasoningDeps, circuit: Circuit, record: ProvenanceRecord, backend: str) -> Analysis:
    """The structured evidence the debugger is given about one executed run (see ``qentor.reasoning.debug``)."""
    optimization = optimization_analysis(d, circuit, backend)
    run_backend = record.backend if record.backend in d.adapters else backend
    try:
        return analyze_debug(circuit, record, runner=make_runner(d, run_backend), optimization=optimization)
    except ReasoningError as exc:
        raise _http(exc) from exc


# --------------------------------------------------------------------------------------------- response


def facts_of(record: ProvenanceRecord) -> list[TutorFact]:
    return build_reasoning_facts(record)


def respond(d: ReasoningDeps, record: ProvenanceRecord, question: str | None, language: str, debug: DebugResponse | None = None) -> AnalysisResponse:
    facts = facts_of(record)
    answer, fallback = answer_reasoning(question or "", record, facts, d.llm, language)
    payload = record.payload
    return AnalysisResponse(
        analysis_id=record.result_id,
        intent=payload["intent"],
        status=payload["status"],
        reason=payload.get("reason"),
        method=payload["method"],
        circuit_hash=payload["circuit_hash"],
        sources=[Source.model_validate(s) for s in payload["sources"]],
        provenance=provenance_of(record),
        data=payload["data"],
        facts=[TutorFactResponse(id=f.id, kind=f.kind, description=f.description, result_id=f.result_id) for f in facts],
        answer=answer,
        used_fallback_template=fallback,
        debug=debug,
    )


# ------------------------------------------------------------------------------------------------ routes


@router.post("/analyze", response_model=AnalysisResponse)
def analyze_endpoint(request: AnalyzeRequest) -> AnalysisResponse:
    """Run one reasoning intent on the server. The response carries the structured analysis (``data``), the backend runs it rests on
    (``sources``), the analysis record's own provenance, the ``R#`` facts and an answer worded from them (deterministic, or a model's
    after the claim guard). Nothing in the request is a result."""
    d = deps()
    if isinstance(request, ProbabilityRequest):
        record = probability(d, request.circuit, request.result_id, request.target, request.backend, request.expected_circuit_hash)
        return respond(d, record, request.question, request.language)
    if isinstance(request, OptimizeRequest):
        record = optimize(d, request.circuit, request.backend, request.expected_circuit_hash)
        return respond(d, record, request.question, request.language)
    if isinstance(request, WhatIfRequest):
        record = what_if(
            d, request.circuit, request.modification, request.backend, request.expected_circuit_hash, request.counterfactual_circuit_hash
        )
        return respond(d, record, request.question, request.language)
    if isinstance(request, TraceChangeRequest):
        record = trace_change(d, request.circuit, request.trace_step, request.expected_circuit_hash)
        return respond(d, record, request.question, request.language)
    if isinstance(request, CompareRequest):
        record = compare(d, request.circuit, request.result_id_a, request.circuit_b, request.result_id_b, request.expected_circuit_hash)
        return respond(d, record, request.question, request.language)

    # DEBUG: the deterministic debugger, given this analysis's evidence (see ``qentor.api.app.debug_endpoint``).
    check_fresh(request.circuit, request.expected_circuit_hash)
    report = d.run_debug(
        DebugRequest(
            circuit=request.circuit,
            result_id=request.result_id,
            challenge_id=request.challenge_id,
            attempt_id=request.attempt_id,
            trace_step=request.trace_step,
            goal=request.goal,
            language=request.language,
        )
    )
    if report.analysis_id is None:
        raise _structured(
            422, "REASONING_DEBUG_EVIDENCE_UNAVAILABLE", "the debugger ran, but the reasoning engine could not gather evidence for this circuit"
        )
    record = d.store.get(report.analysis_id)
    assert record is not None
    return respond(d, record, request.question, request.language, debug=report)


@router.post("/what-if/preview", response_model=WhatIfPreview)
def what_if_preview_endpoint(request: WhatIfPreviewRequest) -> WhatIfPreview:
    """The counterfactual circuit the server would build for one modification, shown BEFORE anything runs. Nothing is executed and
    nothing is stored: it is the same construction ``analyze`` repeats (and compares by hash) when the learner confirms."""
    try:
        return preview_what_if(request.circuit, request.modification)
    except WhatIfRejected as exc:
        raise _http(exc) from exc
    except ReasoningError as exc:  # pragma: no cover - the preview raises only WhatIfRejected
        raise _http(exc) from exc
