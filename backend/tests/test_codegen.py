"""Generated Qiskit / Cirq / PennyLane views (``qentor.circuit.codegen``).

Three things are proven, none of them by reading the text:

1. The text is the golden text in every shared fixture (both suites share those files).
2. The text is a fixed template: an AST check over every fixture and hundreds of random circuits shows the
   program contains only imports, one assignment or function, and calls from a short allow-list, with only
   integer and float constants — no free text can reach it.
3. The text MEANS what the circuit means. In this test suite only (the product never runs it), each
   measurement-free program is executed and the state it produces is compared with the backend's, for every
   gate in every operand order. A wrongly ordered ``ccx`` would print plausibly and fail here.
"""

from __future__ import annotations

import ast
import itertools
import json
import random
import unittest
from pathlib import Path

from qentor.circuit.codegen import CODEGEN_VERSION, FRAMEWORKS, generate_all, generate_code
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = {
    p.name: json.loads(p.read_text(encoding="utf-8"))
    for p in sorted((ROOT / "fixtures" / "circuits").glob("*.json"))
    if not p.name.startswith("_")
}

ALLOWED_CALLS = {
    "QuantumCircuit", "qc.h", "qc.x", "qc.y", "qc.z", "qc.s", "qc.sdg", "qc.t", "qc.tdg", "qc.rx", "qc.ry", "qc.rz",
    "qc.cx", "qc.cz", "qc.swap", "qc.ccx", "qc.measure",
    "cirq.LineQubit.range", "cirq.Circuit", "cirq.H", "cirq.X", "cirq.Y", "cirq.Z", "cirq.S", "cirq.T", "cirq.CNOT",
    "cirq.CZ", "cirq.SWAP", "cirq.CCX", "cirq.measure", "cirq.rx", "cirq.ry", "cirq.rz",
    "qml.device", "qml.qnode", "qml.Hadamard", "qml.PauliX", "qml.PauliY", "qml.PauliZ", "qml.S", "qml.T", "qml.adjoint",
    "qml.RX", "qml.RY", "qml.RZ", "qml.CNOT", "qml.CZ", "qml.SWAP", "qml.Toffoli", "qml.probs", "qml.state",
}


def _dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_dotted(node.value)}.{node.attr}"
    if isinstance(node, ast.Call):  # (cirq.S**-1)(q) and qml.adjoint(qml.S)(wires=..)
        return _dotted(node.func)
    if isinstance(node, ast.BinOp):
        return _dotted(node.left)
    return f"<{type(node).__name__}>"


def assert_only_a_fixed_template(test: unittest.TestCase, code: str, label: str) -> None:
    tree = ast.parse(code)  # it must at least be valid Python
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _dotted(node.func)
            test.assertIn(name, ALLOWED_CALLS, f"{label}: unexpected call {name}")
        elif isinstance(node, ast.Constant):
            test.assertIsInstance(node.value, (int, float, str, type(None)), label)
            if isinstance(node.value, str):
                test.assertRegex(node.value, r"^(default\.qubit|c\d+|qiskit|cirq|pennylane)$", f"{label}: free text {node.value!r}")
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names]
            test.assertTrue(set(names) <= {"QuantumCircuit", "cirq", "pennylane"}, f"{label}: import {names}")
        elif isinstance(node, (ast.Lambda, ast.Await, ast.Global, ast.Delete, ast.With, ast.Try, ast.While, ast.For)):
            test.fail(f"{label}: {type(node).__name__} in generated code")


def random_circuit(rng: random.Random) -> Circuit:
    n = rng.randint(1, 4)
    ops: list[GateOp] = []
    for _ in range(rng.randint(0, 8)):
        gate = rng.choice([g for g in GateName if g is not GateName.MEASURE])
        qubits = list(range(n))
        rng.shuffle(qubits)
        try:
            if gate in (GateName.RX, GateName.RY, GateName.RZ):
                ops.append(GateOp(gate=gate, targets=[qubits[0]], params=[rng.choice([0.5, -1.25, 3.0, 1e-05, 2.5e-10])]))
            elif gate in (GateName.CX, GateName.CZ):
                ops.append(GateOp(gate=gate, targets=[qubits[1]], controls=[qubits[0]]))
            elif gate is GateName.SWAP:
                ops.append(GateOp(gate=gate, targets=[qubits[0], qubits[1]]))
            elif gate is GateName.CCX:
                ops.append(GateOp(gate=gate, targets=[qubits[2]], controls=[qubits[0], qubits[1]]))
            else:
                ops.append(GateOp(gate=gate, targets=[qubits[0]]))
        except (IndexError, ValueError):
            continue  # the circuit is too small for that gate
    clbits = rng.randint(0, n)
    for c in range(clbits):
        ops.append(GateOp(gate=GateName.MEASURE, targets=[c], clbits=[c]))
    return Circuit(num_qubits=n, num_clbits=clbits, ops=ops)


