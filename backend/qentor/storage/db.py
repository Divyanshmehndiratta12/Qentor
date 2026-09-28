"""SQLite connection and schema for the provenance store.

One table for Milestone 1: ``results``. No queue, no server process, no ORM —
a plain connection and plain SQL, matching docs/ARCHITECTURE.md's "smallest
system" principle.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "data" / "qentor.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS results (
    result_id           TEXT PRIMARY KEY,
    circuit_hash        TEXT NOT NULL,
    backend             TEXT NOT NULL,
    backend_version     TEXT NOT NULL,
    execution_mode      TEXT NOT NULL,
    provenance_class    TEXT NOT NULL,
    verification_status TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    payload_json         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_circuit_hash ON results (circuit_hash);
"""


def connect(db_path: Path | str = DEFAULT_DB_PATH, *, check_same_thread: bool = True) -> sqlite3.Connection:
    """Open a SQLite connection with the schema applied. Safe to call repeatedly.

    ``check_same_thread=False`` lets the returned connection be handed to callers
    that serialize their own access across threads (see ``ProvenanceStore``),
    instead of relying on sqlite3's default same-thread check.
    """
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=check_same_thread)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.commit()
    return conn
