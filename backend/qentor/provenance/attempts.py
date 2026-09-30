"""Challenge attempt log: the verdicts the server computed, keyed by attempt id.

Like ``ProvenanceStore`` this is a WRITER, so it lives with the provenance package and only ``qentor.api`` uses it. The
tutor never imports it (``backend/tests/test_architecture_rule.py``); the API layer reads an attempt and hands the tutor a
plain, already-fetched object.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

from qentor.storage.db import DEFAULT_DB_PATH, connect


class AttemptRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attempt_id: str
    challenge_id: str
    circuit_hash: str
    passed: bool
    final_result_id: str | None
    checks: list[dict[str, Any]]
    created_at: str

    @classmethod
    def new(
        cls,
        *,
        challenge_id: str,
        circuit_hash: str,
        passed: bool,
        final_result_id: str | None,
        checks: list[dict[str, Any]],
    ) -> "AttemptRecord":
        return cls(
            attempt_id=f"att_{uuid.uuid4().hex}",
            challenge_id=challenge_id,
            circuit_hash=circuit_hash,
            passed=passed,
            final_result_id=final_result_id,
            checks=checks,
            created_at=datetime.now(UTC).isoformat(),
        )

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "AttemptRecord":
        return cls(
            attempt_id=row["attempt_id"],
            challenge_id=row["challenge_id"],
            circuit_hash=row["circuit_hash"],
            passed=bool(row["passed"]),
            final_result_id=row["final_result_id"],
            checks=json.loads(row["checks_json"]),
            created_at=row["created_at"],
        )


class AttemptStore:
    """Thread-safe for the same reason ``ProvenanceStore`` is (FastAPI's worker threadpool)."""

    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self._conn: sqlite3.Connection = connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()

    def insert(self, record: AttemptRecord) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO challenge_attempts (attempt_id, challenge_id, circuit_hash, passed, final_result_id, checks_json, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    record.attempt_id,
                    record.challenge_id,
                    record.circuit_hash,
                    int(record.passed),
                    record.final_result_id,
                    json.dumps(record.checks, sort_keys=True),
                    record.created_at,
                ),
            )
            self._conn.commit()

    def get(self, attempt_id: str) -> AttemptRecord | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM challenge_attempts WHERE attempt_id = ?", (attempt_id,)).fetchone()
        return AttemptRecord.from_row(row) if row else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()
