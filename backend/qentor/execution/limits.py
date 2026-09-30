"""Explicit request limits, checked BEFORE any backend allocates memory.

Without these, "how big a circuit can I run?" was answered by the operating
system: a 30-qubit statevector request would ask a backend for gigabytes and
either fail with whatever ``MemoryError`` the SDK raised or, on a big enough
machine, be OOM-killed with the server. A limit that depends on the host's RAM is
not a limit a learner can be told about, and it is not testable. These are.

The numbers are for a learning platform, not for a benchmark. Measured on the
development machine (docs/BUILD_STATE.md), a 16-qubit statevector of a simple
circuit takes well under a second on every backend, and a statevector is
2**n complex numbers (16 MB at 20 qubits), so each limit sits comfortably inside
what the backend can do and far below what would threaten the host:

| limit                     | value | why                                                      |
|---------------------------|-------|----------------------------------------------------------|
| qubits, Qiskit Aer        | 16    | fastest backend; native memory check as a second line    |
| qubits, Cirq              | 14    | pure-Python state handling                               |
| qubits, PennyLane         | 14    | re-traces every operation                                |
| operations per request    | 500   | lesson circuits are tens of operations                   |
| shots per request         | 100000| counts are small, sampling time is not                   |
| qubits, equivalence check | 10    | a 2**n x 2**n operator (docs/ARCHITECTURE.md §4)         |

The trace and the multi-input harness keep their own tighter limits
(``MAX_SWEEP_QUBITS``), which this module does not loosen.

``LimitExceeded`` carries a stable ``code`` and the numbers involved so the API
can return a structured error and the UI can say exactly what to change.
"""

from __future__ import annotations

from qentor.circuit.model import Circuit

MAX_QUBITS_BY_BACKEND: dict[str, int] = {
    "qiskit-aer": 16,
    "cirq": 14,
    "pennylane": 14,
}
MAX_OPERATIONS = 500
MAX_SHOTS = 100_000
EQUIVALENCE_MAX_QUBITS = 10

TOO_MANY_QUBITS = "CIRCUIT_TOO_MANY_QUBITS"
TOO_MANY_OPERATIONS = "CIRCUIT_TOO_MANY_OPERATIONS"
TOO_MANY_SHOTS = "SHOTS_TOO_MANY"
UNKNOWN_BACKEND = "BACKEND_UNKNOWN"


class LimitExceeded(ValueError):
    """A request is larger than the platform runs. Refused, never truncated."""

    def __init__(self, code: str, message: str, *, limit: int | None, requested: int | None, backend: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.limit = limit
        self.requested = requested
        self.backend = backend

    def detail(self) -> dict:
        detail: dict = {"code": self.code, "message": self.message, "limit": self.limit, "requested": self.requested}
        if self.backend is not None:
            detail["backend"] = self.backend
        return detail


def max_qubits(backend: str) -> int:
    try:
        return MAX_QUBITS_BY_BACKEND[backend]
    except KeyError:
        raise LimitExceeded(UNKNOWN_BACKEND, f"no qubit limit is defined for backend {backend!r}", limit=None, requested=None, backend=backend) from None


def check_run_limits(circuit: Circuit, backend: str, *, shots: int | None = None, max_qubits_override: int | None = None) -> None:
    """Raise ``LimitExceeded`` if running ``circuit`` on ``backend`` is over a limit.

    ``max_qubits_override`` lets a caller with a tighter limit of its own (the
    trace) reuse this check; it can only lower the backend's limit, never raise it.
    """
    limit = max_qubits(backend)
    if max_qubits_override is not None:
        limit = min(limit, max_qubits_override)
    if circuit.num_qubits > limit:
        raise LimitExceeded(
            TOO_MANY_QUBITS,
            f"a {circuit.num_qubits}-qubit circuit is over the {limit}-qubit limit for {backend}; reduce the number of qubits",
            limit=limit,
            requested=circuit.num_qubits,
            backend=backend,
        )
    if len(circuit.ops) > MAX_OPERATIONS:
        raise LimitExceeded(
            TOO_MANY_OPERATIONS,
            f"{len(circuit.ops)} operations is over the {MAX_OPERATIONS}-operation limit per request",
            limit=MAX_OPERATIONS,
            requested=len(circuit.ops),
            backend=backend,
        )
    if shots is not None and shots > MAX_SHOTS:
        raise LimitExceeded(
            TOO_MANY_SHOTS,
            f"{shots} shots is over the {MAX_SHOTS}-shot limit per request",
            limit=MAX_SHOTS,
            requested=shots,
            backend=backend,
        )


def check_equivalence_limits(num_qubits: int) -> None:
    if num_qubits > EQUIVALENCE_MAX_QUBITS:
        raise LimitExceeded(
            TOO_MANY_QUBITS,
            f"an equivalence check on {num_qubits} qubits needs a 2**{num_qubits} x 2**{num_qubits} operator; "
            f"the limit is {EQUIVALENCE_MAX_QUBITS} qubits",
            limit=EQUIVALENCE_MAX_QUBITS,
            requested=num_qubits,
        )