class TestGoldenText(unittest.TestCase):
    def test_every_fixture_has_the_golden_code_for_every_framework(self) -> None:
        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                self.assertEqual(list(data["code"]), list(FRAMEWORKS))
                circuit = Circuit.model_validate(data["circuit"])
                for framework in FRAMEWORKS:
                    self.assertEqual(generate_code(circuit, framework), data["code"][framework], framework)

    def test_generation_is_deterministic_and_versioned(self) -> None:
        circuit = Circuit.model_validate(FIXTURES["bell_measured.json"]["circuit"])
        self.assertEqual(generate_all(circuit), generate_all(circuit))
        self.assertEqual(CODEGEN_VERSION, "1")

    def test_an_unknown_framework_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            generate_code(Circuit(num_qubits=1, num_clbits=0, ops=[]), "tket")

    def test_the_empty_circuit_still_reads_as_a_program(self) -> None:
        empty = Circuit(num_qubits=2, num_clbits=0, ops=[])
        self.assertIn("QuantumCircuit(2)", generate_code(empty, "qiskit"))
        self.assertIn("circuit = cirq.Circuit()", generate_code(empty, "cirq"))
        self.assertIn("return qml.state()", generate_code(empty, "pennylane"))

    def test_the_angles_print_exactly_as_the_qasm_does(self) -> None:
        text = generate_code(Circuit.model_validate(FIXTURES["angle_formatting.json"]["circuit"]), "qiskit")
        for printed in ("1e-05", "1e-07", "1e+16", "1.5e+300", "-0.0", "3.0", "0.30000000000000004"):
            self.assertIn(f"qc.rz({printed}, 0)", text)

    def test_the_ordering_conventions_are_stated_where_they_matter(self) -> None:
        bell = Circuit.model_validate(FIXTURES["bell_measured.json"]["circuit"])
        self.assertIn("Cirq lists q[0] first", generate_code(bell, "cirq"))
        self.assertIn("c0", generate_code(bell, "cirq"))
        unmeasured = Circuit(num_qubits=2, num_clbits=0, ops=bell.ops[:2])
        self.assertIn("PennyLane lists wire 0 first", generate_code(unmeasured, "pennylane"))


class TestOnlyAFixedTemplate(unittest.TestCase):
    def test_every_fixture_program_is_a_fixed_template(self) -> None:
        for name, data in FIXTURES.items():
            for framework, code in data["code"].items():
                assert_only_a_fixed_template(self, code, f"{name}/{framework}")

    def test_random_circuits_produce_only_the_allowed_calls(self) -> None:
        rng = random.Random(20260930)
        for i in range(300):
            circuit = random_circuit(rng)
            for framework in FRAMEWORKS:
                assert_only_a_fixed_template(self, generate_code(circuit, framework), f"random {i}/{framework}")

    def test_no_field_of_the_model_can_smuggle_text_into_the_program(self) -> None:
        # The gate name is an enum, indices are ints, angles are floats: there is no string field to inject.
        with self.assertRaises(Exception):
            Circuit.model_validate({"num_qubits": 1, "num_clbits": 0, "ops": [{"gate": "h); import os #", "targets": [0]}]})
        with self.assertRaises(Exception):
            GateOp.model_validate({"gate": "rz", "targets": [0], "params": ["__import__('os')"]})


class _Backends(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        except Exception:
            pass


def _reverse_bits(index: int, n: int) -> int:
    return int(format(index, f"0{n}b")[::-1], 2)


def _without_measurements(circuit: Circuit) -> Circuit:
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=0, ops=[op for op in circuit.ops if op.gate is not GateName.MEASURE])


