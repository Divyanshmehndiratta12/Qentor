"""Deterministic OpenQASM 3 emitter for the canonical circuit model.

This emitter never executes anything and never interprets arbitrary text — it only
walks a validated ``Circuit`` and prints fixed, known-safe statements. There is no
code path here that can run learner- or AI-supplied Python.

The same ``Circuit`` always produces byte-identical QASM text, which is what the
circuit hash (``qentor.circuit.hashing``) depends on.

Independent verification of this emitter's output belongs in
``backend/tests/test_qasm_emitter.py``, which re-parses the emitted text with
Qiskit's own ``qasm3`` importer — a second, independent parser — and compares the
result against the original model. That test is written but is a documented SKIP
in this environment; see docs/BUILD_STATE.md.
"""

from __future__ import annotations

from .model import Circuit, GateName

# Gate names that take no parameters and map 1:1 onto an OpenQASM 3 stdgate call.
_SIMPLE_GATE_QASM = {
    GateName.H: "h",
    GateName.X: "x",
    GateName.Y: "y",
    GateName.Z: "z",
    GateName.S: "s",
    GateName.SDG: "sdg",
    GateName.T: "t",
    GateName.TDG: "tdg",
}
_ROTATION_GATE_QASM = {
    GateName.RX: "rx",
    GateName.RY: "ry",
    GateName.RZ: "rz",
}


def _format_angle(theta: float) -> str:
    """Deterministic, round-trip-safe float formatting.

    ``repr(float)`` in CPython has produced the shortest string that round-trips
    back to the same float since Python 3.1, so the same angle always renders the
    same text regardless of when or where this runs.
    """
    return repr(float(theta))


def to_qasm3(circuit: Circuit) -> str:
    """Emit deterministic OpenQASM 3 text for a canonical circuit."""
    lines: list[str] = [
        "OPENQASM 3.0;",
        'include "stdgates.inc";',
        f"qubit[{circuit.num_qubits}] q;",
    ]
    if circuit.num_clbits > 0:
        lines.append(f"bit[{circuit.num_clbits}] c;")

    for op in circuit.ops:
        if op.gate in _SIMPLE_GATE_QASM:
            name = _SIMPLE_GATE_QASM[op.gate]
            lines.append(f"{name} q[{op.targets[0]}];")

        elif op.gate in _ROTATION_GATE_QASM:
            name = _ROTATION_GATE_QASM[op.gate]
            angle = _format_angle(op.params[0])
            lines.append(f"{name}({angle}) q[{op.targets[0]}];")

        elif op.gate is GateName.CX:
            lines.append(f"cx q[{op.controls[0]}], q[{op.targets[0]}];")

        elif op.gate is GateName.CZ:
            lines.append(f"cz q[{op.controls[0]}], q[{op.targets[0]}];")

        elif op.gate is GateName.CP:
            lines.append(f"cp({_format_angle(op.params[0])}) q[{op.controls[0]}], q[{op.targets[0]}];")

        elif op.gate is GateName.SWAP:
            lines.append(f"swap q[{op.targets[0]}], q[{op.targets[1]}];")

        elif op.gate is GateName.CCX:
            lines.append(f"ccx q[{op.controls[0]}], q[{op.controls[1]}], q[{op.targets[0]}];")

        elif op.gate is GateName.MEASURE:
            lines.append(f"c[{op.clbits[0]}] = measure q[{op.targets[0]}];")

        else:  # pragma: no cover - Circuit validation already restricts gate names
            raise ValueError(f"unsupported gate for QASM emission: {op.gate!r}")

    return "\n".join(lines) + "\n"
