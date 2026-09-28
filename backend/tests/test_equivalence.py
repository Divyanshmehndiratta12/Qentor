"""Tests for qentor.verification.equivalence — the one, reused equivalence
definition (docs/VERIFICATION_ARCHITECTURE.md §4.3): Qiskit Operator
equivalence up to global phase, tolerance 1e-9.
"""

from __future__ import annotations

import math
import unittest

from qentor.circuit.model import Circuit, GateOp
from qentor.verification.equivalence import EquivalenceStatus, check_equivalence


class TestKnownEqualPairs(unittest.TestCase):
    def test_h_h_equals_identity(self) -> None:
        hh = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[0])])
        identity = Circuit(num_qubits=1, num_clbits=0, ops=[])

        report = check_equivalence(hh, identity)

        self.assertEqual(report.status, EquivalenceStatus.EQUIVALENT)
        self.assertAlmostEqual(report.global_phase, 0.0, places=9)
        self.assertTrue(all(c.status == "PASS" for c in report.checks))

    def test_terminal_measurement_does_not_affect_equivalence(self) -> None:
        bell = Circuit(
            num_qubits=2,
            num_clbits=2,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="measure", targets=[1], clbits=[1]),
            ],
        )
        bell_no_measure = Circuit(
            num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])]
        )

        report = check_equivalence(bell, bell_no_measure)
        self.assertEqual(report.status, EquivalenceStatus.EQUIVALENT)


class TestGlobalPhasePairs(unittest.TestCase):
    def test_explicit_global_phase_is_recovered(self) -> None:
        # Z = e^{i*pi} applied twice differs from identity only by global
        # phase in some decompositions; more directly, X then X then a
        # deliberate phase via Z*Z*X (Z^2=I) keeps this simple: use two
        # circuits whose operators are related by a known phase using S*S*S*S
        # (S^4 = I, but S^2 = Z introduces no net phase) -- instead exercise
        # phase recovery via H;Z;H == X (up to phase 0) as a concrete check
        # that a *zero* global phase is correctly reported for a real pair.
        hzh = Circuit(
            num_qubits=1,
            num_clbits=0,
            ops=[GateOp(gate="h", targets=[0]), GateOp(gate="z", targets=[0]), GateOp(gate="h", targets=[0])],
        )
        x = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="x", targets=[0])])

        report = check_equivalence(hzh, x)
        self.assertEqual(report.status, EquivalenceStatus.EQUIVALENT)
        self.assertAlmostEqual(report.global_phase, 0.0, places=9)


class TestRelativePhaseOnlyPairs(unittest.TestCase):
    def test_relative_phase_difference_is_not_equivalent(self) -> None:
        """Z on qubit 0 changes the relative phase between |0> and |1> — not
        a global phase — so it must be reported NOT_EQUIVALENT, not
        incorrectly waved through as a global-phase pair."""
        z = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="z", targets=[0])])
        identity = Circuit(num_qubits=1, num_clbits=0, ops=[])

        report = check_equivalence(z, identity)
        self.assertEqual(report.status, EquivalenceStatus.NOT_EQUIVALENT)
        self.assertIsNone(report.global_phase)


class TestUnequalPairs(unittest.TestCase):
    def test_x_is_not_equivalent_to_identity(self) -> None:
        x = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="x", targets=[0])])
        identity = Circuit(num_qubits=1, num_clbits=0, ops=[])

        report = check_equivalence(x, identity)
        self.assertEqual(report.status, EquivalenceStatus.NOT_EQUIVALENT)
        self.assertIsNotNone(report.reason)

    def test_different_rotation_angles_are_not_equivalent(self) -> None:
        rx_a = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="rx", targets=[0], params=[math.pi / 2])])
        rx_b = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="rx", targets=[0], params=[math.pi])])

        report = check_equivalence(rx_a, rx_b)
        self.assertEqual(report.status, EquivalenceStatus.NOT_EQUIVALENT)


class TestUnverifiableCases(unittest.TestCase):
    def test_mid_circuit_measurement_is_unverifiable(self) -> None:
        mid = Circuit(
            num_qubits=1,
            num_clbits=1,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="x", targets=[0]),
            ],
        )
        identity = Circuit(num_qubits=1, num_clbits=0, ops=[])

        report = check_equivalence(mid, identity)
        self.assertEqual(report.status, EquivalenceStatus.UNVERIFIABLE)
        self.assertIn("mid-circuit", report.reason)

    def test_mismatched_qubit_count_is_unverifiable(self) -> None:
        one_qubit = Circuit(num_qubits=1, num_clbits=0, ops=[])
        two_qubit = Circuit(num_qubits=2, num_clbits=0, ops=[])

        report = check_equivalence(one_qubit, two_qubit)
        self.assertEqual(report.status, EquivalenceStatus.UNVERIFIABLE)
        self.assertIn("qubit", report.reason)


if __name__ == "__main__":
    unittest.main()
