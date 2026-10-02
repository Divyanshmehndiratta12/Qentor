"""WHAT_IF: a safe counterfactual of one circuit.

The learner names ONE explicit modification from a closed set (remove a gate, replace a gate with another, change an angle,
insert a gate). The server validates it, builds the counterfactual canonical circuit itself, hashes it, runs the original and the
counterfactual on the backend and compares the two runs with the platform's own comparison (``experiment_compare``). Everything
the answer says is read from those runs.

What cannot happen here, by construction:

* no code is read or executed: a modification is a small typed record (``extra="forbid"``), and the counterfactual is built from
  the canonical ``Circuit`` model, which validates every gate it holds;
* nothing unbounded is generated: one modification adds at most one operation, and the counterfactual must fit
  ``WHATIF_MAX_QUBITS`` qubits and ``WHATIF_MAX_OPERATIONS`` operations or it is refused (the original, too);
* no result comes from the client: there is no field for an expected probability, state or verdict. The only things a client may
  send beside the circuit and the modification are the hashes it was SHOWN in the preview, and they are compared, never trusted:
  a hash that is not the one the server computes now means the circuit changed since the preview (``REASONING_STALE_CIRCUIT``).
"""

from __future__ import annotations

import math
from typing import Annotated, Callable, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from qentor.circuit.describe import describe_op
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import PARAMETRIC_GATES, SINGLE_QUBIT_GATES, Circuit, GateName, GateOp
from qentor.circuit.qasm import to_qasm3
from qentor.execution.trace import TraceNotSupported, split_terminal_measurements
from qentor.provenance.models import ExecutionStatus, ProvenanceRecord
from qentor.verification.experiment_compare import compare_experiments
from qentor.verification.multi_input_harness import MAX_SWEEP_QUBITS
from qentor.verification.optimizer import OpChange, diff_ops

from .models import Analysis, Intent, ReasoningError, source_of

# The same qubit limit the trace and the harness keep for exhaustive statevector work; one number, not a private one.
WHATIF_MAX_QUBITS = MAX_SWEEP_QUBITS
# The largest circuit a challenge allows (``Constraints.max_ops``): a what-if is a classroom-sized question, not a benchmark.
WHATIF_MAX_OPERATIONS = 64
# An angle is a number of radians; a few turns either way is more than any lesson needs, and it keeps the value a sane float.
MAX_ANGLE = 8 * math.pi
MAX_INDEX = 1000

_ROTATIONS = (GateName.RX, GateName.RY, GateName.RZ)
_FIXED_SINGLE = tuple(sorted(SINGLE_QUBIT_GATES, key=lambda g: g.value))
_ONE_QUBIT_GATES = (*_FIXED_SINGLE, *_ROTATIONS)
_CONTROLLED_PAIR = (GateName.CX, GateName.CZ)

# What a client may name as a new gate: every gate of the model except a measurement.
InsertableGate = Literal["h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz", "cx", "cz", "cp", "swap", "ccx"]
ReplacementGate = Literal["h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz", "cx", "cz"]
_Angle = Annotated[float, Field(ge=-MAX_ANGLE, le=MAX_ANGLE, allow_inf_nan=False)]


class RemoveGate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["remove_gate"] = "remove_gate"
    index: int = Field(ge=0, le=MAX_INDEX)


class ReplaceGate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["replace_gate"] = "replace_gate"
    index: int = Field(ge=0, le=MAX_INDEX)
    gate: ReplacementGate
    angle: _Angle | None = None


class SetAngle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["set_angle"] = "set_angle"
    index: int = Field(ge=0, le=MAX_INDEX)
    angle: _Angle


class InsertGate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["insert_gate"] = "insert_gate"
    index: int = Field(ge=0, le=MAX_INDEX)
    gate: InsertableGate
    targets: list[int] = Field(min_length=1, max_length=2)
    controls: list[int] = Field(default_factory=list, max_length=2)
    angle: _Angle | None = None


Modification = Annotated[Union[RemoveGate, ReplaceGate, SetAngle, InsertGate], Field(discriminator="op")]


class WhatIfRejected(ReasoningError):
    """The modification is not one the server will apply. ``code`` names why."""


def _reject(code: str, message: str) -> WhatIfRejected:
    return WhatIfRejected(code, message)


def _check_original(circuit: Circuit) -> None:
    if circuit.num_qubits > WHATIF_MAX_QUBITS:
        raise _reject(
            "WHATIF_TOO_MANY_QUBITS",
            f"a what-if analysis keeps a statevector per run and is limited to {WHATIF_MAX_QUBITS} qubits; this circuit has {circuit.num_qubits}",
        )
    if len(circuit.ops) > WHATIF_MAX_OPERATIONS:
        raise _reject(
            "WHATIF_TOO_MANY_OPERATIONS",
            f"a what-if analysis is limited to circuits of at most {WHATIF_MAX_OPERATIONS} operations; this one has {len(circuit.ops)}",
        )
    _check_measurements(circuit)


