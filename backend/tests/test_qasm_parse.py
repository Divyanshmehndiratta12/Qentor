"""The server-side OpenQASM 3 parser (``qentor.circuit.qasm_parse``).

Three groups: (1) it reads back exactly what the emitter wrote, for every shared golden fixture, so the two sides of the
canonical text agree and the circuit hash is stable through a round trip; (2) it accepts the ordinary spellings a person or a
language model uses and lands on the SAME canonical circuit; (3) it refuses everything outside the subset, with the line and a
reason, and nothing in the text can run code.
"""

from __future__ import annotations

import json
import math
import unittest
from pathlib import Path

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName
from qentor.circuit.qasm import to_qasm3
from qentor.circuit.qasm_parse import MAX_STATEMENTS, MAX_TEXT_CHARS, QasmParseError, parse_qasm3, read_angle

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = sorted(p for p in (ROOT / "fixtures" / "circuits").glob("*.json") if not p.name.startswith("_"))

BELL = "OPENQASM 3.0;\ninclude \"stdgates.inc\";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n"


def bell() -> Circuit:
    return parse_qasm3(BELL)


class TestItReadsBackWhatTheEmitterWrote(unittest.TestCase):
    def test_every_golden_fixture_round_trips_to_the_same_circuit_text_and_hash(self) -> None:
        self.assertGreaterEqual(len(FIXTURES), 15)  # a guard against a vacuous pass
        for path in FIXTURES:
            fixture = json.loads(path.read_text(encoding="utf-8"))
            with self.subTest(fixture=path.name):
                circuit = Circuit.model_validate(fixture["circuit"])
                parsed = parse_qasm3(fixture["qasm"])
                self.assertEqual(parsed, circuit)
                self.assertEqual(to_qasm3(parsed), fixture["qasm"])
                self.assertEqual(circuit_hash(parsed), fixture["hash"])

    def test_angles_survive_a_round_trip_exactly(self) -> None:
        for theta in (0.0, 1.0, math.pi / 3, 1e-5, -2.718281828459045, 123.456):
            circuit = Circuit(num_qubits=1, num_clbits=0, ops=[{"gate": "rz", "targets": [0], "params": [theta]}])
            self.assertEqual(parse_qasm3(to_qasm3(circuit)).ops[0].params, [theta])


class TestOrdinarySpellingsLandOnTheSameCircuit(unittest.TestCase):
    def test_the_example_from_the_brief(self) -> None:
        circuit = parse_qasm3('OPENQASM 3;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];')
        self.assertEqual(circuit, bell())
        self.assertEqual(circuit_hash(circuit), circuit_hash(bell()))

    def test_comments_whitespace_and_several_statements_per_line(self) -> None:
        text = "// a Bell pair\nOPENQASM   3.0 ;  /* header */ qubit[2]   q ; h q[0];cx   q[0] ,q[1] ;\n\n"
        self.assertEqual(parse_qasm3(text), bell())

    def test_no_header_is_fine(self) -> None:
        self.assertEqual(parse_qasm3("qubit[2] q; h q[0]; cx q[0], q[1];"), bell())

    def test_a_single_qubit_register_and_free_register_names(self) -> None:
        circuit = parse_qasm3("qubit a; x a[0];")
        self.assertEqual((circuit.num_qubits, circuit.ops[0].gate, circuit.ops[0].targets), (1, GateName.X, [0]))
        circuit = parse_qasm3("qubit[2] reg; bit[2] out; h reg[1]; out[0] = measure reg[1];")
        self.assertEqual([(o.gate.value, o.targets, o.clbits) for o in circuit.ops], [("h", [1], []), ("measure", [1], [0])])

    def test_legacy_qreg_and_creg_declarations(self) -> None:
        self.assertEqual(parse_qasm3("OPENQASM 3.0; qreg q[2]; creg c[2]; h q[0]; cx q[0], q[1]; measure q -> c;").num_clbits, 2)

    def test_a_single_qubit_gate_on_a_whole_register_expands_in_index_order(self) -> None:
        circuit = parse_qasm3("qubit[3] q; h q;")
        self.assertEqual([(o.gate.value, o.targets) for o in circuit.ops], [("h", [0]), ("h", [1]), ("h", [2])])

    def test_all_measurement_spellings(self) -> None:
        expected = [("measure", [0], [0]), ("measure", [1], [1])]
        for line in ("c = measure q;", "measure q -> c;", "c[0] = measure q[0]; c[1] = measure q[1];", "measure q[0] -> c[0]; measure q[1] -> c[1];"):
            with self.subTest(line=line):
                circuit = parse_qasm3(f"qubit[2] q; bit[2] c; {line}")
                self.assertEqual([(o.gate.value, o.targets, o.clbits) for o in circuit.ops], expected)

    def test_cnot_and_toffoli_are_names_for_cx_and_ccx(self) -> None:
        circuit = parse_qasm3("qubit[3] q; cnot q[0], q[1]; toffoli q[0], q[1], q[2];")
        self.assertEqual([o.gate for o in circuit.ops], [GateName.CX, GateName.CCX])
        self.assertEqual((circuit.ops[1].controls, circuit.ops[1].targets), ([0, 1], [2]))

    def test_every_gate_in_the_model_has_a_spelling(self) -> None:
        text = (
            "qubit[3] q; bit[3] c; h q[0]; x q[0]; y q[0]; z q[0]; s q[0]; sdg q[0]; t q[0]; tdg q[0];"
            "rx(0.1) q[0]; ry(0.2) q[1]; rz(0.3) q[2]; cx q[0], q[1]; cz q[1], q[0]; cp(0.4) q[0], q[2];"
            "swap q[1], q[2]; ccx q[0], q[1], q[2]; c[0] = measure q[0];"
        )
        self.assertEqual({o.gate for o in parse_qasm3(text).ops}, {g for g in GateName})

    def test_angle_expressions(self) -> None:
        for text, value in (
            ("pi", math.pi), ("pi/2", math.pi / 2), ("-pi/4", -math.pi / 4), ("3*pi/4", 3 * math.pi / 4), ("π/2", math.pi / 2),
            ("(1+2)*0.5", 1.5), ("2*(pi - 1)", 2 * (math.pi - 1)), (".5", 0.5), ("1e-3", 1e-3), ("--1", 1.0), ("+2", 2.0),
        ):
            with self.subTest(text=text):
                self.assertAlmostEqual(read_angle(text), value, places=12)
        circuit = parse_qasm3("qubit q; ry(pi/2) q[0]; rz(-pi) q[0];")
        self.assertAlmostEqual(circuit.ops[0].params[0], math.pi / 2, places=12)
        self.assertAlmostEqual(circuit.ops[1].params[0], -math.pi, places=12)

    def test_the_circuit_is_the_canonical_text_not_the_authors(self) -> None:
        messy = parse_qasm3("qubit[2] q;  // hi\n h   q[0] ;\n cx q[0] , q[1];")
        self.assertEqual(to_qasm3(messy), to_qasm3(bell()))


