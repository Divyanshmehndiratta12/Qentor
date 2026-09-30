"""FastAPI app — POST /api/execute, POST /api/execute/trace, POST /api/verify/bell-state,
POST /api/tutor, POST /api/test/multi-input, POST /api/optimize and
GET /api/lessons.

This module imports ``circuit``, ``execution``, ``provenance``, ``storage``,
``verification`` and ``tutor`` — exactly the ``api -> tutor -> verification ->
execution -> circuit`` chain in docs/ARCHITECTURE.md §1. Only this module ever
calls ``ProvenanceStore.get``/``insert``: ``qentor.tutor`` (like
``qentor.verification``) takes an already-fetched ``ProvenanceRecord`` as a
plain argument and never imports the store itself — see
backend/tests/test_architecture_rule.py.

``ExecuteRequest.backend`` selects which ``ExecutionAdapter`` runs the
circuit (Qiskit Aer by default, or Cirq/PennyLane); every one builds its
native circuit from the same canonical ``Circuit`` model and returns a
``qentor.execution.adapter.ExecutionResult`` in the same q[n-1]...q[0]
bit-order convention, so results from different adapters for the same
circuit are directly comparable.

The tutor's optional LLM layer (``qentor.tutor.llm``/``config``) only ever
runs here, server-side, and is built once at startup from environment
variables (see backend/.env.example) — a browser can never reach it directly,
and with no key configured this process behaves exactly as it did before the
LLM layer existed.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from qentor.circuit.hashing import circuit_hash
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionResult
from qentor.execution.aer import AerAdapter
from qentor.execution.capabilities import UnsupportedGate, check_gate_support
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.limits import LimitExceeded, check_equivalence_limits, check_run_limits
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.execution.sanity import state_problems
from qentor.execution.trace import TraceBackendFault, TraceNotSupported, trace_circuit
from qentor.lessons import LESSONS
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.provenance.store import ProvenanceStore
from qentor.tutor import (
    LessonContextError,
    TraceContextError,
    answer_failed_execution,
    answer_lesson_aware_question,
    answer_question_with_llm,
    answer_step_aware_question,
    build_default_llm_adapter,
    build_fact_sheet,
    build_trace_step_context,
    resolve_lesson_context,
)
from qentor.tutor.trace_context import TRACE_RESULT_NOT_FOUND
from qentor.tutor.lesson_context import LESSON_NOT_FOUND, SECTION_MISMATCH, SECTION_NOT_FOUND
from qentor.verification.bell_state import verify_bell_state
from qentor.verification.multi_input_harness import (
    MAX_SWEEP_QUBITS,
    MAX_TEST_CASES,
    HarnessValidationError,
    TestCaseSpec,
    run_multi_input_test,
)
from qentor.verification.optimizer import optimize_circuit

from .schemas import (
    ExecuteRequest,
    ExecuteResponse,
    LessonCatalogResponse,
    MultiInputCaseResponse,
    MultiInputCounterexampleResponse,
    MultiInputTestRequest,
    MultiInputTestResponse,
    OptimizeEquivalenceCheckResponse,
    OptimizeEquivalenceResponse,
    OptimizeRequest,
    OptimizeResponse,
    TraceProvenanceResponse,
    TraceRequest,
    TraceResponse,
    TraceStepResponse,
    TraceTerminalMeasurementResponse,
    TutorFactResponse,
    TutorRequest,
    TutorResponse,
    TutorTraceStepResponse,
    VerificationCheckResponse,
    VerifyBellStateRequest,
    VerifyBellStateResponse,
)

app = FastAPI(title="Qentor backend", version="0.1.0")

_adapter = AerAdapter()
# Keyed by each adapter's own `.name`, matching ExecuteRequest.backend's
# Literal values exactly. _adapter (Aer) stays the untouched default so a
# request that never specifies `backend` behaves exactly as before this
# registry existed.
_adapters = {
    _adapter.name: _adapter,
    CirqAdapter.name: CirqAdapter(),
    PennyLaneAdapter.name: PennyLaneAdapter(),
}
_store = ProvenanceStore()
# None unless QENTOR_TUTOR_LLM_ENABLED and an API key are both set in the
# server's own environment (qentor.tutor.config) — read once at process
# startup, like _adapter/_store above. See backend/.env.example.
_llm_adapter = build_default_llm_adapter()

# HTTP status for each structured tutor lesson-context error code
# (qentor.tutor.lesson_context). A missing lesson/section is 404; a section id
# that exists but belongs to another lesson is a 422 conflict in the request.
_LESSON_ERROR_STATUS = {LESSON_NOT_FOUND: 404, SECTION_NOT_FOUND: 404, SECTION_MISMATCH: 422}

EXECUTION_STATE_INVALID = "EXECUTION_STATE_INVALID"


def _limit_http_error(exc: LimitExceeded) -> HTTPException:
    """A request over a platform limit (``qentor.execution.limits``): 422 with the
    stable code and the numbers, before any backend allocates anything."""
    return HTTPException(status_code=422, detail=exc.detail())


def _enforce_run_limits(circuit, backend: str, *, shots: int | None = None) -> None:
    """Refuse, before any backend runs, a request over a size limit or using a gate the
    chosen backend cannot run (422, structured)."""
    try:
        check_run_limits(circuit, backend, shots=shots)
        check_gate_support(circuit, backend)
    except LimitExceeded as exc:
        raise _limit_http_error(exc) from exc
    except UnsupportedGate as exc:
        raise HTTPException(status_code=422, detail=exc.detail()) from exc


def _record_run(
    result: ExecutionResult,
    circuit_hash_: str,
    num_qubits: int,
    *,
    shots: int | None = None,
) -> ProvenanceRecord:
    """Persist one successful backend run, after the state sanity check.

    ``STATE_CHECKED`` means the backend's output is well-formed (unit norm,
    probabilities and counts that add up) - it is NOT a claim about the circuit.
    A result that fails the check is stored as ``FAILED`` with the reasons and
    none of its numbers, and the request is refused with 502: a malformed state is
    never shown, explained or built on.
    """
    problems = state_problems(result, num_qubits, shots=shots)
    if problems:
        _store.insert(
            ProvenanceRecord.new(
                circuit_hash=circuit_hash_,
                backend=result.backend_name,
                backend_version=result.backend_version,
                execution_mode=result.execution_mode,
                provenance_class=ProvenanceClass.SIMULATION,
                verification_status=ExecutionStatus.FAILED,
                payload={"error": "; ".join(problems), "code": EXECUTION_STATE_INVALID},
            )
        )
        raise HTTPException(
            status_code=502,
            detail={
                "code": EXECUTION_STATE_INVALID,
                "message": f"backend {result.backend_name!r} returned a result that failed the state check: {'; '.join(problems)}",
            },
        )
    record = ProvenanceRecord.new(
        circuit_hash=circuit_hash_,
        backend=result.backend_name,
        backend_version=result.backend_version,
        execution_mode=result.execution_mode,
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.STATE_CHECKED,
        payload=result.to_payload(),
    )
    _store.insert(record)
    return record


@app.post("/api/execute", response_model=ExecuteResponse)
def execute(request: ExecuteRequest) -> ExecuteResponse:
    _enforce_run_limits(request.circuit, request.backend, shots=request.shots)
    chash = circuit_hash(request.circuit)
    adapter = _adapters[request.backend]

    try:
        result = adapter.run(request.circuit, request.mode, request.shots)
    except AdapterUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Backend '{adapter.name}' is unavailable in this environment: {exc}",
        ) from exc
    except AdapterExecutionError as exc:
        record = ProvenanceRecord.new(
            circuit_hash=chash,
            backend=adapter.name,
            backend_version="unknown",
            execution_mode=request.mode,
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.ERROR,
            payload={"error": str(exc)},
        )
        _store.insert(record)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    record = _record_run(
        result,
        chash,
        request.circuit.num_qubits,
        shots=request.shots if request.mode == "shots" else None,
    )

    return ExecuteResponse(
        result_id=record.result_id,
        circuit_hash=record.circuit_hash,
        backend=record.backend,
        backend_version=record.backend_version,
        execution_mode=record.execution_mode,
        provenance_class=record.provenance_class.value,
        verification_status=record.verification_status.value,
        created_at=record.created_at,
        payload=record.payload,
    )


@app.post("/api/execute/trace", response_model=TraceResponse)
def execute_trace(request: TraceRequest) -> TraceResponse:
    """The backend's own state after each operation (``qentor.execution.trace``).

    Not a second simulator: every step is an ordinary statevector-mode
    ``adapter.run`` of the circuit truncated after that operation, persisted
    as an ordinary provenance record (so each step's ``result_id`` resolves
    like any ``/api/execute`` result, with its own prefix ``circuit_hash``).
    "Read-only" with respect to the client's state — it accepts no
    amplitude/probability/verdict — but like ``/api/execute`` it does append
    provenance rows.

    Size limits come from what the backend already enforces for exhaustive
    statevector work (the multi-input harness's ``MAX_SWEEP_QUBITS`` qubits
    and ``MAX_TEST_CASES`` runs per request), not a new rule: one run per
    operation plus the initial state must fit in that run budget.

    Anything that can't be traced comes back as a structured error
    (``detail = {"code": ..., "message": ...}``) and never as substitute
    data: 422 for a request that can't be traced (shots mode, a measurement
    followed by gates, too large), 502 if the backend returned an unusable
    state, 503 if it is unavailable, 400 if the run itself failed.
    """
    adapter = _adapters[request.backend]
    # Backend and operation limits first (the trace keeps its own, tighter,
    # qubit limit and reports it with its own code).
    _enforce_run_limits(request.circuit, request.backend)
    chash = circuit_hash(request.circuit)
    records: dict[str, ProvenanceRecord] = {}

    def record_execution(result: ExecutionResult, prefix_hash: str) -> str:
        # The trace layer has already required a real, normalised statevector
        # (docs/VERIFICATION_ARCHITECTURE.md §4.1) before calling this; the same
        # state check is applied here so a trace step means exactly what an
        # /api/execute result means: STATE_CHECKED - the backend ran and returned a
        # well-formed state, not a claim about the circuit.
        record = _record_run(result, prefix_hash, request.circuit.num_qubits)
        records[record.result_id] = record
        return record.result_id

    def error(status_code: int, code: str, message: str) -> HTTPException:
        return HTTPException(status_code=status_code, detail={"code": code, "message": message})

    def log_error(error_hash: str, code: str, message: str) -> None:
        _store.insert(
            ProvenanceRecord.new(
                circuit_hash=error_hash,
                backend=adapter.name,
                backend_version="unknown",
                execution_mode="statevector",
                provenance_class=ProvenanceClass.SIMULATION,
                verification_status=ExecutionStatus.ERROR,
                payload={"error": message, "code": code},
            )
        )

    try:
        trace = trace_circuit(
            request.circuit,
            adapter,
            mode=request.mode,
            max_qubits=MAX_SWEEP_QUBITS,
            max_operations=MAX_TEST_CASES - 1,
            record_execution=record_execution,
        )
    except TraceNotSupported as exc:
        raise error(422, exc.code, exc.message) from exc
    except TraceBackendFault as exc:
        log_error(exc.circuit_hash, exc.code, exc.message)
        raise error(502, exc.code, exc.message) from exc
    except AdapterUnavailable as exc:
        raise error(
            503,
            "TRACE_BACKEND_UNAVAILABLE",
            f"Backend '{adapter.name}' is unavailable in this environment: {exc}",
        ) from exc
    except AdapterExecutionError as exc:
        log_error(chash, "TRACE_BACKEND_EXECUTION_FAILED", str(exc))
        raise error(400, "TRACE_BACKEND_EXECUTION_FAILED", str(exc)) from exc

    steps = []
    for step in trace.steps:
        record = records[step.result_id]
        steps.append(
            TraceStepResponse(
                step_index=step.step_index,
                operation_index=step.operation_index,
                operation=step.operation,
                execution_id=step.execution_id,
                provenance=TraceProvenanceResponse(
                    result_id=record.result_id,
                    circuit_hash=record.circuit_hash,
                    backend=record.backend,
                    backend_version=record.backend_version,
                    execution_mode=record.execution_mode,
                    provenance_class=record.provenance_class.value,
                    verification_status=record.verification_status.value,
                    created_at=record.created_at,
                ),
                statevector=step.statevector,
                bloch_vector=step.bloch_vector,
            )
        )

    return TraceResponse(
        circuit_hash=trace.circuit_hash,
        traced_circuit_hash=trace.traced_circuit_hash,
        backend=trace.backend,
        backend_version=trace.backend_version,
        num_qubits=trace.num_qubits,
        mode="statevector",
        trace_method=trace.trace_method,
        basis_ordering="statevector index k is the bitstring q[n-1]...q[0] read as a binary number",
        steps=steps,
        terminal_measurements=[
            TraceTerminalMeasurementResponse(operation_index=m.operation_index, operation=m.operation)
            for m in trace.terminal_measurements
        ],
        final_result_id=trace.final_result_id,
    )


@app.post("/api/verify/bell-state", response_model=VerifyBellStateResponse)
def verify_bell_state_endpoint(request: VerifyBellStateRequest) -> VerifyBellStateResponse:
    """Verify an already-executed result against the ideal Bell-state circuit.

    Never re-executes the circuit: the result comes only from the provenance record
    the original ``/api/execute`` call persisted, looked up by ``result_id``. The
    request's ``circuit`` is the learner's own canonical circuit (the same shape
    ``/api/execute`` accepts, never a probability/count/verdict); ``verify_bell_state``
    itself rejects it with an ERROR report if its hash doesn't match the record's.
    """
    record = _store.get(request.result_id)
    if record is None:
        raise HTTPException(
            status_code=404,
            detail=f"no provenance record found for result_id '{request.result_id}'",
        )

    try:
        report = verify_bell_state(request.circuit, record)
    except Exception as exc:  # noqa: BLE001 - surface a malformed/inconsistent record, don't crash
        raise HTTPException(
            status_code=422,
            detail=(
                f"could not verify provenance record '{request.result_id}': "
                f"{type(exc).__name__}: {exc}"
            ),
        ) from exc

    return VerifyBellStateResponse(
        result_id=report.result_id,
        circuit_hash=report.circuit_hash,
        verifier=report.verifier,
        verification_status=report.verification_status.value,
        checks=[
            VerificationCheckResponse(name=c.name, status=c.status.value, detail=c.detail)
            for c in report.checks
        ],
        expected_support=report.expected_support,
        observed_support=report.observed_support,
    )


@app.post("/api/tutor", response_model=TutorResponse)
def tutor_endpoint(request: TutorRequest) -> TutorResponse:
    """Grounded tutor answer — deterministic by default, optionally backed by
    a server-only LLM (see qentor.tutor.answer / qentor.tutor.guard).

    Never re-executes the circuit and never trusts a client-supplied number:
    every fact in the response is built from the persisted provenance record
    named by ``result_id``, looked up once here. A circuit that doesn't match
    that record's own circuit hash is rejected outright, not silently
    explained as if it were the executed one. If an LLM is configured, its
    output only ever reaches the response after ``validate_llm_draft`` confirms
    every cited fact id exists and every number in it is already grounded in
    the fact sheet; anything that fails falls back to the deterministic
    template, exactly as if no LLM were configured at all.

    Optional ``lesson_id``/``section_id`` add lesson context: identifiers only,
    resolved here against the server's own lesson registry
    (``qentor.tutor.lesson_context``). Lesson explanation comes from the
    registry (``L#`` facts); quantum numbers still come only from the
    provenance record (``F#`` facts). A lesson-only request (no ``result_id``)
    is answered from the lesson alone and reports no provenance.
    """
    # Optional lesson context: ids only, resolved against the server's own
    # lesson registry. Resolved first so a bad id fails fast, before any
    # provenance lookup, with a structured error.
    lesson_context = None
    if request.lesson_id is not None:
        try:
            lesson_context = resolve_lesson_context(request.lesson_id, request.section_id)
        except LessonContextError as exc:
            raise HTTPException(
                status_code=_LESSON_ERROR_STATUS[exc.code],
                detail={"code": exc.code, "message": exc.message},
            ) from exc

    record = None
    facts: list = []
    if request.result_id is not None and request.circuit is not None:
        record = _store.get(request.result_id)
        if record is None:
            raise HTTPException(
                status_code=404,
                detail=f"no provenance record found for result_id '{request.result_id}'",
            )

        request_hash = circuit_hash(request.circuit)
        if request_hash != record.circuit_hash:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"circuit does not match provenance record '{request.result_id}': "
                    f"got circuit hash '{request_hash}', expected '{record.circuit_hash}'"
                ),
            )

        facts = build_fact_sheet(request.circuit, record)

    # Optional trace-step context: the step's identity, VERIFIED against the
    # circuit and the records the server itself holds (never believed).
    trace_context = None
    if request.trace_step is not None:
        ref = request.trace_step
        step_record = _store.get(ref.result_id)
        if step_record is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": TRACE_RESULT_NOT_FOUND,
                    "message": f"no provenance record found for the trace step's result_id '{ref.result_id}'",
                },
            )
        previous_record = None
        if ref.previous_result_id is not None:
            previous_record = _store.get(ref.previous_result_id)
            if previous_record is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "code": TRACE_RESULT_NOT_FOUND,
                        "message": f"no provenance record found for the previous step's result_id '{ref.previous_result_id}'",
                    },
                )
        try:
            trace_context = build_trace_step_context(ref, request.circuit, step_record, previous_record)
        except TraceContextError as exc:
            raise HTTPException(
                status_code=422, detail={"code": exc.code, "message": exc.message}
            ) from exc

    if trace_context is not None:
        answer, used_fallback_template = answer_step_aware_question(
            request.question, trace_context, lesson_context, facts, record, _llm_adapter, request.language
        )
    elif lesson_context is not None:
        answer, used_fallback_template = answer_lesson_aware_question(
            request.question, lesson_context, facts, record, _llm_adapter, request.language
        )
    elif record.verification_status != ExecutionStatus.STATE_CHECKED:
        answer, used_fallback_template = answer_failed_execution(record, request.language), True
    else:
        answer, used_fallback_template = answer_question_with_llm(
            request.question, facts, record, _llm_adapter, request.language
        )

    # Result facts first (F#), then trace-step facts (S#), then lesson facts (L#) —
    # the sources stay distinguishable by id and by `result_id` (None for lessons).
    response_facts = [
        *facts,
        *(trace_context.facts if trace_context else []),
        *(lesson_context.facts if lesson_context else []),
    ]

    # Top-level provenance: the Lab result if there is one; otherwise, for a
    # step-only question, the step's own record. `trace_step` always carries the
    # step's provenance separately.
    provenance = record or trace_context
    return TutorResponse(
        answer=answer,
        result_id=provenance.result_id if provenance else None,
        circuit_hash=provenance.circuit_hash if provenance else None,
        provenance_class=(
            record.provenance_class.value if record else (trace_context.provenance_class if trace_context else None)
        ),
        verification_status=(
            record.verification_status.value if record else (trace_context.verification_status if trace_context else None)
        ),
        used_fallback_template=used_fallback_template,
        facts=[
            TutorFactResponse(id=f.id, kind=f.kind, description=f.description, result_id=f.result_id)
            for f in response_facts
        ],
        lesson_id=lesson_context.lesson_id if lesson_context else None,
        section_id=lesson_context.section_id if lesson_context else None,
        trace_step=(
            TutorTraceStepResponse(
                step_index=trace_context.step_index,
                step_number=trace_context.step_index + 1,
                total_steps=trace_context.total_steps,
                operation_index=trace_context.operation_index,
                result_id=trace_context.result_id,
                circuit_hash=trace_context.circuit_hash,
                provenance_class=trace_context.provenance_class,
                verification_status=trace_context.verification_status,
            )
            if trace_context
            else None
        ),
    )


@app.post("/api/test/multi-input", response_model=MultiInputTestResponse)
def multi_input_test_endpoint(request: MultiInputTestRequest) -> MultiInputTestResponse:
    """Basis-sweep multi-input test harness (docs/VERIFICATION_ARCHITECTURE.md
    §4.2, ``qentor.verification.multi_input_harness``).

    Every case's own execution is persisted exactly like ``/api/execute``
    would (this is the only place ``multi_input_harness`` touches
    ``ProvenanceStore`` — the harness module itself never imports it, it only
    calls back into this closure once per case). A request that doesn't fit
    the circuit (an out-of-range qubit, a wrong-width bitstring, too many
    qubits/cases) is rejected outright as HTTP 422, never silently
    reinterpreted or truncated.
    """
    adapter = _adapters[request.backend]
    _enforce_run_limits(request.circuit, request.backend)

    def record_execution(result: ExecutionResult, case_circuit_hash: str) -> str:
        return _record_run(result, case_circuit_hash, request.circuit.num_qubits).result_id

    try:
        report = run_multi_input_test(
            circuit=request.circuit,
            adapter=adapter,
            input_qubits=request.input_qubits,
            output_qubits=request.output_qubits,
            cases=[TestCaseSpec(input_bits=c.input_bits, expected_output=c.expected_output) for c in request.cases],
            record_execution=record_execution,
        )
    except HarnessValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return MultiInputTestResponse(
        test_id=report.test_id,
        circuit_hash=report.circuit_hash,
        backend=report.backend,
        backend_version=report.backend_version,
        input_qubits=report.input_qubits,
        output_qubits=report.output_qubits,
        cases=[
            MultiInputCaseResponse(
                input_bits=c.input_bits,
                expected_output=c.expected_output,
                status=c.status.value,
                observed_distribution=c.observed_distribution,
                error=c.error,
                result_id=c.result_id,
                circuit_hash=c.circuit_hash,
            )
            for c in report.cases
        ],
        counterexamples=[
            MultiInputCounterexampleResponse(
                input_bits=c.input_bits,
                expected_output=c.expected_output,
                observed_distribution=c.observed_distribution,
                circuit_hash=c.circuit_hash,
                result_id=c.result_id,
            )
            for c in report.counterexamples
        ],
        overall_status=report.overall_status.value,
    )


@app.post("/api/optimize", response_model=OptimizeResponse)
def optimize_endpoint(request: OptimizeRequest) -> OptimizeResponse:
    """Verified circuit optimisation (docs/VERIFICATION_ARCHITECTURE.md §4.4,
    ``qentor.verification.optimizer``).

    A rewrite rule alone never earns "verified": every candidate goes through
    ``qentor.verification.equivalence`` (Qiskit Operator equivalence, the one
    documented method) before this endpoint can report it as shorter.
    ``backend`` only selects which adapter runs the already-verified candidate
    once, to persist supporting evidence — it plays no part in the
    equivalence verdict. If nothing survives verification, the response says
    so explicitly and carries no candidate circuit definition at all.
    """
    adapter = _adapters[request.backend]
    _enforce_run_limits(request.circuit, request.backend)
    try:
        check_equivalence_limits(request.circuit.num_qubits)
    except LimitExceeded as exc:
        raise _limit_http_error(exc) from exc

    def record_execution(result: ExecutionResult, candidate_hash: str) -> str:
        return _record_run(result, candidate_hash, request.circuit.num_qubits).result_id

    report = optimize_circuit(request.circuit, adapter=adapter, record_execution=record_execution)

    equivalence = None
    if report.equivalence is not None:
        equivalence = OptimizeEquivalenceResponse(
            status=report.equivalence.status.value,
            method=report.equivalence.method,
            global_phase=report.equivalence.global_phase,
            checks=[
                OptimizeEquivalenceCheckResponse(name=c.name, status=c.status.value, detail=c.detail)
                for c in report.equivalence.checks
            ],
            reason=report.equivalence.reason,
        )

    return OptimizeResponse(
        original_circuit_hash=report.original_circuit_hash,
        candidate_circuit_hash=report.candidate_circuit_hash,
        original_op_count=report.original_op_count,
        candidate_op_count=report.candidate_op_count,
        rules_applied=report.rules_applied,
        reduction_summary=report.reduction_summary,
        status=report.status.value,
        equivalence=equivalence,
        verifier_name=report.verifier_name,
        verifier_version=report.verifier_version,
        reason=report.reason,
        candidate_circuit=report.candidate_circuit,
        result_id=report.result_id,
    )


@app.get("/api/lessons", response_model=LessonCatalogResponse)
def list_lessons() -> LessonCatalogResponse:
    """The read-only lesson catalog (``qentor.lessons``), already validated
    at process startup (``qentor.lessons.registry.build_registry``).

    Metadata and section structure only — no learner progress/state exists
    yet, and nothing here executes, verifies or computes anything: a lesson's
    ``linked_circuit`` is a plain canonical circuit definition, the same shape
    ``/api/execute`` itself accepts, not a result.
    """
    return LessonCatalogResponse(lessons=LESSONS)
