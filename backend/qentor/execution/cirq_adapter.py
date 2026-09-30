"""Cirq execution adapter (docs/ARCHITECTURE.md §6).

Builds a native ``cirq.Circuit`` directly from the canonical model — never
from generated QASM/source text — exactly like ``AerAdapter``. Every number in
the returned ``ExecutionResult`` comes from Cirq's own simulator; nothing here
computes a probability, count or statevector by hand.

Bit-order normalisation: Cirq's own convention makes the *first* qubit in a
``qubit_order``/measurement list the most-significant bit, the opposite of
Qentor's Qiskit-style convention (qubit ``k`` contributes ``2**k`` to a
statevector index; displayed bitstrings are ``q[n-1]...q[0]``). Circuits are
always built using each canonical qubit's own index directly
(``cirq.LineQubit(q)`` for canonical qubit ``q``); the statevector is instead
requested in *reversed* qubit order (``[q[n-1], ..., q[0]]``), which converts
Cirq's own indexing into Qentor's directly — verified against an asymmetric
circuit (not just a qubit-swap-symmetric one like Bell) during development.
Shots are assembled bit-by-bit from per-qubit measurements the same way, via
each measured qubit's declared classical-bit position.
"""

from __future__ import annotations

import uuid
from collections import Counter

from qentor.circuit.model import Circuit, GateName

from .adapter import AdapterExecutionError, AdapterUnavailable, ExecutionMode, ExecutionResult

_SIMPLE_GATE_NAME = {
    GateName.H: "H",
    GateName.X: "X",
    GateName.Y: "Y",
    GateName.Z: "Z",
    GateName.S: "S",
    GateName.T: "T",
}
_ROTATION_GATE_NAME = {
    GateName.RX: "rx",
    GateName.RY: "ry",
    GateName.RZ: "rz",
}

# Fixed so a given circuit + shot count always reproduces the same counts —
# docs/ARCHITECTURE.md §6: "Shots with a fixed, recorded seed."
_SHOTS_SEED = 1234


class CirqAdapter:
    name = "cirq"

    def run(self, circuit: Circuit, mode: ExecutionMode, shots: int | None = None) -> ExecutionResult:
        try:
            import cirq
        except Exception as exc:  # noqa: BLE001 - report the real import failure
            raise AdapterUnavailable(f"cirq could not be imported: {type(exc).__name__}: {exc}") from exc

        has_measure = any(op.gate is GateName.MEASURE for op in circuit.ops)
        if mode == "shots" and not has_measure:
            raise AdapterExecutionError(
                "shots mode requires at least one measure operation in the circuit; "
                "this circuit has none"
            )

        qubits = cirq.LineQubit.range(circuit.num_qubits)
        # Force every declared qubit to exist in the circuit even if no gate
        # ever touches it — matches QuantumCircuit(num_qubits, ...)'s fixed
        # register size in AerAdapter, so an unused qubit still contributes a
        # basis-state dimension rather than silently vanishing.
        moments: list = [cirq.I(q) for q in qubits]
        measured_clbit_of_qubit: dict[int, int] = {}

        for op in circuit.ops:
            if op.gate in _SIMPLE_GATE_NAME:
                moments.append(getattr(cirq, _SIMPLE_GATE_NAME[op.gate])(qubits[op.targets[0]]))
            elif op.gate in _ROTATION_GATE_NAME:
                moments.append(getattr(cirq, _ROTATION_GATE_NAME[op.gate])(op.params[0])(qubits[op.targets[0]]))
            elif op.gate is GateName.CX:
                moments.append(cirq.CNOT(qubits[op.controls[0]], qubits[op.targets[0]]))
            elif op.gate is GateName.CZ:
                moments.append(cirq.CZ(qubits[op.controls[0]], qubits[op.targets[0]]))
            elif op.gate is GateName.CP:
                moments.append(cirq.cphase(op.params[0])(qubits[op.controls[0]], qubits[op.targets[0]]))
            elif op.gate is GateName.SWAP:
                moments.append(cirq.SWAP(qubits[op.targets[0]], qubits[op.targets[1]]))
            elif op.gate is GateName.CCX:
                moments.append(cirq.CCX(qubits[op.controls[0]], qubits[op.controls[1]], qubits[op.targets[0]]))
            elif op.gate is GateName.SDG:
                moments.append((cirq.S**-1)(qubits[op.targets[0]]))
            elif op.gate is GateName.TDG:
                moments.append((cirq.T**-1)(qubits[op.targets[0]]))
            elif op.gate is GateName.MEASURE:
                measured_clbit_of_qubit[op.targets[0]] = op.clbits[0]
            else:  # pragma: no cover - Circuit validation already restricts gate names
                raise AdapterExecutionError(f"unsupported gate for Cirq: {op.gate!r}")

        for qubit_index in measured_clbit_of_qubit:
            moments.append(cirq.measure(qubits[qubit_index], key=str(qubit_index)))

        native_circuit = cirq.Circuit(moments)
        execution_id = f"cirq-local-{uuid.uuid4().hex[:12]}"
        backend_version = cirq.__version__

        try:
            if mode == "statevector":
                # docs/ARCHITECTURE.md §6: "cirq.Simulator(dtype=np.complex128)".
                # Cirq's own default is complex64, which is too coarse for the
                # 1e-9 tolerance the rest of Qentor's verification layer uses.
                import numpy as np

                result = cirq.Simulator(dtype=np.complex128).simulate(
                    native_circuit, qubit_order=list(reversed(qubits))
                )
                sv = result.final_state_vector
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

                result = cirq.Simulator(seed=_SHOTS_SEED).run(native_circuit, repetitions=shots)
                counts: Counter[str] = Counter()
                for shot_index in range(shots):
                    bits = ["0"] * circuit.num_clbits
                    for qubit_index, clbit in measured_clbit_of_qubit.items():
                        value = int(result.measurements[str(qubit_index)][shot_index, 0])
                        bits[circuit.num_clbits - 1 - clbit] = str(value)
                    counts["".join(bits)] += 1

                probabilities = {bitstring: count / shots for bitstring, count in counts.items()}
                return ExecutionResult(
                    backend_name=self.name,
                    backend_version=backend_version,
                    execution_mode="shots",
                    execution_id=execution_id,
                    counts=dict(counts),
                    probabilities=probabilities,
                )

            raise AdapterExecutionError(f"unsupported execution mode: {mode!r}")

        except (AdapterExecutionError, AdapterUnavailable):
            raise
        except Exception as exc:  # noqa: BLE001 - surface the real Cirq error
            raise AdapterExecutionError(f"Cirq execution failed: {type(exc).__name__}: {exc}") from exc
