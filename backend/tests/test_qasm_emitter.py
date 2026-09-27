"""Golden fixtures for the OpenQASM 3 emitter, plus an independent re-parse of the
emitted text through Qiskit's own qasm3 importer (a second, independent parser).

The independent-parser test is a documented SKIP in this environment because
qiskit cannot be imported here (see docs/BUILD_STATE.md). It is written correctly
and will run for real wherever qiskit's native extension is not blocked.
"""

from __future__ import annotations

import unittest

from qentor.circuit.model import Circuit, GateOp
from qentor.circuit.qasm import to_qasm3

# --- golden fixtures --------------------------------------------------------

FIXTURE_ZERO = Circuit(num_qubits=1, num_clbits=0, ops=[])
GOLDEN_ZERO = (
    "OPENQASM 3.0;\n"
    'include "stdgates.inc";\n'
    "qubit[1] q;\n"
)

FIXTURE_X = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="x", targets=[0])])
GOLDEN_X = (
    "OPENQASM 3.0;\n"
    'include "stdgates.inc";\n'
    "qubit[1] q;\n"
    "x q[0];\n"
)

FIXTURE_H = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0])])
GOLDEN_H = (
    "OPENQASM 3.0;\n"
    'include "stdgates.inc";\n'
    "qubit[1] q;\n"
    "h q[0];\n"
)

FIXTURE_BELL = Circuit(
    num_qubits=2,
    num_clbits=2,
    ops=[
        GateOp(gate="h", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
    ],
)
GOLDEN_BELL = (
    "OPENQASM 3.0;\n"
    'include "stdgates.inc";\n'
    "qubit[2] q;\n"
    "bit[2] c;\n"
    "h q[0];\n"
    "cx q[0], q[1];\n"
    "c[0] = measure q[0];\n"
    "c[1] = measure q[1];\n"
)

FIXTURES = [
    ("zero", FIXTURE_ZERO, GOLDEN_ZERO),
    ("x", FIXTURE_X, GOLDEN_X),
    ("h", FIXTURE_H, GOLDEN_H),
    ("bell", FIXTURE_BELL, GOLDEN_BELL),
]


class TestGoldenFixtures(unittest.TestCase):
    def test_fixtures_match_golden_text(self) -> None:
        for name, circuit, golden in FIXTURES:
            with self.subTest(fixture=name):
                self.assertEqual(to_qasm3(circuit), golden)

    def test_emission_is_deterministic(self) -> None:
        for name, circuit, _ in FIXTURES:
            with self.subTest(fixture=name):
                self.assertEqual(to_qasm3(circuit), to_qasm3(circuit))


class TestIndependentQiskitParse(unittest.TestCase):
    """Re-parses our emitted QASM with Qiskit's own qasm3 importer and checks the
    resulting circuit has the expected qubit/clbit/instruction counts. This is the
    "independent validation step" required by docs/ARCHITECTURE.md §4 (B3)."""

    def setUp(self) -> None:
        try:
            import qiskit_qasm3_import  # noqa: F401
        except Exception as exc:  # noqa: BLE001
            self.skipTest(
                "qiskit_qasm3_import unavailable in this environment "
                f"({type(exc).__name__}: {exc}) — see docs/BUILD_STATE.md"
            )

    def test_bell_fixture_parses_and_matches_shape(self) -> None:
        from qiskit_qasm3_import import parse

        qasm_text = to_qasm3(FIXTURE_BELL)
        parsed = parse(qasm_text)
        self.assertEqual(parsed.num_qubits, 2)
        self.assertEqual(parsed.num_clbits, 2)
        names = [instr.operation.name for instr in parsed.data]
        self.assertEqual(names, ["h", "cx", "measure", "measure"])

    def test_all_fixtures_parse_without_error(self) -> None:
        from qiskit_qasm3_import import parse

        for name, circuit, _ in FIXTURES:
            with self.subTest(fixture=name):
                qasm_text = to_qasm3(circuit)
                parsed = parse(qasm_text)
                self.assertEqual(parsed.num_qubits, circuit.num_qubits)


if __name__ == "__main__":
    unittest.main()
