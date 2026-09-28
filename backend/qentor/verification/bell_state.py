"""The first real verifier: does an executed result match the ideal Bell state?

Per CLAUDE.md's invariant, this module never runs a circuit and never invents a
number. It consumes exactly two trusted inputs — the canonical ``Circuit`` and the
``ProvenanceRecord`` an execution adapter already produced and the API layer already
persisted — and checks the *observed* support (the basis states that actually showed
up in the real result) against the *expected* support (the basis states an ideal
Bell circuit's own math says are possible). It is read-only with respect to
execution: nothing here calls Aer, computes an amplitude, or writes to the
provenance log.

Scope of this first verifier (docs/VERIFICATION_ARCHITECTURE.md §4 describes the
general test-harness/equivalence-checker machinery; this is a narrower, concrete
instance of it): a circuit matches the canonical Bell pattern when it is exactly
``h`` on some qubit ``control`` followed by ``cx(control, target)`` on a 2-qubit
circuit, with either no measurements (statevector mode) or measurements on exactly
those two qubits (shots mode). Anything else is UNVERIFIABLE by this verifier, not
a judgement that the circuit is wrong.
"""

from __future__ import annotations

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.provenance.models import ProvenanceRecord
from qentor.provenance.models import VerificationStatus as ExecutionStatus

from .models import CheckStatus, VerificationCheck, VerificationReport, VerificationStatus

VERIFIER_NAME = "bell_state/1"

_SUPPORT_TOLERANCE = 1e-9


class BellPatternMismatch(Exception):
    """The circuit is not the canonical H -> CX Bell pattern this verifier checks."""


class UnsupportedExecutionMode(Exception):
    """The record's payload has neither a statevector nor shot probabilities."""


def verify_bell_state(circuit: Circuit, record: ProvenanceRecord) -> VerificationReport:
    """Check a real execution result against the ideal Bell-state circuit's own math.

    Returns a full ``VerificationReport`` regardless of outcome — UNVERIFIABLE for a
    circuit shape this verifier does not recognise, ERROR for mismatched inputs or a
    failed execution, VERIFIED/FAILED once the observed support has actually been
    compared against the expected one.
    """
    checks: list[VerificationCheck] = []

    expected_hash = circuit_hash(circuit)
    hash_matches = expected_hash == record.circuit_hash
    checks.append(
        _check(
            "circuit_hash_matches_record",
            hash_matches,
            f"circuit hash {expected_hash} matches the provenance record",
            f"circuit hash {expected_hash} does not match the provenance record's "
            f"circuit hash {record.circuit_hash}; refusing to verify a mismatched pair",
        )
    )
    if not hash_matches:
        return _report(record, VerificationStatus.ERROR, checks, [], [])

    execution_ok = record.verification_status == ExecutionStatus.VERIFIED
    checks.append(
        _check(
            "execution_succeeded",
            execution_ok,
            f"execution result {record.result_id} has status {record.verification_status.value}",
            f"execution result {record.result_id} did not succeed "
            f"(status={record.verification_status.value}); there is no result to verify",
        )
    )
    if not execution_ok:
        return _report(record, VerificationStatus.ERROR, checks, [], [])

    try:
        control, target, clbit_map = _match_bell_pattern(circuit)
    except BellPatternMismatch as exc:
        checks.append(VerificationCheck(name="circuit_matches_bell_pattern", status=CheckStatus.FAIL, detail=str(exc)))
        return _report(record, VerificationStatus.UNVERIFIABLE, checks, [], [])
    checks.append(
        VerificationCheck(
            name="circuit_matches_bell_pattern",
            status=CheckStatus.PASS,
            detail=f"h(q{control}) -> cx(control=q{control}, target=q{target}) matches the canonical Bell pattern",
        )
    )

    try:
        expected_support, observed_support, support_checks = _support_checks(
            circuit, record.payload, control, target, clbit_map
        )
    except UnsupportedExecutionMode as exc:
        checks.append(VerificationCheck(name="execution_mode_supported", status=CheckStatus.FAIL, detail=str(exc)))
        return _report(record, VerificationStatus.UNVERIFIABLE, checks, [], [])

    checks.extend(support_checks)
    overall = (
        VerificationStatus.VERIFIED
        if all(c.status is CheckStatus.PASS for c in support_checks)
        else VerificationStatus.FAILED
    )
    return _report(record, overall, checks, sorted(expected_support), sorted(observed_support))


def _report(
    record: ProvenanceRecord,
    status: VerificationStatus,
    checks: list[VerificationCheck],
    expected_support: list[str],
    observed_support: list[str],
) -> VerificationReport:
    return VerificationReport(
        result_id=record.result_id,
        circuit_hash=record.circuit_hash,
        verifier=VERIFIER_NAME,
        verification_status=status,
        checks=checks,
        expected_support=expected_support,
        observed_support=observed_support,
    )


def _check(name: str, ok: bool, passed_detail: str, failed_detail: str) -> VerificationCheck:
    return VerificationCheck(
        name=name,
        status=CheckStatus.PASS if ok else CheckStatus.FAIL,
        detail=passed_detail if ok else failed_detail,
    )


