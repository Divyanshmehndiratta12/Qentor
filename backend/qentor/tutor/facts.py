"""Fact-sheet builder (docs/AI_BOUNDARY.md §4 step 1).

Turns a canonical ``Circuit`` and an already-persisted ``ProvenanceRecord`` into
a list of atomic, citable ``TutorFact``s. This module never executes anything
and never touches the provenance store directly — the caller (the API layer)
is the only place that calls ``ProvenanceStore.get``; this function takes the
record it already fetched as a plain argument. That keeps the one read/write
path into the log in one place, and lets this same fact sheet be reused
unchanged once an LLM adapter is added later (it becomes the context the
model is given, not something the model can override).
"""

from __future__ import annotations

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.sanity import STATE_CHECKED_PLAIN
from qentor.provenance.models import ProvenanceRecord

from .models import FactKind, TutorFact

_SUPPORT_TOLERANCE = 1e-9


def build_fact_sheet(circuit: Circuit, record: ProvenanceRecord) -> list[TutorFact]:
    facts: list[TutorFact] = []
    counter = 0

    def add(kind: FactKind, description: str) -> None:
        nonlocal counter
        counter += 1
        facts.append(TutorFact(id=f"F{counter}", kind=kind, description=description, result_id=record.result_id))

    gate_list = ", ".join(_describe_op(op) for op in circuit.ops) or "no operations"
    add("circuit_summary", f"{circuit.num_qubits}-qubit, {circuit.num_clbits}-clbit circuit: {gate_list}")

    add(
        "execution_status",
        f"execution {record.result_id} on {record.backend} {record.backend_version} "
        f"({record.provenance_class.value}, {record.execution_mode} mode): {record.verification_status.value} "
        f"({STATE_CHECKED_PLAIN})",
    )

    payload = record.payload
    if "probabilities" in payload:
        counts = payload.get("counts") or {}
        for bitstring in sorted(payload["probabilities"]):
            probability = payload["probabilities"][bitstring]
            # A shots run measured a sample: what it reports is a frequency, never "the probability".
            detail = f"outcome {bitstring}: sampled frequency {probability:.6f}"
            if bitstring in counts:
                detail += f" ({counts[bitstring]} shots)"
            add("probability", detail)
    elif "statevector" in payload:
        width = circuit.num_qubits
        for i, (re, im) in enumerate(payload["statevector"]):
            if re * re + im * im <= _SUPPORT_TOLERANCE:
                continue
            bitstring = format(i, f"0{width}b")
            add("amplitude", f"|{bitstring}⟩ amplitude: {re:.6f} + {im:.6f}i")
        for bitstring, probability in sorted(payload.get("theoretical_probabilities", {}).items()):
            add("probability", f"outcome {bitstring}: theoretical probability {probability:.6f}")

    return facts


def _describe_op(op: GateOp) -> str:
    gate = op.gate.value
    if len(op.controls) > 1:
        controls = ", ".join(f"q{c}" for c in op.controls)
        return f"{gate}(controls={controls}, target=q{op.targets[0]})"
    if op.controls:
        return f"{gate}(control=q{op.controls[0]}, target=q{op.targets[0]})"
    if len(op.targets) > 1:
        return f"{gate}({', '.join(f'q{t}' for t in op.targets)})"
    if op.params:
        return f"{gate}(q{op.targets[0]}, angle={op.params[0]:.6f})"
    if op.clbits:
        return f"{gate}(q{op.targets[0]} -> c{op.clbits[0]})"
    return f"{gate}(q{op.targets[0]})"
