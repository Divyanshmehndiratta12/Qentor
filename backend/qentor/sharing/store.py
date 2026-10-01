"""Persistence for shared experiments (SQLite, the provenance database). Like ``ProvenanceStore`` this is a WRITER used only by ``qentor.api``."""

from __future__ import annotations

import re
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from qentor.circuit.model import Circuit
from qentor.storage.db import DEFAULT_DB_PATH, connect

_RE_ID = re.compile(r"ex_[0-9a-f]{16}")
MAX_TITLE = 80


def is_experiment_id(text: object) -> bool:
    return isinstance(text, str) and _RE_ID.fullmatch(text) is not None


def clean_experiment_title(text: str | None) -> str | None:
    """Optional free text from the sharer, only ever rendered as text: control characters removed, whitespace collapsed, capped; ``None`` when empty."""
    if text is None:
        return None
    cleaned = "".join(ch for ch in text if ch.isprintable())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:MAX_TITLE]
    return cleaned or None


@dataclass(frozen=True)
class ExperimentRecord:
    experiment_id: str
    created_at: str
    title: str | None
    circuit: Circuit
    circuit_hash: str
    backend: str
    mode: str
    shots: int | None
    result_id: str | None
    lesson_id: str | None
    challenge_id: str | None


class ExperimentStore:
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self._conn: sqlite3.Connection = connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()

    def create(
        self,
        *,
        circuit: Circuit,
        circuit_hash: str,
        backend: str,
        mode: str,
        shots: int | None,
        result_id: str | None,
        lesson_id: str | None,
        challenge_id: str | None,
        title: str | None,
    ) -> ExperimentRecord:
        record = ExperimentRecord(
            experiment_id=f"ex_{uuid.uuid4().hex[:16]}",
            created_at=datetime.now(UTC).isoformat(),
            title=clean_experiment_title(title),
            circuit=circuit,
            circuit_hash=circuit_hash,
            backend=backend,
            mode=mode,
            shots=shots,
            result_id=result_id,
            lesson_id=lesson_id,
            challenge_id=challenge_id,
        )
        with self._lock:
            self._conn.execute(
                "INSERT INTO shared_experiments (experiment_id, created_at, title, circuit_json, circuit_hash, backend, mode, shots, result_id, lesson_id, challenge_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.experiment_id,
                    record.created_at,
                    record.title,
                    circuit.model_dump_json(by_alias=True),
                    circuit_hash,
                    backend,
                    mode,
                    shots,
                    result_id,
                    lesson_id,
                    challenge_id,
                ),
            )
            self._conn.commit()
        return record

    def get(self, experiment_id: str) -> ExperimentRecord | None:
        if not is_experiment_id(experiment_id):
            return None
        with self._lock:
            row = self._conn.execute("SELECT * FROM shared_experiments WHERE experiment_id = ?", (experiment_id,)).fetchone()
        if row is None:
            return None
        try:
            circuit = Circuit.model_validate_json(row["circuit_json"])
        except ValueError:  # a stored circuit that no longer validates is not served
            return None
        return ExperimentRecord(
            row["experiment_id"], row["created_at"], row["title"], circuit, row["circuit_hash"], row["backend"], row["mode"], row["shots"],
            row["result_id"], row["lesson_id"], row["challenge_id"],
        )  # fmt: skip

    def close(self) -> None:
        with self._lock:
            self._conn.close()
