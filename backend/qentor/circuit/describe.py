"""One-line, structure-only descriptions of operations, shared by the layers that need to name a gate for a person.

``h on q[0]`` / ``cx control q[0], target q[1]`` / ``ry(1.5707963267948966) on q[1]``. A description says WHICH gate acts on WHICH
qubits and with what angle; it never says what the gate does to a state, so it can appear next to any fact without being one.
Pure functions of the canonical model: no execution, no I/O.
"""

from __future__ import annotations

from .model import GateName, GateOp


def describe_op(op: GateOp) -> str:
    q = lambda i: f"q[{i}]"  # noqa: E731
    gate = op.gate
    if gate is GateName.MEASURE:
        return f"measure {q(op.targets[0])} into c[{op.clbits[0]}]"
    if gate is GateName.SWAP:
        return f"swap {q(op.targets[0])} and {q(op.targets[1])}"
    if gate in (GateName.CX, GateName.CZ):
        return f"{gate.value} control {q(op.controls[0])}, target {q(op.targets[0])}"
    if gate is GateName.CP:
        return f"cp({op.params[0]!r}) control {q(op.controls[0])}, target {q(op.targets[0])}"
    if gate is GateName.CCX:
        return f"ccx controls {q(op.controls[0])}, {q(op.controls[1])}, target {q(op.targets[0])}"
    if op.params:
        return f"{gate.value}({op.params[0]!r}) on {q(op.targets[0])}"
    return f"{gate.value} on {q(op.targets[0])}"
