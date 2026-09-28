"""Operator equivalence checker (docs/VERIFICATION_ARCHITECTURE.md §4.3).

The one and only equivalence definition used anywhere in this codebase:
build each circuit's unitary with Qiskit's own ``quantum_info.Operator`` and
compare them up to global phase, tolerance 1e-9 — "Do not invent a new
equivalence definition" means implement exactly this, once, and reuse it
(the optimiser in ``qentor.verification.optimizer`` is the first caller, but
this module has no dependency on it and is usable standalone later for a
learner-facing "are these two circuits the same?" check).

This never calls an ``ExecutionAdapter`` and produces no ``ExecutionResult`` —
``Operator`` construction is Qiskit's own analytical decomposition of a
circuit into its unitary matrix, not a simulation/execution, so there is
nothing here for the provenance log to record. Comparing two circuits this
way also never depends on which adapter (if any) actually ran either one.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict

from qentor.circuit.model import Circuit, GateName

from .models import CheckStatus, VerificationCheck

_TOLERANCE = 1e-9

_SIMPLE_GATE_METHOD = {
    GateName.H: "h",
    GateName.X: "x",
    GateName.Y: "y",
    GateName.Z: "z",
    GateName.S: "s",
    GateName.T: "t",
}
_ROTATION_GATE_METHOD = {
    GateName.RX: "rx",
    GateName.RY: "ry",
    GateName.RZ: "rz",
}


class EquivalenceStatus(str, Enum):
    EQUIVALENT = "EQUIVALENT"
    NOT_EQUIVALENT = "NOT_EQUIVALENT"
    UNVERIFIABLE = "UNVERIFIABLE"


class EquivalenceReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: EquivalenceStatus
    method: str
    global_phase: float | None
    checks: list[VerificationCheck]
    reason: str | None


def check_equivalence(circuit_a: Circuit, circuit_b: Circuit) -> EquivalenceReport:
    """UNVERIFIABLE if either circuit has non-terminal measurement or the
    qubit counts differ; otherwise EQUIVALENT/NOT_EQUIVALENT via
    ``Operator.equiv`` on the measurement-stripped circuits."""
    checks: list[VerificationCheck] = []

    same_qubits = circuit_a.num_qubits == circuit_b.num_qubits
    checks.append(
        VerificationCheck(
            name="same_qubit_count",
            status=CheckStatus.PASS if same_qubits else CheckStatus.FAIL,
            detail=(
                f"both circuits have {circuit_a.num_qubits} qubits"
                if same_qubits
                else f"circuit A has {circuit_a.num_qubits} qubits, circuit B has {circuit_b.num_qubits}"
            ),
        )
    )
    if not same_qubits:
        return EquivalenceReport(
            status=EquivalenceStatus.UNVERIFIABLE,
            method="qiskit.quantum_info.Operator.equiv",
            global_phase=None,
            checks=checks,
            reason="circuits act on a different number of qubits",
        )

    for label, circuit in (("A", circuit_a), ("B", circuit_b)):
        mid_circuit = _has_non_terminal_measurement(circuit)
        checks.append(
            VerificationCheck(
                name=f"no_mid_circuit_measurement_{label.lower()}",
                status=CheckStatus.FAIL if mid_circuit else CheckStatus.PASS,
                detail=(
                    f"circuit {label} measures a qubit and then applies another gate afterward"
                    if mid_circuit
                    else f"circuit {label} has no mid-circuit measurement"
                ),
            )
        )
        if mid_circuit:
            return EquivalenceReport(
                status=EquivalenceStatus.UNVERIFIABLE,
                method="qiskit.quantum_info.Operator.equiv",
                global_phase=None,
                checks=checks,
                reason=f"circuit {label} has mid-circuit measurement; operator equivalence is undefined for it",
            )

    try:
        from qiskit.quantum_info import Operator
    except Exception as exc:  # noqa: BLE001 - report the real import failure
        checks.append(
            VerificationCheck(
                name="qiskit_available",
                status=CheckStatus.FAIL,
                detail=f"qiskit could not be imported: {type(exc).__name__}: {exc}",
            )
        )
        return EquivalenceReport(
            status=EquivalenceStatus.UNVERIFIABLE,
            method="qiskit.quantum_info.Operator.equiv",
            global_phase=None,
            checks=checks,
            reason="qiskit is unavailable in this environment; cannot build an Operator",
        )

    operator_a = Operator(_to_qiskit_circuit_without_measurement(circuit_a))
    operator_b = Operator(_to_qiskit_circuit_without_measurement(circuit_b))

    equivalent = operator_a.equiv(operator_b, atol=_TOLERANCE)
    checks.append(
        VerificationCheck(
            name="operator_equivalent_up_to_global_phase",
            status=CheckStatus.PASS if equivalent else CheckStatus.FAIL,
            detail=(
                f"U_b = e^(i*phi) * U_a holds within {_TOLERANCE}"
                if equivalent
                else f"no global phase makes the two operators agree within {_TOLERANCE}"
            ),
        )
    )

    global_phase = None
    if equivalent:
        import numpy as np

        trace = np.trace(operator_a.data.conj().T @ operator_b.data)
        global_phase = float(np.angle(trace))

    return EquivalenceReport(
        status=EquivalenceStatus.EQUIVALENT if equivalent else EquivalenceStatus.NOT_EQUIVALENT,
        method="qiskit.quantum_info.Operator.equiv",
        global_phase=global_phase,
        checks=checks,
        reason=None if equivalent else "operators differ by more than a global phase",
    )


def _has_non_terminal_measurement(circuit: Circuit) -> bool:
    measured = False
    for op in circuit.ops:
        if op.gate is GateName.MEASURE:
            measured = True
        elif measured:
            return True
    return False


def _to_qiskit_circuit_without_measurement(circuit: Circuit):
    """Build a native ``qiskit.QuantumCircuit`` for ``Operator`` construction
    only — this is analysis, not simulation, so it deliberately does not
    reuse or duplicate ``qentor.execution.aer``'s simulator-driving code."""
    from qiskit import QuantumCircuit

    qc = QuantumCircuit(circuit.num_qubits)
    for op in circuit.ops:
        if op.gate in _SIMPLE_GATE_METHOD:
            getattr(qc, _SIMPLE_GATE_METHOD[op.gate])(op.targets[0])
        elif op.gate in _ROTATION_GATE_METHOD:
            getattr(qc, _ROTATION_GATE_METHOD[op.gate])(op.params[0], op.targets[0])
        elif op.gate is GateName.CX:
            qc.cx(op.controls[0], op.targets[0])
        elif op.gate is GateName.MEASURE:
            continue  # terminal measurement doesn't change the unitary before it
        else:  # pragma: no cover - Circuit validation already restricts gate names
            raise ValueError(f"unsupported gate for equivalence checking: {op.gate!r}")
    return qc
