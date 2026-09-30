"""Read-only Qiskit, Cirq and PennyLane source for a canonical circuit.

This is TEXT, generated from the validated ``Circuit`` by fixed templates — the same
discipline as the OpenQASM emitter (``qentor.circuit.qasm``): the only things that ever
appear in the output are fixed gate calls, integers taken from the model, and floats printed
with ``repr``. Nothing here runs, imports or evaluates anything, and the browser never
executes it. The adapters do NOT run this text (they build native circuits from the model,
docs/ARCHITECTURE.md §6); the views exist so a learner can see, and copy, what the same circuit
looks like in each SDK.

What the tests pin (``tests/test_codegen.py``):

* golden text for every shared fixture (``fixtures/circuits/*.json``, ``code`` field);
* the program is only calls from a short allow-list (an AST check, over the fixtures and random
  circuits), so no free text can ever reach the output;
* in the test suite ONLY, each measurement-free program is executed and its state compared with the
  backend's — proof the view means what the circuit means, for every gate and operand order.

Conventions, stated in the generated code where they matter:

* Qiskit lists qubit 0 as the least significant bit of a basis state; Cirq and PennyLane list
  qubit/wire 0 first. Qentor displays ``q[n-1] … q[0]`` (Qiskit order). The Cirq and PennyLane
  programs use qubit *i* / wire *i* for canonical qubit *i*, so the physics is identical and only
  the printed ordering of a state differs; a comment says so.
* A classical bit ``c<k>`` becomes a Cirq measurement key ``"c<k>"``.
"""

from __future__ import annotations

from .model import Circuit, GateName, GateOp
from .qasm import _format_angle

CODEGEN_VERSION = "1"
FRAMEWORKS = ("qiskit", "cirq", "pennylane")

_QISKIT_SIMPLE = {
    GateName.H: "h",
    GateName.X: "x",
    GateName.Y: "y",
    GateName.Z: "z",
    GateName.S: "s",
    GateName.SDG: "sdg",
    GateName.T: "t",
    GateName.TDG: "tdg",
}
_QISKIT_ROTATION = {GateName.RX: "rx", GateName.RY: "ry", GateName.RZ: "rz"}

_CIRQ_SIMPLE = {
    GateName.H: "cirq.H(q[{t}])",
    GateName.X: "cirq.X(q[{t}])",
    GateName.Y: "cirq.Y(q[{t}])",
    GateName.Z: "cirq.Z(q[{t}])",
    GateName.S: "cirq.S(q[{t}])",
    GateName.SDG: "(cirq.S**-1)(q[{t}])",
    GateName.T: "cirq.T(q[{t}])",
    GateName.TDG: "(cirq.T**-1)(q[{t}])",
}
_CIRQ_ROTATION = {GateName.RX: "cirq.rx", GateName.RY: "cirq.ry", GateName.RZ: "cirq.rz"}

_PENNYLANE_SIMPLE = {
    GateName.H: "qml.Hadamard(wires={t})",
    GateName.X: "qml.PauliX(wires={t})",
    GateName.Y: "qml.PauliY(wires={t})",
    GateName.Z: "qml.PauliZ(wires={t})",
    GateName.S: "qml.S(wires={t})",
    GateName.SDG: "qml.adjoint(qml.S)(wires={t})",
    GateName.T: "qml.T(wires={t})",
    GateName.TDG: "qml.adjoint(qml.T)(wires={t})",
}
_PENNYLANE_ROTATION = {GateName.RX: "qml.RX", GateName.RY: "qml.RY", GateName.RZ: "qml.RZ"}


def generate_code(circuit: Circuit, framework: str) -> str:
    """The program text for ``circuit`` in ``framework`` (``qiskit`` | ``cirq`` | ``pennylane``)."""
    if framework == "qiskit":
        return _qiskit(circuit)
    if framework == "cirq":
        return _cirq(circuit)
    if framework == "pennylane":
        return _pennylane(circuit)
    raise ValueError(f"unknown framework {framework!r}; expected one of {FRAMEWORKS}")


def generate_all(circuit: Circuit) -> dict[str, str]:
    return {name: generate_code(circuit, name) for name in FRAMEWORKS}


# --------------------------------------------------------------------------- #


def _qiskit(circuit: Circuit) -> str:
    size = f"{circuit.num_qubits}, {circuit.num_clbits}" if circuit.num_clbits else f"{circuit.num_qubits}"
    lines = ["from qiskit import QuantumCircuit", "", f"qc = QuantumCircuit({size})"]
    for op in circuit.ops:
        lines.append(_qiskit_op(op))
    return "\n".join(lines) + "\n"