def _check_measurements(circuit: Circuit) -> None:
    try:
        split_terminal_measurements(circuit)
    except TraceNotSupported as exc:
        raise _reject("WHATIF_MID_CIRCUIT_MEASUREMENT", exc.message) from exc


def _op_at(circuit: Circuit, index: int) -> GateOp:
    if index >= len(circuit.ops):
        raise _reject(
            "WHATIF_INDEX_OUT_OF_RANGE",
            f"operation {index} does not exist: the circuit has {len(circuit.ops)} operation{'' if len(circuit.ops) == 1 else 's'} (numbered from 0)",
        )
    return circuit.ops[index]


def _new_op(gate: str, targets: list[int], controls: list[int], angle: float | None) -> GateOp:
    name = GateName(gate)
    parametric = name in PARAMETRIC_GATES or name is GateName.CP
    if parametric and angle is None:
        raise _reject("WHATIF_ANGLE_REQUIRED", f"{gate} needs an angle in radians")
    if not parametric and angle is not None:
        raise _reject("WHATIF_ANGLE_NOT_ALLOWED", f"{gate} takes no angle")
    try:
        return GateOp(gate=name, targets=targets, controls=controls, params=[angle] if parametric else [], clbits=[])
    except ValidationError as exc:
        raise _reject("WHATIF_INVALID_GATE", _first_message(exc)) from exc


def _first_message(exc: ValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "the gate is not valid"
    message = str(errors[0].get("msg", "the gate is not valid"))
    return message.removeprefix("Value error, ")


def _with_ops(circuit: Circuit, ops: list[GateOp]) -> Circuit:
    try:
        return Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=ops)
    except ValidationError as exc:
        raise _reject("WHATIF_INVALID_GATE", _first_message(exc)) from exc


def apply_modification(circuit: Circuit, modification: Modification) -> tuple[Circuit, str]:
    """The counterfactual circuit and a sentence saying what was changed. Raises ``WhatIfRejected``; never edits ``circuit``."""
    _check_original(circuit)
    ops = list(circuit.ops)

    if isinstance(modification, RemoveGate):
        old = _op_at(circuit, modification.index)
        del ops[modification.index]
        description = f"remove operation {modification.index} ({describe_op(old)})"

    elif isinstance(modification, ReplaceGate):
        old = _op_at(circuit, modification.index)
        if old.gate in _ONE_QUBIT_GATES:
            if GateName(modification.gate) not in _ONE_QUBIT_GATES:
                raise _reject(
                    "WHATIF_REPLACEMENT_INCOMPATIBLE",
                    f"{old.gate.value} acts on one qubit; it can be replaced only by another one-qubit gate ({', '.join(g.value for g in _ONE_QUBIT_GATES)})",
                )
            new_gate = GateName(modification.gate)
            angle = modification.angle
            if new_gate in _ROTATIONS and angle is None and old.gate in _ROTATIONS:
                angle = old.params[0]  # a rotation replaced by another rotation keeps its angle unless a new one is named
            new = _new_op(modification.gate, list(old.targets), [], angle)
        elif old.gate in _CONTROLLED_PAIR:
            if GateName(modification.gate) not in _CONTROLLED_PAIR:
                raise _reject(
                    "WHATIF_REPLACEMENT_INCOMPATIBLE", f"{old.gate.value} can be replaced only by cx or cz, on the same two qubits"
                )
            new = _new_op(modification.gate, list(old.targets), list(old.controls), modification.angle)
        else:
            raise _reject(
                "WHATIF_REPLACEMENT_UNSUPPORTED",
                f"{old.gate.value} cannot be replaced here: only a one-qubit gate, cx or cz can",
            )
        if new == old:
            raise _reject("WHATIF_NO_CHANGE", "that replacement is the gate the circuit already has, so it would change nothing")
        ops[modification.index] = new
        description = f"replace operation {modification.index} ({describe_op(old)}) with {describe_op(new)}"

    elif isinstance(modification, SetAngle):
        old = _op_at(circuit, modification.index)
        if old.gate not in (*_ROTATIONS, GateName.CP):
            raise _reject(
                "WHATIF_NOT_A_ROTATION",
                f"operation {modification.index} is {old.gate.value}, which has no angle to change (only rx, ry, rz and cp do)",
            )
        if modification.angle == old.params[0]:
            raise _reject("WHATIF_NO_CHANGE", "that angle is the one the gate already has, so it would change nothing")
        new = GateOp(gate=old.gate, targets=list(old.targets), controls=list(old.controls), params=[modification.angle], clbits=[])
        ops[modification.index] = new
        description = f"change the angle of operation {modification.index} ({describe_op(old)}) to {modification.angle!r} radians"

    else:  # InsertGate
        if modification.index > len(ops):
            raise _reject(
                "WHATIF_INDEX_OUT_OF_RANGE",
                f"cannot insert at position {modification.index}: the circuit has {len(ops)} operation{'' if len(ops) == 1 else 's'}, so positions run 0 to {len(ops)}",
            )
        new = _new_op(modification.gate, list(modification.targets), list(modification.controls), modification.angle)
        ops.insert(modification.index, new)
        description = f"insert {describe_op(new)} as operation {modification.index}"

    counterfactual = _with_ops(circuit, ops)
    if len(counterfactual.ops) > WHATIF_MAX_OPERATIONS:
        raise _reject(
            "WHATIF_TOO_MANY_OPERATIONS",
            f"the counterfactual would have {len(counterfactual.ops)} operations; a what-if analysis is limited to {WHATIF_MAX_OPERATIONS}",
        )
    _check_measurements(counterfactual)
    return counterfactual, description