def _match_bell_pattern(circuit: Circuit) -> tuple[int, int, dict[int, int]]:
    """Return (control_qubit, target_qubit, {qubit: clbit}) or raise BellPatternMismatch."""
    if circuit.num_qubits != 2:
        raise BellPatternMismatch(
            f"the Bell-state verifier only checks 2-qubit circuits, got {circuit.num_qubits} qubits"
        )

    non_measure = [op for op in circuit.ops if op.gate is not GateName.MEASURE]
    if len(non_measure) != 2:
        raise BellPatternMismatch(
            f"expected exactly two non-measurement operations (h, cx), found {len(non_measure)}"
        )

    h_op, cx_op = non_measure
    if h_op.gate is not GateName.H:
        raise BellPatternMismatch(f"expected the first operation to be h, found {h_op.gate.value}")
    if cx_op.gate is not GateName.CX:
        raise BellPatternMismatch(f"expected the second operation to be cx, found {cx_op.gate.value}")

    control = cx_op.controls[0]
    target = cx_op.targets[0]
    if h_op.targets[0] != control:
        raise BellPatternMismatch(
            f"expected h to act on the cx control qubit q{control}, found it on q{h_op.targets[0]}"
        )

    measure_ops: list[GateOp] = [op for op in circuit.ops if op.gate is GateName.MEASURE]
    clbit_map = {op.targets[0]: op.clbits[0] for op in measure_ops}
    if measure_ops and set(clbit_map) != {control, target}:
        raise BellPatternMismatch(
            f"expected measurements on exactly the two Bell qubits (q{control}, q{target}), "
            f"found measurements on {sorted(clbit_map)}"
        )

    return control, target, clbit_map


def _support_checks(
    circuit: Circuit,
    payload: dict,
    control: int,
    target: int,
    clbit_map: dict[int, int],
) -> tuple[set[str], set[str], list[VerificationCheck]]:
    if "statevector" in payload:
        return _statevector_support_checks(payload, circuit.num_qubits, control, target)
    if "probabilities" in payload:
        return _shots_support_checks(payload, circuit.num_clbits, clbit_map[control], clbit_map[target])
    raise UnsupportedExecutionMode(
        "the execution result payload has neither 'statevector' nor 'probabilities'; nothing to verify"
    )


def _statevector_support_checks(
    payload: dict, num_qubits: int, control: int, target: int
) -> tuple[set[str], set[str], list[VerificationCheck]]:
    statevector = payload["statevector"]
    amplitude_probabilities = [re * re + im * im for re, im in statevector]

    norm = sum(amplitude_probabilities)
    checks = [
        _check(
            "statevector_normalised",
            abs(norm - 1.0) <= 1e-9,
            f"the statevector's total probability is {norm:.12f} (within 1e-9 of 1.0)",
            f"the statevector's total probability is {norm:.12f}, not within 1e-9 of 1.0",
        )
    ]

    expected_support = {
        format(i, f"0{num_qubits}b")
        for i in range(2**num_qubits)
        if _bit(i, control) == _bit(i, target)
    }
    observed_support = {
        format(i, f"0{num_qubits}b")
        for i, p in enumerate(amplitude_probabilities)
        if p > _SUPPORT_TOLERANCE
    }

    checks.append(_support_subset_check(observed_support, expected_support))
    checks.append(_support_coverage_check(expected_support, observed_support))
    return expected_support, observed_support, checks


def _shots_support_checks(
    payload: dict, num_clbits: int, control_clbit: int, target_clbit: int
) -> tuple[set[str], set[str], list[VerificationCheck]]:
    probabilities: dict[str, float] = payload["probabilities"]

    total = sum(probabilities.values())
    checks = [
        _check(
            "shots_probabilities_normalised",
            abs(total - 1.0) <= 1e-9,
            f"the shot probabilities sum to {total:.12f} (within 1e-9 of 1.0)",
            f"the shot probabilities sum to {total:.12f}, not within 1e-9 of 1.0",
        )
    ]

    other_clbits = [c for c in range(num_clbits) if c not in (control_clbit, target_clbit)]
    expected_support = {
        bits
        for i in range(2**num_clbits)
        for bits in [format(i, f"0{num_clbits}b")]
        if _bit_str(bits, control_clbit) == _bit_str(bits, target_clbit)
        and all(_bit_str(bits, c) == "0" for c in other_clbits)
    }
    observed_support = set(probabilities.keys())

    checks.append(_support_subset_check(observed_support, expected_support))
    checks.append(_support_coverage_check(expected_support, observed_support))
    return expected_support, observed_support, checks


def _support_subset_check(observed_support: set[str], expected_support: set[str]) -> VerificationCheck:
    return _check(
        "observed_support_within_expected",
        observed_support <= expected_support,
        f"every observed outcome {sorted(observed_support)} is inside the expected support "
        f"{sorted(expected_support)}",
        f"observed outcomes {sorted(observed_support)} include some outside the expected support "
        f"{sorted(expected_support)}",
    )


def _support_coverage_check(expected_support: set[str], observed_support: set[str]) -> VerificationCheck:
    return _check(
        "expected_support_fully_observed",
        expected_support <= observed_support,
        f"every expected outcome {sorted(expected_support)} was observed",
        f"expected outcomes {sorted(expected_support)} were not all observed "
        f"(observed only {sorted(observed_support)})",
    )


def _bit(i: int, qubit: int) -> int:
    return (i >> qubit) & 1


def _bit_str(bits: str, clbit: int) -> str:
    """``bits`` is a q[n-1]...q[0]-ordered string; ``clbit`` counts from the right."""
    return bits[len(bits) - 1 - clbit]
