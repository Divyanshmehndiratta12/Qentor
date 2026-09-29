"""Scripted stand-in adapters for the trace tests.

These exist ONLY to prove properties of the trace layer itself — that it
forwards exactly what a backend returned, and that it refuses (rather than
repairs) a backend that misbehaves. They are never used to produce an
expected quantum value for a "real" assertion: the tests that check physics
obtain their reference states from the real Aer adapter.

Not named ``test_*.py`` on purpose, so ``unittest discover`` doesn't collect it.
"""

from __future__ import annotations

from typing import Callable

from qentor.circuit.model import Circuit
from qentor.execution.adapter import ExecutionResult


def make_result(
    statevector: list[list[float]] | None,
    *,
    backend_name: str = "scripted",
    backend_version: str = "0.0-test",
    execution_mode: str = "statevector",
    execution_id: str = "scripted-0",
    counts: dict[str, int] | None = None,
) -> ExecutionResult:
    return ExecutionResult(
        backend_name=backend_name,
        backend_version=backend_version,
        execution_mode=execution_mode,  # type: ignore[arg-type]
        execution_id=execution_id,
        statevector=statevector,
        counts=counts,
    )


class ScriptedAdapter:
    """Returns whatever ``respond(call_index, circuit)`` says, and remembers
    every call so a test can assert exactly what the trace asked the backend."""

    name = "scripted"

    def __init__(self, respond: Callable[[int, Circuit], ExecutionResult]) -> None:
        self._respond = respond
        self.calls: list[tuple[Circuit, str]] = []

    def run(self, circuit: Circuit, mode: str, shots: int | None = None) -> ExecutionResult:
        index = len(self.calls)
        self.calls.append((circuit, mode))
        return self._respond(index, circuit)


# Distinctive, normalised 1-qubit states. None of them is any real gate's
# output for the circuits they're used with, so if a trace passes one through
# untouched, it provably did not compute its own.
SENTINEL_STATES: list[list[list[float]]] = [
    [[0.6, 0.0], [0.8, 0.0]],
    [[0.0, 0.6], [0.0, 0.8]],
    [[0.8, 0.0], [0.0, -0.6]],
    [[0.28, 0.96], [0.0, 0.0]],
]
