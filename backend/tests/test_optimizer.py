"""Tests for qentor.verification.optimizer — the rewrite-rule-set + the one
rule that matters: no candidate is ever reported optimised without passing
qentor.verification.equivalence first.
"""

from __future__ import annotations

import math
import unittest
from unittest.mock import patch

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable, ExecutionResult
from qentor.execution.aer import AerAdapter
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.verification.equivalence import EquivalenceStatus
from qentor.verification.optimizer import OptimizationStatus, generate_candidate, optimize_circuit

HH = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[0])])

BELL = Circuit(
    num_qubits=2,
    num_clbits=2,
    ops=[
        GateOp(gate="h", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
    ],
)

REDUNDANT = Circuit(
    num_qubits=2,
    num_clbits=0,
    ops=[
        GateOp(gate="x", targets=[0]),
        GateOp(gate="x", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="cx", controls=[0], targets=[1]),
    ],
)


class TestRedundantCircuitIsReduced(unittest.TestCase):
    def test_hh_cancels_to_the_empty_circuit(self) -> None:
        report = optimize_circuit(HH)

        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertEqual(report.original_op_count, 2)
        self.assertEqual(report.candidate_op_count, 0)
        self.assertIn("cancelled adjacent h pair on qubit(s) [0]", report.rules_applied)

    def test_redundant_pairs_across_two_gate_types_both_cancel(self) -> None:
        report = optimize_circuit(REDUNDANT)

        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertEqual(report.candidate_op_count, 0)
        self.assertEqual(len(report.rules_applied), 2)

    def test_same_axis_rotations_merge(self) -> None:
        circuit = Circuit(
            num_qubits=1,
            num_clbits=0,
            ops=[
                GateOp(gate="rx", targets=[0], params=[math.pi / 4]),
                GateOp(gate="rx", targets=[0], params=[math.pi / 4]),
            ],
        )
        report = optimize_circuit(circuit)

        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertEqual(report.candidate_op_count, 1)
        self.assertAlmostEqual(report.candidate_circuit.ops[0].params[0], math.pi / 2, places=9)

    def test_zero_angle_rotation_is_removed(self) -> None:
        circuit = Circuit(
            num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="ry", targets=[0], params=[0.0])]
        )
        report = optimize_circuit(circuit)

        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertEqual(report.candidate_op_count, 1)
        self.assertEqual(report.candidate_circuit.ops[0].gate.value, "h")


class TestReducedCircuitIsVerifiedEquivalent(unittest.TestCase):
    def test_verified_shorter_always_carries_an_equivalent_equivalence_report(self) -> None:
        report = optimize_circuit(HH)

        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertIsNotNone(report.equivalence)
        self.assertEqual(report.equivalence.status, EquivalenceStatus.EQUIVALENT)
        self.assertEqual(report.equivalence.method, "qiskit.quantum_info.Operator.equiv")


class TestNonOptimizableCircuitIsUnchanged(unittest.TestCase):
    def test_bell_circuit_has_nothing_to_cancel(self) -> None:
        report = optimize_circuit(BELL)

        self.assertEqual(report.status, OptimizationStatus.NO_OPTIMIZATION_FOUND)
        self.assertEqual(report.original_circuit_hash, report.candidate_circuit_hash)
        self.assertEqual(report.original_op_count, report.candidate_op_count)
        self.assertIsNone(report.candidate_circuit)
        self.assertIsNotNone(report.reason)
        self.assertEqual(report.rules_applied, [])


class TestCandidateFailingEquivalenceIsRejected(unittest.TestCase):
    """Proves the safety net, not the rule author, decides — inject a
    deliberately wrong "rewrite" (not one this module's real rules would ever
    produce) and confirm it is discarded rather than reported as optimised."""

    def test_a_wrong_candidate_is_rejected_not_trusted(self) -> None:
        wrong_candidate = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="x", targets=[0])])

        with patch(
            "qentor.verification.optimizer.generate_candidate",
            return_value=(wrong_candidate, ["a deliberately broken rule for this test"]),
        ):
            identity_like = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[0])])
            report = optimize_circuit(identity_like)

        self.assertEqual(report.status, OptimizationStatus.REJECTED)
        self.assertEqual(report.equivalence.status, EquivalenceStatus.NOT_EQUIVALENT)
        self.assertIsNone(report.candidate_circuit)
        self.assertIn("not verified equivalent", report.reason)


