"""Provenance persistence.

This is the *only* module allowed to write to the ``results`` table. The tutor
(not yet built) will get a read-only lookup here later; it must never gain access
to ``insert``.

Retention. The log is bounded, because one 16-qubit statevector run stores about 6 MB and a trace stores a record per step: left alone, a loop
of large requests would fill the disk. When the table holds more than ``max_rows`` records or more than ``max_bytes`` of payload, the OLDEST
records are deleted until it is back under 80% of both limits. A record that a shared experiment or a challenge attempt points at is never
deleted, and neither is the record just written. A pruned result is simply gone: asking about it is answered "not found" like any unknown id,
and nothing is regenerated or substituted. The limits are ``QENTOR_MAX_RESULT_ROWS`` (default 20000) and ``QENTOR_MAX_RESULT_BYTES`` (default 512 MiB).
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from pathlib import Path

from qentor.storage.db import DEFAULT_DB_PATH, connect

from .models import ProvenanceRecord

logger = logging.getLogger("qentor.provenance")

ROWS_ENV = "QENTOR_MAX_RESULT_ROWS"
BYTES_ENV = "QENTOR_MAX_RESULT_BYTES"
DEFAULT_MAX_ROWS = 20_000
DEFAULT_MAX_BYTES = 512 * 1024 * 1024
PRUNE_TARGET_FRACTION = 0.8
_PRUNE_BATCH = 200

# Records something else still points at: a shared experiment's stored run, a challenge attempt's examined run.
_UNREFERENCED = """
    result_id != ?
    AND result_id NOT IN (SELECT result_id FROM shared_experiments WHERE result_id IS NOT NULL)
    AND result_id NOT IN (SELECT final_result_id FROM challenge_attempts WHERE final_result_id IS NOT NULL)
"""


def _env_limit(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw.isdigit() and int(raw) >= 1 else default


class ProvenanceStore:
    """Thread-safe: FastAPI runs sync path operations in a worker threadpool, so a
    single ``ProvenanceStore`` instance (e.g. the module-level singleton in
    ``api/app.py``) is routinely called from a different thread than the one that
    constructed it. The connection is opened with ``check_same_thread=False`` and
    every access is serialized through ``self._lock``, since a single sqlite3
    connection is not safe for concurrent use from multiple threads even when the
    same-thread check is disabled.
    """

    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH, *, max_rows: int | None = None, max_bytes: int | None = None) -> None:
        self._conn: sqlite3.Connection = connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        self.max_rows = max_rows if max_rows is not None else _env_limit(ROWS_ENV, DEFAULT_MAX_ROWS)
        self.max_bytes = max_bytes if max_bytes is not None else _env_limit(BYTES_ENV, DEFAULT_MAX_BYTES)
        self.pruned_total = 0
        row = self._conn.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) FROM results").fetchone()
        self._rows, self._bytes = int(row[0]), int(row[1])

    def insert(self, record: ProvenanceRecord) -> None:
        row = record.to_row()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO results (
                    result_id, circuit_hash, backend, backend_version, execution_mode,
                    provenance_class, verification_status, created_at, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                row,
            )
            self._conn.commit()
            self._rows += 1
            self._bytes += len(str(row[-1]).encode("utf-8"))
            if self._rows > self.max_rows or self._bytes > self.max_bytes:
                self._prune_locked(protect=str(row[0]))

    def _prune_locked(self, protect: str) -> None:
        """Delete the oldest unreferenced records until under 80% of both limits. Caller holds the lock."""
        target_rows = int(self.max_rows * PRUNE_TARGET_FRACTION)
        target_bytes = int(self.max_bytes * PRUNE_TARGET_FRACTION)
        removed = 0
        while self._rows > target_rows or self._bytes > target_bytes:
            batch = self._conn.execute(
                f"SELECT result_id, LENGTH(CAST(payload_json AS BLOB)) FROM results WHERE {_UNREFERENCED} ORDER BY created_at, rowid LIMIT ?",
                (protect, _PRUNE_BATCH),
            ).fetchall()
            if not batch:
                break  # everything left is referenced or is the record just written
            doomed: list[tuple[str]] = []
            for result_id, size in batch:  # oldest first, and only as many as it takes to get under both targets
                if self._rows <= target_rows and self._bytes <= target_bytes:
                    break
                doomed.append((result_id,))
                self._rows -= 1
                self._bytes -= int(size)
            self._conn.executemany("DELETE FROM results WHERE result_id = ?", doomed)
            self._conn.commit()
            removed += len(doomed)
        if removed:
            self.pruned_total += removed
            logger.info("provenance log pruned %d oldest records; %d rows, %d bytes remain", removed, self._rows, self._bytes)

    def get(self, result_id: str) -> ProvenanceRecord | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM results WHERE result_id = ?", (result_id,)
            ).fetchone()
        return ProvenanceRecord.from_row(row) if row else None

    def list_by_circuit_hash(self, circuit_hash: str) -> list[ProvenanceRecord]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM results WHERE circuit_hash = ? ORDER BY created_at", (circuit_hash,)
            ).fetchall()
        return [ProvenanceRecord.from_row(r) for r in rows]

    def close(self) -> None:
        with self._lock:
            self._conn.close()
