"""Trace-step context for the tutor (docs/AI_BOUNDARY.md).

When the learner has a step of an execution trace selected, the browser sends
the step's IDENTITY — step/operation index, the operation, and the ids and
hashes of the provenance record the backend wrote for that step — never its
numbers. This module turns that identity into authoritative ``S#`` facts, and
only after checking it against what the server itself holds.

Nothing here executes anything, computes a state, or trusts a client value:

- the step's amplitudes come from the persisted provenance record the trace
  wrote (``payload["statevector"]``), read once by the API layer and passed in as
  a plain argument (this package never imports the provenance store);
- a single-qubit step's Bloch vector is ``qentor.execution.bloch``'s own
  function of that stored statevector — the very function the trace used when it
  built the step — so it is the backend's number, not a browser's;
- the step's identity is VERIFIED, not believed: the trace built step *k* by
  executing the circuit cut off after operation *k*, so the record's
  ``circuit_hash`` must equal the hash of exactly that prefix of the submitted
  circuit, the claimed operation must be that circuit's operation *k*, and the
  backend, version and execution id must match the record. A step that does not
  add up is refused (``TUTOR_TRACE_STEP_MISMATCH``), never explained.

The previous step (the state "before") is the same kind of record, verified the
same way against the prefix one operation shorter.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict, Field, model_validator

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.bloch import bloch_coordinates
from qentor.execution.sanity import STATE_CHECKED_PLAIN
from qentor.provenance.models import ExecutionStatus, ProvenanceRecord

from .facts import _describe_op
from .models import FactKind, TutorFact

TRACE_RESULT_NOT_FOUND = "TUTOR_TRACE_RESULT_NOT_FOUND"
TRACE_STEP_MISMATCH = "TUTOR_TRACE_STEP_MISMATCH"

_SUPPORT_TOLERANCE = 1e-9
# A trace can span up to 8 qubits (256 amplitudes); a tutor prompt lists at most
# this many non-zero amplitudes per state and says when it stopped.
MAX_LISTED_AMPLITUDES = 16


class TraceContextError(Exception):
    """The claimed trace step does not match what the server holds. ``code`` is
    a stable machine identifier the API layer forwards."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class TraceStepRef(BaseModel):
    """The identity of one trace step, as the browser knows it. IDs, indices,
    the operation and provenance labels only: no amplitude, probability or
    Bloch coordinate has a field here, and ``extra="forbid"`` means none can be
    smuggled in."""

    model_config = ConfigDict(extra="forbid")

    step_index: int = Field(ge=0)
    operation_index: int | None = Field(default=None, ge=0)
    operation: GateOp | None = None
    result_id: str = Field(min_length=1)
    execution_id: str = Field(min_length=1)
    circuit_hash: str = Field(min_length=1)
    backend: str = Field(min_length=1)
    backend_version: str = Field(min_length=1)
    previous_result_id: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _shape_matches_the_step(self) -> "TraceStepRef":
        if self.step_index == 0:
            if self.operation_index is not None or self.operation is not None:
                raise ValueError("step 0 is the initial state: it has no operation_index or operation")
            if self.previous_result_id is not None:
                raise ValueError("step 0 has no previous step")
        else:
            if self.operation_index != self.step_index - 1:
                raise ValueError("operation_index must be step_index - 1 (step 0 is the initial state)")
            if self.operation is None:
                raise ValueError("a step after the initial state needs its operation")
        return self


# One line per gate: what it does IN GENERAL. Textbook, and free of any number
# from a run. The values in an answer always come from the step's own facts.
GATE_NOTES: dict[str, str] = {
    "h": "H (Hadamard) turns a basis state into an equal-size superposition of |0⟩ and |1⟩, and turns those superpositions back into basis states.",
    "x": "X is the bit flip: it swaps the |0⟩ and |1⟩ amplitudes.",
    "y": "Y swaps the |0⟩ and |1⟩ amplitudes and gives them a phase (a factor of i or −i).",
    "z": "Z leaves the |0⟩ amplitude alone and multiplies the |1⟩ amplitude by −1: a phase change that leaves the outcome probabilities as they were.",
    "s": "S leaves the |0⟩ amplitude alone and multiplies the |1⟩ amplitude by i: a quarter-turn of phase.",
    "t": "T leaves the |0⟩ amplitude alone and multiplies the |1⟩ amplitude by a phase of an eighth of a turn.",
    "rx": "RX rotates the state about the x-axis of the Bloch sphere by the gate's angle.",
    "ry": "RY rotates the state about the y-axis of the Bloch sphere by the gate's angle.",
    "rz": "RZ rotates the state about the z-axis of the Bloch sphere by the gate's angle.",
    "sdg": "S† (S-dagger) leaves the |0⟩ amplitude alone and multiplies |1⟩ by −i: a quarter-turn of phase the other way, undoing S.",
    "tdg": "T† (T-dagger) undoes T: it multiplies |1⟩ by a phase of an eighth of a turn the other way.",
    "cz": "CZ flips the sign of the amplitude where both qubits are 1 and leaves every other amplitude alone. It is symmetric in its two qubits and can entangle them.",
    "swap": "SWAP exchanges the states of its two qubits.",
    "ccx": "CCX (Toffoli) flips the target qubit only when both control qubits are 1. It acts on three qubits together.",
    "cx": "CX flips the target qubit when the control qubit is 1. It acts on both qubits together and can entangle them.",
}