class TestAnythingOutsideTheSubsetIsRefusedWithALine(unittest.TestCase):
    def refused(self, text: str, *, line: int | None = None, mention: str = "") -> QasmParseError:
        with self.assertRaises(QasmParseError) as caught:
            parse_qasm3(text)
        if line is not None:
            self.assertEqual(caught.exception.line, line, str(caught.exception))
        self.assertIn(mention.lower(), str(caught.exception).lower())
        return caught.exception

    def test_unsupported_constructs_name_themselves(self) -> None:
        cases = {
            "gate mygate a { h a; }": "block",
            "qubit q; for int i in [0:1] { h q[0]; }": "block",
            "qubit[2] q; bit c; if (c == 1) x q[0];": "classical control",
            "qubit q; reset q[0];": "reset",
            "qubit[2] q; barrier q;": "barrier",
            "input float theta; qubit q;": "inputs",
            "qubit q; delay[10ns] q[0];": "timing",
            "qubit q; ctrl @ x q[0], q[0];": "modifiers",
            "qubit q; int x = 1;": "classical variables",
            "qubit q; gphase(pi);": "global phase",
        }
        for text, mention in cases.items():
            with self.subTest(text=text):
                self.refused(text, mention=mention)

    def test_gates_the_model_does_not_have(self) -> None:
        for gate in ("u3(0,0,0) q[0]", "p(0.5) q[0]", "cy q[0], q[1]", "sx q[0]", "u q[0]", "id q[0]"):
            with self.subTest(gate=gate):
                self.refused(f"qubit[2] q; {gate};", mention="unknown or unsupported gate")

    def test_the_wrong_number_of_operands_or_angles(self) -> None:
        self.refused("qubit[2] q; cx q[0];", mention="takes 2 qubit operands")
        self.refused("qubit[2] q; h q[0], q[1];", mention="exactly one qubit")
        self.refused("qubit q; rx q[0];", mention="needs one angle")
        self.refused("qubit q; rx(1,2) q[0];", mention="exactly one angle")
        self.refused("qubit q; h(0.5) q[0];", mention="takes no angle")
        self.refused("qubit[2] q; cp q[0], q[1];", mention="needs one angle")
        self.refused("qubit[2] q; cx q, q;", mention="single qubits")

    def test_operands_out_of_range_or_unknown_registers(self) -> None:
        self.refused("qubit[2] q; h q[2];", line=1, mention="out of range")
        self.refused("qubit[2] q; bit[1] c; c[1] = measure q[0];", mention="out of range")
        self.refused("qubit[2] q; h r[0];", mention="not the declared")
        self.refused("h q[0]; qubit q;", line=1, mention="before any qubit register")
        self.refused("qubit[2] q; cx q[0], q[0];", mention="different")

    def test_registers(self) -> None:
        self.refused("qubit[2] q; qubit[2] r;", mention="only one qubit register")
        self.refused("qubit q; bit a; bit b;", mention="only one classical register")
        self.refused("qubit[40] q;", mention="1 to 32")
        self.refused("h q[0];", mention="before any")
        self.refused("// nothing but a comment", mention="empty")
        self.refused("OPENQASM 3.0;", mention="no qubit declaration")

    def test_measurement_problems(self) -> None:
        self.refused("qubit q; bit c; q[0] = measure q[0];", mention="not the declared classical")
        self.refused("qubit q; measure q[0] -> c[0];", mention="needs a classical register")
        self.refused("qubit[2] q; bit c; c = measure q;", mention="cannot measure 2 qubits into 1")
        self.refused("qubit q; bit c = measure q;", mention="declare the classical register on its own line")

    def test_version_include_and_syntax(self) -> None:
        self.refused("OPENQASM 2.0; qreg q[1];", mention="only OpenQASM 3")
        self.refused('include "other.inc"; qubit q;', mention="stdgates.inc")
        self.refused("qubit q; h q[0]", mention="missing its ';'")
        self.refused("qubit q; /* never closed h q[0];", mention="never closed")
        self.refused("qubit q; h q[0]; @@@;", line=1, mention="not in the supported")

    def test_the_line_of_the_offending_statement_is_reported(self) -> None:
        text = "OPENQASM 3.0;\nqubit[2] q;\nh q[0];\n\n   cx q[0], q[5];\nh q[1];"
        error = self.refused(text, line=5, mention="out of range")
        self.assertIn("cx q[0], q[5]", error.text)

    def test_bad_angles(self) -> None:
        for angle in ("", "pi/0", "abc", "1+", "(1", "2**3", "1e999", "pi pi", "1,2"):
            with self.subTest(angle=angle):
                with self.assertRaises(QasmParseError):
                    parse_qasm3(f"qubit q; rx({angle}) q[0];")

    def test_size_limits(self) -> None:
        self.refused("qubit q; " + "h q[0]; " * (MAX_STATEMENTS + 1), mention="too many statements")
        self.refused("// " + "x" * MAX_TEXT_CHARS, mention="too long")

    def test_a_refused_program_yields_no_partial_circuit(self) -> None:
        with self.assertRaises(QasmParseError):
            parse_qasm3("qubit[2] q; h q[0]; cx q[0], q[1]; frobnicate q[0];")