def _qiskit_op(op: GateOp) -> str:
    g = op.gate
    if g in _QISKIT_SIMPLE:
        return f"qc.{_QISKIT_SIMPLE[g]}({op.targets[0]})"
    if g in _QISKIT_ROTATION:
        return f"qc.{_QISKIT_ROTATION[g]}({_format_angle(op.params[0])}, {op.targets[0]})"
    if g is GateName.CX:
        return f"qc.cx({op.controls[0]}, {op.targets[0]})"
    if g is GateName.CZ:
        return f"qc.cz({op.controls[0]}, {op.targets[0]})"
    if g is GateName.SWAP:
        return f"qc.swap({op.targets[0]}, {op.targets[1]})"
    if g is GateName.CCX:
        return f"qc.ccx({op.controls[0]}, {op.controls[1]}, {op.targets[0]})"
    if g is GateName.MEASURE:
        return f"qc.measure({op.targets[0]}, {op.clbits[0]})"
    raise ValueError(f"no Qiskit rendering for gate {g!r}")  # pragma: no cover


def _cirq(circuit: Circuit) -> str:
    lines = [
        "import cirq",
        "",
        f"q = cirq.LineQubit.range({circuit.num_qubits})",
        "# Cirq lists q[0] first in a state; Qiskit lists qubit 0 last. The circuit is the same.",
    ]
    if not circuit.ops:
        lines.append("circuit = cirq.Circuit()")
    else:
        lines.append("circuit = cirq.Circuit(")
        lines.extend(f"    {_cirq_op(op)}," for op in circuit.ops)
        lines.append(")")
    return "\n".join(lines) + "\n"


def _cirq_op(op: GateOp) -> str:
    g = op.gate
    if g in _CIRQ_SIMPLE:
        return _CIRQ_SIMPLE[g].format(t=op.targets[0])
    if g in _CIRQ_ROTATION:
        return f"{_CIRQ_ROTATION[g]}({_format_angle(op.params[0])})(q[{op.targets[0]}])"
    if g is GateName.CX:
        return f"cirq.CNOT(q[{op.controls[0]}], q[{op.targets[0]}])"
    if g is GateName.CZ:
        return f"cirq.CZ(q[{op.controls[0]}], q[{op.targets[0]}])"
    if g is GateName.SWAP:
        return f"cirq.SWAP(q[{op.targets[0]}], q[{op.targets[1]}])"
    if g is GateName.CCX:
        return f"cirq.CCX(q[{op.controls[0]}], q[{op.controls[1]}], q[{op.targets[0]}])"
    if g is GateName.MEASURE:
        return f'cirq.measure(q[{op.targets[0]}], key="c{op.clbits[0]}")'
    raise ValueError(f"no Cirq rendering for gate {g!r}")  # pragma: no cover


def _pennylane(circuit: Circuit) -> str:
    measured = [op for op in circuit.ops if op.gate is GateName.MEASURE]
    lines = [
        "import pennylane as qml",
        "",
        f'dev = qml.device("default.qubit", wires={circuit.num_qubits})',
        "",
        "",
        "@qml.qnode(dev)",
        "def circuit():",
    ]
    for op in circuit.ops:
        if op.gate is not GateName.MEASURE:
            lines.append(f"    {_pennylane_op(op)}")
    if measured:
        wires = ", ".join(str(op.targets[0]) for op in measured)
        lines.append("    # measured: " + ", ".join(f"q{op.targets[0]} -> c{op.clbits[0]}" for op in measured))
        lines.append(f"    return qml.probs(wires=[{wires}])")
    else:
        lines.append("    # PennyLane lists wire 0 first in a state; Qiskit lists qubit 0 last. The circuit is the same.")
        lines.append("    return qml.state()")
    return "\n".join(lines) + "\n"


def _pennylane_op(op: GateOp) -> str:
    g = op.gate
    if g in _PENNYLANE_SIMPLE:
        return _PENNYLANE_SIMPLE[g].format(t=op.targets[0])
    if g in _PENNYLANE_ROTATION:
        return f"{_PENNYLANE_ROTATION[g]}({_format_angle(op.params[0])}, wires={op.targets[0]})"
    if g is GateName.CX:
        return f"qml.CNOT(wires=[{op.controls[0]}, {op.targets[0]}])"
    if g is GateName.CZ:
        return f"qml.CZ(wires=[{op.controls[0]}, {op.targets[0]}])"
    if g is GateName.SWAP:
        return f"qml.SWAP(wires=[{op.targets[0]}, {op.targets[1]}])"
    if g is GateName.CCX:
        return f"qml.Toffoli(wires=[{op.controls[0]}, {op.controls[1]}, {op.targets[0]}])"
    raise ValueError(f"no PennyLane rendering for gate {g!r}")  # pragma: no cover
