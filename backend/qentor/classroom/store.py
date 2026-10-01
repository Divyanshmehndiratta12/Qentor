"""Persistence for the anonymous classroom layer (SQLite, the same database as the provenance log).

What is stored, and what is not:

* ``classes``: an opaque id, the short class code, an optional title the instructor typed, and the SHA-256 of the instructor key.
* ``learners``: an opaque id and the SHA-256 of the learner token. No name, no email, no address, no browser detail.
* ``memberships``: which learner is in which class, and when they joined or left.
* ``learner_events``: one row per useful learning fact the SERVER derived (``EVENT_KINDS``), with small validated detail. There is no
  click log, no free text and no client-supplied metric.

Retention: ``purge_events_older_than`` deletes old events (the server calls it at start with ``QENTOR_CLASSROOM_RETENTION_DAYS``, default 180),
and ``delete_class`` removes a class and everything attached to it. Like ``ProvenanceStore`` this is a WRITER: it lives beside the provenance
package, only ``qentor.api`` uses it, and the tutor never imports it (``tests/test_classroom_architecture.py``).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable

from qentor.storage.db import DEFAULT_DB_PATH, connect

from .codes import (
    alias_for,
    clean_title,
    hash_secret,
    is_learner_token,
    new_class_code,
    new_instructor_key,
    new_learner_token,
    secrets_match,
)

# The only facts that can be recorded. Each is a learning fact, not an interaction.
EVENT_KINDS = (
    "joined_class",
    "lesson_started",
    "lesson_completed",
    "concept_check_submitted",
    "concept_check_corrected",
    "concept_check_synced",
    "challenge_started",
    "challenge_solved",
    "challenge_failed",
    "experiment_shared",
)
OUTCOMES = ("correct", "incorrect")
# Events one learner may hold in one class: a bound on storage and on a misbehaving client.
MAX_EVENTS_PER_LEARNER = 5000
MAX_DETAIL_BYTES = 600
DEFAULT_RETENTION_DAYS = 180

RECORDED = "RECORDED"
DUPLICATE = "DUPLICATE"
LIMIT = "LIMIT"


@dataclass(frozen=True)
class ClassRecord:
    class_id: str
    class_code: str
    title: str
    created_at: str


@dataclass(frozen=True)
class JoinOutcome:
    learner_id: str
    learner_token: str
    alias: str
    cls: ClassRecord
    rejoined: bool
    new_identity: bool


@dataclass(frozen=True)
class Membership:
    learner_id: str
    cls: ClassRecord
    joined_at: str


@dataclass(frozen=True)
class EventRow:
    event_id: str
    learner_id: str
    kind: str
    subject_id: str
    outcome: str | None
    detail: dict[str, Any]
    created_at: str


def _now() -> datetime:
    return datetime.now(UTC)


class ClassroomStore:
    """Thread-safe for the same reason ``ProvenanceStore`` is (FastAPI's worker threadpool)."""

    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH, *, now: Callable[[], datetime] = _now) -> None:
        self._conn: sqlite3.Connection = connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        self._now = now

    # ----------------------------------------------------------------------------------------------------------------- classes

    def create_class(self, title: str | None = None) -> tuple[ClassRecord, str]:
        """A new class: ``(record, instructor_key)``. The key is returned ONCE and only its hash is kept."""
        key = new_instructor_key()
        created = self._now().isoformat()
        with self._lock:
            for _ in range(20):  # a collision of two 8-symbol codes is rare; retry rather than fail
                code = new_class_code()
                class_id = f"cls_{uuid.uuid4().hex[:16]}"
                try:
                    self._conn.execute(
                        "INSERT INTO classes (class_id, class_code, instructor_key_hash, title, created_at) VALUES (?, ?, ?, ?, ?)",
                        (class_id, code, hash_secret(key), clean_title(title), created),
                    )
                    self._conn.commit()
                    return ClassRecord(class_id, code, clean_title(title), created), key
                except sqlite3.IntegrityError:
                    self._conn.rollback()
        raise RuntimeError("could not allocate a class code")  # pragma: no cover

    def class_by_code(self, code: str) -> ClassRecord | None:
        with self._lock:
            row = self._conn.execute("SELECT class_id, class_code, title, created_at FROM classes WHERE class_code = ?", (code,)).fetchone()
        return ClassRecord(row["class_id"], row["class_code"], row["title"], row["created_at"]) if row else None

    def authorize_instructor(self, code: str, instructor_key: str) -> ClassRecord | None:
        """The class, when ``instructor_key`` is the capability issued for exactly this class; else ``None`` (the same answer for an unknown
        class and a wrong key, so the response says nothing about which codes exist)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT class_id, class_code, title, created_at, instructor_key_hash FROM classes WHERE class_code = ?", (code,)
            ).fetchone()
        if row is None or not secrets_match(instructor_key, row["instructor_key_hash"]):
            return None
        return ClassRecord(row["class_id"], row["class_code"], row["title"], row["created_at"])

    def delete_class(self, class_id: str) -> int:
        """Remove a class, its memberships and its events (and any learner left with no membership). Returns the events deleted."""
        with self._lock:
            deleted = self._conn.execute("DELETE FROM learner_events WHERE class_id = ?", (class_id,)).rowcount
            self._conn.execute("DELETE FROM memberships WHERE class_id = ?", (class_id,))
            self._conn.execute("DELETE FROM classes WHERE class_id = ?", (class_id,))
            self._drop_orphan_learners()
            self._conn.commit()
        return deleted

    # --------------------------------------------------------------------------------------------------------------- learners

    def join(self, code: str, learner_token: str | None = None) -> JoinOutcome | None:
        """Put a learner in the class with this (already normalised) code. ``None`` when there is no such class.

        A presented token that belongs to a learner is reused (the same learner rejoining from the same browser keeps their alias and
        history); anything else gets a new anonymous identity. A learner is in one class at a time: joining one leaves the other.
        """
        now = self._now().isoformat()
        with self._lock:
            row = self._conn.execute("SELECT class_id, class_code, title, created_at FROM classes WHERE class_code = ?", (code,)).fetchone()
            if row is None:
                return None
            cls = ClassRecord(row["class_id"], row["class_code"], row["title"], row["created_at"])
            learner_id: str | None = None
            token = learner_token
            if learner_token is not None and is_learner_token(learner_token):
                found = self._conn.execute("SELECT learner_id FROM learners WHERE secret_hash = ?", (hash_secret(learner_token),)).fetchone()
                learner_id = found["learner_id"] if found else None
            new_identity = learner_id is None
            if learner_id is None:
                token = new_learner_token()
                learner_id = f"ln_{uuid.uuid4().hex[:16]}"
                self._conn.execute("INSERT INTO learners (learner_id, secret_hash, created_at) VALUES (?, ?, ?)", (learner_id, hash_secret(token), now))
            assert token is not None
            self._conn.execute(
                "UPDATE memberships SET left_at = ? WHERE learner_id = ? AND left_at IS NULL AND class_id != ?", (now, learner_id, cls.class_id)
            )
            existing = self._conn.execute(
                "SELECT left_at FROM memberships WHERE class_id = ? AND learner_id = ?", (cls.class_id, learner_id)
            ).fetchone()
            rejoined = existing is not None
            newly_active = existing is None or existing["left_at"] is not None
            if existing is None:
                self._conn.execute("INSERT INTO memberships (class_id, learner_id, joined_at, left_at) VALUES (?, ?, ?, NULL)", (cls.class_id, learner_id, now))
            elif existing["left_at"] is not None:
                self._conn.execute("UPDATE memberships SET left_at = NULL WHERE class_id = ? AND learner_id = ?", (cls.class_id, learner_id))
            if newly_active:
                self._insert_event(cls.class_id, learner_id, "joined_class", cls.class_code, None, {"rejoined": rejoined}, None, now)
            self._conn.commit()
        return JoinOutcome(learner_id, token, alias_for(learner_id), cls, rejoined, new_identity)

    def membership_for_token(self, learner_token: str) -> Membership | None:
        """The learner's ACTIVE class, found from their token; ``None`` for an unknown token or a learner in no class."""
        if not is_learner_token(learner_token):
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT l.learner_id, m.joined_at, c.class_id, c.class_code, c.title, c.created_at FROM learners l"
                " JOIN memberships m ON m.learner_id = l.learner_id AND m.left_at IS NULL"
                " JOIN classes c ON c.class_id = m.class_id WHERE l.secret_hash = ?",
                (hash_secret(learner_token),),
            ).fetchone()
        if row is None:
            return None
        return Membership(row["learner_id"], ClassRecord(row["class_id"], row["class_code"], row["title"], row["created_at"]), row["joined_at"])

    def knows_token(self, learner_token: str) -> bool:
        if not is_learner_token(learner_token):
            return False
        with self._lock:
            return self._conn.execute("SELECT 1 FROM learners WHERE secret_hash = ?", (hash_secret(learner_token),)).fetchone() is not None

    def leave(self, learner_id: str) -> bool:
        """Leave the active class. Local learner data is the browser's and is untouched; the server keeps the rows (the instructor no longer sees
        them) until retention or class deletion removes them."""
        with self._lock:
            n = self._conn.execute("UPDATE memberships SET left_at = ? WHERE learner_id = ? AND left_at IS NULL", (self._now().isoformat(), learner_id)).rowcount
            self._conn.commit()
        return n > 0

    # ----------------------------------------------------------------------------------------------------------------- events

    def add_event(
        self,
        class_id: str,
        learner_id: str,
        kind: str,
        subject_id: str,
        outcome: str | None = None,
        detail: dict[str, Any] | None = None,
        dedupe_key: str | None = None,
    ) -> str:
        """Record one event. ``RECORDED``, ``DUPLICATE`` (the same idempotent event was already recorded) or ``LIMIT`` (this learner is at the cap).
        An unknown kind, an outcome that is not one of ``OUTCOMES``, or oversized detail raises ``ValueError``: callers build these themselves."""
        if kind not in EVENT_KINDS:
            raise ValueError(f"unknown event kind {kind!r}")
        if outcome is not None and outcome not in OUTCOMES:
            raise ValueError(f"unknown outcome {outcome!r}")
        if not subject_id or len(subject_id) > 120:
            raise ValueError("an event needs a subject id of at most 120 characters")
        text = json.dumps(detail or {}, sort_keys=True, separators=(",", ":"))
        if len(text.encode("utf-8")) > MAX_DETAIL_BYTES:
            raise ValueError("event detail is too large")
        with self._lock:
            count = self._conn.execute("SELECT COUNT(*) FROM learner_events WHERE class_id = ? AND learner_id = ?", (class_id, learner_id)).fetchone()[0]
            if count >= MAX_EVENTS_PER_LEARNER:
                return LIMIT
            try:
                self._insert_event(class_id, learner_id, kind, subject_id, outcome, detail or {}, dedupe_key, self._now().isoformat())
                self._conn.commit()
            except sqlite3.IntegrityError:
                self._conn.rollback()
                return DUPLICATE
        return RECORDED

    def _insert_event(self, class_id, learner_id, kind, subject_id, outcome, detail, dedupe_key, created_at) -> None:  # noqa: ANN001
        self._conn.execute(
            "INSERT INTO learner_events (event_id, class_id, learner_id, kind, subject_id, outcome, detail_json, dedupe_key, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (f"ev_{uuid.uuid4().hex}", class_id, learner_id, kind, subject_id, outcome, json.dumps(detail, sort_keys=True, separators=(",", ":")), dedupe_key, created_at),
        )

    def events_for_learner(self, class_id: str, learner_id: str, kinds: Iterable[str] | None = None) -> list[EventRow]:
        sql = "SELECT * FROM learner_events WHERE class_id = ? AND learner_id = ?"
        params: list[Any] = [class_id, learner_id]
        if kinds is not None:
            kinds = list(kinds)
            sql += f" AND kind IN ({','.join('?' for _ in kinds)})"
            params += kinds
        with self._lock:
            rows = self._conn.execute(sql + " ORDER BY created_at, rowid", params).fetchall()
        return [self._event(r) for r in rows]

    def member_events(self, class_id: str) -> list[EventRow]:
        """Every event of the learners who are in the class NOW (a learner who left is not in the instructor's view), oldest first."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT e.* FROM learner_events e JOIN memberships m ON m.class_id = e.class_id AND m.learner_id = e.learner_id AND m.left_at IS NULL"
                " WHERE e.class_id = ? ORDER BY e.created_at, e.rowid",
                (class_id,),
            ).fetchall()
        return [self._event(r) for r in rows]

    def member_counts(self, class_id: str) -> tuple[int, int]:
        """``(learners in the class now, learners who left)``."""
        with self._lock:
            now_in = self._conn.execute("SELECT COUNT(*) FROM memberships WHERE class_id = ? AND left_at IS NULL", (class_id,)).fetchone()[0]
            left = self._conn.execute("SELECT COUNT(*) FROM memberships WHERE class_id = ? AND left_at IS NOT NULL", (class_id,)).fetchone()[0]
        return now_in, left

    @staticmethod
    def _event(row: sqlite3.Row) -> EventRow:
        try:
            detail = json.loads(row["detail_json"])
            if not isinstance(detail, dict):
                detail = {}
        except (TypeError, ValueError):  # malformed stored data is skipped over, not trusted and not fatal
            detail = {}
        return EventRow(row["event_id"], row["learner_id"], row["kind"], row["subject_id"], row["outcome"], detail, row["created_at"])

    # ------------------------------------------------------------------------------------------------------------- retention

    def purge_events_older_than(self, days: int) -> int:
        """Delete events older than ``days`` days; returns how many. Memberships and learners with nothing left are removed too."""
        cutoff = (self._now() - timedelta(days=days)).isoformat()
        with self._lock:
            n = self._conn.execute("DELETE FROM learner_events WHERE created_at < ?", (cutoff,)).rowcount
            self._conn.execute("DELETE FROM memberships WHERE left_at IS NOT NULL AND left_at < ?", (cutoff,))
            self._drop_orphan_learners()
            self._conn.commit()
        return n

    def _drop_orphan_learners(self) -> None:
        self._conn.execute(
            "DELETE FROM learners WHERE learner_id NOT IN (SELECT learner_id FROM memberships)"
            " AND learner_id NOT IN (SELECT learner_id FROM learner_events)"
        )

    def close(self) -> None:
        with self._lock:
            self._conn.close()
