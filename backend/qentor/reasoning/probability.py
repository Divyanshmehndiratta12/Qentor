"""PROBABILITY: what a measurement of this circuit gives, read from the backend's own runs.

Nothing is computed from a gate name or a textbook state. The numbers are:

* ``theoretical`` probabilities: ``|amplitude|^2`` read from a statevector the backend produced (the learner's own statevector
  run when it has no measurement in it; otherwise a statevector run of the circuit with its terminal measurements stripped,
  made here through the injected ``runner``, because a statevector taken after a measurement is a collapsed state);
* ``sampled`` frequencies: ``count / shots`` read from a shots run the learner already made.

A basis state is a bitstring ``q[n-1] … q[0]``. "Qubit k is 1" is the sum of the probabilities of the basis states whose bit k
is 1. Neither is an approximation: they are sums over the backend's own probabilities, and the sampled value, when there is
one, is shown beside the theoretical one, never in its place.
"""

from __future__ import annotations

from typing import Annotated, Callable, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName
from qentor.execution.adapter import theoretical_probabilities
from qentor.execution.trace import TraceNotSupported, split_terminal_measurements
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord

from .models import Analysis, Intent, ReasoningError, source_of

# An outcome shown as a most-likely outcome ties with the top one within this much (the backend's own numbers have ~1e-16 noise).
TIE_TOLERANCE = 1e-9
MAX_TARGET_BITS = 16

Runner = Callable[[Circuit], ProvenanceRecord]


class BasisStateTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["basis_state"] = "basis_state"
    bits: str = Field(pattern=r"^[01]+$", max_length=MAX_TARGET_BITS)


class QubitValueTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["qubit_value"] = "qubit_value"
    qubit: int = Field(ge=0, lt=MAX_TARGET_BITS)
    value: Literal[0, 1]


class EachQubitValueTarget(BaseModel):
    """"The probability of 1" on a register of several qubits: the answer is each qubit's own probability of reading that value."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["each_qubit_value"] = "each_qubit_value"
    value: Literal[0, 1]


class MostLikelyTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["most_likely"] = "most_likely"


class SampledVsTheoreticalTarget(BaseModel):
    """Every outcome the runs report, theoretical beside sampled; or, with ``bits``, one outcome."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["sampled_vs_theoretical"] = "sampled_vs_theoretical"
    bits: str | None = Field(default=None, pattern=r"^[01]+$", max_length=MAX_TARGET_BITS)


ProbabilityTarget = Annotated[
    Union[BasisStateTarget, QubitValueTarget, EachQubitValueTarget, MostLikelyTarget, SampledVsTheoreticalTarget],
    Field(discriminator="kind"),
]


class ProbabilityItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    outcome: str | None = None
    qubit: int | None = None
    value: int | None = None
    theoretical_probability: float | None = None
    sampled_frequency: float | None = None
    sampled_count: int | None = None
    shots: int | None = None
    # |sampled - theoretical|, only when both are present for this item.
    difference: float | None = None


def _unitary_circuit(circuit: Circuit) -> tuple[Circuit, bool]:
    """The circuit without its terminal measurements, and whether it had any. A measurement followed by a gate is refused."""
    try:
        unitary_ops, terminal = split_terminal_measurements(circuit)
    except TraceNotSupported as exc:
        raise ReasoningError("PROBABILITY_MID_CIRCUIT_MEASUREMENT", exc.message) from exc
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=list(unitary_ops)), bool(terminal)


def _measures_each_qubit_into_its_own_bit(circuit: Circuit) -> bool:
    """True when the circuit's measurements read qubit k into classical bit k for every qubit: only then does a shots outcome
    ``c[m-1] … c[0]`` mean the same thing as a basis state ``q[n-1] … q[0]``."""
    if circuit.num_clbits != circuit.num_qubits:
        return False
    mapping = {op.targets[0]: op.clbits[0] for op in circuit.ops if op.gate is GateName.MEASURE}
    return len(mapping) == circuit.num_qubits and all(q == c for q, c in mapping.items())


def _theoretical(state_record: ProvenanceRecord) -> dict[str, float]:
    payload = state_record.payload
    given = payload.get("theoretical_probabilities")
    if isinstance(given, dict):
        return {k: float(v) for k, v in given.items()}
    return theoretical_probabilities(payload["statevector"])


def _marginal(distribution: dict[str, float], qubit: int, value: int) -> float:
    """P(qubit = value): the sum of the probabilities of the outcomes whose bit ``qubit`` (counted from the right) is ``value``."""
    total = 0.0
    for outcome, p in distribution.items():
        if outcome[len(outcome) - 1 - qubit] == str(value):
            total += p
    return total


def _require_usable(record: ProvenanceRecord, circuit: Circuit) -> None:
    if record.execution_mode not in ("statevector", "shots"):
        raise ReasoningError(
            "REASONING_RESULT_UNUSABLE", f"'{record.result_id}' is a {record.execution_mode} record, not a run of a circuit; there is no measurement outcome in it"
        )
    if record.circuit_hash != circuit_hash(circuit):
        raise ReasoningError(
            "REASONING_RESULT_CIRCUIT_MISMATCH",
            f"circuit does not match provenance record '{record.result_id}': got circuit hash '{circuit_hash(circuit)}', expected '{record.circuit_hash}'",
        )
    if record.verification_status != ExecutionStatus.STATE_CHECKED:
        raise ReasoningError(
            "REASONING_RESULT_UNUSABLE",
            f"the run {record.result_id} did not produce a usable result ({record.verification_status.value}); nothing was analysed",
        )
    if record.provenance_class != ProvenanceClass.SIMULATION:
        raise ReasoningError(
            "REASONING_CLASS_UNSUPPORTED", f"run {record.result_id} is {record.provenance_class.value}; only simulations are analysed"
        )


