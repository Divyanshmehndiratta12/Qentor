"""Verified circuit optimisation foundation (docs/VERIFICATION_ARCHITECTURE.md §4.4).

A small, deterministic, peephole rewrite pass — not a global optimiser — plus
the one rule that actually matters here: **the rewrite rules never speak for
themselves**. Every candidate this module produces is checked against the
original with ``qentor.verification.equivalence.check_equivalence`` (the one
documented equivalence definition, §4.3) before it can ever be reported as
optimised. A candidate that fails that check, or that can't be checked at
all, is discarded — the caller gets the original circuit back with an honest
status, never a rewrite "trusted" because the rule that produced it looked
safe.

Rules implemented (all provably operator-preserving on adjacent, same-qubit
operations — no cross-qubit commuting/reordering search is attempted, which
is what keeps this "small" rather than a general optimiser):

- adjacent self-inverse cancellation: H·H, X·X, Y·Y, Z·Z, CX·CX with the same
  control/target, CZ·CZ (symmetric, so either qubit order), SWAP·SWAP (either order)
  and CCX·CCX with the same controls (either order) and target, each pair removed
  entirely (G·G = I for these gates).
- adjacent inverse-pair cancellation: S·S†, S†·S, T·T†, T†·T on the same qubit.
- same-axis rotation merging: adjacent RX/RY/RZ on the same qubit combine
  into one rotation with the summed angle (rotations about the same axis
  compose by adding angles).
- zero-angle rotation removal: RX/RY/RZ with angle exactly 0 is the identity.

Not implemented, deliberately: commuting gates across disjoint qubits to expose
a cancellation that isn't already adjacent (a real optimiser feature, but a
search problem, not a "small" rule).
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict

from qentor.circuit.describe import describe_op
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import (
    AdapterExecutionError,
    AdapterUnavailable,
    ExecutionAdapter,
    ExecutionResult,
)

from .equivalence import EquivalenceReport, EquivalenceStatus, check_equivalence

VERIFIER_NAME = "qentor.verification.optimizer"
VERIFIER_VERSION = "1"

_SELF_INVERSE_SINGLE = {GateName.H, GateName.X, GateName.Y, GateName.Z}
_INVERSE_PAIRS = {
    (GateName.S, GateName.SDG),
    (GateName.SDG, GateName.S),
    (GateName.T, GateName.TDG),
    (GateName.TDG, GateName.T),
}
_ROTATION_GATES = {GateName.RX, GateName.RY, GateName.RZ}
_NO_MATCH = object()


class OptimizationStatus(str, Enum):
    VERIFIED_SHORTER = "VERIFIED_SHORTER"
    NO_OPTIMIZATION_FOUND = "NO_OPTIMIZATION_FOUND"
    REJECTED = "REJECTED"
    UNVERIFIABLE = "UNVERIFIABLE"


class OpChange(BaseModel):
    """One line of the difference between the original circuit and the verified candidate, computed here from the two operation
    lists (a longest-common-subsequence diff on exact operations): an operation kept, one removed from the original, one added
    in the candidate (a merged rotation shows as the two removed and the one added). It describes structure, never an effect."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["kept", "removed", "added"]
    original_index: int | None
    candidate_index: int | None
    description: str


class RuleNote(BaseModel):
    """What an applied rewrite rule rests on, in one plain sentence (``None`` for a rule this module has no sentence for: nothing is
    made up). It is textbook reasoning about why the rule is safe; whether the candidate really is equivalent is decided only by
    the equivalence checker, and the sentence says nothing about this circuit's state."""

    model_config = ConfigDict(extra="forbid")

    rule: str
    explanation: str | None


_SELF_INVERSE_NAMES = {"h", "x", "y", "z", "cx", "cz", "swap", "ccx"}
_INVERSE_PAIR_NAMES = {"s", "sdg", "t", "tdg"}


