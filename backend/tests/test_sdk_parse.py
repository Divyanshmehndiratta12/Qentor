"""The safe SDK reader (``qentor.circuit.sdk_parse``) and ``POST /api/circuit/parse-code``.

Three promises, each tested hard:

1. It READS a small documented subset of Qiskit, Cirq and PennyLane into the canonical circuit, including everything the server's own code generator
   writes (round-trip over every shared fixture).
2. It REFUSES everything else, naming the first unsupported constructs with their lines, and never guesses or "translates" what it does not know.
3. It NEVER EXECUTES Python: no code path in the module evaluates, imports or looks anything up dynamically (read from its own syntax tree), side-effecting
   programs have no effect, and hostile or pathological input ends as a refusal, never a crash or a hang.
"""

from __future__ import annotations

import ast
import builtins
import json
import math
import random
import time
import unittest
from pathlib import Path

from qentor.api import classroom as classroom_api
from qentor.circuit.codegen import generate_all
from qentor.circuit.model import Circuit, GateName
from qentor.circuit import sdk_parse
from qentor.circuit.sdk_parse import (
    DIALECTS,
    LABEL,
    MAX_CODE_CHARS,
    MAX_LINES,
    SdkParseError,
    parse_sdk,
)
from tests.asgi_driver import http

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FIXTURES = {
    p.stem: json.loads(p.read_text(encoding="utf-8"))
    for p in sorted((ROOT / "fixtures" / "circuits").glob("*.json"))
    if not p.name.startswith("_")
}
PI = math.pi

QISKIT_HEAD = "from qiskit import QuantumCircuit\n"
CIRQ_HEAD = "import cirq\n"
PL_HEAD = 'import pennylane as qml\ndev = qml.device("default.qubit", wires=2)\n'


def qiskit(body: str, head: str = QISKIT_HEAD + "qc = QuantumCircuit(2, 2)\n") -> str:
    return head + body


def cirq(body: str, head: str = CIRQ_HEAD + "q = cirq.LineQubit.range(2)\ncircuit = cirq.Circuit()\n") -> str:
    return head + body


def pl(body: str, qnode: bool = True) -> str:
    return PL_HEAD + ("@qml.qnode(dev)\n" if qnode else "") + "def circuit():\n" + "".join(f"    {line}\n" for line in body.splitlines())


def shape(circuit: Circuit, *, clbits: bool = True) -> list[tuple]:
    return [(o.gate.value, tuple(o.controls), tuple(o.targets), tuple(o.params), tuple(o.clbits) if clbits else ()) for o in circuit.ops]


def refused(dialect: str, code: str) -> SdkParseError:
    with_error = None
    try:
        parse_sdk(code, dialect)
    except SdkParseError as exc:
        with_error = exc
    assert with_error is not None, f"expected a refusal for:\n{code}"
    return with_error


class _Case(unittest.TestCase):
    def assertRefused(self, dialect: str, code: str, fragment: str, line: int | None = None) -> SdkParseError:
        error = refused(dialect, code)
        text = " | ".join(p.message for p in error.problems)
        self.assertIn(fragment, text, f"{dialect}: {code!r}")
        if line is not None:
            self.assertIn(line, [p.line for p in error.problems], f"{dialect}: {code!r} lines {[p.line for p in error.problems]}")
        return error


# --------------------------------------------------------------------------- #
# What it reads                                                                #
# --------------------------------------------------------------------------- #


