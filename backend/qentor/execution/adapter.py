"""Execution adapter contract.

Every backend (Aer now; Cirq, PennyLane, recorded/live hardware later) implements
this shape. ``run`` must return a real, backend-produced ``ExecutionResult`` — it
must never fabricate probabilities, counts or a statevector. If the backend cannot
run (not installed, blocked, or a runtime error), it raises ``AdapterUnavailable``
or ``AdapterExecutionError`` rather than returning a plausible-looking fake result.
"""

from __future__ import annotations

from typing import Any, Literal, Protocol

ExecutionMode = Literal["statevector", "shots"]


class AdapterUnavailable(RuntimeError):
    """The backend's runtime could not be imported or initialised in this environment."""


class AdapterExecutionError(RuntimeError):
    """The backend was available but the run itself failed."""


class ExecutionResult:
    """Normalised, backend-produced result. See docs/VERIFICATION_ARCHITECTURE.md §3."""

    def __init__(
        self,
        *,
        backend_name: str,
        backend_version: str,
        execution_mode: ExecutionMode,
        execution_id: str,
        probabilities: dict[str, float] | None = None,
        counts: dict[str, int] | None = None,
        statevector: list[list[float]] | None = None,
    ) -> None:
        self.backend_name = backend_name
        self.backend_version = backend_version
        self.execution_mode = execution_mode
        self.execution_id = execution_id
        self.probabilities = probabilities
        self.counts = counts
        self.statevector = statevector

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "execution_id": self.execution_id,
        }
        if self.probabilities is not None:
            payload["probabilities"] = self.probabilities
        if self.counts is not None:
            payload["counts"] = self.counts
        if self.statevector is not None:
            payload["statevector"] = self.statevector
        return payload


class ExecutionAdapter(Protocol):
    name: str

    def run(self, circuit, mode: ExecutionMode, shots: int | None = None) -> ExecutionResult: ...