@dataclass(frozen=True)
class TraceStepContext:
    step_index: int
    operation_index: int | None
    total_steps: int
    num_qubits: int
    operation: GateOp | None
    result_id: str
    circuit_hash: str
    backend: str
    backend_version: str
    provenance_class: str
    verification_status: str
    # False when the step's own record is not a usable, successful statevector:
    # the tutor then says so instead of explaining anything.
    usable: bool
    facts: tuple[TutorFact, ...]
    groups: dict[str, tuple[TutorFact, ...]] = field(default_factory=dict)

    def group(self, name: str) -> list[TutorFact]:
        return list(self.groups.get(name, ()))


def unitary_ops(circuit: Circuit) -> list[GateOp]:
    """The operations a trace covers: everything before the first ``measure``
    (terminal measurements are stripped from a trace, not stepped through)."""
    first = next((i for i, op in enumerate(circuit.ops) if op.gate is GateName.MEASURE), None)
    return list(circuit.ops if first is None else circuit.ops[:first])


def prefix_hash(circuit: Circuit, ops: list[GateOp], length: int) -> str:
    return circuit_hash(Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=ops[:length]))


def build_trace_step_context(
    ref: TraceStepRef,
    circuit: Circuit,
    record: ProvenanceRecord,
    previous_record: ProvenanceRecord | None,
) -> TraceStepContext:
    """Verify ``ref`` against ``circuit`` and the stored records, then build the
    ``S#`` facts. Raises ``TraceContextError`` for anything that does not add up."""
    ops = unitary_ops(circuit)
    total_steps = len(ops) + 1

    if ref.step_index >= total_steps:
        _mismatch(f"step {ref.step_index} does not exist: the circuit's trace has {total_steps} steps (0..{total_steps - 1})")

    expected = prefix_hash(circuit, ops, ref.step_index)
    if ref.circuit_hash != expected:
        _mismatch(
            f"the step's circuit hash '{ref.circuit_hash}' is not the hash of the circuit cut off after "
            f"step {ref.step_index} ('{expected}')"
        )
    _check_record(record, ref.result_id, expected, "the selected step")
    if record.payload.get("execution_id") != ref.execution_id:
        _mismatch(f"execution id '{ref.execution_id}' is not the one recorded for result '{record.result_id}'")
    if (record.backend, record.backend_version) != (ref.backend, ref.backend_version):
        _mismatch(
            f"backend '{ref.backend} {ref.backend_version}' is not the one recorded for result '{record.result_id}' "
            f"('{record.backend} {record.backend_version}')"
        )
    if ref.step_index > 0 and ops[ref.step_index - 1] != ref.operation:
        _mismatch(f"the claimed operation is not operation {ref.step_index} of the submitted circuit")

    if ref.step_index == 0 and previous_record is not None:
        _mismatch("the initial state has no previous step")
    if previous_record is not None:
        _check_record(
            previous_record, ref.previous_result_id, prefix_hash(circuit, ops, ref.step_index - 1), "the previous step"
        )
        if (previous_record.backend, previous_record.backend_version) != (record.backend, record.backend_version):
            _mismatch("the previous step was produced by a different backend")

    current_state = _usable_state(record, circuit.num_qubits)
    previous_state = _usable_state(previous_record, circuit.num_qubits) if previous_record is not None else None

    builder = _FactBuilder(record.result_id)
    groups: dict[str, list[TutorFact]] = {}

    def add(group: str, kind: FactKind, description: str) -> None:
        groups.setdefault(group, []).append(builder.add(kind, description))

    # -- identity ----------------------------------------------------------------
    if ref.step_index == 0:
        add("step", "trace_step", f"selected trace step 1 of {total_steps}: the initial state, before any operation")
    else:
        add(
            "step",
            "trace_step",
            f"selected trace step {ref.step_index + 1} of {total_steps}: applies {_describe_op(ref.operation)} "
            f"(operation {ref.step_index} of your circuit)",
        )
        note = GATE_NOTES.get(ref.operation.gate.value)
        if note is not None:
            add("gate", "trace_gate_note", note)
    add(
        "status",
        "trace_status",
        f"step result {record.result_id} (execution {ref.execution_id}) on {record.backend} {record.backend_version} "
        f"({record.provenance_class.value}, {record.execution_mode} mode): {record.verification_status.value} "
        f"({STATE_CHECKED_PLAIN})",
    )

    # -- the backend's state, then (single qubit) its Bloch vector ----------------
    if current_state is None:
        add("notes", "trace_note", "this step's record holds no usable statevector, so no state is available for it")
    else:
        _add_state(add, "after", "trace_amplitude", "trace_note", current_state, circuit.num_qubits, "after this step")
        _add_bloch(add, "bloch_after", current_state, circuit.num_qubits, "after this step")
    if ref.step_index > 0:
        if previous_state is None:
            add("notes", "trace_note", "the previous step's state was not available, so no before/after comparison is possible")
        else:
            _add_state(add, "before", "trace_amplitude", "trace_note", previous_state, circuit.num_qubits, "before this step")
            _add_bloch(add, "bloch_before", previous_state, circuit.num_qubits, "before this step")

    all_facts = tuple(f for group in ("step", "gate", "status", "after", "bloch_after", "before", "bloch_before", "notes") for f in groups.get(group, ()))
    # ids are assigned in call order; re-issue them in presentation order so S1.. read top to bottom
    ordered = tuple(TutorFact(id=f"S{i}", kind=f.kind, description=f.description, result_id=f.result_id) for i, f in enumerate(all_facts, start=1))
    remap = {old.id: new for old, new in zip(all_facts, ordered)}
    groups_out = {name: tuple(remap[f.id] for f in members) for name, members in groups.items()}

    return TraceStepContext(
        step_index=ref.step_index,
        operation_index=ref.operation_index,
        total_steps=total_steps,
        num_qubits=circuit.num_qubits,
        operation=ref.operation,
        result_id=record.result_id,
        circuit_hash=record.circuit_hash,
        backend=record.backend,
        backend_version=record.backend_version,
        provenance_class=record.provenance_class.value,
        verification_status=record.verification_status.value,
        usable=current_state is not None,
        facts=ordered,
        groups=groups_out,
    )