class TestReadsTheSubset(_Case):
    def test_the_brief_example_reads_as_the_circuit_it_says(self) -> None:
        code = "from qiskit import QuantumCircuit\n\nqc = QuantumCircuit(2)\nqc.h(0)\nqc.x(1)\nqc.cx(0, 1)\nqc.measure_all()\n"
        result = parse_sdk(code, "qiskit")
        c = result.circuit
        self.assertEqual((c.num_qubits, c.num_clbits), (2, 2))
        self.assertEqual(
            shape(c),
            [("h", (), (0,), (), ()), ("x", (), (1,), (), ()), ("cx", (0,), (1,), (), ()), ("measure", (), (0,), (), (0,)), ("measure", (), (1,), (), (1,))],
        )
        self.assertEqual(result.dialect, "qiskit")
        self.assertIn("measure_all", result.notes[0])

    def test_every_qiskit_gate(self) -> None:
        body = "\n".join(
            [
                "qc = QuantumCircuit(3, 3)",
                *(f"qc.{g}(0)" for g in ("h", "x", "y", "z", "s", "sdg", "t", "tdg")),
                "qc.rx(0.5, 1)", "qc.ry(pi / 2, 1)", "qc.rz(-pi, 2)",
                "qc.cx(0, 1)", "qc.cz(1, 2)", "qc.cp(pi / 4, 0, 2)", "qc.swap(0, 2)", "qc.ccx(0, 1, 2)", "qc.measure(2, 0)",
            ]
        )  # fmt: skip
        c = parse_sdk("from math import pi\nfrom qiskit import QuantumCircuit\n" + body + "\n", "qiskit").circuit
        self.assertEqual([o.gate.value for o in c.ops], ["h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz", "cx", "cz", "cp", "swap", "ccx", "measure"])
        by_gate = {o.gate: o for o in c.ops}
        self.assertEqual(by_gate[GateName.RY].params, [PI / 2])
        self.assertEqual(by_gate[GateName.RZ].params, [-PI])
        self.assertEqual((by_gate[GateName.CP].controls, by_gate[GateName.CP].targets, by_gate[GateName.CP].params), ([0], [2], [PI / 4]))
        self.assertEqual((by_gate[GateName.CCX].controls, by_gate[GateName.CCX].targets), ([0, 1], [2]))
        self.assertEqual(by_gate[GateName.SWAP].targets, [0, 2])
        self.assertEqual(by_gate[GateName.MEASURE].clbits, [0])

    def test_angles_are_numbers_and_expressions_of_pi_and_nothing_else(self) -> None:
        cases = {
            "qc.rx(1, 0)": 1.0,
            "qc.rx(0.25, 0)": 0.25,
            "qc.rx(pi, 0)": PI,
            "qc.rx(math.pi, 0)": PI,
            "qc.rx(np.pi / 4, 0)": PI / 4,
            "qc.rx(numpy.pi / 8, 0)": PI / 8,
            "qc.rx(-pi / 2, 0)": -PI / 2,
            "qc.rx(2 * pi / 3, 0)": (2 * PI) / 3,
            "qc.rx((pi + pi) / 4, 0)": (PI + PI) / 4,
            "qc.rx(pi - pi / 2, 0)": PI - PI / 2,
            "qc.rx(--pi, 0)": PI,
            "qc.rx(1e-3, 0)": 1e-3,
            "qc.rx(+1.5, 0)": 1.5,
        }
        head = "import math\nimport numpy\nimport numpy as np\nfrom math import pi\nfrom qiskit import QuantumCircuit\nqc = QuantumCircuit(1)\n"
        for line, want in cases.items():
            c = parse_sdk(head + line + "\n", "qiskit").circuit
            self.assertEqual(c.ops[0].params, [want], line)

    def test_numeric_assignments_can_name_an_angle(self) -> None:
        code = "from math import pi\nfrom qiskit import QuantumCircuit\ntheta = pi / 4\nphi = theta * 2\nqc = QuantumCircuit(1)\nqc.rx(theta, 0)\nqc.rz(phi, 0)\n"
        c = parse_sdk(code, "qiskit").circuit
        self.assertEqual([o.params[0] for o in c.ops], [PI / 4, PI / 2])

    def test_a_circuit_variable_may_have_any_name_and_a_docstring_is_harmless(self) -> None:
        code = '"""A Bell pair."""\nfrom qiskit import QuantumCircuit\nbell = QuantumCircuit(2)\nbell.h(0)\nbell.cx(0, 1)\n'
        self.assertEqual(len(parse_sdk(code, "qiskit").circuit.ops), 2)

    def test_qiskit_measure_all_adds_bits_after_the_declared_ones_as_qiskit_does(self) -> None:
        c = parse_sdk(qiskit("qc.h(0)\nqc.measure_all()\n"), "qiskit").circuit
        self.assertEqual(c.num_clbits, 4)
        self.assertEqual([tuple(o.clbits) for o in c.ops if o.gate is GateName.MEASURE], [(2,), (3,)])

    def test_a_barrier_has_no_effect_and_says_so(self) -> None:
        result = parse_sdk(qiskit("qc.h(0)\nqc.barrier()\nqc.barrier(0, 1)\nqc.x(1)\n"), "qiskit")
        self.assertEqual([o.gate.value for o in result.circuit.ops], ["h", "x"])
        self.assertTrue(any("barrier" in n for n in result.notes))

    def test_an_empty_circuit_is_a_circuit(self) -> None:
        c = parse_sdk(QISKIT_HEAD + "qc = QuantumCircuit(3)\n", "qiskit").circuit
        self.assertEqual((c.num_qubits, c.ops), (3, []))

    def test_every_cirq_form(self) -> None:
        code = "\n".join(
            [
                "import cirq",
                "import math",
                "q = cirq.LineQubit.range(3)",
                "a, b = cirq.LineQubit.range(2)",
                "z0 = cirq.LineQubit(2)",
                "circuit = cirq.Circuit(",
                "    cirq.H(q[0]),",
                "    [cirq.X(q[1]), cirq.Y(q[2])],",
                "    cirq.Z(a), cirq.S(b), cirq.T(z0),",
                "    (cirq.S**-1)(q[0]), (cirq.T**-1)(q[1]), (cirq.S**1)(q[2]),",
                "    cirq.rx(0.5)(q[0]), cirq.ry(rads=math.pi / 2)(q[1]), cirq.rz(1)(q[2]),",
                "    cirq.CNOT(q[0], q[1]), cirq.CX(q[1], q[2]), cirq.CZ(q[0], q[2]), cirq.SWAP(q[0], q[1]),",
                "    cirq.CCX(q[0], q[1], q[2]), cirq.CCNOT(q[0], q[1], q[2]), cirq.TOFFOLI(q[2], q[1], q[0]),",
                "    cirq.cphase(math.pi / 4)(q[0], q[1]), (cirq.CZ**0.5)(q[1], q[2]),",
                ")",
                "circuit.append(cirq.H(q[0]))",
                "circuit.append([cirq.X(q[1]), cirq.measure(q[0], key='c0')])",
                "circuit.append(cirq.measure(q[1], q[2], key='both'))",
            ]
        )
        c = parse_sdk(code, "cirq").circuit
        self.assertEqual(c.num_qubits, 3)
        gates = [o.gate.value for o in c.ops]
        self.assertEqual(
            gates,
            ["h", "x", "y", "z", "s", "t", "sdg", "tdg", "s", "rx", "ry", "rz", "cx", "cx", "cz", "swap", "ccx", "ccx", "ccx", "cp", "cp", "h", "x", "measure", "measure", "measure"],
        )
        cps = [o for o in c.ops if o.gate is GateName.CP]
        self.assertEqual([(o.controls, o.targets, o.params) for o in cps], [([0], [1], [PI / 4]), ([1], [2], [PI * 0.5])])
        self.assertEqual([o.params for o in c.ops if o.gate in (GateName.RX, GateName.RY, GateName.RZ)], [[0.5], [PI / 2], [1.0]])
        toffoli = [o for o in c.ops if o.gate is GateName.CCX][-1]
        self.assertEqual((toffoli.controls, toffoli.targets), ([2, 1], [0]))
        self.assertEqual([(o.targets[0], o.clbits[0]) for o in c.ops if o.gate is GateName.MEASURE], [(0, 0), (1, 1), (2, 2)])  # c0 explicit; the rest take the next free bits
        self.assertEqual(c.num_clbits, 3)

    def test_cirq_measurement_keys_become_classical_bits(self) -> None:
        code = cirq("circuit.append(cirq.measure(q[1], key='c1'))\ncircuit.append(cirq.measure(q[0], key='c0'))\n")
        c = parse_sdk(code, "cirq").circuit
        self.assertEqual([(o.targets[0], o.clbits[0]) for o in c.ops], [(1, 1), (0, 0)])
        self.assertEqual(c.num_clbits, 2)
        c = parse_sdk(cirq("circuit.append(cirq.measure(*q, key='m'))\n"), "cirq").circuit if False else None  # starred qubits are refused (tested below)

    def test_cirq_qubits_may_be_used_without_a_declared_range(self) -> None:
        c = parse_sdk("import cirq\na = cirq.LineQubit(0)\nb = cirq.LineQubit(3)\ncircuit = cirq.Circuit(cirq.CNOT(a, b))\n", "cirq").circuit
        self.assertEqual((c.num_qubits, shape(c)), (4, [("cx", (0,), (3,), (), ())]))

    def test_every_pennylane_form(self) -> None:
        body = "\n".join(
            [
                "qml.Hadamard(wires=0)", "qml.PauliX(1)", "qml.PauliY(wires=[0])", "qml.PauliZ(wires=1)", "qml.S(wires=0)", "qml.T(wires=1)",
                "qml.adjoint(qml.S)(wires=0)", "qml.adjoint(qml.T)(wires=1)",
                "qml.RX(0.5, wires=0)", "qml.RY(3.14159, 1)", "qml.RZ(0.25, wires=[1])",
                "qml.CNOT(wires=[0, 1])", "qml.CZ([1, 0])", "qml.SWAP(wires=[0, 1])",
                "qml.ControlledPhaseShift(0.75, wires=[0, 1])",
                "return qml.state()",
            ]
        )  # fmt: skip
        c = parse_sdk(pl(body), "pennylane").circuit
        self.assertEqual(
            [o.gate.value for o in c.ops], ["h", "x", "y", "z", "s", "t", "sdg", "tdg", "rx", "ry", "rz", "cx", "cz", "swap", "cp"]
        )
        self.assertEqual([(o.controls, o.targets) for o in c.ops if o.gate is GateName.CZ], [([1], [0])])
        self.assertEqual([o.params for o in c.ops if o.gate in (GateName.RX, GateName.RY, GateName.RZ)], [[0.5], [3.14159], [0.25]])

    def test_pennylane_toffoli_and_a_function_without_a_decorator(self) -> None:
        code = 'import pennylane as qml\ndev = qml.device("default.qubit", 3)\ndef circuit():\n    qml.Toffoli(wires=[0, 1, 2])\n    return qml.state()\n'
        c = parse_sdk(code, "pennylane").circuit
        self.assertEqual((c.num_qubits, shape(c)), (3, [("ccx", (0, 1), (2,), (), ())]))

    def test_pennylane_returns_that_measure_are_read_as_measuring(self) -> None:
        for ret, wires in (("qml.probs(wires=[1, 0])", [1, 0]), ("qml.probs()", [0, 1]), ("qml.sample(wires=1)", [1]), ("qml.counts(wires=[0])", [0])):
            result = parse_sdk(pl(f"qml.Hadamard(wires=0)\nreturn {ret}"), "pennylane")
            measures = [o for o in result.circuit.ops if o.gate is GateName.MEASURE]
            self.assertEqual([o.targets[0] for o in measures], wires, ret)
            self.assertEqual([o.clbits[0] for o in measures], list(range(len(wires))), ret)
            self.assertEqual(result.circuit.num_clbits, len(wires))
            self.assertTrue(any("measuring those wires" in n for n in result.notes), ret)

    def test_pennylane_state_adds_no_measurement_and_a_call_to_the_function_is_noted_not_run(self) -> None:
        result = parse_sdk(pl("qml.Hadamard(wires=0)\nreturn qml.state()") + "result = circuit()\ncircuit()\n", "pennylane")
        self.assertEqual([o.gate.value for o in result.circuit.ops], ["h"])
        self.assertEqual(sum("was not run" in n for n in result.notes), 2)


