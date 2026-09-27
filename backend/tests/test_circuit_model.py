"""Reliability tests for the canonical circuit model — malformed input, out-of-range
indices, unsupported gates, invalid parameters. Pure Python; no qiskit needed."""

from __future__ import annotations

import unittest

from pydantic import ValidationError

from qentor.circuit.model import Circuit, GateOp


class TestValidCircuits(unittest.TestCase):
    def test_bell_circuit_is_valid(self) -> None:
        c = Circuit(
            schema="qentor.circuit/1",
            num_qubits=2,
            num_clbits=2,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="measure", targets=[1], clbits=[1]),
            ],
        )
        self.assertEqual(c.num_qubits, 2)
        self.assertEqual(len(c.ops), 4)

    def test_rotation_gate_with_angle_is_valid(self) -> None:
        c = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="rx", targets=[0], params=[1.5707963267948966])])
        self.assertAlmostEqual(c.ops[0].params[0], 1.5707963267948966)


class TestMalformedCircuits(unittest.TestCase):
    def test_missing_required_field_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            Circuit.model_validate({"num_clbits": 0, "ops": []})  # missing num_qubits

    def test_extra_field_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            Circuit.model_validate(
                {"num_qubits": 1, "num_clbits": 0, "ops": [], "probabilities": {"0": 1.0}}
            )

    def test_wrong_type_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            Circuit.model_validate({"num_qubits": "two", "num_clbits": 0, "ops": []})


class TestInvalidQubitIndex(unittest.TestCase):
    def test_target_out_of_range_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[5])])

    def test_negative_qubit_index_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[-1])])


class TestInvalidCnot(unittest.TestCase):
    def test_control_out_of_range_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="cx", controls=[9], targets=[0])])

    def test_control_equals_target_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp(gate="cx", controls=[0], targets=[0])

    def test_cx_needs_exactly_one_control(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp(gate="cx", controls=[0, 1], targets=[2])


class TestUnsupportedGate(unittest.TestCase):
    def test_unknown_gate_name_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp.model_validate({"gate": "toffoli", "targets": [0]})


class TestInvalidParameter(unittest.TestCase):
    def test_rotation_gate_missing_param_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp(gate="rx", targets=[0], params=[])

    def test_rotation_gate_extra_param_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp(gate="rx", targets=[0], params=[1.0, 2.0])

    def test_rotation_gate_nan_param_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp(gate="rx", targets=[0], params=[float("nan")])

    def test_non_parametric_gate_with_param_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp(gate="h", targets=[0], params=[1.0])


class TestInvalidMeasure(unittest.TestCase):
    def test_measure_missing_clbit_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            GateOp(gate="measure", targets=[0], clbits=[])

    def test_measure_clbit_out_of_range_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            Circuit(num_qubits=1, num_clbits=1, ops=[GateOp(gate="measure", targets=[0], clbits=[5])])


class TestCanonicalSerialisation(unittest.TestCase):
    def test_canonical_json_is_deterministic(self) -> None:
        c = Circuit(
            num_qubits=2, num_clbits=2,
            ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])],
        )
        self.assertEqual(c.canonical_json(), c.canonical_json())

    def test_round_trip_through_canonical_json(self) -> None:
        c = Circuit(
            num_qubits=2, num_clbits=2,
            ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])],
        )
        restored = Circuit.from_canonical_json(c.canonical_json())
        self.assertEqual(restored.canonical_json(), c.canonical_json())


if __name__ == "__main__":
    unittest.main()
