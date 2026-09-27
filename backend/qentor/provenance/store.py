"""Provenance persistence.

This is the *only* module allowed to write to the ``results`` table. The tutor
(not yet built) will get a read-only lookup here later; it must never gain access
to ``insert``.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from qentor.storage.db import DEFAULT_DB_PATH, connect

from .models import ProvenanceRecord


class ProvenanceStore:
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self._conn: sqlite3.Connection = connect(db_path)

    def insert(self, record: ProvenanceRecord) -> None:
        self._conn.execute(
            """
            INSERT INTO results (
                result_id, circuit_hash, backend, backend_version, execution_mode,
                provenance_class, verification_status, created_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            record.to_row(),
        )
        self._conn.commit()

    def get(self, result_id: str) -> ProvenanceRecord | None:
        row = self._conn.execute(
            "SELECT * FROM results WHERE result_id = ?", (result_id,)
        ).fetchone()
        return ProvenanceRecord.from_row(row) if row else None

    def list_by_circuit_hash(self, circuit_hash: str) -> list[ProvenanceRecord]:
        rows = self._conn.execute(
            "SELECT * FROM results WHERE circuit_hash = ? ORDER BY created_at", (circuit_hash,)
        ).fetchall()
        return [ProvenanceRecord.from_row(r) for r in rows]

    def close(self) -> None:
        self._conn.close()
