"""Deterministic circuit hashing — pure Python, no qiskit needed."""

from __future__ import annotations

import hashlib
import unittest

from qentor.circuit.hashing import circuit_hash, short_circuit_id
from qentor.circuit.model import Circuit, GateOp
from qentor.circuit.qasm import to_qasm3


class TestCircuitHash(unittest.TestCase):
    def test_same_circuit_same_hash(self) -> None:
        c1 = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])
        c2 = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])
        self.assertEqual(circuit_hash(c1), circuit_hash(c2))

    def test_different_circuit_different_hash(self) -> None:
        c1 = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])
        c2 = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="x", targets=[0])])
        self.assertNotEqual(circuit_hash(c1), circuit_hash(c2))

    def test_hash_matches_manual_sha256_of_qasm(self) -> None:
        c = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])
        expected = hashlib.sha256(to_qasm3(c).encode("utf-8")).hexdigest()
        self.assertEqual(circuit_hash(c), expected)

    def test_hash_is_64_hex_chars(self) -> None:
        c = Circuit(num_qubits=1, num_clbits=0, ops=[])
        h = circuit_hash(c)
        self.assertEqual(len(h), 64)
        int(h, 16)  # raises ValueError if not valid hex

    def test_short_id_format(self) -> None:
        c = Circuit(num_qubits=1, num_clbits=0, ops=[])
        sid = short_circuit_id(c)
        self.assertTrue(sid.startswith("qc_"))
        self.assertEqual(len(sid), len("qc_") + 12)
        self.assertTrue(circuit_hash(c).startswith(sid[3:]))


if __name__ == "__main__":
    unittest.main()
