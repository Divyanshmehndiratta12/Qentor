"""FastAPI app — Milestone 1 scope: POST /api/execute only.

No frontend is served here yet. No tutor endpoint exists yet. This module imports
only ``circuit``, ``execution``, ``provenance`` and ``storage`` — never ``tutor``,
because ``tutor`` does not exist yet and, per the architecture rule, never will be
imported from here in a way that lets it write results.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from qentor.circuit.hashing import circuit_hash
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord, VerificationStatus
from qentor.provenance.store import ProvenanceStore

from .schemas import ExecuteRequest, ExecuteResponse

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