class TestRoundTripOfTheServersOwnCode(_Case):
    """Everything ``generate_all`` writes for every shared fixture is read back to the same circuit."""

    def test_qiskit_reads_back_exactly(self) -> None:
        for name, fx in FIXTURES.items():
            original = Circuit.model_validate(fx["circuit"])
            back = parse_sdk(generate_all(original)["qiskit"], "qiskit").circuit
            self.assertEqual((back.num_qubits, back.num_clbits, shape(back)), (original.num_qubits, original.num_clbits, shape(original)), name)

    def test_cirq_reads_back_to_the_same_operations(self) -> None:
        for name, fx in FIXTURES.items():
            original = Circuit.model_validate(fx["circuit"])
            back = parse_sdk(generate_all(original)["cirq"], "cirq").circuit
            self.assertEqual((back.num_qubits, shape(back)), (original.num_qubits, shape(original)), name)

    def test_pennylane_reads_back_to_the_same_gates_and_measured_wires(self) -> None:
        for name, fx in FIXTURES.items():
            original = Circuit.model_validate(fx["circuit"])
            back = parse_sdk(generate_all(original)["pennylane"], "pennylane").circuit
            self.assertEqual(back.num_qubits, original.num_qubits, name)
            self.assertEqual(shape(back, clbits=False), shape(original, clbits=False), name)  # PennyLane's text does not carry which bit a wire went to

    def test_the_same_circuit_through_the_three_dialects_is_the_same_circuit(self) -> None:
        for name, fx in FIXTURES.items():
            original = Circuit.model_validate(fx["circuit"])
            code = generate_all(original)
            shapes = {d: shape(parse_sdk(code[d], d).circuit, clbits=False) for d in DIALECTS}
            self.assertEqual(shapes["qiskit"], shapes["cirq"], name)
            self.assertEqual(shapes["qiskit"], shapes["pennylane"], name)

    def test_random_circuits_survive_the_trip_too(self) -> None:
        rng = random.Random(2026)
        singles = ["h", "x", "y", "z", "s", "sdg", "t", "tdg"]
        for _ in range(150):
            n = rng.randint(1, 4)
            ops = []
            for _ in range(rng.randint(0, 12)):
                kind = rng.choice(["one", "rot", "cx", "cz", "cp", "swap", "ccx"])
                qs = rng.sample(range(n), min(n, 3))
                if kind == "one":
                    ops.append({"gate": rng.choice(singles), "targets": [qs[0]], "controls": [], "params": [], "clbits": []})
                elif kind == "rot":
                    ops.append({"gate": rng.choice(["rx", "ry", "rz"]), "targets": [qs[0]], "controls": [], "params": [rng.uniform(-7, 7)], "clbits": []})
                elif kind in ("cx", "cz", "cp") and n >= 2:
                    ops.append({"gate": kind, "targets": [qs[1]], "controls": [qs[0]], "params": [rng.uniform(-3, 3)] if kind == "cp" else [], "clbits": []})
                elif kind == "swap" and n >= 2:
                    ops.append({"gate": "swap", "targets": [qs[0], qs[1]], "controls": [], "params": [], "clbits": []})
                elif kind == "ccx" and n >= 3:
                    ops.append({"gate": "ccx", "targets": [qs[2]], "controls": [qs[0], qs[1]], "params": [], "clbits": []})
            original = Circuit.model_validate({"schema": "qentor.circuit/1", "num_qubits": n, "num_clbits": 0, "ops": ops})
            code = generate_all(original)
            for dialect in DIALECTS:
                back = parse_sdk(code[dialect], dialect).circuit
                self.assertEqual((back.num_qubits, shape(back)), (original.num_qubits, shape(original)), dialect)


# --------------------------------------------------------------------------- #
# What it refuses                                                              #
# --------------------------------------------------------------------------- #


