"""OPTIMIZE: the platform's optimiser and equivalence checker, asked as one analysis.

Reuses ``qentor.verification.optimizer`` (a small peephole rewrite pass) and, through it, ``qentor.verification.equivalence`` (the
one equivalence definition). Whether the candidate is the same circuit is decided ONLY by that checker: this module adds no
verdict, and a model is never asked. A candidate is shown only when the checker found it equivalent AND it has fewer operations;
in every other case the answer is an explicit no-improvement result with the reason, and no candidate circuit at all.
"""

from __future__ import annotations

from typing import Callable

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit
from qentor.circuit.qasm import to_qasm3
from qentor.execution.adapter import ExecutionAdapter, ExecutionResult
from qentor.provenance.models import ProvenanceRecord
from qentor.verification.optimizer import OptimizationReport, OptimizationStatus, optimize_circuit

from .models import Analysis, Intent, source_of


def optimization_data(circuit: Circuit, report: OptimizationReport) -> dict:
    verified = report.status is OptimizationStatus.VERIFIED_SHORTER and report.candidate_circuit is not None
    data: dict = {
        "optimization_status": report.status.value,
        "original_circuit": circuit.model_dump(mode="json", by_alias=True),
        "original_qasm": to_qasm3(circuit),
        "original_circuit_hash": report.original_circuit_hash,
        "original_op_count": report.original_op_count,
        "candidate_circuit": report.candidate_circuit.model_dump(mode="json", by_alias=True) if verified else None,
        "candidate_qasm": to_qasm3(report.candidate_circuit) if verified else None,
        "candidate_circuit_hash": report.candidate_circuit_hash if verified else None,
        "candidate_op_count": report.candidate_op_count if verified else None,
        "operations_removed": report.operations_removed if verified else 0,
        "rules_applied": list(report.rules_applied) if verified else [],
        "rewrites": [n.model_dump(mode="json") for n in report.rule_notes] if verified else [],
        "changes": [c.model_dump(mode="json") for c in report.changes] if verified else [],
        "equivalence": (
            {
                "status": report.equivalence.status.value,
                "method": report.equivalence.method,
                "global_phase": report.equivalence.global_phase,
                "reason": report.equivalence.reason,
                "checks": [c.model_dump(mode="json") for c in report.equivalence.checks],
            }
            if report.equivalence is not None
            else None
        ),
        "verifier": f"{report.verifier_name}/{report.verifier_version}",
        "candidate_result_id": report.result_id if verified else None,
    }
    return data


def analyze_optimization(
    circuit: Circuit,
    *,
    adapter: ExecutionAdapter,
    record_execution: Callable[[ExecutionResult, str], str],
    get_record: Callable[[str], ProvenanceRecord | None],
) -> Analysis:
    report = optimize_circuit(circuit, adapter=adapter, record_execution=record_execution)
    data = optimization_data(circuit, report)
    sources = []
    if report.result_id is not None and (record := get_record(report.result_id)) is not None:
        sources.append(source_of("candidate", record))

    if report.status is OptimizationStatus.VERIFIED_SHORTER and report.candidate_circuit is not None:
        return Analysis(intent=Intent.OPTIMIZE, status="OK", circuit_hash=circuit_hash(circuit), sources=sources, data=data)

    if report.status is OptimizationStatus.NO_OPTIMIZATION_FOUND:
        reason = "no rewrite rule matched this circuit, so there is no shorter circuit to offer"
    elif report.status is OptimizationStatus.REJECTED:
        reason = "a rewrite was found but the equivalence checker did not confirm it is the same circuit, so it was discarded"
    else:
        reason = f"a rewrite was found but the equivalence checker could not decide whether it is the same circuit ({report.reason or 'unverifiable'}), so it was discarded"
    return Analysis(intent=Intent.OPTIMIZE, status="NO_IMPROVEMENT", reason=reason, circuit_hash=circuit_hash(circuit), sources=sources, data=data)
