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


class VerificationStatus(str, Enum):
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"
    ERROR = "ERROR"


class ProvenanceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit_hash: str
    backend: str
    backend_version: str
    execution_mode: str
    provenance_class: ProvenanceClass
    verification_status: VerificationStatus
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
        verification_status: VerificationStatus,
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
            verification_status=VerificationStatus(row["verification_status"]),
            created_at=row["created_at"],
            payload=json.loads(row["payload_json"]),
        )
