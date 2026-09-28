"""FastAPI app — POST /api/execute, POST /api/verify/bell-state,
POST /api/tutor, POST /api/test/multi-input and POST /api/optimize.

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
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord, VerificationStatus
from qentor.provenance.store import ProvenanceStore
from qentor.tutor import (
    answer_failed_execution,
    answer_question_with_llm,
    build_default_llm_adapter,
    build_fact_sheet,
)
from qentor.verification.bell_state import verify_bell_state
from qentor.verification.multi_input_harness import (
    HarnessValidationError,
    TestCaseSpec,
    run_multi_input_test,
)
from qentor.verification.optimizer import optimize_circuit

from .schemas import (
    ExecuteRequest,
    ExecuteResponse,
    MultiInputCaseResponse,
    MultiInputCounterexampleResponse,
    MultiInputTestRequest,
    MultiInputTestResponse,
    OptimizeEquivalenceCheckResponse,
    OptimizeEquivalenceResponse,
    OptimizeRequest,
    OptimizeResponse,
    TutorFactResponse,
    TutorRequest,
    TutorResponse,
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


@app.post("/api/execute", response_model=ExecuteResponse)
def execute(request: ExecuteRequest) -> ExecuteResponse:
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
            verification_status=VerificationStatus.ERROR,
            payload={"error": str(exc)},
        )
        _store.insert(record)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    record = ProvenanceRecord.new(
        circuit_hash=chash,
        backend=result.backend_name,
        backend_version=result.backend_version,
        execution_mode=result.execution_mode,
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=VerificationStatus.VERIFIED,
        payload=result.to_payload(),
    )
    _store.insert(record)

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
    """
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
    if record.verification_status != VerificationStatus.VERIFIED:
        answer, used_fallback_template = answer_failed_execution(record), True
    else:
        answer, used_fallback_template = answer_question_with_llm(
            request.question, facts, record, _llm_adapter
        )

    return TutorResponse(
        answer=answer,
        result_id=record.result_id,
        circuit_hash=record.circuit_hash,
        provenance_class=record.provenance_class.value,
        verification_status=record.verification_status.value,
        used_fallback_template=used_fallback_template,
        facts=[
            TutorFactResponse(id=f.id, kind=f.kind, description=f.description, result_id=f.result_id)
            for f in facts
        ],
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

    def record_execution(result: ExecutionResult, case_circuit_hash: str) -> str:
        record = ProvenanceRecord.new(
            circuit_hash=case_circuit_hash,
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode=result.execution_mode,
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=VerificationStatus.VERIFIED,
            payload=result.to_payload(),
        )
        _store.insert(record)
        return record.result_id

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

    def record_execution(result: ExecutionResult, candidate_hash: str) -> str:
        record = ProvenanceRecord.new(
            circuit_hash=candidate_hash,
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode=result.execution_mode,
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=VerificationStatus.VERIFIED,
            payload=result.to_payload(),
        )
        _store.insert(record)
        return record.result_id

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