class TestOpCountNeverIncreases(unittest.TestCase):
    def test_verified_shorter_candidates_never_have_more_ops_than_the_original(self) -> None:
        for circuit in (HH, REDUNDANT):
            report = optimize_circuit(circuit)
            with self.subTest(circuit=circuit):
                self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
                self.assertLessEqual(report.candidate_op_count, report.original_op_count)

    def test_generate_candidate_alone_never_increases_op_count(self) -> None:
        for circuit in (HH, REDUNDANT, BELL):
            candidate, _rules = generate_candidate(circuit)
            with self.subTest(circuit=circuit):
                self.assertLessEqual(len(candidate.ops), len(circuit.ops))


class TestCircuitHashesAreRecordedCorrectly(unittest.TestCase):
    def test_hashes_match_independently_computed_values(self) -> None:
        report = optimize_circuit(HH)
        candidate, _ = generate_candidate(HH)

        self.assertEqual(report.original_circuit_hash, circuit_hash(HH))
        self.assertEqual(report.candidate_circuit_hash, circuit_hash(candidate))
        self.assertEqual(len(report.original_circuit_hash), 64)
        self.assertEqual(len(report.candidate_circuit_hash), 64)

    def test_no_optimization_found_reports_identical_hashes(self) -> None:
        report = optimize_circuit(BELL)
        self.assertEqual(report.original_circuit_hash, report.candidate_circuit_hash)


class TestProvenanceReferencesArePreserved(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = AerAdapter()
        try:
            self.adapter.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")

    def test_verified_shorter_persists_supporting_execution_and_returns_its_id(self) -> None:
        recorded: list[tuple[str, str]] = []

        def record_execution(result: ExecutionResult, candidate_hash: str) -> str:
            result_id = f"res_fake_{len(recorded)}"
            recorded.append((result_id, candidate_hash))
            return result_id

        report = optimize_circuit(HH, adapter=self.adapter, record_execution=record_execution)

        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertEqual(len(recorded), 1)
        self.assertEqual(report.result_id, recorded[0][0])
        self.assertEqual(recorded[0][1], report.candidate_circuit_hash)

    def test_no_optimization_found_never_calls_record_execution(self) -> None:
        calls: list[str] = []

        def record_execution(result: ExecutionResult, candidate_hash: str) -> str:
            calls.append(candidate_hash)
            return "res_should_not_happen"

        report = optimize_circuit(BELL, adapter=self.adapter, record_execution=record_execution)

        self.assertEqual(report.status, OptimizationStatus.NO_OPTIMIZATION_FOUND)
        self.assertEqual(calls, [])
        self.assertIsNone(report.result_id)

    def test_without_an_adapter_result_id_stays_unset(self) -> None:
        report = optimize_circuit(HH)
        self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
        self.assertIsNone(report.result_id)


class TestAllThreeAdaptersCanParticipate(unittest.TestCase):
    def test_supporting_execution_succeeds_on_every_adapter(self) -> None:
        for name, adapter in (("qiskit-aer", AerAdapter()), ("cirq", CirqAdapter()), ("pennylane", PennyLaneAdapter())):
            recorded: list[str] = []

            def record_execution(result: ExecutionResult, candidate_hash: str, _name=name) -> str:
                recorded.append(_name)
                return f"res_{_name}"

            try:
                report = optimize_circuit(HH, adapter=adapter, record_execution=record_execution)
            except AdapterUnavailable as exc:
                self.skipTest(f"{name} unavailable in this environment: {exc}")

            with self.subTest(adapter=name):
                self.assertEqual(report.status, OptimizationStatus.VERIFIED_SHORTER)
                self.assertEqual(report.result_id, f"res_{name}")
                self.assertEqual(recorded, [name])


class TestUnverifiableCircuitsReturnUnverifiable(unittest.TestCase):
    def test_mid_circuit_measurement_around_a_real_rewrite_is_unverifiable(self) -> None:
        """H;H cancels (a real rewrite fires), but the original circuit has a
        gate after a measurement — the equivalence checker can't verify
        anything for it, and the optimizer must say so, not silently succeed
        or silently ignore the measurement."""
        mid_circuit = Circuit(
            num_qubits=1,
            num_clbits=1,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="h", targets=[0]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="x", targets=[0]),
            ],
        )
        report = optimize_circuit(mid_circuit)

        self.assertEqual(report.status, OptimizationStatus.UNVERIFIABLE)
        self.assertIsNone(report.candidate_circuit)
        self.assertIsNotNone(report.reason)
        # A real rewrite did fire — this isn't "nothing to optimise", it's
        # "found something, but couldn't verify it".
        self.assertNotEqual(report.rules_applied, [])


if __name__ == "__main__":
    unittest.main()
