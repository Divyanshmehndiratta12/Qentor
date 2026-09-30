"""PennyLane execution adapter (docs/ARCHITECTURE.md §6).

Builds a native PennyLane circuit directly from the canonical model — never
from generated QASM/source text — exactly like ``AerAdapter``. Every number in
the returned ``ExecutionResult`` comes from PennyLane's own ``default.qubit``
device; nothing here computes a probability, count or statevector by hand.

Bit-order normalisation: PennyLane's own convention makes *wire 0* the
most-significant bit of ``qml.state()``/``qml.counts()`` output, the opposite
of Qentor's Qiskit-style convention (qubit ``k`` contributes ``2**k`` to a
statevector index; displayed bitstrings are ``q[n-1]...q[0]``). Canonical
qubit ``q`` is therefore placed on PennyLane wire ``num_qubits - 1 - q`` for
every gate and every measured wire — verified against an asymmetric circuit
(not just a qubit-swap-symmetric one like Bell) during development, so
``qml.state()``/``qml.counts()`` already come back in Qentor's own ordering
with no further permutation needed for a fully-measured register. A register
where only some qubits are measured is still re-placed into a full-width,
clbit-indexed string, since ``qml.counts(wires=...)``'s bitstring only
contains the wires actually passed to it.

Shots use a fixed device seed so a given circuit + shot count always
reproduces the same counts — docs/ARCHITECTURE.md §6: "Shots with a fixed,
recorded seed."
"""

from __future__ import annotations

import uuid

from qentor.circuit.model import Circuit, GateName

from .adapter import AdapterExecutionError, AdapterUnavailable, ExecutionMode, ExecutionResult

_SIMPLE_GATE_NAME = {
    GateName.H: "Hadamard",
    GateName.X: "PauliX",
    GateName.Y: "PauliY",
    GateName.Z: "PauliZ",
    GateName.S: "S",
    GateName.T: "T",
}
_ROTATION_GATE_NAME = {
    GateName.RX: "RX",
    GateName.RY: "RY",
    GateName.RZ: "RZ",
}

_SHOTS_SEED = 1234


class PennyLaneAdapter:
    name = "pennylane"

    def run(self, circuit: Circuit, mode: ExecutionMode, shots: int | None = None) -> ExecutionResult:
        try:
            import pennylane as qml
        except Exception as exc:  # noqa: BLE001 - report the real import failure
            raise AdapterUnavailable(f"pennylane could not be imported: {type(exc).__name__}: {exc}") from exc

        has_measure = any(op.gate is GateName.MEASURE for op in circuit.ops)
        if mode == "shots" and not has_measure:
            raise AdapterExecutionError(
                "shots mode requires at least one measure operation in the circuit; "
                "this circuit has none"
            )

        num_qubits = circuit.num_qubits

        def wire_of(qubit: int) -> int:
            return num_qubits - 1 - qubit

        def apply_ops() -> None:
            for op in circuit.ops:
                if op.gate in _SIMPLE_GATE_NAME:
                    getattr(qml, _SIMPLE_GATE_NAME[op.gate])(wires=wire_of(op.targets[0]))
                elif op.gate in _ROTATION_GATE_NAME:
                    getattr(qml, _ROTATION_GATE_NAME[op.gate])(op.params[0], wires=wire_of(op.targets[0]))
                elif op.gate is GateName.CX:
                    qml.CNOT(wires=[wire_of(op.controls[0]), wire_of(op.targets[0])])
                elif op.gate is GateName.CZ:
                    qml.CZ(wires=[wire_of(op.controls[0]), wire_of(op.targets[0])])
                elif op.gate is GateName.SWAP:
                    qml.SWAP(wires=[wire_of(op.targets[0]), wire_of(op.targets[1])])
                elif op.gate is GateName.CCX:
                    qml.Toffoli(wires=[wire_of(op.controls[0]), wire_of(op.controls[1]), wire_of(op.targets[0])])
                elif op.gate is GateName.SDG:
                    qml.adjoint(qml.S)(wires=wire_of(op.targets[0]))
                elif op.gate is GateName.TDG:
                    qml.adjoint(qml.T)(wires=wire_of(op.targets[0]))
                elif op.gate is GateName.MEASURE:
                    pass  # measured wires are declared on the return value below, not inline
                else:  # pragma: no cover - Circuit validation already restricts gate names
                    raise AdapterExecutionError(f"unsupported gate for PennyLane: {op.gate!r}")

        execution_id = f"pennylane-local-{uuid.uuid4().hex[:12]}"
        backend_version = qml.version()

        try:
            if mode == "statevector":
                device = qml.device("default.qubit", wires=num_qubits)

                @qml.qnode(device)
                def statevector_circuit():
                    apply_ops()
                    return qml.state()

                sv = statevector_circuit()
                statevector = [[complex(amp).real, complex(amp).imag] for amp in sv]
                return ExecutionResult(
                    backend_name=self.name,
                    backend_version=backend_version,
                    execution_mode="statevector",
                    execution_id=execution_id,
                    statevector=statevector,
                )

            if mode == "shots":
                if shots is None or shots <= 0:
                    raise AdapterExecutionError("shots mode requires shots > 0")

                measured_clbit_of_qubit = {
                    op.targets[0]: op.clbits[0] for op in circuit.ops if op.gate is GateName.MEASURE
                }
                measured_wires = sorted(wire_of(q) for q in measured_clbit_of_qubit)
                clbit_of_wire = {wire_of(q): c for q, c in measured_clbit_of_qubit.items()}

                device = qml.device("default.qubit", wires=num_qubits, seed=_SHOTS_SEED)

                @qml.set_shots(shots=shots)
                @qml.qnode(device)
                def shots_circuit():
                    apply_ops()
                    return qml.counts(wires=measured_wires)

                raw_counts = shots_circuit()

                counts: dict[str, int] = {}
                for raw_key, count in raw_counts.items():
                    bits = ["0"] * circuit.num_clbits
                    for position, wire in enumerate(measured_wires):
                        bits[circuit.num_clbits - 1 - clbit_of_wire[wire]] = str(raw_key)[position]
                    bitstring = "".join(bits)
                    counts[bitstring] = counts.get(bitstring, 0) + int(count)

                probabilities = {bitstring: count / shots for bitstring, count in counts.items()}
                return ExecutionResult(
                    backend_name=self.name,
                    backend_version=backend_version,
                    execution_mode="shots",
                    execution_id=execution_id,
                    counts=counts,
                    probabilities=probabilities,
                )

            raise AdapterExecutionError(f"unsupported execution mode: {mode!r}")

        except (AdapterExecutionError, AdapterUnavailable):
            raise
        except Exception as exc:  # noqa: BLE001 - surface the real PennyLane error
            raise AdapterExecutionError(f"PennyLane execution failed: {type(exc).__name__}: {exc}") from exc