class TestNothingInTheTextCanRunCode(unittest.TestCase):
    """The text is read, never executed: these are all just unsupported statements or bad angles."""

    def test_python_and_shell_text_is_not_a_program(self) -> None:
        for text in (
            "__import__('os').system('echo hi')",
            "import os; os.system('echo hi')",
            "qubit q; h q[0]; exec('1+1')",
            "qubit q; rx(__import__('os').getcwd()) q[0];",
            "qubit q; rx(open('/etc/passwd').read()) q[0];",
            "qubit q; rx(1; __import__('os')) q[0];",
            "qubit q; rx(os.system('x')) q[0];",
            "qubit q; rx(eval('1')) q[0];",
        ):
            with self.subTest(text=text):
                with self.assertRaises(QasmParseError):
                    parse_qasm3(text)

    def test_the_angle_reader_knows_only_numbers_pi_and_arithmetic(self) -> None:
        for text in ("pi.real", "pi_", "e", "tau", "sqrt(2)", "sin(1)", "1 if 1 else 2", "[1]", "1 << 2", "2 ** 2", "1 // 2", "__name__"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    read_angle(text)

    def test_the_module_never_calls_or_imports_anything_that_evaluates_text(self) -> None:
        import ast

        tree = ast.parse((ROOT / "backend" / "qentor" / "circuit" / "qasm_parse.py").read_text(encoding="utf-8"))
        called = {node.func.id for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertFalse(called & {"eval", "exec", "compile", "__import__", "open", "getattr", "setattr", "globals", "locals"}, called)
        imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        imported |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        self.assertFalse(imported & {"os", "sys", "subprocess", "importlib", "builtins", "pathlib", "ctypes", "pickle"}, imported)

    def test_huge_input_is_refused_before_it_is_read(self) -> None:
        with self.assertRaises(QasmParseError):
            parse_qasm3("qubit q;" + " " * (MAX_TEXT_CHARS + 1))


if __name__ == "__main__":
    unittest.main()
