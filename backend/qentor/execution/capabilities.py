"""Which gates each backend can run — declared, checked, and tested.

A gate the canonical model accepts but one backend cannot run must never surface as an
unexpected failure halfway through a run, or (worse) as a quietly different result. So the
supported set is written out per backend, the API checks a circuit against it before running
anything, and the test-suite runs EVERY declared gate on EVERY backend and compares the
states (``tests/test_gate_support.py``), so this table cannot claim more than the adapter
does.

Today all three simulators support the whole gate set. The table exists so the day one
does not (a hardware backend with a native gate set, a future adapter), the answer is a
structured 422 ``BACKEND_GATE_UNSUPPORTED`` naming the gates, not a crash.
"""

from __future__ import annotations

from qentor.circuit.model import Circuit, GateName

BACKEND_GATE_UNSUPPORTED = "BACKEND_GATE_UNSUPPORTED"

_ALL = frozenset(GateName)

SUPPORTED_GATES: dict[str, frozenset[GateName]] = {
    "qiskit-aer": _ALL,
    "cirq": _ALL,
    "pennylane": _ALL,
}


class UnsupportedGate(ValueError):
    """The circuit uses a gate the chosen backend cannot run. Refused before any run."""

    def __init__(self, backend: str, gates: list[str]) -> None:
        message = (
            f"backend {backend!r} cannot run {', '.join(gates)}; "
            f"choose another backend or remove {'that gate' if len(gates) == 1 else 'those gates'}"
        )
        super().__init__(message)
        self.code = BACKEND_GATE_UNSUPPORTED
        self.message = message
        self.backend = backend
        self.gates = gates

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, "backend": self.backend, "gates": self.gates}


def check_gate_support(circuit: Circuit, backend: str) -> None:
    supported = SUPPORTED_GATES.get(backend)
    if supported is None:
        raise UnsupportedGate(backend, sorted({op.gate.value for op in circuit.ops}))
    missing = sorted({op.gate.value for op in circuit.ops if op.gate not in supported})
    if missing:
        raise UnsupportedGate(backend, missing)
