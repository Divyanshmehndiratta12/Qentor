"""Execution trace: the backend's own state after each operation of a circuit.

A trace is NOT a second simulator. The state after operation *k* is, by
definition, the statevector the backend produces when it executes the circuit
truncated after operation *k*. So a trace is simply ``N + 1`` ordinary
``adapter.run(prefix, "statevector")`` calls — the very same code path
``POST /api/execute`` uses — one for the empty circuit (the initial state, as
the backend itself represents it) and one for each unitary operation. This
module never computes, normalises, rotates, interpolates or "fills in" an
amplitude; it forwards exactly what each adapter returned. Because it goes
through the ``ExecutionAdapter`` protocol, it works for every adapter that can
run statevector mode (Aer, Cirq, PennyLane), and it cannot exist for one that
can't: a backend that can't produce a state raises, and so does the trace.

Provenance: every step is handed to an injected ``record_execution`` callback
(the API layer's job — like ``qentor.verification.multi_input_harness`` this
module never imports ``ProvenanceStore``), so each step is an ordinary,
independently retrievable provenance record whose ``circuit_hash`` is the hash
of *that step's own prefix circuit*. The record for the final step is
therefore exactly the record ``/api/execute`` would have written for the same
circuit, and is compatible with everything that already reads records
(tutor, verification).

Only ``statevector`` mode can be traced. Shots return sampled counts, not a
state; there is nothing per-step to report and none is invented — a shots
request is refused with ``TraceNotSupported``.

Bloch vectors: for a SINGLE-qubit circuit each step also carries an optional
``bloch_vector`` (``qentor.execution.bloch``) — the one quantity this module
derives rather than forwards. It is computed from that step's own validated,
backend-returned statevector and nothing else (no gate names, no textbook
states), and it is tagged with the step's identity (step index, result id,
execution id, prefix circuit hash, backend and version) so it can never be
detached from the state it came from. A multi-qubit step has ``bloch_vector =
None``: a Bloch vector describes one qubit, an entangled register has no pure
state per qubit, and no reduced-state abstraction exists yet, so nothing is
invented for the whole register. A Bloch vector is not a verdict on the circuit.

Measurement: ``measure`` is not a unitary step. Running a circuit that still
contains one through Aer's ``save_statevector`` lets the projective
measurement collapse the state at random (see the harness docstring), so no
reliable deterministic state exists after it. *Terminal* measurements (every
``measure`` comes after every other op) are therefore stripped from the traced
circuit and reported separately in ``terminal_measurements`` — the
pre-measurement state is the exact, deterministic state. A measurement followed
by further gates is refused outright.

Size limits are supplied by the caller (required keyword arguments) so they
come from constraints the backend already enforces elsewhere rather than
being a private number here; see ``qentor.api.app``.
"""

from __future__ import annotations

from typing import Callable

from pydantic import BaseModel, ConfigDict

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp

from .adapter import ExecutionAdapter, ExecutionMode, ExecutionResult
# NORM_TOLERANCE is the tolerance the rest of Qentor uses for exact statevectors
# (docs/VERIFICATION_ARCHITECTURE.md §4.1: a state is only accepted when its
# norm is within 1e-9 of 1). Defined once in `bloch` (which needs the same
# number) and re-exported here under its existing name.
from .bloch import NORM_TOLERANCE, BlochSource, BlochVector, derive_bloch_vector

TRACE_METHOD = "prefix-statevector"


