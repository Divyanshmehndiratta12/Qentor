"""FastAPI app — POST /api/execute, POST /api/verify/bell-state and POST /api/tutor.

This module imports ``circuit``, ``execution``, ``provenance``, ``storage``,
``verification`` and ``tutor`` — exactly the ``api -> tutor -> verification ->
execution -> circuit`` chain in docs/ARCHITECTURE.md §1. Only this module ever
calls ``ProvenanceStore.get``/``insert``: ``qentor.tutor`` (like
``qentor.verification``) takes an already-fetched ``ProvenanceRecord`` as a
plain argument and never imports the store itself — see
backend/tests/test_architecture_rule.py.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from qentor.circuit.hashing import circuit_hash
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord, VerificationStatus
from qentor.provenance.store import ProvenanceStore
from qentor.tutor import answer_failed_execution, answer_question, build_fact_sheet
from qentor.verification.bell_state import verify_bell_state

from .schemas import (
    ExecuteRequest,
    ExecuteResponse,
    TutorFactResponse,
    TutorRequest,
    TutorResponse,
    VerificationCheckResponse,
    VerifyBellStateRequest,
    VerifyBellStateResponse,
)

app = FastAPI(title="Qentor backend", version="0.1.0")

_adapter = AerAdapter()
_store = ProvenanceStore()


@app.post("/api/execute", response_model=ExecuteResponse)
def execute(request: ExecuteRequest) -> ExecuteResponse:
    chash = circuit_hash(request.circuit)

    try:
        result = _adapter.run(request.circuit, request.mode, request.shots)
    except AdapterUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Backend '{_adapter.name}' is unavailable in this environment: {exc}",
        ) from exc
    except AdapterExecutionError as exc:
        record = ProvenanceRecord.new(
            circuit_hash=chash,
            backend=_adapter.name,
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
    """Grounded, deterministic tutor answer (no LLM yet — see qentor.tutor).

    Never re-executes the circuit and never trusts a client-supplied number:
    every fact in the response is built from the persisted provenance record
    named by ``result_id``, looked up once here. A circuit that doesn't match
    that record's own circuit hash is rejected outright, not silently
    explained as if it were the executed one.
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
    answer = (
        answer_failed_execution(record)
        if record.verification_status != VerificationStatus.VERIFIED
        else answer_question(request.question, facts, record)
    )

    return TutorResponse(
        answer=answer,
        result_id=record.result_id,
        circuit_hash=record.circuit_hash,
        provenance_class=record.provenance_class.value,
        verification_status=record.verification_status.value,
        used_fallback_template=True,
        facts=[
            TutorFactResponse(id=f.id, kind=f.kind, description=f.description, result_id=f.result_id)
            for f in facts
        ],
    )
