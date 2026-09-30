"""Provenance record shape.

Every execution writes exactly one of these before the result is allowed to leave
the server. ``tutor`` (not yet built) will only ever read these by ``result_id`` —
see the import-graph rule checked in ``backend/tests/test_architecture_rule.py``.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict


class ProvenanceClass(str, Enum):
    SIMULATION = "SIMULATION"
    REAL_HARDWARE = "REAL_HARDWARE"
    RECORDED_HARDWARE = "RECORDED_HARDWARE"


class ExecutionStatus(str, Enum):
    """What is known about ONE execution record — never about the circuit.

    Deliberately not called "verified": the property verifiers in
    ``qentor.verification`` own that word, and an execution that ran says nothing
    about whether the circuit is right.

    - ``STATE_CHECKED``: the backend ran and what it returned passed the state
      sanity check (``qentor.execution.sanity``: unit-norm statevector, probabilities
      summing to 1, counts summing to the shots).
    - ``FAILED``: the backend ran but returned a result that failed that check.
    - ``ERROR``: the run itself failed.
    - ``SUCCEEDED``: the backend ran and no state check was recorded. Only rows
      written before state checks existed (they were stored as ``VERIFIED``) read back
      as this; nothing writes it any more, and it is not treated as usable.
    """

    STATE_CHECKED = "STATE_CHECKED"
    FAILED = "FAILED"
    ERROR = "ERROR"
    SUCCEEDED = "SUCCEEDED"


# Rows written before the rename stored the execution status as "VERIFIED".
_LEGACY_EXECUTION_STATUS = {"VERIFIED": ExecutionStatus.SUCCEEDED}


class ProvenanceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit_hash: str
    backend: str
    backend_version: str
    execution_mode: str
    provenance_class: ProvenanceClass
    verification_status: ExecutionStatus
    created_at: str
    payload: dict[str, Any]

    @classmethod
    def new(
        cls,
        *,
        circuit_hash: str,
        backend: str,
        backend_version: str,
        execution_mode: str,
        provenance_class: ProvenanceClass,
        verification_status: ExecutionStatus,
        payload: dict[str, Any],
    ) -> "ProvenanceRecord":
        return cls(
            result_id=f"res_{uuid.uuid4().hex}",
            circuit_hash=circuit_hash,
            backend=backend,
            backend_version=backend_version,
            execution_mode=execution_mode,
            provenance_class=provenance_class,
            verification_status=verification_status,
            created_at=datetime.now(UTC).isoformat(),
            payload=payload,
        )

    def to_row(self) -> tuple:
        return (
            self.result_id,
            self.circuit_hash,
            self.backend,
            self.backend_version,
            self.execution_mode,
            self.provenance_class.value,
            self.verification_status.value,
            self.created_at,
            json.dumps(self.payload, sort_keys=True),
        )

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "ProvenanceRecord":
        return cls(
            result_id=row["result_id"],
            circuit_hash=row["circuit_hash"],
            backend=row["backend"],
            backend_version=row["backend_version"],
            execution_mode=row["execution_mode"],
            provenance_class=ProvenanceClass(row["provenance_class"]),
            verification_status=_LEGACY_EXECUTION_STATUS.get(row["verification_status"])
            or ExecutionStatus(row["verification_status"]),
            created_at=row["created_at"],
            payload=json.loads(row["payload_json"]),
        )