# ------------------------------------------------------------------------------ helpers


def _mismatch(message: str) -> None:
    raise TraceContextError(TRACE_STEP_MISMATCH, message)


def _check_record(record: ProvenanceRecord, claimed_id: str | None, expected_hash: str, what: str) -> None:
    if record.result_id != claimed_id:
        _mismatch(f"{what}: result id '{claimed_id}' is not the record that was loaded ('{record.result_id}')")
    if record.circuit_hash != expected_hash:
        _mismatch(
            f"{what}: result '{record.result_id}' was recorded for circuit '{record.circuit_hash}', "
            f"not for the circuit cut off at that step ('{expected_hash}')"
        )
    if record.execution_mode != "statevector":
        _mismatch(f"{what}: result '{record.result_id}' is a {record.execution_mode} run, not a trace step")


def _usable_state(record: ProvenanceRecord | None, num_qubits: int) -> list[list[float]] | None:
    if record is None or record.verification_status != ExecutionStatus.STATE_CHECKED:
        return None
    state = record.payload.get("statevector")
    if not isinstance(state, list) or len(state) != 2**num_qubits:
        return None
    return state


class _FactBuilder:
    """Provisional ids; presentation order is fixed afterwards."""

    def __init__(self, result_id: str) -> None:
        self._result_id = result_id
        self._n = 0

    def add(self, kind: FactKind, description: str) -> TutorFact:
        self._n += 1
        return TutorFact(id=f"tmp{self._n}", kind=kind, description=description, result_id=self._result_id)


def _add_state(add, group, kind, note_kind, state, num_qubits, when) -> None:
    listed = 0
    skipped = 0
    for i, (re, im) in enumerate(state):
        if re * re + im * im <= _SUPPORT_TOLERANCE:
            continue
        if listed >= MAX_LISTED_AMPLITUDES:
            skipped += 1
            continue
        bitstring = format(i, f"0{num_qubits}b")
        add(group, kind, f"{when}, |{bitstring}⟩ amplitude: {re:.6f} + {im:.6f}i")
        listed += 1
    if skipped:
        add(group, note_kind, f"{when}: {skipped} further non-zero amplitudes are not listed")
    add(group, note_kind, f"{when}: every basis state not listed has amplitude zero (within 1e-9)")


def _add_bloch(add, group, state, num_qubits, when) -> None:
    if num_qubits != 1:
        add(group, "trace_note", f"{when}: no Bloch vector — the state has {num_qubits} qubits and a Bloch vector describes one qubit")
        return
    coordinates = bloch_coordinates(state)
    if coordinates is None:
        add(group, "trace_note", f"{when}: the backend state has no valid Bloch vector")
        return
    x, y, z = coordinates
    add(group, "trace_bloch", f"{when}, Bloch vector (derived by the backend from this state): x = {x:.6f}, y = {y:.6f}, z = {z:.6f}")