def explain_rule(rule: str) -> str | None:
    """The sentence behind a rule string produced by ``generate_candidate``; ``None`` if the string is not one of ours."""
    cancelled = re.match(r"^cancelled adjacent (\w+) pair", rule)
    if cancelled:
        gate = cancelled.group(1)
        if gate in _INVERSE_PAIR_NAMES:
            return "A gate followed by its inverse (S then S-dagger, or T then T-dagger) returns every state to where it started, so the pair changes nothing."
        if gate in _SELF_INVERSE_NAMES:
            return f"Applying {gate.upper()} twice in a row returns every state to where it started, so the pair changes nothing."
        return None
    merged = re.match(r"^merged adjacent (\w+) ops", rule)
    if merged and merged.group(1) in {"rx", "ry", "rz"}:
        return f"Two {merged.group(1).upper()} rotations on the same qubit add their angles, so they can be replaced by one rotation by the sum."
    if re.match(r"^removed zero-angle (rx|ry|rz) ", rule):
        return "A rotation by an angle of zero changes nothing, so it can be removed."
    return None


def diff_ops(original: Circuit, candidate: Circuit) -> list[OpChange]:
    """The operation-level difference between two circuits, in reading order, from a longest common subsequence of exact operations."""
    a, b = list(original.ops), list(candidate.ops)
    n, m = len(a), len(b)
    # lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:]
    lcs = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            lcs[i][j] = lcs[i + 1][j + 1] + 1 if a[i] == b[j] else max(lcs[i + 1][j], lcs[i][j + 1])
    changes: list[OpChange] = []
    i = j = 0
    while i < n or j < m:
        if i < n and j < m and a[i] == b[j]:
            changes.append(OpChange(kind="kept", original_index=i, candidate_index=j, description=describe_op(a[i])))
            i += 1
            j += 1
        elif j >= m or (i < n and lcs[i + 1][j] >= lcs[i][j + 1]):
            changes.append(OpChange(kind="removed", original_index=i, candidate_index=None, description=describe_op(a[i])))
            i += 1
        else:
            changes.append(OpChange(kind="added", original_index=None, candidate_index=j, description=describe_op(b[j])))
            j += 1
    return changes


class OptimizationReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    original_circuit_hash: str
    candidate_circuit_hash: str
    original_op_count: int
    candidate_op_count: int
    rules_applied: list[str]
    reduction_summary: str
    status: OptimizationStatus
    equivalence: EquivalenceReport | None
    verifier_name: str
    verifier_version: str
    reason: str | None
    # Only populated once status is VERIFIED_SHORTER — see AI_BOUNDARY.md's
    # "a candidate circuit is never auto-applied ... only after it shows
    # VERIFIED": an unverified/rejected candidate's definition is withheld,
    # not merely labelled, so nothing downstream can apply it by mistake.
    candidate_circuit: Circuit | None
    result_id: str | None
    # Computed here, never by a client: how many operations the candidate removes, what changed operation by operation (only for a
    # VERIFIED_SHORTER candidate, whose definition is the only one ever shown), and the sentence behind each rule that fired.
    operations_removed: int = 0
    changes: list[OpChange] = []
    rule_notes: list[RuleNote] = []


def generate_candidate(circuit: Circuit) -> tuple[Circuit, list[str]]:
    """Apply the rule set to a fixed point. Returns the rewritten circuit
    (identical to the input if no rule ever fired) and the log of rules
    applied, in order."""
    ops = list(circuit.ops)
    rules_applied: list[str] = []
    changed = True
    while changed:
        changed = False
        ops, log = _peephole_pass(ops, _combine_merge_rotations)
        if log:
            rules_applied.extend(log)
            changed = True
        ops, log = _remove_zero_angle_rotations(ops)
        if log:
            rules_applied.extend(log)
            changed = True
        ops, log = _peephole_pass(ops, _combine_cancel_self_inverse)
        if log:
            rules_applied.extend(log)
            changed = True

    candidate = Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=ops)
    return candidate, rules_applied