class TestRefusesQiskit(_Case):
    def test_imports(self) -> None:
        for code, fragment in {
            "import os\n": "only 'from qiskit import QuantumCircuit'",
            "import qiskit\n": "only 'from qiskit import QuantumCircuit'",
            "from qiskit import *\n": "only 'from qiskit import QuantumCircuit'",
            "from qiskit import QuantumCircuit as QC\n": "only 'from qiskit import QuantumCircuit'",
            "from qiskit import QuantumCircuit, QuantumRegister\n": "only 'from qiskit import QuantumCircuit'",
            "from qiskit.circuit import QuantumCircuit\n": "only 'from qiskit import QuantumCircuit'",
            "from os import system\n": "only 'from qiskit import QuantumCircuit'",
            "import numpy as foo\n": "only 'from qiskit import QuantumCircuit'",
            "from numpy import sqrt\n": "only 'from qiskit import QuantumCircuit'",
            "from . import x\n": "only 'from qiskit import QuantumCircuit'",
            "import math as m\n": "only 'from qiskit import QuantumCircuit'",
        }.items():
            self.assertRefused("qiskit", code, fragment, 1)

    def test_the_circuit_declaration(self) -> None:
        for code, fragment in {
            QISKIT_HEAD + "qc = QuantumCircuit()\n": "QuantumCircuit takes the number of qubits",
            QISKIT_HEAD + "qc = QuantumCircuit(0)\n": "needs 1 to 16 qubits",
            QISKIT_HEAD + "qc = QuantumCircuit(17)\n": "needs 1 to 16 qubits",
            QISKIT_HEAD + "qc = QuantumCircuit(-1)\n": "negative",
            QISKIT_HEAD + "qc = QuantumCircuit(2.5)\n": "integer literal",
            QISKIT_HEAD + "qc = QuantumCircuit(n)\n": "integer literal",
            QISKIT_HEAD + "qc = QuantumCircuit(2, 2, 2)\n": "QuantumCircuit takes",
            QISKIT_HEAD + "qc = QuantumCircuit(2, name='x')\n": "keyword argument 'name'",
            QISKIT_HEAD + "qc = QuantumCircuit(*[2])\n": "starred",
            QISKIT_HEAD + "qc = QuantumCircuit(2)\nqc = QuantumCircuit(3)\n": "only one QuantumCircuit",
            QISKIT_HEAD + "a = b = QuantumCircuit(2)\n": "chained assignment",
            QISKIT_HEAD + "qc, other = QuantumCircuit(2)\n": "plain name",
            QISKIT_HEAD + "qc = QuantumCircuit(2)\nqc = 5\n": "cannot be reassigned",
            QISKIT_HEAD + "qc = QuantumCircuit(2, 99)\n": "too many classical bits",
            QISKIT_HEAD + "qc = QuantumCircuit(10**9)\n": "integer literal",
            QISKIT_HEAD + "qc = QuantumCircuit(1000000000)\n": "far outside",
            QISKIT_HEAD + "x = 1\n": "no circuit was found",
            "qc.h(0)\n": "the circuit must be created first",
        }.items():
            self.assertRefused("qiskit", code, fragment)

    def test_python_constructs(self) -> None:
        head = QISKIT_HEAD + "qc = QuantumCircuit(2)\n"
        for body, fragment in {
            "for i in range(2):\n    qc.h(i)\n": "a for loop is not supported",
            "while True:\n    qc.h(0)\n": "a while loop is not supported",
            "if True:\n    qc.h(0)\n": "an if statement is not supported",
            "def f():\n    qc.h(0)\n": "a function definition is not supported",
            "class A:\n    pass\n": "a class definition is not supported",
            "with open('f') as f:\n    pass\n": "a with block is not supported",
            "try:\n    qc.h(0)\nexcept Exception:\n    pass\n": "a try block is not supported",
            "async def f():\n    pass\n": "an async function definition is not supported",
            "global qc\n": "a global statement is not supported",
            "del qc\n": "a del statement is not supported",
            "assert True\n": "an assert statement is not supported",
            "raise SystemExit\n": "a raise statement is not supported",
            "pass\n": "a pass statement is not supported",
            "qc += 1\n": "an augmented assignment",
            "x: int = 1\n": "an annotated assignment",
            "x = lambda: 1\n": "a lambda",
            "x = [q for q in range(2)]\n": "a list comprehension",
            "x = (y := 3)\n": "an assignment expression",
            "x = f'{qc}'\n": "an f-string",
            "x = [1]\n": "a list",
            "x = {}\n": "a dictionary",
            "x = qc\n": "unknown name 'qc'",
            "x = 'text'\n": "a string is not a number",
            "x = None\n": "only numbers are allowed",
            "x = True\n": "only numbers are allowed",
            "x = 1j\n": "only numbers are allowed",
            "x = 2 ** 3\n": "only + - * / are allowed",
            "x = 7 // 2\n": "only + - * / are allowed",
            "x = 7 % 2\n": "only + - * / are allowed",
            "x = 1 / 0\n": "division by zero",
            "x = abs(1)\n": "must be a number or an expression",
            "x = os.system('x')\n": "must be a number or an expression",
            "x = y\n": "unknown name 'y'",
            "x = 1e999\n": "not finite",
            "match 1:\n    case 1:\n        pass\n": "a match statement is not supported",
            "yield 1\n": "this expression is not supported",
            "await foo()\n": "this expression is not supported",
            "print(qc)\n": "only calls on the circuit",
            "eval('1')\n": "only calls on the circuit",
            "exec('qc.h(0)')\n": "only calls on the circuit",
            "open('file')\n": "only calls on the circuit",
            "__import__('os').system('echo hi')\n": "only calls on the circuit",
            "().__class__.__bases__\n": "this expression is not supported",
            "qc.h.__self__\n": "this expression is not supported",
            "getattr(qc, 'h')(0)\n": "only calls on the circuit",
            "qc.draw()\n": "qc.draw is not a supported gate or method",
            "qc.h(0).x(1)\n": "only calls on the circuit",
            "[qc.h(i) for i in range(2)]\n": "this expression is not supported",
            "qc.h(0) if True else qc.x(0)\n": "this expression is not supported",
            "(qc.h(0), qc.x(0))\n": "this expression is not supported",
            "other.h(0)\n": "unknown object 'other'",
            "qc['h'](0)\n": "only calls on the circuit",
        }.items():
            self.assertRefused("qiskit", head + body, fragment, 3)

    def test_a_decorated_function_is_refused_at_its_def(self) -> None:
        self.assertRefused("qiskit", QISKIT_HEAD + "qc = QuantumCircuit(2)\n@decorator\ndef f():\n    pass\n", "a function definition is not supported", 4)

    def test_pi_must_be_imported_the_way_python_requires(self) -> None:
        head = QISKIT_HEAD + "qc = QuantumCircuit(1)\n"
        self.assertRefused("qiskit", head + "qc.rx(pi, 0)\n", "unknown name 'pi'")
        self.assertRefused("qiskit", head + "qc.rx(math.pi, 0)\n", "unknown name 'math'")
        self.assertRefused("qiskit", head + "qc.rx(np.pi, 0)\n", "unknown name 'np'")
        self.assertRefused("qiskit", "import numpy\n" + head + "qc.rx(np.pi, 0)\n", "unknown name 'np'")
        self.assertRefused("qiskit", "import math\n" + head + "qc.rx(numpy.pi, 0)\n", "unknown name 'numpy'")
        self.assertRefused("qiskit", "from math import pi as p\n" + head, "only 'from qiskit import QuantumCircuit'")
        self.assertRefused("qiskit", "from math import e\n" + head, "only 'from qiskit import QuantumCircuit'")
        self.assertRefused("qiskit", head + "qc.rx(math.tau, 0)\n", "must be a number or an expression")

    def test_gate_calls(self) -> None:
        head = QISKIT_HEAD + "qc = QuantumCircuit(2, 1)\n"
        for body, fragment in {
            "qc.h()\n": "takes 1 argument, got 0",
            "qc.h(0, 1)\n": "takes 1 argument, got 2",
            "qc.cx(0)\n": "takes 2 arguments, got 1",
            "qc.cx(0, 0)\n": "must be different",
            "qc.cx(0, 1, 0)\n": "takes 2 arguments",
            "qc.ccx(0, 1)\n": "takes 3 arguments",
            "qc.ccx(0, 1, 1)\n": "differ",
            "qc.swap(1, 1)\n": "differ",
            "qc.rx(0)\n": "takes 2 arguments, got 1",
            "qc.rx(0, 0, 0)\n": "takes 2 arguments, got 3",
            "qc.cp(0, 1)\n": "takes 3 arguments",
            "qc.h(5)\n": "qubit 5 is outside the circuit, which has 2 qubits",
            "qc.cx(0, 2)\n": "outside the circuit",
            "qc.h(-1)\n": "negative",
            "qc.h(1.5)\n": "integer literal",
            "qc.h(True)\n": "integer literal",
            "qc.h('0')\n": "integer literal",
            "qc.h(None)\n": "integer literal",
            "qc.h(0 + 1)\n": "integer literal",
            "qc.h(q)\n": "integer literal",
            "qc.h(*[0])\n": "starred",
            "qc.h([0, 1])\n": "integer literal",
            "qc.h(range(2))\n": "integer literal",
            "qc.h(qubit=0)\n": "keyword argument 'qubit'",
            "qc.h(**{'qubit': 0})\n": "kwargs",
            "qc.h(10**9)\n": "integer literal",
            "qc.h(1000000000)\n": "far outside",
            "qc.u(0, 0, 0, 0)\n": "not a supported gate",
            "qc.unitary([[1,0],[0,1]], 0)\n": "not a supported gate",
            "qc.reset(0)\n": "not a supported gate",
            "qc.id(0)\n": "not a supported gate",
            "qc.p(0.1, 0)\n": "not a supported gate",
            "qc.cnot(0, 1)\n": "not a supported gate",
            "qc.measure(0)\n": "takes 2 arguments",
            "qc.measure(0, 1)\n": "classical bit 1 does not exist",
            "qc.measure([0], [0])\n": "integer literal",
            "qc.measure_all(0)\n": "takes 0 arguments",
            "qc.measure_all(add_bits=False)\n": "keyword argument 'add_bits'",
            "qc.rx(pi, 0)\n": "unknown name 'pi'",
            "qc.rx(1 / 0, 0)\n": "division by zero",
            "qc.rx(1j, 0)\n": "only numbers are allowed",
            "qc.rx('a', 0)\n": "a string is not a number",
            "qc.rx(abs(1), 0)\n": "must be a number or an expression",
            "qc.rx(2 ** 3, 0)\n": "only + - * /",
            "qc.rx(sqrt(2), 0)\n": "must be a number or an expression",
            "qc.rx(x, 0)\n": "unknown name 'x'",
            "qc.rx([1], 0)\n": "must be a number or an expression",
            "qc.rx(1e999, 0)\n": "not finite",
            "qc.rx(99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999, 0)\n": "too large",
        }.items():
            error = self.assertRefused("qiskit", head + body, fragment)
            self.assertTrue(all(p.line == 3 or p.line is None for p in error.problems), body)

    def test_several_problems_are_listed_with_their_lines_up_to_five(self) -> None:
        code = QISKIT_HEAD + "qc = QuantumCircuit(2)\nfor i in range(2):\n    pass\nqc.h(5)\nqc.draw()\nprint(1)\nqc.foo(0)\nqc.bar(0)\n"
        error = refused("qiskit", code)
        self.assertEqual(len(error.problems), 5)
        self.assertEqual([p.line for p in error.problems], [3, 5, 6, 7, 8])

    def test_a_good_circuit_with_one_bad_line_is_refused_whole(self) -> None:
        with self.assertRaises(SdkParseError):
            parse_sdk(QISKIT_HEAD + "qc = QuantumCircuit(2)\nqc.h(0)\nqc.cx(0, 1)\nqc.what(1)\n", "qiskit")


