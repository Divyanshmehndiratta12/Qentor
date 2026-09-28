"""FastAPI app — POST /api/execute and POST /api/verify/bell-state.

No frontend is served here yet. No tutor endpoint exists yet. This module imports
``circuit``, ``execution``, ``provenance``, ``storage`` and ``verification`` — never
``tutor``, because ``tutor`` does not exist yet and, per the architecture rule, never
will be imported from here in a way that lets it write results.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from qentor.circuit.hashing import circuit_hash
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord, VerificationStatus
from qentor.provenance.store import ProvenanceStore
from qentor.verification.bell_state import verify_bell_state

from .schemas import (
    ExecuteRequest,
    ExecuteResponse,
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
