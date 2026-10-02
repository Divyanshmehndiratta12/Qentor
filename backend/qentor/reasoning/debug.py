"""DEBUG: the structured evidence the deterministic debugger is given.

The debugger (``qentor.tutor.debugger``) already builds its report from provenance facts; this analysis adds what the reasoning
engine can establish about the SAME run: the most likely outcomes (the probability analysis), whether a verified shorter circuit
exists (the optimiser and equivalence checker), and plain structural observations read from the canonical circuit (qubits no
operation touches, whether there is a measurement). Each is computed here from backend runs or from the circuit; nothing is
inferred from what the learner "meant", and nothing is said about whether the circuit is right.
"""

from __future__ import annotations

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName
from qentor.provenance.models import ProvenanceRecord

from .models import Analysis, Intent, Source
from .optimization import analyze_optimization
from .probability import MostLikelyTarget, Runner, analyze_probability


def structure_facts(circuit: Circuit) -> dict:
    touched = {q for op in circuit.ops for q in (*op.targets, *op.controls)}
    return {
        "num_qubits": circuit.num_qubits,
        "num_operations": len(circuit.ops),
        "idle_qubits": [q for q in range(circuit.num_qubits) if q not in touched],
        "has_measurement": any(op.gate is GateName.MEASURE for op in circuit.ops),
    }


def analyze_debug(circuit: Circuit, record: ProvenanceRecord, *, runner: Runner, optimization: Analysis) -> Analysis:
    """``optimization`` is the OPTIMIZE analysis of the same circuit (made by the caller, which owns the adapter and the log)."""
    probability = analyze_probability(circuit, record, MostLikelyTarget(), runner=runner)
    sources: list[Source] = []
    for source in (*probability.sources, *optimization.sources):
        if source.result_id not in {s.result_id for s in sources}:
            sources.append(source)
    optimization_summary = {
        "status": optimization.status,
        "reason": optimization.reason,
        "optimization_status": optimization.data["optimization_status"],
        "original_op_count": optimization.data["original_op_count"],
        "candidate_op_count": optimization.data["candidate_op_count"],
        "operations_removed": optimization.data["operations_removed"],
    }
    return Analysis(
        intent=Intent.DEBUG,
        status="OK",
        circuit_hash=circuit_hash(circuit),
        sources=sources,
        data={"most_likely": probability.data, "optimization": optimization_summary, "structure": structure_facts(circuit)},
    )


__all__ = ["analyze_debug", "analyze_optimization", "structure_facts"]