class TestRefusesCirq(_Case):
    def test_imports_and_setup(self) -> None:
        for code, fragment in {
            "import os\n": "only 'import cirq'",
            "import cirq as c\n": "only 'import cirq'",
            "from cirq import H\n": "only 'import cirq'",
            "from cirq import *\n": "only 'import cirq'",
            "import cirq, os\n": "only 'import cirq'",
            CIRQ_HEAD + "q = cirq.NamedQubit('a')\n": "must be",
            CIRQ_HEAD + "q = cirq.LineQubit.range(0)\n": "needs 1 to 16 qubits",
            CIRQ_HEAD + "q = cirq.LineQubit.range(17)\n": "needs 1 to 16 qubits",
            CIRQ_HEAD + "q = cirq.LineQubit.range(n)\n": "integer literal",
            CIRQ_HEAD + "a, b = cirq.LineQubit.range(3)\n": "gives 3 qubits but 2 names",
            CIRQ_HEAD + "a, b = cirq.LineQubit.range(2, 3)\n": "takes 1 argument",
            CIRQ_HEAD + "q = cirq.LineQubit.range(2)\nc1 = cirq.Circuit()\nc2 = cirq.Circuit()\n": "only one cirq.Circuit",
            CIRQ_HEAD + "c = cirq.Circuit(strategy=1)\n": "keyword argument",
            CIRQ_HEAD + "c = cirq.Circuit(*[])\n": "starred",
            CIRQ_HEAD: "the code is empty" if False else "no circuit was found",
        }.items():
            self.assertRefused("cirq", code, fragment)

    def test_operations(self) -> None:
        for body, fragment in {
            "circuit.append(cirq.H(q[5]))\n": "outside the 2 qubits it holds",
            "circuit.append(cirq.H(q[-1]))\n": "negative",
            "circuit.append(cirq.H(q[0.5]))\n": "integer literal",
            "circuit.append(cirq.H(q[i]))\n": "integer literal",
            "circuit.append(cirq.H(r[0]))\n": "unknown qubit 'r'",
            "circuit.append(cirq.H(z))\n": "unknown qubit 'z'",
            "circuit.append(cirq.H(0))\n": "a qubit must be",
            "circuit.append(cirq.H(cirq.NamedQubit('a')))\n": "cirq.NamedQubit is not supported",
            "circuit.append(cirq.H(cirq.GridQubit(0, 0)))\n": "cirq.GridQubit is not supported",
            "circuit.append(cirq.Foo(q[0]))\n": "cirq.Foo is not a supported gate",
            "circuit.append(cirq.H(q[0], q[1]))\n": "takes 1 argument, got 2",
            "circuit.append(cirq.CNOT(q[0]))\n": "takes 2 arguments, got 1",
            "circuit.append(cirq.CNOT(q[0], q[0]))\n": "differ",
            "circuit.append(cirq.CCX(q[0], q[1]))\n": "takes 3 arguments",
            "circuit.append(cirq.rx()(q[0]))\n": "takes one angle",
            "circuit.append(cirq.rx(0.5, 0.2)(q[0]))\n": "takes one angle",
            "circuit.append(cirq.rx(foo=0.5)(q[0]))\n": "keyword argument 'foo'",
            "circuit.append(cirq.rx(x)(q[0]))\n": "unknown name 'x'",
            "circuit.append(cirq.rx(0.5)(q[0], q[1]))\n": "takes 1 argument",
            "circuit.append(cirq.cphase(0.5)(q[0]))\n": "takes 2 arguments",
            "circuit.append((cirq.S**2)(q[0]))\n": "only cirq.S**-1",
            "circuit.append((cirq.T**0.5)(q[0]))\n": "only cirq.T**-1",
            "circuit.append((cirq.CZ**x)(q[0], q[1]))\n": "unknown name 'x'",
            "circuit.append((cirq.H**-1)(q[0]))\n": "not a supported cirq gate",
            "circuit.append(cirq.H(q[0]).on(q[1]))\n": "not a supported cirq gate",
            "circuit.append(cirq.X.on(q[0]))\n": "not a supported cirq gate",
            "circuit.append(cirq.H)\n": "a circuit operation must be a gate applied to qubits",
            "circuit.append(5)\n": "a circuit operation must be a gate applied to qubits",
            "circuit.append(cirq.H(q[0]), cirq.X(q[1]))\n": "takes 1 argument, got 2",
            "circuit.append(cirq.H(q[0]) for _ in range(2))\n": "a generator expression",
            "circuit.append([[cirq.H(q[0])]])\n": "nested lists",
            "circuit.append([x for x in []])\n": "a list comprehension",
            "circuit.append(cirq.H(q[0]), strategy=1)\n": "keyword argument",
            "circuit.insert(0, cirq.H(q[0]))\n": "only circuit.append",
            "circuit.run()\n": "only circuit.append",
            "cirq.Simulator().run(circuit)\n": "only circuit.append",
            "print(circuit)\n": "only circuit.append",
            "circuit.append(cirq.measure(q[0], key=5))\n": "must be a string literal",
            "circuit.append(cirq.measure(q[0], key=k))\n": "must be a string literal",
            "circuit.append(cirq.measure())\n": "at least one qubit",
            "circuit.append(cirq.measure(*q, key='m'))\n": "starred",
            "circuit.append(cirq.measure(q[0], foo='m'))\n": "keyword argument 'foo'",
            "circuit.append(cirq.measure(q[0], key='c0'))\ncircuit.append(cirq.measure(q[1], key='c0'))\n": "measured into twice",
            "circuit.append(cirq.measure(q[0], key='c40'))\n": "beyond",
            "for i in range(2):\n    pass\n": "a for loop is not supported",
            "if True:\n    pass\n": "an if statement is not supported",
            "def f():\n    pass\n": "a function definition is not supported",
            "lambda: 1\n": "this expression is not supported",
            "eval('1')\n": "only circuit.append",
            "__import__('os')\n": "only circuit.append",
            "x = cirq.H(q[0])\n": "must be a number or an expression",
            "circuit = 5\n": "cannot be reassigned",
        }.items():
            self.assertRefused("cirq", cirq(body), fragment)

    def test_a_qubit_unpacking_that_does_not_match(self) -> None:
        self.assertRefused("cirq", CIRQ_HEAD + "a, b = cirq.LineQubit(0), cirq.LineQubit(1), cirq.LineQubit(2)\n", "2 names are assigned 3 qubits")
        self.assertRefused("cirq", CIRQ_HEAD + "a = cirq.LineQubit(99)\n", "beyond the 16 qubits")
        self.assertRefused("cirq", CIRQ_HEAD + "a = cirq.LineQubit(-1)\n", "negative")


