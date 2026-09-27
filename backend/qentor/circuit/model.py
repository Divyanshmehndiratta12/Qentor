"""Canonical Qentor circuit model — the single source of truth for every module.

Every other part of the backend (the QASM emitter, the circuit hash, the execution
adapters, and later the verification layer) reads and writes this model. Nothing
downstream invents a gate, a qubit index, or a parameter that is not in here.

Milestone 1 gate set: h, x, y, z, s, t, rx, ry, rz, cx, measure.
"""

from __future__ import annotations

import json
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "qentor.circuit/1"


class GateName(str, Enum):
    H = "h"
    X = "x"
    Y = "y"
    Z = "z"
    S = "s"
    T = "t"
    RX = "rx"
    RY = "ry"
    RZ = "rz"
    CX = "cx"
    MEASURE = "measure"


# Gates that take no control qubit and exactly one target.
SINGLE_QUBIT_GATES = {GateName.H, GateName.X, GateName.Y, GateName.Z, GateName.S, GateName.T}
# Gates that take one target and exactly one real-valued parameter (a rotation angle).
PARAMETRIC_GATES = {GateName.RX, GateName.RY, GateName.RZ}


class GateOp(BaseModel):
    """One operation in a circuit.

    - targets: qubit indices the gate acts on (always length 1 in this gate set,
      except CX which has one target and one control).
    - controls: control qubit indices (only CX uses this, exactly one).
    - params: rotation angle in radians (only rx/ry/rz use this, exactly one).
    - clbits: classical bit index written to (only measure uses this, exactly one).
    """

    model_config = ConfigDict(extra="forbid")

    gate: GateName
    targets: list[int] = Field(default_factory=list)
    controls: list[int] = Field(default_factory=list)
    params: list[float] = Field(default_factory=list)
    clbits: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_arity(self) -> "GateOp":
        gate = self.gate

        if gate in SINGLE_QUBIT_GATES:
            if len(self.targets) != 1:
                raise ValueError(f"{gate.value} takes exactly 1 target qubit, got {len(self.targets)}")
            if self.controls:
                raise ValueError(f"{gate.value} takes no control qubits")
            if self.params:
                raise ValueError(f"{gate.value} takes no parameters")
            if self.clbits:
                raise ValueError(f"{gate.value} takes no classical bits")

        elif gate in PARAMETRIC_GATES:
            if len(self.targets) != 1:
                raise ValueError(f"{gate.value} takes exactly 1 target qubit, got {len(self.targets)}")
            if self.controls:
                raise ValueError(f"{gate.value} takes no control qubits")
            if len(self.params) != 1:
                raise ValueError(f"{gate.value} takes exactly 1 parameter (an angle in radians), got {len(self.params)}")
            if not _is_finite(self.params[0]):
                raise ValueError(f"{gate.value} parameter must be a finite number, got {self.params[0]!r}")
            if self.clbits:
                raise ValueError(f"{gate.value} takes no classical bits")

        elif gate is GateName.CX:
            if len(self.targets) != 1:
                raise ValueError(f"cx takes exactly 1 target qubit, got {len(self.targets)}")
            if len(self.controls) != 1:
                raise ValueError(f"cx takes exactly 1 control qubit, got {len(self.controls)}")
            if self.controls[0] == self.targets[0]:
                raise ValueError("cx control and target must be different qubits")
            if self.params:
                raise ValueError("cx takes no parameters")
            if self.clbits:
                raise ValueError("cx takes no classical bits")

        elif gate is GateName.MEASURE:
            if len(self.targets) != 1:
                raise ValueError(f"measure takes exactly 1 target qubit, got {len(self.targets)}")
            if len(self.clbits) != 1:
                raise ValueError(f"measure takes exactly 1 classical bit, got {len(self.clbits)}")
            if self.controls:
                raise ValueError("measure takes no control qubits")
            if self.params:
                raise ValueError("measure takes no parameters")

        else:  # pragma: no cover - Enum already restricts this
            raise ValueError(f"unknown gate {gate!r}")

        return self


def _is_finite(x: float) -> bool:
    return x == x and x not in (float("inf"), float("-inf"))  # noqa: PLR0124 - NaN check


class Circuit(BaseModel):
    """The canonical Qentor circuit.

    Deterministic JSON serialisation: field order is fixed by the model definition,
    ``canonical_json()`` uses sorted, compact separators, and every gate name is a
    plain lowercase string, so the same circuit always produces the same bytes —
    which is what the circuit hash depends on.
    """

    model_config = ConfigDict(extra="forbid")

    schema_: Literal["qentor.circuit/1"] = Field(default=SCHEMA_VERSION, alias="schema")
    num_qubits: int = Field(gt=0, le=32)
    num_clbits: int = Field(ge=0, le=32)
    ops: list[GateOp] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_indices(self) -> "Circuit":
        for i, op in enumerate(self.ops):
            for q in (*op.targets, *op.controls):
                if not (0 <= q < self.num_qubits):
                    raise ValueError(
                        f"op[{i}] ({op.gate.value}): qubit index {q} is out of range "
                        f"for a {self.num_qubits}-qubit circuit"
                    )
            for c in op.clbits:
                if not (0 <= c < self.num_clbits):
                    raise ValueError(
                        f"op[{i}] ({op.gate.value}): classical bit index {c} is out of range "
                        f"for {self.num_clbits} classical bits"
                    )
        return self

    def canonical_dict(self) -> dict:
        """A plain dict with deterministic key order, used for hashing and for the
        canonical JSON representation. Enum values are rendered as their plain string.
        """
        return {
            "schema": self.schema_,
            "num_qubits": self.num_qubits,
            "num_clbits": self.num_clbits,
            "ops": [
                {
                    "gate": op.gate.value,
                    "targets": list(op.targets),
                    "controls": list(op.controls),
                    "params": list(op.params),
                    "clbits": list(op.clbits),
                }
                for op in self.ops
            ],
        }

    def canonical_json(self) -> str:
        """Deterministic, compact JSON text. Same circuit -> same string, always."""
        return json.dumps(self.canonical_dict(), sort_keys=True, separators=(",", ":"))

    @classmethod
    def from_canonical_json(cls, text: str) -> "Circuit":
        return cls.model_validate(json.loads(text))