def analyze_probability(
    circuit: Circuit,
    record: ProvenanceRecord,
    target: ProbabilityTarget,
    *,
    runner: Runner,
) -> Analysis:
    """Answer ``target`` about ``circuit`` from ``record`` (the learner's own run of exactly this circuit).

    ``runner`` runs a circuit in statevector mode on the backend and returns its persisted provenance record; it is called only
    when the learner's run cannot supply the theoretical probabilities by itself (a shots run, or a circuit with measurements).
    """
    _require_usable(record, circuit)
    unitary, had_measurements = _unitary_circuit(circuit)
    n = circuit.num_qubits
    payload = record.payload

    sources = []
    sampled: dict[str, float] | None = None
    counts: dict[str, int] | None = None
    shots: int | None = None
    sampled_note: str | None = None
    if record.execution_mode == "shots" and "counts" in payload:
        counts = {k: int(v) for k, v in payload["counts"].items()}
        shots = sum(counts.values())
        sampled = {k: v / shots for k, v in counts.items()} if shots else None
        sources.append(source_of("sampled", record))
        if not _measures_each_qubit_into_its_own_bit(circuit):
            sampled_note = (
                "the measured classical bits are not qubit k into bit k for every qubit, so the sampled outcomes are labelled "
                "by classical bits and cannot be matched to basis states; no sampled value is shown"
            )
            sampled, counts = None, None

    # Theoretical probabilities: the learner's own statevector run when it is a clean state; otherwise a statevector run of the
    # unitary part, made through the runner (and recorded like any run).
    if record.execution_mode == "statevector" and not had_measurements and "statevector" in payload:
        state_record = record
        sources.append(source_of("theoretical", record))
    else:
        state_record = runner(unitary)
        if state_record.verification_status != ExecutionStatus.STATE_CHECKED or "statevector" not in state_record.payload:
            raise ReasoningError("REASONING_RESULT_UNUSABLE", "the backend's statevector run for this circuit was not usable; nothing was analysed")
        sources.append(source_of("theoretical", state_record))
    theoretical = _theoretical(state_record)

    def item(label: str, *, outcome: str | None = None, qubit: int | None = None, value: int | None = None) -> ProbabilityItem:
        if outcome is not None:
            t = theoretical.get(outcome, 0.0)
            s = sampled.get(outcome, 0.0) if sampled is not None else None
            c = counts.get(outcome, 0) if counts is not None else None
        else:
            assert qubit is not None and value is not None
            t = _marginal(theoretical, qubit, value)
            s = _marginal(sampled, qubit, value) if sampled is not None else None
            c = sum(v for k, v in counts.items() if k[len(k) - 1 - qubit] == str(value)) if counts is not None else None
        return ProbabilityItem(
            label=label,
            outcome=outcome,
            qubit=qubit,
            value=value,
            theoretical_probability=t,
            sampled_frequency=s,
            sampled_count=c,
            shots=shots if s is not None else None,
            difference=abs(s - t) if s is not None else None,
        )

    status, reason = "OK", None
    items: list[ProbabilityItem] = []
    notes: list[str] = []
    if sampled_note:
        notes.append(sampled_note)

    if isinstance(target, BasisStateTarget):
        if len(target.bits) != n:
            raise ReasoningError(
                "PROBABILITY_TARGET_INVALID",
                f"an outcome of this {n}-qubit circuit is {n} bits long (written q[{n - 1}]…q[0]); '{target.bits}' is {len(target.bits)}",
            )
        items.append(item(f"outcome {target.bits}", outcome=target.bits))
    elif isinstance(target, QubitValueTarget):
        if target.qubit >= n:
            raise ReasoningError("PROBABILITY_TARGET_INVALID", f"qubit {target.qubit} is outside this {n}-qubit circuit")
        items.append(item(f"qubit {target.qubit} measured as {target.value}", qubit=target.qubit, value=target.value))
    elif isinstance(target, EachQubitValueTarget):
        for q in range(n):
            items.append(item(f"qubit {q} measured as {target.value}", qubit=q, value=target.value))
    elif isinstance(target, MostLikelyTarget):
        top = max(theoretical.values()) if theoretical else 0.0
        winners = sorted(k for k, v in theoretical.items() if top - v <= TIE_TOLERANCE)
        for outcome in winners:
            items.append(item(f"most likely outcome {outcome}", outcome=outcome))
        if len(winners) > 1:
            notes.append(f"{len(winners)} outcomes tie for the highest probability, so there is no single most likely outcome")
    else:  # SampledVsTheoreticalTarget
        if sampled is None:
            status = "NOT_APPLICABLE"
            reason = (
                "there is no usable sampled run of this circuit to compare with: run it in shots mode (with every qubit measured "
                "into its own classical bit) first"
            )
        else:
            if target.bits is not None:
                if len(target.bits) != n:
                    raise ReasoningError("PROBABILITY_TARGET_INVALID", f"an outcome of this {n}-qubit circuit is {n} bits long; '{target.bits}' is {len(target.bits)}")
                outcomes = [target.bits]
            else:
                outcomes = sorted({*theoretical, *sampled})
            for outcome in outcomes:
                items.append(item(f"outcome {outcome}", outcome=outcome))
            notes.append("the sampled frequency is from a finite number of shots, so it differs from the theoretical probability by sampling noise alone")

    data = {
        "target": target.model_dump(mode="json"),
        "num_qubits": n,
        "bit_order": f"outcomes are written q[{n - 1}]…q[0]",
        "items": [i.model_dump(mode="json") for i in items],
        "notes": notes,
    }
    return Analysis(intent=Intent.PROBABILITY, status=status, reason=reason, circuit_hash=circuit_hash(circuit), sources=sources, data=data)