class WhatIfPreview(BaseModel):
    """What the learner is shown BEFORE anything runs: the counterfactual the server built, its hash, and what differs."""

    model_config = ConfigDict(extra="forbid")

    description: str
    original_circuit_hash: str
    counterfactual_circuit: Circuit
    counterfactual_circuit_hash: str
    counterfactual_qasm: str
    original_op_count: int
    counterfactual_op_count: int
    changes: list[OpChange]


def preview_what_if(circuit: Circuit, modification: Modification) -> WhatIfPreview:
    counterfactual, description = apply_modification(circuit, modification)
    return WhatIfPreview(
        description=description,
        original_circuit_hash=circuit_hash(circuit),
        counterfactual_circuit=counterfactual,
        counterfactual_circuit_hash=circuit_hash(counterfactual),
        counterfactual_qasm=to_qasm3(counterfactual),
        original_op_count=len(circuit.ops),
        counterfactual_op_count=len(counterfactual.ops),
        changes=diff_ops(circuit, counterfactual),
    )


def check_not_stale(circuit: Circuit, expected_original_hash: str | None, expected_counterfactual_hash: str | None, counterfactual: Circuit) -> None:
    """The hashes the client was shown must be the ones the server computes now."""
    if expected_original_hash is not None and expected_original_hash != circuit_hash(circuit):
        raise ReasoningError(
            "REASONING_STALE_CIRCUIT",
            "the circuit has changed since this preview was made (its hash is not the one that was shown); preview the change again",
            status=409,
        )
    if expected_counterfactual_hash is not None and expected_counterfactual_hash != circuit_hash(counterfactual):
        raise ReasoningError(
            "REASONING_STALE_CIRCUIT",
            "the counterfactual the server builds now is not the one that was shown in the preview; preview the change again",
            status=409,
        )


def _unitary(circuit: Circuit) -> Circuit:
    ops, _ = split_terminal_measurements(circuit)
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=list(ops))


def analyze_what_if(
    circuit: Circuit,
    modification: Modification,
    *,
    runner: Callable[[Circuit], ProvenanceRecord],
    expected_original_hash: str | None = None,
    expected_counterfactual_hash: str | None = None,
) -> tuple[Analysis, WhatIfPreview]:
    """Build the counterfactual, run both circuits' states on the backend and compare them. Returns the analysis and its preview."""
    counterfactual, description = apply_modification(circuit, modification)
    check_not_stale(circuit, expected_original_hash, expected_counterfactual_hash, counterfactual)
    preview = WhatIfPreview(
        description=description,
        original_circuit_hash=circuit_hash(circuit),
        counterfactual_circuit=counterfactual,
        counterfactual_circuit_hash=circuit_hash(counterfactual),
        counterfactual_qasm=to_qasm3(counterfactual),
        original_op_count=len(circuit.ops),
        counterfactual_op_count=len(counterfactual.ops),
        changes=diff_ops(circuit, counterfactual),
    )

    # Both runs are statevector runs of the circuit WITHOUT its terminal measurements: a statevector taken after a measurement is a
    # collapsed state, not the state the circuit prepares.
    record_a = runner(_unitary(circuit))
    record_b = runner(_unitary(counterfactual))
    for label, record in (("original", record_a), ("counterfactual", record_b)):
        if record.verification_status != ExecutionStatus.STATE_CHECKED or "statevector" not in record.payload:
            raise ReasoningError("REASONING_RESULT_UNUSABLE", f"the backend's run of the {label} circuit was not usable; nothing was compared")

    comparison = compare_experiments(circuit, record_a.payload, counterfactual, record_b.payload)
    data = {
        "description": description,
        "modification": modification.model_dump(mode="json"),
        "original_circuit_hash": preview.original_circuit_hash,
        "counterfactual_circuit_hash": preview.counterfactual_circuit_hash,
        "counterfactual_qasm": preview.counterfactual_qasm,
        "original_op_count": preview.original_op_count,
        "counterfactual_op_count": preview.counterfactual_op_count,
        "changes": [c.model_dump(mode="json") for c in preview.changes],
        "comparison": comparison.model_dump(mode="json"),
        "compared_values": "theoretical probabilities and statevectors of the circuits without their terminal measurements",
    }
    analysis = Analysis(
        intent=Intent.WHAT_IF,
        status="OK",
        circuit_hash=preview.original_circuit_hash,
        sources=[source_of("original", record_a), source_of("counterfactual", record_b)],
        data=data,
    )
    return analysis, preview
