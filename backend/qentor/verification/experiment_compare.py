"""Compare two real executions (Phase D). Every number here is computed on the server from what two backends returned.

Given two circuits and the payloads of their two provenance records, this module reports, and only reports:

* **circuit difference** - a structural diff of the canonical operation lists (what was added, removed, changed) and, when both
  fit the limits, the operator-equivalence verdict from ``qentor.verification.equivalence`` (the one equivalence definition in
  the codebase);
* **measurement difference** - per-outcome values from each run and the differences between them. Each run's values are labelled
  for what they are: a *sampled frequency* (shots) or a *theoretical probability* (statevector). Comparing the two kinds is
  allowed and labelled - sampling noise is expected - never silently treated as one thing;
* **state difference** - only where it is meaningful: two statevector runs on the same number of qubits. Fidelity (which ignores
  a global phase), the largest probability difference, and the largest amplitude difference (which does not).

Nothing here executes a circuit, repairs or rescales a value, or decides which run is "right". A comparison the data cannot support
comes back as ``comparable = False`` with the reason, never a guess.
"""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import Literal, Sequence

from pydantic import BaseModel, ConfigDict

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import theoretical_probabilities
from qentor.execution.limits import EQUIVALENCE_MAX_QUBITS

from .agreement import compare_states
from .equivalence import EquivalenceStatus, check_equivalence

METHOD = "qentor.experiment-comparison/1"

ValueKind = Literal["sampled_frequency", "theoretical_probability"]


class OpChange(BaseModel):
    """One stretch of the operation lists. ``equal`` stretches are kept so the whole story can be shown; the rest are the difference."""

    model_config = ConfigDict(extra="forbid")

    tag: Literal["equal", "replace", "delete", "insert"]
    a_start: int
    a_ops: list[str]
    b_start: int
    b_ops: list[str]


class CircuitDifference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    same_circuit: bool
    num_qubits_a: int
    num_qubits_b: int
    num_ops_a: int
    num_ops_b: int
    changes: list[OpChange]
    equivalence_status: EquivalenceStatus
    equivalence_reason: str | None


class OutcomeRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: str
    a: float | None  # None: the run reported nothing for this outcome (absent, not zero)
    b: float | None
    difference: float | None  # |a - b| when both are present


class MeasurementDifference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comparable: bool
    reason: str | None
    kind_a: ValueKind | None
    kind_b: ValueKind | None
    rows: list[OutcomeRow]
    # Half the sum of |a - b| over every outcome (a missing value counts as 0 here, and only here): 0 = identical distributions.
    total_variation_distance: float | None
    max_difference: float | None
    note: str | None


class StateDifference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comparable: bool
    reason: str | None
    fidelity: float | None
    max_probability_difference: float | None
    max_amplitude_difference: float | None
    note: str | None