class TestRefusesPennyLane(_Case):
    def test_setup(self) -> None:
        for code, fragment in {
            "import pennylane\n": "only 'import pennylane as qml'",
            "import pennylane as pl\n": "only 'import pennylane as qml'",
            "from pennylane import numpy as np\n": "only 'import pennylane as qml'",
            "import os\n": "only 'import pennylane as qml'",
            'import pennylane as qml\ndev = qml.device("lightning.qubit", wires=2)\n': 'only the device "default.qubit"',
            'import pennylane as qml\ndev = qml.device("default.qubit", wires=[0, 1])\n': "integer literal",
            'import pennylane as qml\ndev = qml.device("default.qubit")\n': "takes the device name and the number of wires",
            'import pennylane as qml\ndev = qml.device("default.qubit", wires=0)\n': "needs 1 to 16 wires",
            'import pennylane as qml\ndev = qml.device("default.qubit", wires=2, shots=10)\n': "keyword argument 'shots'",
            'import pennylane as qml\na = qml.device("default.qubit", wires=2)\nb = qml.device("default.qubit", wires=2)\n': "only one device",
            "import pennylane as qml\ndef circuit():\n    return qml.state()\n": "define the device first",
            PL_HEAD: "no circuit was found",
        }.items():
            self.assertRefused("pennylane", code, fragment)

    def test_the_circuit_function(self) -> None:
        for code, fragment in {
            PL_HEAD + "def circuit(x):\n    return qml.state()\n": "must take no arguments",
            PL_HEAD + "def circuit(x=1):\n    return qml.state()\n": "must take no arguments",
            PL_HEAD + "def circuit(*a):\n    return qml.state()\n": "must take no arguments",
            PL_HEAD + "def circuit() -> int:\n    return qml.state()\n": "return annotation",
            PL_HEAD + "@qml.qnode(dev, interface='torch')\ndef circuit():\n    return qml.state()\n": "only supported decorator",
            PL_HEAD + "@qml.qnode(other)\ndef circuit():\n    return qml.state()\n": "only supported decorator",
            PL_HEAD + "@cache\ndef circuit():\n    return qml.state()\n": "only supported decorator",
            PL_HEAD + "@qml.qnode\ndef circuit():\n    return qml.state()\n": "only supported decorator",
            PL_HEAD + "def a():\n    return qml.state()\ndef b():\n    return qml.state()\n": "only one circuit function",
            PL_HEAD + "async def circuit():\n    return qml.state()\n": "an async function definition is not supported",
            PL_HEAD + "def circuit():\n    qml.Hadamard(wires=0)\n": "must end by returning",
            PL_HEAD + "def circuit():\n    return\n": "must return qml.state()",
            PL_HEAD + "def circuit():\n    return qml.expval(qml.PauliZ(0))\n": "must return qml.state()",
            PL_HEAD + "def circuit():\n    return 5\n": "must return qml.state()",
            PL_HEAD + "def circuit():\n    return qml.state(), qml.state()\n": "must return qml.state()",
            PL_HEAD + "def circuit():\n    return qml.probs(wires=[0, 0])\n": "listed twice",
            PL_HEAD + "def circuit():\n    return qml.probs(wires=7)\n": "outside the circuit",
            PL_HEAD + "def circuit():\n    return qml.probs(wires=[])\n": "at least one wire",
            PL_HEAD + "def circuit():\n    return qml.probs(0, wires=1)\n": "give the wires once",
            PL_HEAD + "def circuit():\n    return qml.state(1)\n": "takes no arguments",
            PL_HEAD + "def circuit():\n    return qml.state()\n    qml.Hadamard(wires=0)\n": "nothing may follow the return",
            PL_HEAD + "def circuit():\n    for i in range(2):\n        qml.Hadamard(wires=i)\n    return qml.state()\n": "a for loop is not supported",
            PL_HEAD + "def circuit():\n    if True:\n        qml.Hadamard(wires=0)\n    return qml.state()\n": "an if statement is not supported",
            PL_HEAD + "def circuit():\n    def inner():\n        pass\n    return qml.state()\n": "a function definition is not supported",
            PL_HEAD + "def circuit():\n    x = [qml.Hadamard(wires=0)]\n    return qml.state()\n": "must be a number or an expression",
            PL_HEAD + "def circuit():\n    print(1)\n    return qml.state()\n": "not a supported qml gate",
            PL_HEAD + "def circuit():\n    eval('1')\n    return qml.state()\n": "not a supported qml gate",
            PL_HEAD + "def circuit():\n    import os\n    return qml.state()\n": "this import is not supported",
        }.items():
            self.assertRefused("pennylane", code, fragment)

    def test_gates(self) -> None:
        for body, fragment in {
            "qml.Foo(wires=0)\nreturn qml.state()": "qml.Foo is not a supported gate",
            "qml.Hadamard()\nreturn qml.state()": "needs its wires",
            "qml.Hadamard(wires=[0, 1])\nreturn qml.state()": "acts on 1 wire, got 2",
            "qml.CNOT(wires=0)\nreturn qml.state()": "acts on 2 wires, got 1",
            "qml.CNOT(wires=[0, 0])\nreturn qml.state()": "differ",
            "qml.CNOT(wires=[0, 5])\nreturn qml.state()": "outside the circuit",
            "qml.Hadamard(wires=-1)\nreturn qml.state()": "negative",
            "qml.Hadamard(wires=1.5)\nreturn qml.state()": "integer literal",
            "qml.Hadamard(wires='a')\nreturn qml.state()": "integer literal",
            "qml.Hadamard(wires=w)\nreturn qml.state()": "integer literal",
            "qml.Hadamard(wires=0, id='x')\nreturn qml.state()": "keyword argument 'id'",
            "qml.Hadamard(0, wires=1)\nreturn qml.state()": "wires given twice",
            "qml.RX(wires=0)\nreturn qml.state()": "needs its angle first",
            "qml.RX(0.1)\nreturn qml.state()": "needs its wires",
            "qml.RX(0.1, 0, 1)\nreturn qml.state()": "too many positional",
            "qml.RX(x, wires=0)\nreturn qml.state()": "unknown name 'x'",
            "qml.RX(wires=0, phi=0.1)\nreturn qml.state()": "keyword argument 'phi'",
            "qml.ControlledPhaseShift(wires=[0, 1])\nreturn qml.state()": "needs its angle first",
            "qml.adjoint(qml.H)(wires=0)\nreturn qml.state()": "only qml.adjoint(qml.S)",
            "qml.adjoint(qml.S, lazy=False)(wires=0)\nreturn qml.state()": "only qml.adjoint(qml.S)",
            "qml.adjoint(qml.S)\nreturn qml.state()": "qml.adjoint is not a supported gate",
            "qml.adjoint(qml.S)(wires=0)(wires=1)\nreturn qml.state()": "not a supported qml gate",
            "qml.QubitUnitary([[1, 0], [0, 1]], wires=0)\nreturn qml.state()": "not a supported gate",
            "qml.Hadamard(wires=0).queue()\nreturn qml.state()": "not a supported qml gate",
            "qml.Hadamard(**{'wires': 0})\nreturn qml.state()": "kwargs",
            "qml.Hadamard(*[0])\nreturn qml.state()": "starred",
        }.items():
            self.assertRefused("pennylane", pl(body), fragment)


