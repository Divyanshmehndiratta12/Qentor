"""Qiskit Aer adapter — the first real execution backend.

This module builds an actual ``qiskit.QuantumCircuit`` from the canonical model and
runs it on ``qiskit_aer.AerSimulator``. Every number in the returned
``ExecutionResult`` comes from Aer's own ``Result`` object. Nothing here computes a
probability, a count or a statevector by hand as a substitute for running the
circuit.

Qiskit is imported lazily, inside ``AerAdapter.run``, not at module import time.
That lets the rest of the backend (circuit model, QASM emitter, provenance store,
API scaffolding) load and be tested even when qiskit's native extension is blocked
by the host OS — see docs/BUILD_STATE.md. When qiskit truly cannot be imported,
``run`` raises ``AdapterUnavailable`` with the underlying error; it never falls
back to a fabricated result.
"""

from __future__ import annotations

import uuid

from qentor.circuit.model import Circuit, GateName

from .adapter import AdapterExecutionError, AdapterUnavailable, ExecutionMode, ExecutionResult

_SIMPLE_GATE_METHOD = {
    GateName.H: "h",
    GateName.X: "x",
    GateName.Y: "y",
    GateName.Z: "z",
    GateName.S: "s",
    GateName.SDG: "sdg",
    GateName.T: "t",
    GateName.TDG: "tdg",
}
_ROTATION_GATE_METHOD = {
    GateName.RX: "rx",
    GateName.RY: "ry",
    GateName.RZ: "rz",
}


class AerAdapter:
    name = "qiskit-aer"

    def run(self, circuit: Circuit, mode: ExecutionMode, shots: int | None = None) -> ExecutionResult:
        try:
            import numpy as np
            from qiskit import QuantumCircuit
            from qiskit_aer import AerSimulator
            import qiskit_aer
        except Exception as exc:  # noqa: BLE001 - report the real import failure
            raise AdapterUnavailable(
                f"qiskit-aer could not be imported: {type(exc).__name__}: {exc}"
            ) from exc

        has_measure = any(op.gate is GateName.MEASURE for op in circuit.ops)
        if mode == "shots" and not has_measure:
            raise AdapterExecutionError(
                "shots mode requires at least one measure operation in the circuit; "
                "this circuit has none"
            )

        qc = QuantumCircuit(circuit.num_qubits, circuit.num_clbits)
        for op in circuit.ops:
            if op.gate in _SIMPLE_GATE_METHOD:
                getattr(qc, _SIMPLE_GATE_METHOD[op.gate])(op.targets[0])
            elif op.gate in _ROTATION_GATE_METHOD:
                getattr(qc, _ROTATION_GATE_METHOD[op.gate])(op.params[0], op.targets[0])
            elif op.gate is GateName.CX:
                qc.cx(op.controls[0], op.targets[0])
            elif op.gate is GateName.CZ:
                qc.cz(op.controls[0], op.targets[0])
            elif op.gate is GateName.SWAP:
                qc.swap(op.targets[0], op.targets[1])
            elif op.gate is GateName.CCX:
                qc.ccx(op.controls[0], op.controls[1], op.targets[0])
            elif op.gate is GateName.MEASURE:
                qc.measure(op.targets[0], op.clbits[0])
            else:  # pragma: no cover - Circuit validation already restricts gate names
                raise AdapterExecutionError(f"unsupported gate for Aer: {op.gate!r}")

        execution_id = f"aer-local-{uuid.uuid4().hex[:12]}"
        backend_version = qiskit_aer.__version__

        try:
            if mode == "statevector":
                qc.save_statevector()
                sim = AerSimulator(method="statevector")
                job = sim.run(qc)
                result = job.result()
                if not result.success:
                    raise AdapterExecutionError(f"Aer run did not succeed: {result.status}")
                sv = np.asarray(result.get_statevector(qc))
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
                sim = AerSimulator()
                job = sim.run(qc, shots=shots)
                result = job.result()
                if not result.success:
                    raise AdapterExecutionError(f"Aer run did not succeed: {result.status}")
                counts = dict(result.get_counts(qc))
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
        except Exception as exc:  # noqa: BLE001 - surface the real Aer error
            raise AdapterExecutionError(f"Aer execution failed: {type(exc).__name__}: {exc}") from exc