def optimize_circuit(
    circuit: Circuit,
    *,
    adapter: ExecutionAdapter | None = None,
    record_execution: Callable[[ExecutionResult, str], str] | None = None,
) -> OptimizationReport:
    """Generate a candidate, verify it, and report honestly.

    ``adapter``/``record_execution`` are optional, injected exactly like
    ``qentor.verification.multi_input_harness.run_multi_input_test``: if both
    are given and the candidate is verified, the (measurement-free) candidate
    is run once in statevector mode purely as persisted supporting evidence —
    this module never calls ``ExecutionAdapter.run`` for the equivalence
    verdict itself, which comes only from ``check_equivalence``.
    """
    original_hash = circuit_hash(circuit)
    candidate, rules_applied = generate_candidate(circuit)
    candidate_hash = circuit_hash(candidate)

    if candidate_hash == original_hash:
        return OptimizationReport(
            original_circuit_hash=original_hash,
            candidate_circuit_hash=original_hash,
            original_op_count=len(circuit.ops),
            candidate_op_count=len(circuit.ops),
            rules_applied=[],
            reduction_summary=f"{len(circuit.ops)} -> {len(circuit.ops)} operations (unchanged)",
            status=OptimizationStatus.NO_OPTIMIZATION_FOUND,
            equivalence=None,
            verifier_name=VERIFIER_NAME,
            verifier_version=VERIFIER_VERSION,
            reason="no rewrite rule matched this circuit",
            candidate_circuit=None,
            result_id=None,
        )

    equivalence = check_equivalence(circuit, candidate)
    reduction_summary = f"{len(circuit.ops)} -> {len(candidate.ops)} operations"

    if equivalence.status is EquivalenceStatus.UNVERIFIABLE:
        return OptimizationReport(
            original_circuit_hash=original_hash,
            candidate_circuit_hash=candidate_hash,
            original_op_count=len(circuit.ops),
            candidate_op_count=len(candidate.ops),
            rules_applied=rules_applied,
            reduction_summary=reduction_summary,
            status=OptimizationStatus.UNVERIFIABLE,
            equivalence=equivalence,
            verifier_name=VERIFIER_NAME,
            verifier_version=VERIFIER_VERSION,
            reason=equivalence.reason,
            candidate_circuit=None,
            result_id=None,
            rule_notes=[RuleNote(rule=r, explanation=explain_rule(r)) for r in rules_applied],
        )

    if equivalence.status is EquivalenceStatus.NOT_EQUIVALENT:
        # Should never happen for the provably-safe rules above — this branch
        # exists because the safety net, not the rule author's judgement, is
        # what is allowed to declare a candidate correct. If a future rule is
        # ever buggy, this is where it gets caught rather than shipped.
        return OptimizationReport(
            original_circuit_hash=original_hash,
            candidate_circuit_hash=candidate_hash,
            original_op_count=len(circuit.ops),
            candidate_op_count=len(candidate.ops),
            rules_applied=rules_applied,
            reduction_summary=reduction_summary,
            status=OptimizationStatus.REJECTED,
            equivalence=equivalence,
            verifier_name=VERIFIER_NAME,
            verifier_version=VERIFIER_VERSION,
            reason="candidate rewrite was not verified equivalent to the original; discarded",
            candidate_circuit=None,
            result_id=None,
            rule_notes=[RuleNote(rule=r, explanation=explain_rule(r)) for r in rules_applied],
        )

    result_id = None
    if adapter is not None and record_execution is not None:
        result_id = _record_supporting_execution(candidate, candidate_hash, adapter, record_execution)

    return OptimizationReport(
        original_circuit_hash=original_hash,
        candidate_circuit_hash=candidate_hash,
        original_op_count=len(circuit.ops),
        candidate_op_count=len(candidate.ops),
        rules_applied=rules_applied,
        reduction_summary=reduction_summary,
        status=OptimizationStatus.VERIFIED_SHORTER,
        equivalence=equivalence,
        verifier_name=VERIFIER_NAME,
        verifier_version=VERIFIER_VERSION,
        reason=None,
        candidate_circuit=candidate,
        result_id=result_id,
        operations_removed=len(circuit.ops) - len(candidate.ops),
        changes=diff_ops(circuit, candidate),
        rule_notes=[RuleNote(rule=r, explanation=explain_rule(r)) for r in rules_applied],
    )


