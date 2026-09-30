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

from qentor.circuit.codegen import CODEGEN_VERSION, generate_all
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionResult
from qentor.execution.aer import AerAdapter
from qentor.execution.capabilities import UnsupportedGate, check_gate_support
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.limits import MAX_OPERATIONS, LimitExceeded, check_equivalence_limits, check_run_limits
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.execution.sanity import state_problems
from qentor.execution.trace import TraceBackendFault, TraceNotSupported, split_terminal_measurements, trace_circuit
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
from qentor.verification.agreement import AGREEMENT_THRESHOLD, METHOD as AGREEMENT_METHOD, compare_all
from qentor.verification.bell_state import verify_bell_state
from qentor.verification.equivalence import check_equivalence
from qentor.verification.multi_input_harness import (
    MAX_SWEEP_QUBITS,
    MAX_TEST_CASES,
    HarnessValidationError,
    TestCaseSpec,
    run_multi_input_test,
)
from qentor.verification.optimizer import optimize_circuit

from .schemas import (
    AgreementBackendResponse,
    AgreementPairResponse,
    AgreementRequest,
    AgreementResponse,
    CodeRequest,
    CodeResponse,
    EquivalenceRequest,
    EquivalenceResponse,
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


def _persist_run(
    result: ExecutionResult,
    circuit_hash_: str,
    num_qubits: int,
    *,
    shots: int | None = None,
) -> tuple[ProvenanceRecord, list[str]]:
    """Persist one backend run after the state sanity check; returns the record and the problems found.

    ``STATE_CHECKED`` means the backend's output is well-formed (unit norm, probabilities and counts that
    add up) - it is NOT a claim about the circuit. A result that fails the check is stored as ``FAILED``
    with the reasons and none of its numbers.
    """
    problems = state_problems(result, num_qubits, shots=shots)
    if problems:
        failed = ProvenanceRecord.new(
            circuit_hash=circuit_hash_,
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode=result.execution_mode,
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.FAILED,
            payload={"error": "; ".join(problems), "code": EXECUTION_STATE_INVALID},
        )
        _store.insert(failed)
        return failed, problems
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
    return record, []


def _record_run(
    result: ExecutionResult,
    circuit_hash_: str,
    num_qubits: int,
    *,
    shots: int | None = None,
) -> ProvenanceRecord:
    """As ``_persist_run``, but a malformed result is refused with 502: it is never shown, explained or
    built on."""
    record, problems = _persist_run(result, circuit_hash_, num_qubits, shots=shots)
    if problems:
        raise HTTPException(
            status_code=502,
            detail={
                "code": EXECUTION_STATE_INVALID,
                "message": f"backend {result.backend_name!r} returned a result that failed the state check: {'; '.join(problems)}",
            },
        )
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


def _provenance_response(record: ProvenanceRecord) -> TraceProvenanceResponse:
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


@app.post("/api/circuit/code", response_model=CodeResponse)
def circuit_code_endpoint(request: CodeRequest) -> CodeResponse:
    """Read-only Qiskit, Cirq and PennyLane source for the circuit (``qentor.circuit.codegen``): fixed-template
    text written by the server from the validated model. It is never executed here or in the browser."""
    if len(request.circuit.ops) > MAX_OPERATIONS:
        raise _limit_http_error(
            LimitExceeded(
                "CIRCUIT_TOO_MANY_OPERATIONS",
                f"{len(request.circuit.ops)} operations is over the {MAX_OPERATIONS}-operation limit per request",
                limit=MAX_OPERATIONS,
                requested=len(request.circuit.ops),
            )
        )
    return CodeResponse(
        circuit_hash=circuit_hash(request.circuit),
        generator=f"qentor.codegen/{CODEGEN_VERSION}",
        code=generate_all(request.circuit),
    )


@app.post("/api/verify/equivalence", response_model=EquivalenceResponse)
def equivalence_endpoint(request: EquivalenceRequest) -> EquivalenceResponse:
    """Are two circuits the same operator up to a global phase? The one equivalence definition in this codebase
    (``qentor.verification.equivalence``); the optimizer uses the same checker. Over the size limit is a
    structured 422; a pair it cannot decide (different widths, a mid-circuit measurement) is ``UNVERIFIABLE``
    with the reason, never a guess."""
    from importlib.metadata import PackageNotFoundError, version

    for circuit in (request.circuit_a, request.circuit_b):
        try:
            check_equivalence_limits(circuit.num_qubits, len(circuit.ops))
        except LimitExceeded as exc:
            raise _limit_http_error(exc) from exc
    report = check_equivalence(request.circuit_a, request.circuit_b)
    try:
        checker_version = version("qiskit")
    except PackageNotFoundError:  # pragma: no cover - qiskit is a hard dependency
        checker_version = "unknown"
    return EquivalenceResponse(
        status=report.status.value,
        method=report.method,
        checker_version=checker_version,
        circuit_hash_a=circuit_hash(request.circuit_a),
        circuit_hash_b=circuit_hash(request.circuit_b),
        global_phase=report.global_phase,
        checks=[VerificationCheckResponse(name=c.name, status=c.status.value, detail=c.detail) for c in report.checks],
        reason=report.reason,
    )


_AGREEMENT_BACKENDS = ("qiskit-aer", "cirq", "pennylane")


@app.post("/api/compare/backends", response_model=AgreementResponse)
def compare_backends_endpoint(request: AgreementRequest) -> AgreementResponse:
    """Run the circuit's statevector on several backends and compare the states ON THE SERVER
    (``qentor.verification.agreement``). Each backend's run is an ordinary provenance record; the comparison
    is one more, so every number in the response has a result id behind it. A backend that cannot run is
    reported as such and never replaced by another's numbers; with fewer than two results the status is
    ``INCOMPLETE``."""
    backends = list(dict.fromkeys(request.backends or _AGREEMENT_BACKENDS))
    circuit = request.circuit
    if len(circuit.ops) > MAX_OPERATIONS:
        raise _limit_http_error(
            LimitExceeded(
                "CIRCUIT_TOO_MANY_OPERATIONS",
                f"{len(circuit.ops)} operations is over the {MAX_OPERATIONS}-operation limit per request",
                limit=MAX_OPERATIONS,
                requested=len(circuit.ops),
            )
        )
    try:
        unitary_ops, terminal = split_terminal_measurements(circuit)
    except TraceNotSupported as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "AGREEMENT_MID_CIRCUIT_MEASUREMENT", "message": exc.message},
        ) from exc
    unitary = Circuit(num_qubits=circuit.num_qubits, num_clbits=0, ops=list(unitary_ops))
    chash = circuit_hash(unitary)

    entries: list[AgreementBackendResponse] = []
    states: dict[str, list] = {}
    for name in backends:
        adapter = _adapters[name]
        try:
            check_run_limits(unitary, name)
            check_gate_support(unitary, name)
        except (LimitExceeded, UnsupportedGate) as exc:
            entries.append(AgreementBackendResponse(backend=name, status="REFUSED", message=exc.message, provenance=None))
            continue
        try:
            result = adapter.run(unitary, "statevector")
        except AdapterUnavailable as exc:
            entries.append(
                AgreementBackendResponse(backend=name, status="UNAVAILABLE", message=f"{name} is unavailable in this environment: {exc}", provenance=None)
            )
            continue
        except AdapterExecutionError as exc:
            _store.insert(
                ProvenanceRecord.new(
                    circuit_hash=chash,
                    backend=adapter.name,
                    backend_version="unknown",
                    execution_mode="statevector",
                    provenance_class=ProvenanceClass.SIMULATION,
                    verification_status=ExecutionStatus.ERROR,
                    payload={"error": str(exc)},
                )
            )
            entries.append(AgreementBackendResponse(backend=name, status="FAILED", message=str(exc), provenance=None))
            continue
        record, problems = _persist_run(result, chash, unitary.num_qubits)
        if problems:
            entries.append(
                AgreementBackendResponse(
                    backend=name,
                    status="FAILED",
                    message=f"returned a result that failed the state check: {'; '.join(problems)}",
                    provenance=_provenance_response(record),
                )
            )
            continue
        entries.append(AgreementBackendResponse(backend=name, status="RAN", message=None, provenance=_provenance_response(record)))
        states[name] = result.statevector or []

    pairs = compare_all(states)
    if len(states) < 2:
        status = "INCOMPLETE"
    else:
        status = "AGREE" if all(p.agrees for p in pairs) else "DISAGREE"

    comparison = ProvenanceRecord.new(
        circuit_hash=chash,
        backend="cross-backend-agreement",
        backend_version=AGREEMENT_METHOD,
        execution_mode="agreement",
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.STATE_CHECKED if len(states) >= 2 else ExecutionStatus.FAILED,
        payload={
            "method": AGREEMENT_METHOD,
            "threshold": AGREEMENT_THRESHOLD,
            "status": status,
            "backends": [
                {"backend": e.backend, "status": e.status, "result_id": e.provenance.result_id if e.provenance else None}
                for e in entries
            ],
            "pairs": [
                {
                    "backend_a": p.backend_a,
                    "backend_b": p.backend_b,
                    "max_amplitude_difference": p.max_amplitude_difference,
                    "max_probability_difference": p.max_probability_difference,
                    "fidelity": p.fidelity,
                    "agrees": p.agrees,
                }
                for p in pairs
            ],
        },
    )
    _store.insert(comparison)
    return AgreementResponse(
        method=AGREEMENT_METHOD,
        threshold=AGREEMENT_THRESHOLD,
        status=status,
        circuit_hash=chash,
        terminal_measurements_stripped=len(terminal),
        backends=entries,
        pairs=[
            AgreementPairResponse(
                backend_a=p.backend_a,
                backend_b=p.backend_b,
                max_amplitude_difference=p.max_amplitude_difference,
                max_probability_difference=p.max_probability_difference,
                fidelity=p.fidelity,
                agrees=p.agrees,
            )
            for p in pairs
        ],
        provenance=_provenance_response(comparison),
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
