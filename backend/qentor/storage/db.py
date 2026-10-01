"""SQLite connection and schema for the provenance store.

One table for Milestone 1: ``results``. No queue, no server process, no ORM —
a plain connection and plain SQL, matching docs/ARCHITECTURE.md's "smallest
system" principle.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

DB_PATH_ENV = "QENTOR_DB_PATH"
# ``QENTOR_DB_PATH`` lets a deployment put the database on a mounted volume; otherwise it lives in backend/data (git-ignored).
DEFAULT_DB_PATH = Path(os.environ.get(DB_PATH_ENV) or Path(__file__).resolve().parents[2] / "data" / "qentor.db")

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

-- One row per challenge submission: the deterministic verdict and the provenance record it examined. No user column:
-- there are no accounts, so this is an audit log of verdicts the server itself computed, not a learner profile.
CREATE TABLE IF NOT EXISTS challenge_attempts (
    attempt_id      TEXT PRIMARY KEY,
    challenge_id    TEXT NOT NULL,
    circuit_hash    TEXT NOT NULL,
    passed          INTEGER NOT NULL,
    final_result_id TEXT,
    checks_json     TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_challenge ON challenge_attempts (challenge_id);

-- The anonymous classroom layer (qentor.classroom). No names, no emails, no accounts: a class is a short code plus an
-- instructor capability (only its SHA-256 is stored), a learner is a random token (only its SHA-256 is stored), and an event is
-- one useful learning fact the SERVER derived. Nothing here is a UI click log.
CREATE TABLE IF NOT EXISTS classes (
    class_id            TEXT PRIMARY KEY,
    class_code          TEXT NOT NULL UNIQUE,
    instructor_key_hash TEXT NOT NULL,
    title               TEXT NOT NULL,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learners (
    learner_id  TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
    class_id   TEXT NOT NULL,
    learner_id TEXT NOT NULL,
    joined_at  TEXT NOT NULL,
    left_at    TEXT,
    PRIMARY KEY (class_id, learner_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_learner ON memberships (learner_id);

-- dedupe_key makes a replayed idempotent event (started / completed / synced) a no-op: UNIQUE per learner and class.
CREATE TABLE IF NOT EXISTS learner_events (
    event_id    TEXT PRIMARY KEY,
    class_id    TEXT NOT NULL,
    learner_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    subject_id  TEXT NOT NULL,
    outcome     TEXT,
    detail_json TEXT NOT NULL,
    dedupe_key  TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_class ON learner_events (class_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_learner ON learner_events (class_id, learner_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON learner_events (class_id, learner_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
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