def _states_from_generated_code(circuit: Circuit) -> dict[str, list[complex]]:
    """Execute the three programs (TEST-ONLY) and return each one's state in Qiskit's ordering."""
    import cirq
    from qiskit.quantum_info import Statevector

    n = circuit.num_qubits
    out: dict[str, list[complex]] = {}

    ns: dict = {}
    exec(generate_code(circuit, "qiskit"), ns)  # noqa: S102 - generated by this repo from a validated model, tests only
    out["qiskit"] = list(Statevector(ns["qc"]).data)

    ns = {}
    exec(generate_code(circuit, "cirq"), ns)  # noqa: S102
    state = cirq.Simulator(dtype=__import__("numpy").complex128).simulate(ns["circuit"], qubit_order=ns["q"]).final_state_vector
    out["cirq"] = [complex(state[_reverse_bits(i, n)]) for i in range(2**n)]

    ns = {}
    exec(generate_code(circuit, "pennylane"), ns)  # noqa: S102
    state = ns["circuit"]()
    out["pennylane"] = [complex(state[_reverse_bits(i, n)]) for i in range(2**n)]
    return out


class TestTheGeneratedProgramsMeanWhatTheCircuitMeans(_Backends):
    def assertProgramsMatchTheBackend(self, circuit: Circuit, label: str) -> None:
        circuit = _without_measurements(circuit)
        reference = [complex(re, im) for re, im in AerAdapter().run(circuit, "statevector").statevector]
        for framework, state in _states_from_generated_code(circuit).items():
            overlap = abs(sum(r.conjugate() * s for r, s in zip(reference, state)))
            self.assertAlmostEqual(overlap, 1.0, places=9, msg=f"{label}: the {framework} program does not make the circuit's state")

    def test_every_fixture(self) -> None:
        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                self.assertProgramsMatchTheBackend(Circuit.model_validate(data["circuit"]), name)

    def test_every_gate_in_every_operand_order_on_an_asymmetric_state(self) -> None:
        def prefix(n: int) -> list[GateOp]:
            ops: list[GateOp] = []
            for q in range(n):
                ops += [
                    GateOp(gate="h", targets=[q]),
                    GateOp(gate="rz", targets=[q], params=[0.3 + 0.41 * q]),
                    GateOp(gate="ry", targets=[q], params=[0.7 + 0.29 * q]),
                ]
            return ops

        for name in ("h", "x", "y", "z", "s", "sdg", "t", "tdg"):
            for q in range(3):
                self.assertProgramsMatchTheBackend(Circuit(num_qubits=3, num_clbits=0, ops=[*prefix(3), GateOp(gate=name, targets=[q])]), f"{name} q{q}")
        for gate in ("rx", "ry", "rz"):
            self.assertProgramsMatchTheBackend(Circuit(num_qubits=3, num_clbits=0, ops=[*prefix(3), GateOp(gate=gate, targets=[2], params=[0.9])]), gate)
        for c, t in itertools.permutations(range(3), 2):
            for gate in ("cx", "cz"):
                self.assertProgramsMatchTheBackend(Circuit(num_qubits=3, num_clbits=0, ops=[*prefix(3), GateOp(gate=gate, targets=[t], controls=[c])]), f"{gate} {c}->{t}")
            self.assertProgramsMatchTheBackend(Circuit(num_qubits=3, num_clbits=0, ops=[*prefix(3), GateOp(gate="swap", targets=[c, t])]), f"swap {c},{t}")
        for c1, c2, t in itertools.permutations(range(3), 3):
            self.assertProgramsMatchTheBackend(Circuit(num_qubits=3, num_clbits=0, ops=[*prefix(3), GateOp(gate="ccx", targets=[t], controls=[c1, c2])]), f"ccx {c1},{c2}->{t}")

    def test_random_circuits(self) -> None:
        rng = random.Random(7)
        for i in range(40):
            self.assertProgramsMatchTheBackend(random_circuit(rng), f"random {i}")

    def test_measurements_become_real_measurements_in_each_program(self) -> None:
        circuit = Circuit.model_validate(FIXTURES["bell_measured.json"]["circuit"])
        ns: dict = {}
        exec(generate_code(circuit, "qiskit"), ns)  # noqa: S102
        self.assertEqual([i.operation.name for i in ns["qc"].data].count("measure"), 2)
        ns = {}
        exec(generate_code(circuit, "cirq"), ns)  # noqa: S102
        import cirq

        self.assertEqual(sum(1 for op in ns["circuit"].all_operations() if cirq.is_measurement(op)), 2)
        ns = {}
        exec(generate_code(circuit, "pennylane"), ns)  # noqa: S102
        probs = ns["circuit"]()
        self.assertAlmostEqual(float(sum(probs)), 1.0, places=9)
        self.assertEqual(len(probs), 4)


if __name__ == "__main__":
    unittest.main()