class TestRefusesWholeInputs(_Case):
    def test_unknown_dialect_and_non_text(self) -> None:
        self.assertRefused("fortran", "x", "unknown dialect")
        with self.assertRaises(SdkParseError):
            parse_sdk(None, "qiskit")  # type: ignore[arg-type]
        with self.assertRaises(SdkParseError):
            parse_sdk(b"qc", "qiskit")  # type: ignore[arg-type]

    def test_syntax_errors_name_their_line(self) -> None:
        for dialect in DIALECTS:
            error = refused(dialect, "x = (\n")
            self.assertIn("not valid Python", error.problems[0].message)
        error = refused("qiskit", QISKIT_HEAD + "qc = QuantumCircuit(2)\nqc.h(0\n")
        self.assertIn("not valid Python", error.problems[0].message)
        self.assertIsNotNone(error.problems[0].line)

    def test_empty_and_whitespace_and_comment_only(self) -> None:
        for text in ("", "   \n\n", "# just a comment\n"):
            for dialect in DIALECTS:
                self.assertRefused(dialect, text, "the code is empty")

    def test_size_and_shape_limits(self) -> None:
        self.assertRefused("qiskit", "x = 1\n" * 3000, "too long" if 6 * 3000 > MAX_CODE_CHARS else "too many lines")
        self.assertRefused("qiskit", "#" * (MAX_CODE_CHARS + 1), "too long")
        self.assertRefused("qiskit", "\n" * (MAX_LINES + 1), "too many lines")
        self.assertRefused("qiskit", "a\x00b", "NUL")
        self.assertRefused("qiskit", "x = 1\x07\n", "control character")
        self.assertRefused("qiskit", "x = " + "(" * 40 + "1" + ")" * 40 + "\n", "nested too deeply")
        self.assertRefused("qiskit", "x = " + "[" * 200 + "]" * 200 + "\n", "nested too deeply")

    def test_too_many_operations_and_qubits(self) -> None:
        body = "".join("qc.h(0)\n" for _ in range(sdk_parse.MAX_OPERATIONS + 1))
        if len(body) + 60 > MAX_CODE_CHARS:  # stay under the size limit by using a short method name
            body = "".join("qc.x(0)\n" for _ in range(sdk_parse.MAX_OPERATIONS + 1))
        self.assertRefused("qiskit", QISKIT_HEAD + "qc = QuantumCircuit(1)\n" + body, "too many operations")

    def test_unicode_and_odd_identifiers_are_just_unknown(self) -> None:
        self.assertRefused("qiskit", QISKIT_HEAD + "qc = QuantumCircuit(2)\nqc.h(０)\n", "")  # a full-width digit is a name, not a literal
        # Python itself folds a full-width letter to its plain form (NFKC) in identifiers, so this IS qc.h(0): read as Python reads it, not guessed at
        self.assertEqual(shape(parse_sdk(QISKIT_HEAD + "qc = QuantumCircuit(2)\nqc.ｈ(0)\n", "qiskit").circuit), [("h", (), (0,), (), ())])
        self.assertEqual(parse_sdk(QISKIT_HEAD + "qc = QuantumCircuit(2)\nπ = 3\n", "qiskit").circuit.num_qubits, 2)  # a harmless numeric name


# --------------------------------------------------------------------------- #
# It never executes anything                                                   #
# --------------------------------------------------------------------------- #


class TestNoExecution(_Case):
    def test_no_code_path_in_the_parser_evaluates_imports_or_looks_up_dynamically(self) -> None:
        source = (BACKEND / "qentor" / "circuit" / "sdk_parse.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        forbidden_calls = {"eval", "exec", "compile", "__import__", "getattr", "setattr", "delattr", "globals", "locals", "vars", "open", "input", "breakpoint", "type", "importlib", "literal_eval"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
                self.assertNotIn(name, forbidden_calls, f"line {node.lineno}: call to {name}")
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
                for module in modules:
                    self.assertNotIn(module.split(".")[0], {"os", "sys", "subprocess", "importlib", "builtins", "pickle", "marshal", "ctypes", "socket", "shutil", "runpy"}, module)
        # the only thing it does with text is parse it, in exec mode (which parses; it does not run)
        parse_calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "parse"]
        self.assertEqual(len(parse_calls), 1)
        self.assertEqual([k.value.value for k in parse_calls[0].keywords if k.arg == "mode"], ["exec"])

    def test_a_program_that_would_have_side_effects_if_it_ran_has_none_and_is_refused(self) -> None:
        canaries = [
            "raise SystemExit(1)\n",
            "__import__('builtins').QENTOR_CANARY = 1\n",
            "import builtins\nbuiltins.QENTOR_CANARY = 1\n",
            "exec(\"import builtins; builtins.QENTOR_CANARY = 1\")\n",
            "eval(\"__import__('builtins').__dict__.update(QENTOR_CANARY=1)\")\n",
            "open('/tmp/qentor-canary', 'w').write('x')\n",
            "class A:\n    def __init__(self):\n        import builtins\n        builtins.QENTOR_CANARY = 1\nA()\n",
            "x = [1 for _ in iter(int, 1)]\n",
            "while True:\n    pass\n",
            "def f():\n    return f()\nf()\n",
            "(lambda: __import__('builtins').__dict__.update(QENTOR_CANARY=1))()\n",
        ]
        for dialect in DIALECTS:
            prelude = {"qiskit": QISKIT_HEAD + "qc = QuantumCircuit(1)\n", "cirq": CIRQ_HEAD + "q = cirq.LineQubit.range(1)\ncircuit = cirq.Circuit()\n", "pennylane": PL_HEAD}[dialect]
            for canary in canaries:
                with self.assertRaises(SdkParseError, msg=f"{dialect}: {canary!r}"):
                    parse_sdk(prelude + canary, dialect)
        self.assertFalse(hasattr(builtins, "QENTOR_CANARY"))
        self.assertFalse(Path("/tmp/qentor-canary").exists())

    def test_a_circuit_that_is_read_fine_runs_no_code_either(self) -> None:
        # a valid program followed by something that would raise or loop forever if executed: refused at the later line, and never run
        code = QISKIT_HEAD + "qc = QuantumCircuit(1)\nqc.h(0)\nraise SystemExit\n"
        with self.assertRaises(SdkParseError) as caught:
            parse_sdk(code, "qiskit")
        self.assertEqual(caught.exception.problems[0].line, 4)

    def test_pathological_input_is_a_refusal_not_a_crash_or_a_hang(self) -> None:
        started = time.monotonic()
        nasty = [
            "x = " + "-" * 2000 + "1\n",
            "x = " + "not " * 500 + "1\n",
            "x = 1" + " + 1" * 3000 + "\n",
            "x = " + "(" * 25 + "1" + ")" * 25 + "\n",
            "x = '" + "a" * 19000 + "'\n",
            "x = " + "9" * 5000 + "\n",
            "x = 0x" + "f" * 5000 + "\n",
            "\\\n" * 300,
            "(" * 29 + ")" * 29 + "\n",
            "if 1:\n" + "".join("  " * (i + 1) + "if 1:\n" for i in range(150)) + "  " * 151 + "pass\n",
            "\ufeff" + QISKIT_HEAD,
            "x = 1e9999999\n",
            "x = 1" + "0" * 400 + "\n",
        ]
        for dialect in DIALECTS:
            for text in nasty:
                try:
                    parse_sdk(text, dialect)
                except SdkParseError:
                    pass
        self.assertLess(time.monotonic() - started, 20.0)

    def test_fuzz_always_a_circuit_or_a_refusal_and_never_anything_else(self) -> None:
        rng = random.Random(7)
        pieces = {
            "qiskit": ["from qiskit import QuantumCircuit", "qc = QuantumCircuit(2, 2)", "qc.h(0)", "qc.cx(0, 1)", "qc.rx(pi / 2, 1)", "qc.measure_all()", "qc.barrier()", "qc.foo(1)",
                       "for i in range(2): pass", "import os", "qc.h(", "x = 1", "eval('1')", "qc.cx(0, 0)", "qc.measure(0, 5)", "pi = 3", "qc.h(9)", "print(qc)", "", "  qc.h(0)"],
            "cirq": ["import cirq", "q = cirq.LineQubit.range(2)", "circuit = cirq.Circuit()", "circuit.append(cirq.H(q[0]))", "circuit.append([cirq.CNOT(q[0], q[1])])",
                     "circuit.append(cirq.measure(q[0], key='c0'))", "circuit.append(cirq.foo(q[0]))", "import os", "a, b = cirq.LineQubit.range(2)", "circuit.append(cirq.rx(1)(a))",
                     "x = (", "circuit.append(cirq.H(q[7]))", "print(circuit)", "(cirq.S**-1)(q[0])", ""],
            "pennylane": ['import pennylane as qml', 'dev = qml.device("default.qubit", wires=2)', "@qml.qnode(dev)", "def circuit():", "    qml.Hadamard(wires=0)", "    qml.CNOT(wires=[0, 1])",
                          "    return qml.state()", "    return qml.probs(wires=[0])", "    qml.Foo(wires=0)", "import os", "def other():", "    qml.RX(0.1, wires=3)", "circuit()", ""],
        }
        for dialect in DIALECTS:
            for _ in range(250):
                text = "\n".join(rng.choice(pieces[dialect]) for _ in range(rng.randint(1, 9))) + "\n"
                try:
                    result = parse_sdk(text, dialect)
                except SdkParseError as exc:
                    self.assertTrue(exc.problems)
                    continue
                self.assertIsInstance(result.circuit, Circuit)
                self.assertTrue(1 <= result.circuit.num_qubits <= 16)

    def test_every_refusal_carries_messages_and_never_the_raw_exception(self) -> None:
        for dialect in DIALECTS:
            for text in ("x = (", "import os", "\x00", "", "while 1: pass", "qc = 1 +"):
                try:
                    parse_sdk(text, dialect)
                except SdkParseError as exc:
                    for p in exc.problems:
                        self.assertIsInstance(p.message, str)
                        self.assertNotIn("Traceback", p.message)

    def test_the_label_says_python_is_not_executed(self) -> None:
        self.assertEqual(LABEL, "Safe subset parser — Python is not executed.")


