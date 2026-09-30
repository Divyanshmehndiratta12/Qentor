"""Write (or check) the shared golden fixtures in ``fixtures/circuits/``.

The fixtures are the one definition of "what this circuit is, what its OpenQASM 3 text
is, what its hash is, and what its Qiskit / Cirq / PennyLane views read" that BOTH test suites check: the Python suite against the server
emitter and hash, the TypeScript suite against the web emitter and parser
(docs/ARCHITECTURE.md §4; CLAUDE.md: "the web emitter must match [the server's] on the
fixtures"). Two implementations agreeing with one reviewed file is what makes them agree
with each other.

Usage (from the repository root):

    backend/.venv/bin/python backend/scripts/regen_fixtures.py --check   # CI: fail on any drift
    backend/.venv/bin/python backend/scripts/regen_fixtures.py --write   # after a REVIEWED change

``--write`` derives ``qasm`` and ``hash`` from the server emitter, so a diff in those fields
is a change of behaviour that must be read, not accepted. The circuit definitions below are
the only hand-written part.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qentor.circuit.codegen import generate_all  # noqa: E402
from qentor.circuit.hashing import circuit_hash  # noqa: E402
from qentor.circuit.model import Circuit, GateOp  # noqa: E402
from qentor.circuit.qasm import to_qasm3  # noqa: E402

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "circuits"


def op(gate: str, targets, controls=(), params=(), clbits=()) -> GateOp:
    return GateOp(gate=gate, targets=list(targets), controls=list(controls), params=list(params), clbits=list(clbits))


def circuit(num_qubits: int, num_clbits: int, *ops: GateOp) -> Circuit:
    return Circuit(num_qubits=num_qubits, num_clbits=num_clbits, ops=list(ops))


def measure_all(n: int) -> list[GateOp]:
    return [op("measure", [i], clbits=[i]) for i in range(n)]


# name -> (description, circuit). Order does not matter; files are written sorted.
FIXTURES: dict[str, tuple[str, Circuit]] = {
    "empty": ("A single qubit and no operations.", circuit(1, 0)),
    "x_measure": ("Flip a qubit, then measure it.", circuit(1, 1, op("x", [0]), op("measure", [0], clbits=[0]))),
    "bell_measured": (
        "The Bell circuit with both qubits measured.",
        circuit(2, 2, op("h", [0]), op("cx", [1], [0]), *measure_all(2)),
    ),
    "ghz3": (
        "Three-qubit GHZ, all measured.",
        circuit(3, 3, op("h", [0]), op("cx", [1], [0]), op("cx", [2], [1]), *measure_all(3)),
    ),
    "single_qubit_gates": (
        "Every fixed single-qubit gate in the set, in order.",
        circuit(1, 0, *[op(g, [0]) for g in ("h", "x", "y", "z", "s", "sdg", "t", "tdg")]),
    ),
    "rotations": (
        "The three rotations, including an integral angle (Python prints 1.0) and a negative one.",
        circuit(
            2,
            0,
            op("rx", [0], params=[0.5]),
            op("ry", [1], params=[1.5707963267948966]),
            op("rz", [0], params=[-3.141592653589793]),
            op("rx", [1], params=[1.0]),
        ),
    ),
    "angle_formatting": (
        "Angles whose text differs between Python's repr and JavaScript's toString: exponents, "
        "large and small magnitudes, negative zero, integral floats.",
        circuit(
            1,
            0,
            *[op("rz", [0], params=[a]) for a in (1e-05, 1e-07, 1e16, 1.5e300, 0.0001, 123456789.125, -0.0, 3.0, 0.30000000000000004, 1e22)],
        ),
    ),
    "controlled_gates": (
        "CX and CZ with both operand orders on three qubits (control and target are not interchangeable for CX).",
        circuit(3, 0, op("cx", [1], [0]), op("cz", [0], [1]), op("cx", [0], [2]), op("cz", [2], [1])),
    ),
    "controlled_phase": (
        "CP in every role on three qubits: control and target swapped, a negative angle and an integral angle "
        "(Python prints 1.0), on an H-prepared state so the phase is not invisible.",
        circuit(
            3,
            0,
            op("h", [0]),
            op("h", [1]),
            op("h", [2]),
            op("cp", [1], [0], params=[1.5707963267948966]),
            op("cp", [0], [2], params=[-0.25]),
            op("cp", [2], [1], params=[1.0]),
        ),
    ),
    "swap_gate": (
        "SWAP with operands in both orders, then measured.",
        circuit(3, 3, op("x", [0]), op("swap", [0, 2]), op("swap", [2, 1]), *measure_all(3)),
    ),
    "toffoli": (
        "CCX with its controls in descending order, on a basis input, measured.",
        circuit(3, 3, op("x", [0]), op("x", [2]), op("ccx", [1], [2, 0]), *measure_all(3)),
    ),
    "phase_kickback_lab": (
        "The Phase Kickback lesson's lab circuit: target prepared in |-> (X then H), CX, closing H.",
        circuit(2, 0, op("h", [0]), op("x", [1]), op("h", [1]), op("cx", [1], [0]), op("h", [0])),
    ),
    "deutsch_jozsa_balanced": (
        "The Deutsch-Jozsa lesson's fixed balanced-oracle example.",
        circuit(2, 1, op("x", [1]), op("h", [0]), op("h", [1]), op("cx", [1], [0]), op("h", [0]), op("measure", [0], clbits=[0])),
    ),
    "bernstein_vazirani_secret_01": (
        "The Bernstein-Vazirani lesson's fixed example: a 1 on q0, a 0 on q1 (printed 01).",
        circuit(
            3,
            2,
            op("x", [2]),
            op("h", [0]),
            op("h", [1]),
            op("h", [2]),
            op("cx", [2], [0]),
            op("h", [0]),
            op("h", [1]),
            op("measure", [0], clbits=[0]),
            op("measure", [1], clbits=[1]),
        ),
    ),
    "partial_measurement": (
        "Only some qubits measured, into a different classical bit.",
        circuit(2, 2, op("h", [0]), op("cx", [1], [0]), op("measure", [1], clbits=[0])),
    ),
}

# Circuits that are (or are not) operator-equivalent up to global phase — for the equivalence checker.
EQUIVALENCE: list[dict] = []


def pair(name: str, note: str, expected: str, a: Circuit, b: Circuit) -> None:
    EQUIVALENCE.append({"name": name, "note": note, "expected": expected, "a": a, "b": b})


pair("hzh_is_x", "H Z H is X.", "EQUIVALENT", circuit(1, 0, op("h", [0]), op("z", [0]), op("h", [0])), circuit(1, 0, op("x", [0])))
pair("s_squared_is_z", "S S is Z.", "EQUIVALENT", circuit(1, 0, op("s", [0]), op("s", [0])), circuit(1, 0, op("z", [0])))
pair("t_squared_is_s", "T T is S.", "EQUIVALENT", circuit(1, 0, op("t", [0]), op("t", [0])), circuit(1, 0, op("s", [0])))
pair("s_then_sdg_cancels", "S then S-dagger is the identity.", "EQUIVALENT", circuit(1, 0, op("s", [0]), op("sdg", [0])), circuit(1, 0))
pair("t_then_tdg_cancels", "T then T-dagger is the identity.", "EQUIVALENT", circuit(1, 0, op("t", [0]), op("tdg", [0])), circuit(1, 0))
pair("sdg_squared_is_z", "S-dagger twice is Z.", "EQUIVALENT", circuit(1, 0, op("sdg", [0]), op("sdg", [0])), circuit(1, 0, op("z", [0])))
pair("cz_is_h_cx_h", "CZ is CX conjugated by H on the target.", "EQUIVALENT", circuit(2, 0, op("cz", [1], [0])), circuit(2, 0, op("h", [1]), op("cx", [1], [0]), op("h", [1])))
pair("cz_is_symmetric", "CZ(0,1) is CZ(1,0).", "EQUIVALENT", circuit(2, 0, op("cz", [1], [0])), circuit(2, 0, op("cz", [0], [1])))
pair("cp_pi_is_cz", "CP with angle pi is CZ.", "EQUIVALENT", circuit(2, 0, op("cp", [1], [0], params=[3.141592653589793])), circuit(2, 0, op("cz", [1], [0])))
pair("cp_is_symmetric", "CP(0,1) is CP(1,0) for the same angle.", "EQUIVALENT", circuit(2, 0, op("cp", [1], [0], params=[0.7])), circuit(2, 0, op("cp", [0], [1], params=[0.7])))
pair("cp_then_minus_cp_cancels", "CP(theta) then CP(-theta) is the identity.", "EQUIVALENT", circuit(2, 0, op("cp", [1], [0], params=[0.7]), op("cp", [1], [0], params=[-0.7])), circuit(2, 0))
pair("cp_half_pi_twice_is_cz", "CP(pi/2) twice is CP(pi), which is CZ.", "EQUIVALENT", circuit(2, 0, op("cp", [1], [0], params=[1.5707963267948966]), op("cp", [1], [0], params=[1.5707963267948966])), circuit(2, 0, op("cz", [1], [0])))
pair("swap_is_three_cx", "SWAP is three alternating CX gates.", "EQUIVALENT", circuit(2, 0, op("swap", [0, 1])), circuit(2, 0, op("cx", [1], [0]), op("cx", [0], [1]), op("cx", [1], [0])))
pair("swap_operand_order", "SWAP(0,1) is SWAP(1,0).", "EQUIVALENT", circuit(2, 0, op("swap", [0, 1])), circuit(2, 0, op("swap", [1, 0])))
pair("toffoli_control_order", "CCX with its controls in either order.", "EQUIVALENT", circuit(3, 0, op("ccx", [2], [0, 1])), circuit(3, 0, op("ccx", [2], [1, 0])))
pair("global_phase_only", "Z X Z X is minus the identity: equal to nothing up to global phase.", "EQUIVALENT", circuit(1, 0, op("z", [0]), op("x", [0]), op("z", [0]), op("x", [0])), circuit(1, 0))
pair("relative_phase_differs", "Z is not the identity: a relative phase is a real difference.", "NOT_EQUIVALENT", circuit(1, 0, op("z", [0])), circuit(1, 0))
pair("s_is_not_t", "S and T differ.", "NOT_EQUIVALENT", circuit(1, 0, op("s", [0])), circuit(1, 0, op("t", [0])))
pair("s_is_not_sdg", "S and S-dagger differ.", "NOT_EQUIVALENT", circuit(1, 0, op("s", [0])), circuit(1, 0, op("sdg", [0])))
pair("cx_direction_matters", "CX(0->1) is not CX(1->0).", "NOT_EQUIVALENT", circuit(2, 0, op("cx", [1], [0])), circuit(2, 0, op("cx", [0], [1])))
pair("cz_is_not_cx", "CZ is not CX.", "NOT_EQUIVALENT", circuit(2, 0, op("cz", [1], [0])), circuit(2, 0, op("cx", [1], [0])))
pair("cp_angle_matters", "CP(0.7) is not CP(0.8): the angle is part of the gate.", "NOT_EQUIVALENT", circuit(2, 0, op("cp", [1], [0], params=[0.7])), circuit(2, 0, op("cp", [1], [0], params=[0.8])))
pair("cp_is_not_cz_away_from_pi", "CP(pi/2) is not CZ.", "NOT_EQUIVALENT", circuit(2, 0, op("cp", [1], [0], params=[1.5707963267948966])), circuit(2, 0, op("cz", [1], [0])))
pair("swap_is_not_identity", "SWAP does something.", "NOT_EQUIVALENT", circuit(2, 0, op("swap", [0, 1])), circuit(2, 0))
pair("toffoli_target_matters", "CCX onto q2 is not CCX onto q0.", "NOT_EQUIVALENT", circuit(3, 0, op("ccx", [2], [0, 1])), circuit(3, 0, op("ccx", [0], [1, 2])))
pair("h_is_not_x", "H and X differ.", "NOT_EQUIVALENT", circuit(1, 0, op("h", [0])), circuit(1, 0, op("x", [0])))

# Canonical circuits the model must REJECT (server: validation error; web: ``client_rejects`` says
# whether the web model catches it too — some rules, like index range, only the server checks).
INVALID: list[dict] = [
    {"name": "cz_two_controls", "reason": "exactly 1 control", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 3, "num_clbits": 0, "ops": [{"gate": "cz", "targets": [2], "controls": [0, 1], "params": [], "clbits": []}]}},
    {"name": "cz_same_qubit", "reason": "different qubits", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "cz", "targets": [0], "controls": [0], "params": [], "clbits": []}]}},
    {"name": "cp_without_parameter", "reason": "exactly 1 parameter", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "cp", "targets": [1], "controls": [0], "params": [], "clbits": []}]}},
    {"name": "cp_two_parameters", "reason": "exactly 1 parameter", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "cp", "targets": [1], "controls": [0], "params": [0.5, 0.5], "clbits": []}]}},
    {"name": "cp_without_control", "reason": "exactly 1 control", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "cp", "targets": [1], "controls": [], "params": [0.5], "clbits": []}]}},
    {"name": "cp_two_controls", "reason": "exactly 1 control", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 3, "num_clbits": 0, "ops": [{"gate": "cp", "targets": [2], "controls": [0, 1], "params": [0.5], "clbits": []}]}},
    {"name": "cp_two_targets", "reason": "exactly 1 target", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 3, "num_clbits": 0, "ops": [{"gate": "cp", "targets": [1, 2], "controls": [0], "params": [0.5], "clbits": []}]}},
    {"name": "cp_same_qubit", "reason": "different qubits", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "cp", "targets": [0], "controls": [0], "params": [0.5], "clbits": []}]}},
    {"name": "cp_with_clbit", "reason": "no classical bits", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 1, "ops": [{"gate": "cp", "targets": [1], "controls": [0], "params": [0.5], "clbits": [0]}]}},
    {"name": "cp_control_out_of_range", "reason": "out of range", "client_rejects": False, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "cp", "targets": [1], "controls": [2], "params": [0.5], "clbits": []}]}},
    {"name": "ccx_one_control", "reason": "exactly 2 control", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 3, "num_clbits": 0, "ops": [{"gate": "ccx", "targets": [2], "controls": [0], "params": [], "clbits": []}]}},
    {"name": "ccx_repeated_qubit", "reason": "three different qubits", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 3, "num_clbits": 0, "ops": [{"gate": "ccx", "targets": [1], "controls": [0, 1], "params": [], "clbits": []}]}},
    {"name": "ccx_two_targets", "reason": "exactly 1 target", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 4, "num_clbits": 0, "ops": [{"gate": "ccx", "targets": [2, 3], "controls": [0, 1], "params": [], "clbits": []}]}},
    {"name": "swap_one_target", "reason": "exactly 2 target", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "swap", "targets": [0], "controls": [], "params": [], "clbits": []}]}},
    {"name": "swap_same_target", "reason": "two different", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "swap", "targets": [1, 1], "controls": [], "params": [], "clbits": []}]}},
    {"name": "swap_with_control", "reason": "no control", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 3, "num_clbits": 0, "ops": [{"gate": "swap", "targets": [0, 1], "controls": [2], "params": [], "clbits": []}]}},
    {"name": "sdg_with_parameter", "reason": "no parameters", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 1, "num_clbits": 0, "ops": [{"gate": "sdg", "targets": [0], "controls": [], "params": [0.5], "clbits": []}]}},
    {"name": "tdg_with_control", "reason": "no control", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "tdg", "targets": [0], "controls": [1], "params": [], "clbits": []}]}},
    {"name": "cx_control_equals_target", "reason": "different qubits", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "cx", "targets": [1], "controls": [1], "params": [], "clbits": []}]}},
    {"name": "measure_without_clbit", "reason": "exactly 1 classical bit", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 1, "num_clbits": 1, "ops": [{"gate": "measure", "targets": [0], "controls": [], "params": [], "clbits": []}]}},
    {"name": "unknown_gate", "reason": "cy", "client_rejects": True, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "cy", "targets": [1], "controls": [0], "params": [], "clbits": []}]}},
    {"name": "qubit_out_of_range", "reason": "out of range", "client_rejects": False, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 2, "num_clbits": 0, "ops": [{"gate": "h", "targets": [2], "controls": [], "params": [], "clbits": []}]}},
    {"name": "clbit_out_of_range", "reason": "classical bit index", "client_rejects": False, "circuit": {"schema": "qentor.circuit/1", "num_qubits": 1, "num_clbits": 1, "ops": [{"gate": "measure", "targets": [0], "controls": [], "params": [], "clbits": [1]}]}},
]


def _dump(data: dict) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def fixture_files() -> dict[str, str]:
    files: dict[str, str] = {}
    for name, (description, c) in sorted(FIXTURES.items()):
        files[f"{name}.json"] = _dump(
            {
                "name": name,
                "description": description,
                "circuit": c.canonical_dict(),
                "qasm": to_qasm3(c),
                "hash": circuit_hash(c),
                "code": generate_all(c),
            }
        )
    files["_equivalence.json"] = _dump(
        {
            "description": "Circuit pairs and whether they are operator-equivalent up to global phase.",
            "pairs": [
                {
                    "name": p["name"],
                    "note": p["note"],
                    "expected": p["expected"],
                    "a": {"circuit": p["a"].canonical_dict(), "qasm": to_qasm3(p["a"])},
                    "b": {"circuit": p["b"].canonical_dict(), "qasm": to_qasm3(p["b"])},
                }
                for p in EQUIVALENCE
            ],
        }
    )
    files["_invalid.json"] = _dump(
        {"description": "Canonical circuits the model must reject.", "cases": INVALID}
    )
    return files


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "--check"
    files = fixture_files()
    if mode == "--write":
        FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
        for filename, text in files.items():
            (FIXTURE_DIR / filename).write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {len(files)} fixture files to {FIXTURE_DIR}")
        return 0
    problems = []
    for filename, text in files.items():
        path = FIXTURE_DIR / filename
        if not path.exists():
            problems.append(f"missing: {filename}")
        elif path.read_text(encoding="utf-8") != text:
            problems.append(f"differs from the server emitter: {filename}")
    extra = {p.name for p in FIXTURE_DIR.glob("*.json")} - set(files)
    problems.extend(f"unexpected file: {name}" for name in sorted(extra))
    for problem in problems:
        print(problem)
    print("fixtures OK" if not problems else f"{len(problems)} problem(s); review, then run with --write")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