class TraceNotSupported(ValueError):
    """The request can't be traced (unsupported mode, mid-circuit measurement,
    too large). Raised *before* any backend result is used, and never
    answered with substitute data. ``code`` is a stable machine-readable id."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class TraceBackendFault(RuntimeError):
    """The backend ran but returned something a trace can't honestly use
    (no statevector, wrong length, not normalised). ``circuit_hash`` is the
    prefix that produced it, so the caller can log an ERROR record for it."""

    def __init__(self, code: str, message: str, *, circuit_hash: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.circuit_hash = circuit_hash


class TraceStep(BaseModel):
    """The backend's state after ``operation`` was applied (or the initial
    state, when ``operation`` is ``None``).

    ``operation`` is the canonical ``GateOp`` exactly as it appears in the
    submitted circuit and ``operation_index`` its index in that circuit's
    ``ops``; both are ``None`` for the initial state (``step_index`` 0).
    ``statevector`` is the adapter's own ``[[re, im], ...]`` list, index *k*
    being bitstring ``q[n-1]...q[0]``, untouched.

    ``bloch_vector`` is present only for a single-qubit circuit: derived from
    this step's own statevector, tagged with this step's identity. ``None``
    for every multi-qubit step (see the module docstring).
    """

    model_config = ConfigDict(extra="forbid")

    step_index: int
    operation_index: int | None
    operation: GateOp | None
    prefix_circuit_hash: str
    result_id: str | None
    execution_id: str
    statevector: list[list[float]]
    bloch_vector: BlochVector | None = None


class TerminalMeasurement(BaseModel):
    """A trailing ``measure`` that was stripped before tracing. No state is
    reported for it — see the module docstring."""

    model_config = ConfigDict(extra="forbid")

    operation_index: int
    operation: GateOp


class ExecutionTrace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit_hash: str  # the circuit as submitted
    traced_circuit_hash: str  # terminal measurements stripped == last step's hash
    backend: str
    backend_version: str
    num_qubits: int
    trace_method: str
    steps: list[TraceStep]
    terminal_measurements: list[TerminalMeasurement]

    @property
    def final_result_id(self) -> str | None:
        return self.steps[-1].result_id


def trace_circuit(
    circuit: Circuit,
    adapter: ExecutionAdapter,
    *,
    mode: ExecutionMode = "statevector",
    max_qubits: int,
    max_operations: int,
    record_execution: Callable[[ExecutionResult, str], str] | None = None,
) -> ExecutionTrace:
    """Trace ``circuit`` on ``adapter``.

    Raises ``TraceNotSupported`` for a request that can't be traced,
    ``TraceBackendFault`` if the backend returns an unusable state, and lets
    ``AdapterUnavailable`` / ``AdapterExecutionError`` propagate unchanged —
    a backend that can't run is reported as exactly that, never papered over.

    ``record_execution(result, prefix_hash) -> result_id`` is called once per
    step with the adapter's real result; left as ``None`` the trace is
    identical except ``result_id`` stays ``None`` (used by unit tests that
    have no store).
    """
    if mode != "statevector":
        raise TraceNotSupported(
            "TRACE_MODE_UNSUPPORTED",
            f"execution trace is only available in statevector mode; {mode!r} mode returns "
            "sampled counts, which have no per-operation state to trace",
        )

    unitary_ops, terminal_measurements = split_terminal_measurements(circuit)

    if circuit.num_qubits > max_qubits:
        raise TraceNotSupported(
            "TRACE_CIRCUIT_TOO_LARGE",
            f"circuit has {circuit.num_qubits} qubits; a trace keeps a full statevector per "
            f"step and is limited to {max_qubits} qubits",
        )
    if len(unitary_ops) > max_operations:
        raise TraceNotSupported(
            "TRACE_TOO_MANY_OPERATIONS",
            f"circuit has {len(unitary_ops)} operations; a trace runs the backend once per "
            f"operation and is limited to {max_operations}",
        )

    steps: list[TraceStep] = []
    backend_name: str | None = None
    backend_version: str | None = None

    for step_index in range(len(unitary_ops) + 1):
        prefix = Circuit(
            num_qubits=circuit.num_qubits,
            num_clbits=circuit.num_clbits,
            ops=unitary_ops[:step_index],
        )
        prefix_hash = circuit_hash(prefix)

        result = adapter.run(prefix, "statevector")
        _require_usable_state(result, circuit.num_qubits, prefix_hash)

        if backend_name is None:
            backend_name, backend_version = result.backend_name, result.backend_version
        elif (result.backend_name, result.backend_version) != (backend_name, backend_version):
            raise TraceBackendFault(
                "TRACE_BACKEND_CHANGED",
                "the backend identity changed part-way through the trace "
                f"({backend_name} {backend_version} -> {result.backend_name} {result.backend_version})",
                circuit_hash=prefix_hash,
            )

        result_id = record_execution(result, prefix_hash) if record_execution else None

        # Derived from THIS step's validated state, and tagged with the very
        # identifiers this step is built from (same loop iteration, same
        # variables) so the two cannot drift apart. Only a single-qubit
        # register has a Bloch vector; a multi-qubit step gets None.
        bloch_vector = None
        if circuit.num_qubits == 1:
            bloch_vector = derive_bloch_vector(
                result.statevector,
                source=BlochSource(
                    step_index=step_index,
                    result_id=result_id,
                    execution_id=result.execution_id,
                    circuit_hash=prefix_hash,
                    backend=result.backend_name,
                    backend_version=result.backend_version,
                ),
            )

        steps.append(
            TraceStep(
                step_index=step_index,
                operation_index=None if step_index == 0 else step_index - 1,
                operation=None if step_index == 0 else unitary_ops[step_index - 1],
                prefix_circuit_hash=prefix_hash,
                result_id=result_id,
                execution_id=result.execution_id,
                statevector=result.statevector,
                bloch_vector=bloch_vector,
            )
        )

    assert backend_name is not None and backend_version is not None  # >= 1 step always runs
    return ExecutionTrace(
        circuit_hash=circuit_hash(circuit),
        traced_circuit_hash=steps[-1].prefix_circuit_hash,
        backend=backend_name,
        backend_version=backend_version,
        num_qubits=circuit.num_qubits,
        trace_method=TRACE_METHOD,
        steps=steps,
        terminal_measurements=terminal_measurements,
    )


def split_terminal_measurements(circuit: Circuit) -> tuple[list[GateOp], list[TerminalMeasurement]]:
    """Ops before the first ``measure`` are traced; ``measure`` ops after that
    must all be measures (terminal). Anything else after a measure is refused."""
    first_measure = next((i for i, op in enumerate(circuit.ops) if op.gate is GateName.MEASURE), None)
    if first_measure is None:
        return list(circuit.ops), []

    tail = circuit.ops[first_measure:]
    for offset, op in enumerate(tail):
        if op.gate is not GateName.MEASURE:
            raise TraceNotSupported(
                "TRACE_MID_CIRCUIT_MEASUREMENT",
                f"op[{first_measure + offset}] ({op.gate.value}) comes after a measurement "
                f"(op[{first_measure}]); measurement collapses the state at random, so no "
                "deterministic per-step state exists after it. Only measurements at the end "
                "of the circuit can be traced",
            )
    return list(circuit.ops[:first_measure]), [
        TerminalMeasurement(operation_index=first_measure + i, operation=op) for i, op in enumerate(tail)
    ]


def _require_usable_state(result: ExecutionResult, num_qubits: int, prefix_hash: str) -> None:
    """Reject — never repair — a result that isn't a real, normalised state."""
    state = result.statevector
    if result.execution_mode != "statevector" or state is None:
        raise TraceBackendFault(
            "TRACE_BACKEND_RETURNED_NO_STATE",
            f"backend {result.backend_name!r} returned no statevector for a statevector-mode run; "
            "a trace cannot be built from it",
            circuit_hash=prefix_hash,
        )
    if len(state) != 2**num_qubits:
        raise TraceBackendFault(
            "TRACE_BACKEND_RETURNED_WRONG_SIZE",
            f"backend returned {len(state)} amplitudes for a {num_qubits}-qubit circuit "
            f"(expected {2**num_qubits})",
            circuit_hash=prefix_hash,
        )
    norm = sum(re * re + im * im for re, im in state)
    if not abs(norm - 1.0) <= NORM_TOLERANCE:
        raise TraceBackendFault(
            "TRACE_STATE_NOT_NORMALISED",
            f"backend returned a state whose squared norm is {norm!r}, not 1 within {NORM_TOLERANCE}",
            circuit_hash=prefix_hash,
        )