def _record_supporting_execution(
    candidate: Circuit,
    candidate_hash: str,
    adapter: ExecutionAdapter,
    record_execution: Callable[[ExecutionResult, str], str],
) -> str | None:
    """Best-effort: a verified candidate is still reported VERIFIED_SHORTER
    even if this fails — the equivalence proof already stands on its own."""
    measurement_free_ops = [op for op in candidate.ops if op.gate is not GateName.MEASURE]
    probe = Circuit(num_qubits=candidate.num_qubits, num_clbits=0, ops=measurement_free_ops)
    try:
        result = adapter.run(probe, "statevector")
    except (AdapterUnavailable, AdapterExecutionError):
        return None
    return record_execution(result, candidate_hash)


def _peephole_pass(
    ops: list[GateOp], combine: Callable[[GateOp, GateOp], GateOp | None | object]
) -> tuple[list[GateOp], list[str]]:
    """One left-to-right scan. For each op, if the nearest not-yet-finalised
    op touching exactly the same qubits can be combined with it per
    ``combine``, the pair is replaced. Gates on disjoint qubits never block
    each other here: tensor factors on different qubits commute at the
    matrix level regardless of their order in ``ops``, so no reordering
    search is needed for this to be correct — only per-qubit adjacency
    tracking.
    """
    pending_index: dict[int, int] = {}
    output: list[GateOp | None] = []
    applied: list[str] = []

    for op in ops:
        if op.gate is GateName.MEASURE:
            output.append(op)
            for q in op.targets:
                pending_index.pop(q, None)
            continue

        op_qubits = tuple(sorted(set(op.targets) | set(op.controls)))
        owners = {pending_index.get(q) for q in op_qubits}

        if len(owners) == 1 and None not in owners:
            owner_idx = owners.pop()
            owner_op = output[owner_idx]
            owner_qubits = tuple(sorted(set(owner_op.targets) | set(owner_op.controls)))
            if owner_qubits == op_qubits:
                combined = combine(owner_op, op)
                if combined is not _NO_MATCH:
                    if combined is None:
                        output[owner_idx] = None
                        applied.append(f"cancelled adjacent {op.gate.value} pair on qubit(s) {list(op_qubits)}")
                    else:
                        output[owner_idx] = combined
                        applied.append(f"merged adjacent {op.gate.value} ops on qubit(s) {list(op_qubits)}")
                    for q in op_qubits:
                        pending_index.pop(q, None)
                    continue

        output.append(op)
        idx = len(output) - 1
        for q in op_qubits:
            pending_index[q] = idx

    return [op for op in output if op is not None], applied


def _combine_cancel_self_inverse(a: GateOp, b: GateOp):
    if a.gate == b.gate and a.gate in _SELF_INVERSE_SINGLE:
        return None
    if (a.gate, b.gate) in _INVERSE_PAIRS and a.targets == b.targets:
        return None
    if a.gate is GateName.CX and b.gate is GateName.CX and a.controls == b.controls and a.targets == b.targets:
        return None
    if a.gate is GateName.CZ and b.gate is GateName.CZ and {*a.controls, *a.targets} == {*b.controls, *b.targets}:
        return None  # CZ is symmetric in its two qubits
    if a.gate is GateName.SWAP and b.gate is GateName.SWAP and set(a.targets) == set(b.targets):
        return None
    if (
        a.gate is GateName.CCX
        and b.gate is GateName.CCX
        and set(a.controls) == set(b.controls)
        and a.targets == b.targets
    ):
        return None
    return _NO_MATCH


def _combine_merge_rotations(a: GateOp, b: GateOp):
    if a.gate == b.gate and a.gate in _ROTATION_GATES:
        return GateOp(gate=a.gate, targets=list(a.targets), params=[a.params[0] + b.params[0]])
    return _NO_MATCH


def _remove_zero_angle_rotations(ops: list[GateOp]) -> tuple[list[GateOp], list[str]]:
    kept: list[GateOp] = []
    applied: list[str] = []
    for op in ops:
        if op.gate in _ROTATION_GATES and op.params[0] == 0.0:
            applied.append(f"removed zero-angle {op.gate.value} on qubit {op.targets[0]}")
            continue
        kept.append(op)
    return kept, applied
