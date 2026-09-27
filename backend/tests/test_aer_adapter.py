"""Qiskit Aer adapter tests — statevector mode, shots mode, and reliability cases.

These are real integration tests against the real Aer API. In this environment
they SKIP with the exact import error rather than passing on faked data — see
docs/BUILD_STATE.md. They are written to actually execute wherever qiskit's
native extension is not blocked by the host OS.
"""

from __future__ import annotations

import math
import unittest

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter

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

BELL_NO_MEASURE = Circuit(
    num_qubits=2,
    num_clbits=0,
    ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])],
)


class AerTestCase(unittest.TestCase):
    """Base class that turns AdapterUnavailable into an explicit, reasoned skip
    instead of letting the test error out or, worse, silently passing."""

    def setUp(self) -> None:
        self.adapter = AerAdapter()

    def run_or_skip(self, circuit: Circuit, mode: str, shots: int | None = None):
        try:
            return self.adapter.run(circuit, mode, shots)
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")


class TestStatevectorMode(AerTestCase):
    def test_bell_state_statevector(self) -> None:
        result = self.run_or_skip(BELL_NO_MEASURE, "statevector")
        self.assertEqual(result.backend_name, "qiskit-aer")
        self.assertEqual(result.execution_mode, "statevector")
        self.assertIsNotNone(result.statevector)
        # |00> and |11> amplitudes ~ 1/sqrt(2), |01> and |10> ~ 0
        amp00 = complex(*result.statevector[0])
        amp01 = complex(*result.statevector[1])
        amp10 = complex(*result.statevector[2])
        amp11 = complex(*result.statevector[3])
        self.assertAlmostEqual(abs(amp00), 1 / math.sqrt(2), places=6)
        self.assertAlmostEqual(abs(amp01), 0.0, places=6)
        self.assertAlmostEqual(abs(amp10), 0.0, places=6)
        self.assertAlmostEqual(abs(amp11), 1 / math.sqrt(2), places=6)
        norm = sum(abs(complex(*a)) ** 2 for a in result.statevector)
        self.assertAlmostEqual(norm, 1.0, places=9)


class TestShotsMode(AerTestCase):
    def test_bell_state_shots(self) -> None:
        result = self.run_or_skip(BELL, "shots", shots=4000)
        self.assertEqual(result.execution_mode, "shots")
        self.assertIsNotNone(result.counts)
        self.assertIsNotNone(result.probabilities)
        total = sum(result.counts.values())
        self.assertEqual(total, 4000)
        # Bell state: only 00 and 11 should appear (within statistical noise), each ~0.5
        for outcome in ("00", "11"):
            self.assertIn(outcome, result.probabilities)
            self.assertAlmostEqual(result.probabilities[outcome], 0.5, delta=0.05)
        for outcome in result.probabilities:
            self.assertIn(outcome, ("00", "11"))

    def test_probabilities_sum_to_one(self) -> None:
        result = self.run_or_skip(BELL, "shots", shots=1000)
        self.assertAlmostEqual(sum(result.probabilities.values()), 1.0, places=9)


class TestReliability(AerTestCase):
    def test_shots_mode_without_measurement_raises(self) -> None:
        try:
            with self.assertRaises(AdapterExecutionError):
                self.adapter.run(BELL_NO_MEASURE, "shots", shots=100)
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")

    def test_shots_mode_with_zero_shots_raises(self) -> None:
        try:
            with self.assertRaises(AdapterExecutionError):
                self.adapter.run(BELL, "shots", shots=0)
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")


if __name__ == "__main__":
    unittest.main()
