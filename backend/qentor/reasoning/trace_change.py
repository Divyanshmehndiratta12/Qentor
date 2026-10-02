"""TRACE_CHANGE: what one step of an execution trace did to the state.

The state "before" and "after" are two statevectors the backend produced (two ordinary provenance records, found and VERIFIED by
the API layer before they get here). Everything below is derived from those two states and nothing else: the operation is the
one the circuit has at that position, the probability changes are differences of ``|amplitude|^2``, the per-qubit reduced states
come from ``qentor.execution.reduced_state``, and "what kind of change" is ``qentor.execution.step_changes``. The browser
performs none of it.

A per-qubit state is only listed where it means something: a qubit whose reduced state is unusable is reported as such, with
the reason, and never filled in.
"""

from __future__ import annotations

from qentor.circuit.describe import describe_op
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import theoretical_probabilities
from qentor.execution.bloch import BlochSource
from qentor.execution.reduced_state import derive_qubit_states
from qentor.execution.step_changes import compute_step_change
from qentor.provenance.models import ExecutionStatus, ProvenanceRecord

from .models import Analysis, Intent, ReasoningError, source_of

# A change in an outcome probability smaller than this is not reported as a change (the backend's own noise is ~1e-16).
PROBABILITY_TOLERANCE = 1e-9


def _unitary_ops(circuit: Circuit) -> list[GateOp]:
    first = next((i for i, op in enumerate(circuit.ops) if op.gate is GateName.MEASURE), None)
    return list(circuit.ops if first is None else circuit.ops[:first])


def _state(record: ProvenanceRecord, num_qubits: int) -> list[list[float]]:
    state = record.payload.get("statevector")
    if record.verification_status != ExecutionStatus.STATE_CHECKED or not isinstance(state, list) or len(state) != 2**num_qubits:
        raise ReasoningError("REASONING_RESULT_UNUSABLE", f"the step's run {record.result_id} holds no usable statevector; nothing was analysed")
    return state


def _qubit_rows(state: list[list[float]], num_qubits: int, record: ProvenanceRecord, step_index: int) -> list[dict]:
    source = BlochSource(
        step_index=step_index,
        result_id=record.result_id,
        execution_id=str(record.payload.get("execution_id", "")),
        circuit_hash=record.circuit_hash,
        backend=record.backend,
        backend_version=record.backend_version,
    )
    rows = []
    for q in derive_qubit_states(state, num_qubits, source=source):
        rows.append(
            {
                "qubit": q.qubit,
                "status": q.status,
                "reason": q.reason,
                "bloch": q.bloch.model_dump(mode="json") if q.bloch else None,
                "bloch_length": q.bloch_length,
                "purity": q.purity,
                "entangled_with_rest": q.entangled_with_rest,
            }
        )
    return rows


def analyze_trace_change(
    circuit: Circuit,
    step_index: int,
    record: ProvenanceRecord,
    previous_record: ProvenanceRecord | None,
    circuit_hash_: str,
) -> Analysis:
    """The change made at ``step_index`` (0 is the initial state). ``record`` / ``previous_record`` are the backend's states for
    that step and the one before it, already checked against ``circuit`` by the caller."""
    ops = _unitary_ops(circuit)
    total = len(ops) + 1
    if not 0 <= step_index < total:
        raise ReasoningError("TRACE_CHANGE_STEP_OUT_OF_RANGE", f"step {step_index} does not exist: the trace has {total} steps (0..{total - 1})")
    n = circuit.num_qubits
    after = _state(record, n)
    sources = [source_of("step", record)]

    data: dict = {
        "step_index": step_index,
        "step_number": step_index + 1,
        "total_steps": total,
        "num_qubits": n,
        "bit_order": f"outcomes are written q[{n - 1}]…q[0]",
        "after_probabilities": theoretical_probabilities(after),
        "after_qubits": _qubit_rows(after, n, record, step_index),
    }

    if step_index == 0:
        data["operation"] = None
        return Analysis(
            intent=Intent.TRACE_CHANGE,
            status="INITIAL_STATE",
            reason="this is the initial state, before any operation: there is no change to explain",
            circuit_hash=circuit_hash_,
            sources=sources,
            data=data,
        )

    operation = ops[step_index - 1]
    data["operation"] = {"index": step_index - 1, "gate": operation.gate.value, "description": describe_op(operation)}
    if previous_record is None:
        raise ReasoningError("REASONING_RESULT_UNUSABLE", "the previous step's record is needed to say what changed, and none was given")
    before = _state(previous_record, n)
    sources.append(source_of("previous_step", previous_record))

    change = compute_step_change(before, after, n)
    before_p, after_p = theoretical_probabilities(before), theoretical_probabilities(after)
    width = max(1, n)
    moved = []
    for index in range(2**n):
        key = format(index, f"0{width}b")
        b, a = before_p.get(key, 0.0), after_p.get(key, 0.0)
        if abs(a - b) > PROBABILITY_TOLERANCE:
            moved.append({"outcome": key, "before": b, "after": a, "difference": a - b})

    qubits_before = _qubit_rows(before, n, previous_record, step_index - 1)
    data.update(
        {
            "before_probabilities": before_p,
            "before_qubits": qubits_before,
            "change_kind": change.kind,
            "change_summary": change.summary,
            "amplitudes_changed": change.amplitudes_changed,
            "probabilities_changed": change.probabilities_changed,
            "probability_changes": moved,
        }
    )
    return Analysis(intent=Intent.TRACE_CHANGE, status="OK", circuit_hash=circuit_hash_, sources=sources, data=data)