class ExperimentComparison(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: str = METHOD
    circuit: CircuitDifference
    measurement: MeasurementDifference
    state: StateDifference


# ------------------------------------------------------------------------------------------------- circuit diff


def describe_op(op: GateOp) -> str:
    gate = op.gate.value
    if len(op.controls) > 1:
        return f"{gate}(controls={', '.join(f'q{c}' for c in op.controls)}, target=q{op.targets[0]})"
    if op.controls and op.params:
        return f"{gate}(control=q{op.controls[0]}, target=q{op.targets[0]}, angle={op.params[0]:.6f})"
    if op.controls:
        return f"{gate}(control=q{op.controls[0]}, target=q{op.targets[0]})"
    if len(op.targets) > 1:
        return f"{gate}({', '.join(f'q{t}' for t in op.targets)})"
    if op.params:
        return f"{gate}(q{op.targets[0]}, angle={op.params[0]:.6f})"
    if op.clbits:
        return f"{gate}(q{op.targets[0]} -> c{op.clbits[0]})"
    return f"{gate}(q{op.targets[0]})"


def diff_circuits(a: Circuit, b: Circuit) -> CircuitDifference:
    ops_a, ops_b = list(a.ops), list(b.ops)
    matcher = SequenceMatcher(a=[o.model_dump_json() for o in ops_a], b=[o.model_dump_json() for o in ops_b], autojunk=False)
    changes = [
        OpChange(
            tag=tag,
            a_start=i1,
            a_ops=[describe_op(o) for o in ops_a[i1:i2]],
            b_start=j1,
            b_ops=[describe_op(o) for o in ops_b[j1:j2]],
        )
        for tag, i1, i2, j1, j2 in matcher.get_opcodes()
    ]

    if a.num_qubits <= EQUIVALENCE_MAX_QUBITS and b.num_qubits <= EQUIVALENCE_MAX_QUBITS:
        report = check_equivalence(a, b)
        status, reason = report.status, report.reason
    else:
        status = EquivalenceStatus.UNVERIFIABLE
        reason = f"too many qubits to build the operators (limit {EQUIVALENCE_MAX_QUBITS}); nothing was computed"

    return CircuitDifference(
        same_circuit=ops_a == ops_b and a.num_qubits == b.num_qubits,
        num_qubits_a=a.num_qubits,
        num_qubits_b=b.num_qubits,
        num_ops_a=len(ops_a),
        num_ops_b=len(ops_b),
        changes=changes,
        equivalence_status=status,
        equivalence_reason=reason,
    )


# ------------------------------------------------------------------------------------------------ measurements


def outcome_values(payload: dict) -> tuple[dict[str, float], ValueKind] | None:
    """The run's per-outcome values and what kind they are, straight from its record; ``None`` if it recorded none."""
    if "probabilities" in payload and "counts" in payload:
        return dict(payload["probabilities"]), "sampled_frequency"
    if "theoretical_probabilities" in payload:
        return dict(payload["theoretical_probabilities"]), "theoretical_probability"
    if "statevector" in payload:  # records written before the theoretical probabilities were stored
        return theoretical_probabilities(payload["statevector"]), "theoretical_probability"
    if "probabilities" in payload:
        return dict(payload["probabilities"]), "sampled_frequency"
    return None


def compare_measurements(payload_a: dict, payload_b: dict) -> MeasurementDifference:
    values_a, values_b = outcome_values(payload_a), outcome_values(payload_b)
    if values_a is None or values_b is None:
        return MeasurementDifference(
            comparable=False,
            reason="one of the runs recorded no outcome values",
            kind_a=values_a[1] if values_a else None,
            kind_b=values_b[1] if values_b else None,
            rows=[],
            total_variation_distance=None,
            max_difference=None,
            note=None,
        )
    (a, kind_a), (b, kind_b) = values_a, values_b
    # Shots runs of a measured circuit key outcomes by the measured classical bits, so equal width is required for outcome labels to
    # mean the same thing on both sides.
    if len({len(k) for k in (*a, *b)}) > 1:
        return MeasurementDifference(
            comparable=False,
            reason="the two runs' outcomes are bitstrings of different lengths, so their labels do not mean the same thing",
            kind_a=kind_a,
            kind_b=kind_b,
            rows=[],
            total_variation_distance=None,
            max_difference=None,
            note=None,
        )

    rows = [
        OutcomeRow(
            outcome=key,
            a=a.get(key),
            b=b.get(key),
            difference=abs(a[key] - b[key]) if key in a and key in b else None,
        )
        for key in sorted({*a, *b})
    ]
    diffs = [abs(a.get(k, 0.0) - b.get(k, 0.0)) for k in {*a, *b}]
    note = None
    if kind_a != kind_b:
        note = "One run's values are sampled frequencies and the other's are theoretical probabilities: some difference is expected from sampling alone."
    elif kind_a == "sampled_frequency":
        note = "Both runs are sampled: differences between two sets of shots are expected even for the same circuit."
    return MeasurementDifference(
        comparable=True,
        reason=None,
        kind_a=kind_a,
        kind_b=kind_b,
        rows=rows,
        total_variation_distance=0.5 * sum(diffs),
        max_difference=max(diffs) if diffs else 0.0,
        note=note,
    )


# ------------------------------------------------------------------------------------------------------- states


def compare_result_states(payload_a: dict, payload_b: dict) -> StateDifference:
    state_a: Sequence[Sequence[float]] | None = payload_a.get("statevector")
    state_b: Sequence[Sequence[float]] | None = payload_b.get("statevector")
    if state_a is None or state_b is None:
        return StateDifference(
            comparable=False,
            reason="a state can only be compared between two statevector runs; a shots run has samples, not a state",
            fidelity=None,
            max_probability_difference=None,
            max_amplitude_difference=None,
            note=None,
        )
    if len(state_a) != len(state_b):
        return StateDifference(
            comparable=False,
            reason="the two states are on a different number of qubits",
            fidelity=None,
            max_probability_difference=None,
            max_amplitude_difference=None,
            note=None,
        )
    amp, prob, fidelity = compare_states(state_a, state_b)
    return StateDifference(
        comparable=True,
        reason=None,
        fidelity=fidelity,
        max_probability_difference=prob,
        max_amplitude_difference=amp,
        note="Fidelity is 1 when the states are the same up to a global phase; the amplitude difference is not phase-blind, so it can be non-zero for the same state.",
    )


def compare_experiments(
    circuit_a: Circuit, payload_a: dict, circuit_b: Circuit, payload_b: dict
) -> ExperimentComparison:
    return ExperimentComparison(
        circuit=diff_circuits(circuit_a, circuit_b),
        measurement=compare_measurements(payload_a, payload_b),
        state=compare_result_states(payload_a, payload_b),
    )