# --------------------------------------------------------------------------- #
# The endpoint                                                                 #
# --------------------------------------------------------------------------- #


class TestEndpoint(unittest.TestCase):
    def setUp(self) -> None:
        classroom_api.reset_rate_limits()

    def tearDown(self) -> None:
        classroom_api.reset_rate_limits()

    def post(self, dialect: str, code: str, **extra):
        status, raw = http("POST", "/api/circuit/parse-code", json.dumps({"dialect": dialect, "code": code, **extra}).encode())
        return status, json.loads(raw)

    def test_a_good_program_is_returned_as_the_canonical_circuit_with_its_qasm_and_hash(self) -> None:
        status, body = self.post("qiskit", "from qiskit import QuantumCircuit\nqc = QuantumCircuit(2)\nqc.h(0)\nqc.cx(0, 1)\nqc.measure_all()\n")
        self.assertEqual(status, 200)
        self.assertEqual((body["status"], body["dialect"], body["label"]), ("PARSED", "qiskit", LABEL))
        self.assertEqual(len(body["circuit"]["ops"]), 4)
        self.assertIn("h q[0];", body["canonical_qasm"])
        self.assertRegex(body["circuit_hash"], r"^[0-9a-f]{16,64}$|^qc_")
        self.assertTrue(body["notes"])
        for forbidden in ("result", "statevector", "probabilities", "provenance", "result_id"):
            self.assertNotIn(forbidden, body)

    def test_each_dialect_through_the_endpoint(self) -> None:
        cases = {
            "cirq": "import cirq\nq = cirq.LineQubit.range(2)\ncircuit = cirq.Circuit(cirq.H(q[0]), cirq.CNOT(q[0], q[1]))\n",
            "pennylane": 'import pennylane as qml\ndev = qml.device("default.qubit", wires=2)\n@qml.qnode(dev)\ndef circuit():\n    qml.Hadamard(wires=0)\n    qml.CNOT(wires=[0, 1])\n    return qml.state()\n',
            "openqasm": 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n',
        }
        hashes = set()
        for dialect, code in cases.items():
            status, body = self.post(dialect, code)
            self.assertEqual(status, 200, dialect)
            self.assertEqual([o["gate"] for o in body["circuit"]["ops"]], ["h", "cx"], dialect)
            hashes.add(body["circuit_hash"])
        self.assertEqual(len(hashes), 1)  # the same circuit, whichever way it was written

    def test_an_unsupported_program_is_a_structured_422_naming_the_construct_and_the_line(self) -> None:
        status, body = self.post("qiskit", "from qiskit import QuantumCircuit\nqc = QuantumCircuit(2)\nfor i in range(2):\n    qc.h(i)\n")
        self.assertEqual(status, 422)
        detail = body["detail"]
        self.assertEqual(detail["code"], "CODE_NOT_SUPPORTED")
        self.assertEqual(detail["problems"][0]["line"], 3)
        self.assertIn("a for loop is not supported", detail["problems"][0]["message"])
        self.assertEqual(detail["label"], LABEL)
        self.assertIn("qc.h/x/y/z/s/sdg/t/tdg(q)", detail["supported"])
        self.assertNotIn("circuit", detail)

    def test_a_bad_openqasm_program_is_refused_the_same_way(self) -> None:
        status, body = self.post("openqasm", "OPENQASM 3.0;\nqubit[2] q;\nfor int i in [0:2] { h q[i]; }\n")
        self.assertEqual(status, 422)
        self.assertEqual(body["detail"]["code"], "CODE_NOT_SUPPORTED")
        self.assertTrue(body["detail"]["problems"][0]["message"])

    def test_the_request_is_strict(self) -> None:
        good = "from qiskit import QuantumCircuit\nqc = QuantumCircuit(1)\nqc.h(0)\n"
        self.assertEqual(self.post("qiskit", good)[0], 200)  # the same code, without the extra field, is read
        for extra in ({"execute": True}, {"run": True}, {"language": "python"}, {"role": "instructor"}):
            status, body = self.post("qiskit", good, **extra)
            self.assertEqual(status, 422, extra)
            self.assertIsInstance(body["detail"], list, extra)  # refused by the request schema, before any parsing
        status, _ = self.post("fortran", "x")
        self.assertEqual(status, 422)
        status, _ = http("POST", "/api/circuit/parse-code", json.dumps({"dialect": "qiskit", "code": 5}).encode())
        self.assertEqual(status, 422)
        status, _ = http("POST", "/api/circuit/parse-code", json.dumps({"dialect": "qiskit"}).encode())
        self.assertEqual(status, 422)
        status, _ = http("POST", "/api/circuit/parse-code", b"not json")
        self.assertEqual(status, 422)

    def test_an_oversized_body_is_refused_before_it_is_parsed(self) -> None:
        status, body = self.post("qiskit", "x" * (MAX_CODE_CHARS * 2 + 1))
        self.assertEqual(status, 422)
        self.assertIsInstance(body["detail"], list)  # refused by the request schema: the text is never parsed
        status, body = self.post("qiskit", "#" * (MAX_CODE_CHARS + 5))
        self.assertEqual(status, 422)
        self.assertIn("too long", body["detail"]["problems"][0]["message"])

    def test_parsing_is_rate_limited_per_client(self) -> None:
        statuses = [self.post("qiskit", "x = (")[0] for _ in range(125)]
        self.assertEqual(statuses[0], 422)
        self.assertEqual(statuses[-1], 429)

    def test_it_executes_nothing_and_stores_nothing(self) -> None:
        from qentor.api import app as app_module

        before = app_module._store.list_by_circuit_hash("x")
        status, _ = self.post("qiskit", "from qiskit import QuantumCircuit\nqc = QuantumCircuit(1)\nqc.h(0)\nraise SystemExit\n")
        self.assertEqual(status, 422)
        self.assertEqual(app_module._store.list_by_circuit_hash("x"), before)


if __name__ == "__main__":
    unittest.main()
