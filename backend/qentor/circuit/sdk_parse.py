"""A safe reader for a SMALL documented subset of Qiskit, Cirq and PennyLane programs.

**Python is never executed.** The text is turned into a syntax tree with ``ast.parse`` (which parses; it does not run anything), and the tree
is walked against an explicit allow-list of node shapes. There is no ``eval``, ``exec``, ``compile``, ``__import__``, ``getattr`` or dynamic
attribute lookup anywhere in this module (``tests/test_sdk_parse.py`` checks that by reading this file's own syntax tree). A program is either
read in full or refused with the first unsupported construct named: nothing unknown is skipped, guessed at or "translated".

What is read (everything else is refused, with its line):

Qiskit
    ``from qiskit import QuantumCircuit``; ``qc = QuantumCircuit(n)`` or ``QuantumCircuit(n, m)``; ``qc.h/x/y/z/s/sdg/t/tdg(q)``,
    ``qc.rx/ry/rz(theta, q)``, ``qc.cx/cz(c, t)``, ``qc.cp(theta, c, t)``, ``qc.swap(a, b)``, ``qc.ccx(c1, c2, t)``, ``qc.measure(q, c)``,
    ``qc.measure_all()``, ``qc.barrier()`` (no effect on the state: noted). Qubits are integer literals.
Cirq
    ``import cirq``; ``q = cirq.LineQubit.range(n)`` / ``a, b = cirq.LineQubit.range(2)`` / ``a = cirq.LineQubit(0)``; ``cirq.Circuit(op, ...)`` and
    ``circuit.append(op | [ops])``; operations ``cirq.H/X/Y/Z/S/T(q)``, ``(cirq.S**-1)(q)``, ``cirq.rx/ry/rz(theta)(q)``, ``cirq.CNOT/CX/CZ/SWAP(a, b)``,
    ``cirq.CCX/CCNOT/TOFFOLI(a, b, c)``, ``cirq.cphase(theta)(a, b)``, ``(cirq.CZ**t)(a, b)``, ``cirq.measure(q..., key="c0")``.
PennyLane
    ``import pennylane as qml``; ``dev = qml.device("default.qubit", wires=n)``; one ``def circuit():`` (optionally ``@qml.qnode(dev)``) whose
    statements are ``qml.Hadamard/PauliX/PauliY/PauliZ/S/T(wires=q)``, ``qml.adjoint(qml.S|qml.T)(wires=q)``, ``qml.RX/RY/RZ(theta, wires=q)``,
    ``qml.CNOT/CZ/SWAP(wires=[a, b])``, ``qml.Toffoli(wires=[a, b, c])``, ``qml.ControlledPhaseShift(theta, wires=[c, t])``, ending in
    ``return qml.state()`` or ``return qml.probs/sample/counts(wires=[...])`` (read as measuring those wires).
All three
    Angles are numbers or expressions of numbers with ``pi`` (``pi``, ``math.pi``, ``np.pi``, ``numpy.pi``) and ``+ - * /`` and parentheses, and
    plain numeric assignments (``theta = pi / 4``) of the same.

Refused, with a clear message: loops, conditionals, functions (other than the one PennyLane circuit), classes, comprehensions, lambdas, f-strings,
imports other than the ones above, any call that is not a gate, attribute chains, keyword arguments in qubit positions, starred or computed qubit
indices, registers, parameters, other devices, unknown gates and any gate with the wrong number of arguments.
"""

from __future__ import annotations

import ast
import math
import re
import warnings
from dataclasses import dataclass, field

from pydantic import ValidationError

from .model import Circuit, GateName, GateOp

DIALECTS = ("qiskit", "cirq", "pennylane")
MAX_CODE_CHARS = 20_000
MAX_LINES = 600
MAX_NESTING = 30
MAX_OPERATIONS = 500
MAX_QUBITS = 16
MAX_INDEX = 1_000_000
LABEL = "Safe subset parser — Python is not executed."


@dataclass(frozen=True)
class Problem:
    message: str
    line: int | None = None
    column: int | None = None


class SdkParseError(Exception):
    """The program could not be read. ``problems`` names each unsupported construct (up to five) with its line."""

    def __init__(self, problems: list[Problem]) -> None:
        super().__init__(problems[0].message if problems else "unreadable program")
        self.problems = problems


@dataclass
class SdkParseResult:
    circuit: Circuit
    dialect: str
    notes: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------------------------------------------------- vocabulary

_FRIENDLY = {
    "For": "a for loop",
    "AsyncFor": "an async for loop",
    "While": "a while loop",
    "If": "an if statement",
    "With": "a with block",
    "AsyncWith": "an async with block",
    "Try": "a try block",
    "TryStar": "a try block",
    "FunctionDef": "a function definition",
    "AsyncFunctionDef": "an async function definition",
    "ClassDef": "a class definition",
    "Return": "a return statement",
    "Delete": "a del statement",
    "Global": "a global statement",
    "Nonlocal": "a nonlocal statement",
    "Raise": "a raise statement",
    "Assert": "an assert statement",
    "Pass": "a pass statement",
    "Break": "a break statement",
    "Continue": "a continue statement",
    "Match": "a match statement",
    "AugAssign": "an augmented assignment (+=, -= ...)",
    "AnnAssign": "an annotated assignment",
    "Import": "this import",
    "ImportFrom": "this import",
    "Expr": "this expression",
    "Assign": "this assignment",
    "Lambda": "a lambda",
    "ListComp": "a list comprehension",
    "SetComp": "a set comprehension",
    "DictComp": "a dictionary comprehension",
    "GeneratorExp": "a generator expression",
    "JoinedStr": "an f-string",
    "FormattedValue": "an f-string",
    "Await": "an await",
    "Yield": "a yield",
    "YieldFrom": "a yield from",
    "NamedExpr": "an assignment expression (:=)",
    "Starred": "a starred expression (*)",
    "Dict": "a dictionary",
    "Set": "a set",
    "Compare": "a comparison",
    "BoolOp": "a boolean operation",
    "IfExp": "a conditional expression",
    "Slice": "a slice",
    "Subscript": "an index expression",
    "Attribute": "an attribute access",
    "Call": "a call",
    "Name": "a name",
    "Constant": "a literal",
    "List": "a list",
    "Tuple": "a tuple",
}

_ONE_QUBIT = {"h": GateName.H, "x": GateName.X, "y": GateName.Y, "z": GateName.Z, "s": GateName.S, "sdg": GateName.SDG, "t": GateName.T, "tdg": GateName.TDG}
_ROTATION = {"rx": GateName.RX, "ry": GateName.RY, "rz": GateName.RZ}

SUPPORTED = {
    "qiskit": [
        "from qiskit import QuantumCircuit",
        "qc = QuantumCircuit(n) or QuantumCircuit(n, m)",
        "qc.h/x/y/z/s/sdg/t/tdg(q)",
        "qc.rx/ry/rz(theta, q)",
        "qc.cx/cz(control, target)",
        "qc.cp(theta, control, target)",
        "qc.swap(a, b)",
        "qc.ccx(c1, c2, target)",
        "qc.measure(q, c)",
        "qc.measure_all()",
        "qc.barrier() (no effect on the state)",
    ],
    "cirq": [
        "import cirq",
        "q = cirq.LineQubit.range(n)",
        "a, b = cirq.LineQubit.range(2)",
        "circuit = cirq.Circuit(op, ...)",
        "circuit.append(op or [ops])",
        "cirq.H/X/Y/Z/S/T(q)",
        "(cirq.S**-1)(q), (cirq.T**-1)(q)",
        "cirq.rx/ry/rz(theta)(q)",
        "cirq.CNOT/CX/CZ/SWAP(a, b)",
        "cirq.CCX/CCNOT/TOFFOLI(a, b, c)",
        "cirq.cphase(theta)(a, b)",
        "(cirq.CZ**t)(a, b)",
        'cirq.measure(q..., key="c0")',
    ],
    "pennylane": [
        "import pennylane as qml",
        'dev = qml.device("default.qubit", wires=n)',
        "@qml.qnode(dev) def circuit(): ...",
        "qml.Hadamard/PauliX/PauliY/PauliZ/S/T(wires=q)",
        "qml.adjoint(qml.S) and qml.adjoint(qml.T)",
        "qml.RX/RY/RZ(theta, wires=q)",
        "qml.CNOT/CZ/SWAP(wires=[a, b])",
        "qml.Toffoli(wires=[a, b, c])",
        "qml.ControlledPhaseShift(theta, wires=[c, t])",
        "return qml.state() or qml.probs/sample/counts(wires=[...])",
    ],
}


def _position(node: ast.AST | None) -> tuple[int | None, int | None]:
    if isinstance(node, (ast.stmt, ast.expr, ast.keyword, ast.arg)):
        return node.lineno, node.col_offset
    return None, None


class _Refuse(Exception):
    """Internal: one unsupported construct, with the node it came from."""

    def __init__(self, message: str, node: ast.AST | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.line, self.column = _position(node)


def _what(node: ast.AST) -> str:
    return _FRIENDLY.get(node.__class__.__name__, node.__class__.__name__)


# ------------------------------------------------------------------------------------------------------------------- numbers


class _Numbers:
    """Angles and plain numeric constants: ``number | pi | name | -x | x + y | x - y | x * y | x / y``. Nothing else exists, so nothing else runs."""

    def __init__(self) -> None:
        self.names: dict[str, float] = {}
        self.imported: set[str] = set()  # "pi", "math", "np", "numpy": what the program's own imports made available

    def _is_pi(self, node: ast.AST) -> bool:
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.attr == "pi":
            return node.value.id in ("math", "np", "numpy") and node.value.id in self.imported
        return False

    def value(self, node: ast.AST) -> float:
        if isinstance(node, ast.Constant):
            v = node.value
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise _Refuse(f"only numbers are allowed here, not {v.__class__.__name__} {v!r}" if not isinstance(v, str) else "a string is not a number", node)
            try:
                f = float(v)
            except OverflowError as exc:
                raise _Refuse("that number is too large", node) from exc
            if not math.isfinite(f):
                raise _Refuse("that number is not finite", node)
            return f
        if isinstance(node, ast.Name):
            if node.id in self.names:
                return self.names[node.id]
            if node.id == "pi" and "pi" in self.imported:
                return math.pi
            if node.id == "pi":
                raise _Refuse("unknown name 'pi': import it first, with 'from math import pi'", node)
            raise _Refuse(f"unknown name {node.id!r}: only pi and numbers assigned earlier can be used in an angle", node)
        if self._is_pi(node):
            return math.pi
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.attr == "pi" and node.value.id in ("math", "np", "numpy"):
            raise _Refuse(f"unknown name {node.value.id!r}: import it first (import math, or import numpy as np)", node)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            inner = self.value(node.operand)
            return -inner if isinstance(node.op, ast.USub) else inner
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            a, b = self.value(node.left), self.value(node.right)
            if isinstance(node.op, ast.Add):
                out = a + b
            elif isinstance(node.op, ast.Sub):
                out = a - b
            elif isinstance(node.op, ast.Mult):
                out = a * b
            else:
                if b == 0:
                    raise _Refuse("division by zero", node)
                out = a / b
            if not math.isfinite(out):
                raise _Refuse("the angle is not a finite number", node)
            return out
        if isinstance(node, ast.BinOp):
            raise _Refuse("only + - * / are allowed in an angle (no **, //, % or @)", node)
        raise _Refuse(f"an angle must be a number or an expression of numbers and pi, not {_what(node)}", node)

    def index(self, node: ast.AST, what: str = "a qubit") -> int:
        if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
            if node.value < 0:
                raise _Refuse(f"negative indices are not supported ({node.value})", node)
            if node.value > MAX_INDEX:
                raise _Refuse(f"{what} index {node.value} is far outside any circuit Qentor runs", node)
            return node.value
        if (
            isinstance(node, ast.UnaryOp)
            and isinstance(node.op, ast.USub)
            and isinstance(node.operand, ast.Constant)
            and isinstance(node.operand.value, int)
            and not isinstance(node.operand.value, bool)
        ):
            raise _Refuse(f"negative indices are not supported (-{node.operand.value})", node)
        raise _Refuse(f"{what} must be written as an integer literal, not {_what(node)}", node)

    def assign(self, target: ast.AST, value: ast.AST, node: ast.AST) -> None:
        if not isinstance(target, ast.Name):
            raise _Refuse("only a plain name can be assigned a number", node)
        self.names[target.id] = self.value(value)


# ----------------------------------------------------------------------------------------------------------------------- builder


class _Builder:
    def __init__(self) -> None:
        self.num_qubits: int | None = None
        self.num_clbits = 0
        self.ops: list[GateOp] = []
        self.notes: list[str] = []

    def add(self, gate: GateName, node: ast.AST, *, targets, controls=(), params=(), clbits=()) -> None:  # noqa: ANN001
        if len(self.ops) >= MAX_OPERATIONS:
            raise _Refuse(f"too many operations (at most {MAX_OPERATIONS})", node)
        try:
            op = GateOp(gate=gate, targets=list(targets), controls=list(controls), params=list(params), clbits=list(clbits))
        except ValidationError as exc:
            reason = str(exc.errors()[0]["msg"]).removeprefix("Value error, ") if exc.errors() else "invalid operation"
            raise _Refuse(f"{gate.value}: {reason}", node) from exc
        self.ops.append(op)

    def finish(self, dialect: str, notes: list[str]) -> SdkParseResult:
        if self.num_qubits is None:
            raise SdkParseError([Problem("no circuit was found: " + _NO_CIRCUIT[dialect])])
        try:
            circuit = Circuit(num_qubits=self.num_qubits, num_clbits=self.num_clbits, ops=self.ops)
        except ValidationError as exc:
            reason = str(exc.errors()[0]["msg"]).removeprefix("Value error, ") if exc.errors() else "invalid circuit"
            raise SdkParseError([Problem(reason)]) from exc
        return SdkParseResult(circuit, dialect, [*self.notes, *notes])


_NO_CIRCUIT = {
    "qiskit": "expected a line like qc = QuantumCircuit(2).",
    "cirq": "expected cirq.Circuit(...) or circuit.append(...) with cirq.LineQubit qubits.",
    "pennylane": 'expected a device (dev = qml.device("default.qubit", wires=2)) and a function circuit() with gates.',
}


def _check_qubits(builder: _Builder, qubits: list[int], node: ast.AST) -> None:
    for q in qubits:
        if q >= (builder.num_qubits or 0):
            raise _Refuse(f"qubit {q} is outside the circuit, which has {builder.num_qubits} qubit{'s' if builder.num_qubits != 1 else ''}", node)


# ---------------------------------------------------------------------------------------------------------------------- shared


def _precheck(source: str) -> str:
    if not isinstance(source, str):
        raise SdkParseError([Problem("the code must be text")])
    if "\x00" in source:
        raise SdkParseError([Problem("the code contains a NUL character")])
    if len(source) > MAX_CODE_CHARS:
        raise SdkParseError([Problem(f"the code is too long ({len(source)} characters; at most {MAX_CODE_CHARS})")])
    text = source.replace("\r\n", "\n").replace("\r", "\n")
    if text.count("\n") + 1 > MAX_LINES:
        raise SdkParseError([Problem(f"the code has too many lines (at most {MAX_LINES})")])
    for i, ch in enumerate(text):
        if ord(ch) < 32 and ch not in "\n\t":
            raise SdkParseError([Problem(f"the code contains a control character (U+{ord(ch):04X})")])
    depth = 0
    for ch in text:
        if ch in "([{":
            depth += 1
            if depth > MAX_NESTING:
                raise SdkParseError([Problem(f"the code is nested too deeply (more than {MAX_NESTING} levels of brackets)")])
        elif ch in ")]}":
            depth = max(0, depth - 1)
    return text


def _parse_tree(text: str) -> ast.Module:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return ast.parse(text, mode="exec")
    except SyntaxError as exc:
        raise SdkParseError([Problem(f"not valid Python: {exc.msg}", exc.lineno, exc.offset)]) from exc
    except (RecursionError, MemoryError, ValueError, OverflowError) as exc:
        raise SdkParseError([Problem("the code could not be read (it is too deeply nested or too large)")]) from exc


def _is_docstring(node: ast.stmt) -> bool:
    return isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)


def _no_extras(call: ast.Call, name: str, *, keywords: tuple[str, ...] = ()) -> None:
    for kw in call.keywords:
        if kw.arg is None:
            raise _Refuse(f"{name}: **kwargs are not supported", call)
        if kw.arg not in keywords:
            raise _Refuse(f"{name}: the keyword argument {kw.arg!r} is not supported here", call)
    for arg in call.args:
        if isinstance(arg, ast.Starred):
            raise _Refuse(f"{name}: starred arguments are not supported", call)


def _expect_args(call: ast.Call, name: str, count: int) -> None:
    if len(call.args) != count:
        raise _Refuse(f"{name} takes {count} argument{'s' if count != 1 else ''}, got {len(call.args)}", call)


def _common_imports(node: ast.stmt, nums: _Numbers) -> bool:
    """``import math`` / ``import numpy [as np]`` / ``from math import pi`` / ``from numpy import pi``: only to name pi. Records what became available."""
    if isinstance(node, ast.Import) and len(node.names) == 1:
        a = node.names[0]
        if a.name == "math" and a.asname is None:
            nums.imported.add("math")
            return True
        if a.name == "numpy" and a.asname in (None, "np"):
            nums.imported.add(a.asname or "numpy")
            return True
        return False
    if isinstance(node, ast.ImportFrom) and node.module in ("math", "numpy") and node.level == 0 and len(node.names) == 1:
        if node.names[0].name == "pi" and node.names[0].asname is None:
            nums.imported.add("pi")
            return True
    return False


def _collect(dialect: str, tree: ast.Module, handler) -> list[Problem]:  # noqa: ANN001
    problems: list[Problem] = []
    for stmt in tree.body:
        try:
            handler(stmt)
        except _Refuse as exc:
            problems.append(Problem(exc.message, exc.line, exc.column))
            if len(problems) >= 5:
                break
    return problems


def _unsupported_statement(stmt: ast.stmt, dialect: str) -> _Refuse:
    return _Refuse(f"{_what(stmt)} is not supported: Qentor reads only {_summary(dialect)}, and never runs Python", stmt)


def _summary(dialect: str) -> str:
    return {
        "qiskit": "QuantumCircuit(...) and the gate calls on it",
        "cirq": "cirq.Circuit(...) with cirq gate operations",
        "pennylane": "one device and one circuit function of qml gates",
    }[dialect]


# ------------------------------------------------------------------------------------------------------------------------ Qiskit

_QISKIT_GATES: dict[str, tuple[int, int]] = {  # method -> (angles, qubits)
    **{name: (0, 1) for name in _ONE_QUBIT},
    **{name: (1, 1) for name in _ROTATION},
    "cx": (0, 2),
    "cz": (0, 2),
    "cp": (1, 2),
    "swap": (0, 2),
    "ccx": (0, 3),
}


def _parse_qiskit(tree: ast.Module) -> SdkParseResult:
    nums = _Numbers()
    builder = _Builder()
    state = {"var": None}

    def statement(stmt: ast.stmt) -> None:
        if _is_docstring(stmt) or _common_imports(stmt, nums):
            return
        if isinstance(stmt, ast.ImportFrom):
            if stmt.module == "qiskit" and stmt.level == 0 and len(stmt.names) == 1 and stmt.names[0].name == "QuantumCircuit" and stmt.names[0].asname is None:
                return
            raise _Refuse("only 'from qiskit import QuantumCircuit' (and pi from math or numpy) can be imported", stmt)
        if isinstance(stmt, ast.Import):
            raise _Refuse("only 'from qiskit import QuantumCircuit' (and pi from math or numpy) can be imported", stmt)
        if isinstance(stmt, ast.Assign):
            if len(stmt.targets) != 1:
                raise _Refuse("chained assignment is not supported", stmt)
            target, value = stmt.targets[0], stmt.value
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "QuantumCircuit":
                if state["var"] is not None:
                    raise _Refuse("only one QuantumCircuit can be read", stmt)
                if not isinstance(target, ast.Name):
                    raise _Refuse("the circuit must be assigned to a plain name, like qc = QuantumCircuit(2)", stmt)
                _no_extras(value, "QuantumCircuit")
                if len(value.args) not in (1, 2):
                    raise _Refuse("QuantumCircuit takes the number of qubits and optionally the number of classical bits: QuantumCircuit(n) or QuantumCircuit(n, m)", value)
                n = nums.index(value.args[0], "the number of qubits")
                m = nums.index(value.args[1], "the number of classical bits") if len(value.args) == 2 else 0
                if not 1 <= n <= MAX_QUBITS:
                    raise _Refuse(f"a circuit needs 1 to {MAX_QUBITS} qubits, got {n}", value)
                if m > MAX_QUBITS * 2:
                    raise _Refuse(f"too many classical bits ({m})", value)
                builder.num_qubits, builder.num_clbits, state["var"] = n, m, target.id
                return
            if isinstance(target, ast.Name) and target.id == state["var"]:
                raise _Refuse(f"{target.id!r} is the circuit: it cannot be reassigned", stmt)
            nums.assign(target, value, stmt)
            return
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
            call = stmt.value
            if not (isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)):
                raise _Refuse("only calls on the circuit, like qc.h(0), are supported: Python is not run", stmt)
            if state["var"] is None or call.func.value.id != state["var"]:
                if state["var"] is None:
                    raise _Refuse("the circuit must be created first, with qc = QuantumCircuit(n)", stmt)
                raise _Refuse(f"unknown object {call.func.value.id!r}: only the circuit {state['var']!r} can be used", stmt)
            _qiskit_call(call)
            return
        raise _unsupported_statement(stmt, "qiskit")

    def _qiskit_call(call: ast.Call) -> None:
        method = call.func.attr  # type: ignore[union-attr]
        name = f"{state['var']}.{method}"
        _no_extras(call, name)
        if method == "barrier":
            for arg in call.args:
                q = nums.index(arg)
                _check_qubits(builder, [q], arg)
            builder.notes.append("barrier has no effect on the state and was not kept.")
            return
        if method == "measure_all":
            _expect_args(call, name, 0)
            offset = builder.num_clbits
            n = builder.num_qubits or 0
            if offset + n > 32:
                raise _Refuse("measure_all would need more than 32 classical bits", call)
            builder.num_clbits = offset + n
            for q in range(n):
                builder.add(GateName.MEASURE, call, targets=[q], clbits=[offset + q])
            builder.notes.append(f"measure_all adds {n} classical bit{'s' if n != 1 else ''} (c[{offset}]…c[{offset + n - 1}]) and measures every qubit, as Qiskit does.")
            return
        if method == "measure":
            _expect_args(call, name, 2)
            q, c = nums.index(call.args[0]), nums.index(call.args[1], "a classical bit")
            _check_qubits(builder, [q], call.args[0])
            if c >= builder.num_clbits:
                raise _Refuse(f"classical bit {c} does not exist: declare it with QuantumCircuit({builder.num_qubits}, {max(c + 1, 1)})", call.args[1])
            builder.add(GateName.MEASURE, call, targets=[q], clbits=[c])
            return
        if method not in _QISKIT_GATES:
            raise _Refuse(f"{name} is not a supported gate or method (supported: {', '.join(sorted([*_QISKIT_GATES, 'measure', 'measure_all', 'barrier']))})", call)
        angles, qubits = _QISKIT_GATES[method]
        _expect_args(call, name, angles + qubits)
        params = [nums.value(a) for a in call.args[:angles]]
        qs = [nums.index(a) for a in call.args[angles:]]
        _check_qubits(builder, qs, call)
        if method in _ONE_QUBIT:
            builder.add(_ONE_QUBIT[method], call, targets=qs)
        elif method in _ROTATION:
            builder.add(_ROTATION[method], call, targets=qs, params=params)
        elif method == "cx":
            builder.add(GateName.CX, call, controls=[qs[0]], targets=[qs[1]])
        elif method == "cz":
            builder.add(GateName.CZ, call, controls=[qs[0]], targets=[qs[1]])
        elif method == "cp":
            builder.add(GateName.CP, call, controls=[qs[0]], targets=[qs[1]], params=params)
        elif method == "swap":
            builder.add(GateName.SWAP, call, targets=qs)
        else:  # ccx
            builder.add(GateName.CCX, call, controls=[qs[0], qs[1]], targets=[qs[2]])

    problems = _collect("qiskit", tree, statement)
    if problems:
        raise SdkParseError(problems)
    return builder.finish("qiskit", [])


# -------------------------------------------------------------------------------------------------------------------------- Cirq

_CIRQ_ONE = {"H": GateName.H, "X": GateName.X, "Y": GateName.Y, "Z": GateName.Z, "S": GateName.S, "T": GateName.T}
_CIRQ_TWO = {"CNOT": GateName.CX, "CX": GateName.CX, "CZ": GateName.CZ, "SWAP": GateName.SWAP}
_CIRQ_THREE = {"CCX": GateName.CCX, "CCNOT": GateName.CCX, "TOFFOLI": GateName.CCX}


def _is_cirq_attr(node: ast.AST, names) -> str | None:  # noqa: ANN001
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "cirq" and node.attr in names:
        return node.attr
    return None


def _parse_cirq(tree: ast.Module) -> SdkParseResult:
    nums = _Numbers()
    builder = _Builder()
    qubit_names: dict[str, int] = {}
    qubit_lists: dict[str, int] = {}
    declared: list[int] = []
    circuits: list[str] = []
    pending_measure: list[tuple[int, str | None, ast.AST]] = []
    max_index = [-1]

    def qubit(node: ast.AST) -> int:
        if isinstance(node, ast.Name) and node.id in qubit_names:
            return note_index(qubit_names[node.id], node)
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in qubit_lists:
            idx = nums.index(node.slice)
            if idx >= qubit_lists[node.value.id]:
                raise _Refuse(f"{node.value.id}[{idx}] is outside the {qubit_lists[node.value.id]} qubits it holds", node)
            return note_index(idx, node)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "LineQubit" and isinstance(node.func.value, ast.Name) and node.func.value.id == "cirq":
            _no_extras(node, "cirq.LineQubit")
            _expect_args(node, "cirq.LineQubit", 1)
            return note_index(nums.index(node.args[0]), node)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("NamedQubit", "GridQubit"):
            raise _Refuse(f"cirq.{node.func.attr} is not supported: use cirq.LineQubit", node)
        if isinstance(node, ast.Name):
            raise _Refuse(f"unknown qubit {node.id!r}: define it with cirq.LineQubit.range(n) or cirq.LineQubit(i)", node)
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
            raise _Refuse(f"unknown qubit {node.value.id!r}: define it with cirq.LineQubit.range(n) or cirq.LineQubit(i)", node)
        raise _Refuse(f"a qubit must be a name from cirq.LineQubit, an index like q[0], or cirq.LineQubit(i), not {_what(node)}", node)

    def note_index(i: int, node: ast.AST) -> int:
        if i >= MAX_QUBITS:
            raise _Refuse(f"qubit {i} is beyond the {MAX_QUBITS} qubits Qentor runs", node)
        max_index[0] = max(max_index[0], i)
        return i

    def linequbit_range(call: ast.Call) -> int:
        _no_extras(call, "cirq.LineQubit.range")
        _expect_args(call, "cirq.LineQubit.range", 1)
        n = nums.index(call.args[0], "the number of qubits")
        if not 1 <= n <= MAX_QUBITS:
            raise _Refuse(f"a circuit needs 1 to {MAX_QUBITS} qubits, got {n}", call)
        return n

    def is_range(node: ast.AST) -> bool:
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "range"
            and isinstance(node.func.value, ast.Attribute)
            and node.func.value.attr == "LineQubit"
            and isinstance(node.func.value.value, ast.Name)
            and node.func.value.value.id == "cirq"
        )

    def operation(node: ast.AST) -> None:
        """One cirq operation expression, appended to the circuit."""
        if not isinstance(node, ast.Call):
            raise _Refuse(f"a circuit operation must be a gate applied to qubits, like cirq.H(q[0]), not {_what(node)}", node)
        func = node.func
        # cirq.H(q), cirq.CNOT(a, b), cirq.CCX(a, b, c), cirq.measure(...)
        simple = _is_cirq_attr(func, {*_CIRQ_ONE, *_CIRQ_TWO, *_CIRQ_THREE})
        if simple is not None:
            _no_extras(node, f"cirq.{simple}")
            if simple in _CIRQ_ONE:
                _expect_args(node, f"cirq.{simple}", 1)
                q = qubit(node.args[0])
                builder.add(_CIRQ_ONE[simple], node, targets=[q])
            elif simple in _CIRQ_TWO:
                _expect_args(node, f"cirq.{simple}", 2)
                a, b = qubit(node.args[0]), qubit(node.args[1])
                gate = _CIRQ_TWO[simple]
                if gate is GateName.SWAP:
                    builder.add(gate, node, targets=[a, b])
                else:
                    builder.add(gate, node, controls=[a], targets=[b])
            else:
                _expect_args(node, f"cirq.{simple}", 3)
                a, b, c = (qubit(x) for x in node.args)
                builder.add(GateName.CCX, node, controls=[a, b], targets=[c])
            return
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "cirq" and func.attr == "measure":
            measure(node)
            return
        # cirq.rx(theta)(q), cirq.cphase(theta)(a, b)
        if isinstance(func, ast.Call) and (name := _is_cirq_attr(func.func, {"rx", "ry", "rz", "cphase"})) is not None:
            _no_extras(func, f"cirq.{name}", keywords=("rads",))
            if len(func.args) + len(func.keywords) != 1:
                raise _Refuse(f"cirq.{name} takes one angle", func)
            angle = nums.value(func.args[0] if func.args else func.keywords[0].value)
            _no_extras(node, f"cirq.{name}(...)")
            if name == "cphase":
                _expect_args(node, "cirq.cphase(...)", 2)
                a, b = qubit(node.args[0]), qubit(node.args[1])
                builder.add(GateName.CP, node, controls=[a], targets=[b], params=[angle])
            else:
                _expect_args(node, f"cirq.{name}(...)", 1)
                builder.add(_ROTATION[name], node, targets=[qubit(node.args[0])], params=[angle])
            return
        # (cirq.S**-1)(q), (cirq.T**-1)(q), (cirq.CZ**t)(a, b)
        if isinstance(func, ast.BinOp) and isinstance(func.op, ast.Pow) and (base := _is_cirq_attr(func.left, {"S", "T", "CZ"})) is not None:
            exponent = nums.value(func.right)
            _no_extras(node, f"cirq.{base}**…")
            if base == "CZ":
                _expect_args(node, "(cirq.CZ**t)(...)", 2)
                a, b = qubit(node.args[0]), qubit(node.args[1])
                builder.add(GateName.CP, node, controls=[a], targets=[b], params=[math.pi * exponent])
                return
            if exponent not in (1.0, -1.0):
                raise _Refuse(f"cirq.{base}**{exponent:g} is not supported: only cirq.{base}**-1 (the inverse) and cirq.{base}", node)
            _expect_args(node, f"(cirq.{base}**…)(...)", 1)
            q = qubit(node.args[0])
            gate = {("S", 1.0): GateName.S, ("S", -1.0): GateName.SDG, ("T", 1.0): GateName.T, ("T", -1.0): GateName.TDG}[(base, exponent)]
            builder.add(gate, node, targets=[q])
            return
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "cirq":
            raise _Refuse(f"cirq.{func.attr} is not a supported gate (supported: {', '.join(sorted([*_CIRQ_ONE, *_CIRQ_TWO, *_CIRQ_THREE, 'rx', 'ry', 'rz', 'cphase', 'measure']))})", node)
        raise _Refuse("this call is not a supported cirq gate: Python is not run", node)

    def measure(node: ast.Call) -> None:
        _no_extras(node, "cirq.measure", keywords=("key",))
        key: str | None = None
        for kw in node.keywords:
            if not (isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str)):
                raise _Refuse("the measurement key must be a string literal", kw.value)
            key = kw.value.value
        qubits: list[int] = []
        for arg in node.args:
            qubits.append(qubit(arg))
        if not qubits:
            raise _Refuse("cirq.measure needs at least one qubit", node)
        for q in qubits:
            pending_measure.append((q, key if len(qubits) == 1 else None, node))
            builder.add(GateName.MEASURE, node, targets=[q], clbits=[0])  # clbit fixed up in the second pass, once every key is known

    def op_tree(node: ast.AST) -> None:
        if isinstance(node, (ast.List, ast.Tuple)):
            for element in node.elts:
                if isinstance(element, (ast.List, ast.Tuple)):
                    raise _Refuse("nested lists of operations are not supported", element)
                operation(element)
            return
        operation(node)

    def statement(stmt: ast.stmt) -> None:
        if _is_docstring(stmt) or _common_imports(stmt, nums):
            return
        if isinstance(stmt, ast.Import):
            if len(stmt.names) == 1 and stmt.names[0].name == "cirq" and stmt.names[0].asname is None:
                return
            raise _Refuse("only 'import cirq' (and pi from math or numpy) can be imported", stmt)
        if isinstance(stmt, ast.ImportFrom):
            raise _Refuse("only 'import cirq' (and pi from math or numpy) can be imported", stmt)
        if isinstance(stmt, ast.Assign):
            if len(stmt.targets) != 1:
                raise _Refuse("chained assignment is not supported", stmt)
            target, value = stmt.targets[0], stmt.value
            if is_range(value):
                n = linequbit_range(value)  # type: ignore[arg-type]
                declared.append(n)
                if isinstance(target, ast.Name):
                    qubit_lists[target.id] = n
                    return
                if isinstance(target, ast.Tuple) and all(isinstance(t, ast.Name) for t in target.elts):
                    if len(target.elts) != n:
                        raise _Refuse(f"cirq.LineQubit.range({n}) gives {n} qubits but {len(target.elts)} names are assigned", stmt)
                    for i, t in enumerate(target.elts):
                        qubit_names[t.id] = i  # type: ignore[union-attr]
                    return
                raise _Refuse("assign the qubits to a name or a tuple of names", stmt)
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute) and value.func.attr == "LineQubit" and isinstance(target, ast.Name):
                qubit_names[target.id] = qubit(value)
                return
            if isinstance(value, ast.Tuple) and isinstance(target, ast.Tuple) and len(value.elts) != len(target.elts):
                raise _Refuse(f"{len(target.elts)} names are assigned {len(value.elts)} qubits", stmt)
            if isinstance(value, ast.Tuple) and isinstance(target, ast.Tuple) and len(value.elts) == len(target.elts) and all(isinstance(t, ast.Name) for t in target.elts):
                for t, v in zip(target.elts, value.elts):
                    qubit_names[t.id] = qubit(v)  # type: ignore[union-attr]
                return
            if isinstance(value, ast.Call) and _is_cirq_attr(value.func, {"Circuit"}) is not None:
                if circuits:
                    raise _Refuse("only one cirq.Circuit can be read", stmt)
                if not isinstance(target, ast.Name):
                    raise _Refuse("the circuit must be assigned to a plain name, like circuit = cirq.Circuit(...)", stmt)
                _no_extras(value, "cirq.Circuit")
                circuits.append(target.id)
                for arg in value.args:
                    op_tree(arg)
                return
            if isinstance(target, ast.Name) and target.id in circuits:
                raise _Refuse(f"{target.id!r} is the circuit: it cannot be reassigned", stmt)
            nums.assign(target, value, stmt)
            return
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
            call = stmt.value
            if (
                isinstance(call.func, ast.Attribute)
                and call.func.attr == "append"
                and isinstance(call.func.value, ast.Name)
                and call.func.value.id in circuits
            ):
                _no_extras(call, f"{call.func.value.id}.append")
                _expect_args(call, f"{call.func.value.id}.append", 1)
                op_tree(call.args[0])
                return
            raise _Refuse("only circuit.append(...) calls are supported: Python is not run", stmt)
        raise _unsupported_statement(stmt, "cirq")

    problems = _collect("cirq", tree, statement)
    if problems:
        raise SdkParseError(problems)

    # Qubit count: the largest range declared, or the highest index used.
    builder.num_qubits = max([*declared, max_index[0] + 1]) if (declared or max_index[0] >= 0) else None
    if not circuits and not builder.ops:
        raise SdkParseError([Problem("no circuit was found: " + _NO_CIRCUIT["cirq"])])
    if builder.num_qubits is None:
        raise SdkParseError([Problem("the circuit uses no qubits: " + _NO_CIRCUIT["cirq"])])

    # Classical bits: a single-qubit measurement keyed "c<k>" uses bit k; every other measurement takes the smallest unused bit.
    explicit: dict[int, int] = {}
    for i, (q, key, node) in enumerate(pending_measure):
        m = re.fullmatch(r"c(\d{1,3})", key or "")
        if m:
            bit = int(m.group(1))
            if bit in explicit.values():
                raise SdkParseError([Problem(f"classical bit c{bit} is measured into twice", _position(node)[0])])
            explicit[i] = bit
    used = set(explicit.values())
    assigned: dict[int, int] = dict(explicit)
    next_bit = 0
    for i in range(len(pending_measure)):
        if i in assigned:
            continue
        while next_bit in used:
            next_bit += 1
        assigned[i] = next_bit
        used.add(next_bit)
    measure_positions = [i for i, op in enumerate(builder.ops) if op.gate is GateName.MEASURE]
    for pos, idx in zip(measure_positions, range(len(pending_measure))):
        builder.ops[pos] = GateOp(gate=GateName.MEASURE, targets=builder.ops[pos].targets, clbits=[assigned[idx]])
    builder.num_clbits = (max(assigned.values()) + 1) if assigned else 0
    if builder.num_clbits > 32:
        raise SdkParseError([Problem("a measurement key names a classical bit beyond 31")])
    notes: list[str] = []
    if pending_measure:
        notes.append("Measurement keys are read as classical bits: a single-qubit key c<k> is bit k; any other measurement takes the next free bit.")
    return builder.finish("cirq", notes)


# ---------------------------------------------------------------------------------------------------------------------- PennyLane

_PL_ONE = {"Hadamard": GateName.H, "PauliX": GateName.X, "PauliY": GateName.Y, "PauliZ": GateName.Z, "S": GateName.S, "T": GateName.T}
_PL_ROT = {"RX": GateName.RX, "RY": GateName.RY, "RZ": GateName.RZ}
_PL_TWO = {"CNOT": GateName.CX, "CZ": GateName.CZ, "SWAP": GateName.SWAP}
_PL_THREE = {"Toffoli": GateName.CCX}
_PL_MEASURE = ("state", "probs", "sample", "counts")


def _is_qml(node: ast.AST, names) -> str | None:  # noqa: ANN001
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "qml" and node.attr in names:
        return node.attr
    return None


def _parse_pennylane(tree: ast.Module) -> SdkParseResult:
    nums = _Numbers()
    builder = _Builder()
    notes: list[str] = []
    state: dict[str, object] = {"device": None, "function": None, "returned": False}

    def wires_of(call: ast.Call, name: str, count: int, *, skip_args: int) -> list[int]:
        """The wires of a gate: ``wires=`` keyword, or the positional argument after the parameters."""
        kw = [k for k in call.keywords if k.arg == "wires"]
        positional = call.args[skip_args:]
        if kw and positional:
            raise _Refuse(f"{name}: wires given twice", call)
        if len(kw) > 1:
            raise _Refuse(f"{name}: wires given twice", call)
        if len(positional) > 1:
            raise _Refuse(f"{name}: too many positional arguments (give the wires as wires=[...])", call)
        node = kw[0].value if kw else (positional[0] if positional else None)
        if node is None:
            raise _Refuse(f"{name} needs its wires: {name}(..., wires=...)", call)
        if isinstance(node, (ast.List, ast.Tuple)):
            wires = [nums.index(e, "a wire") for e in node.elts]
        else:
            wires = [nums.index(node, "a wire")]
        if len(wires) != count:
            raise _Refuse(f"{name} acts on {count} wire{'s' if count != 1 else ''}, got {len(wires)}", call)
        _check_qubits(builder, wires, call)
        return wires

    def gate_call(call: ast.Call) -> None:
        func = call.func
        # qml.adjoint(qml.S)(wires=0)
        if isinstance(func, ast.Call) and _is_qml(func.func, {"adjoint"}) is not None:
            if len(func.args) != 1 or func.keywords or (inner := _is_qml(func.args[0], {"S", "T"})) is None:
                raise _Refuse("only qml.adjoint(qml.S) and qml.adjoint(qml.T) are supported", func)
            _no_extras(call, f"qml.adjoint(qml.{inner})", keywords=("wires",))
            (w,) = wires_of(call, f"qml.adjoint(qml.{inner})", 1, skip_args=0)
            builder.add(GateName.SDG if inner == "S" else GateName.TDG, call, targets=[w])
            return
        name = _is_qml(func, {*_PL_ONE, *_PL_ROT, *_PL_TWO, *_PL_THREE, "ControlledPhaseShift"})
        if name is None:
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "qml":
                raise _Refuse(f"qml.{func.attr} is not a supported gate (supported: {', '.join(sorted([*_PL_ONE, *_PL_ROT, *_PL_TWO, *_PL_THREE, 'ControlledPhaseShift']))})", call)
            raise _Refuse("this call is not a supported qml gate: Python is not run", call)
        _no_extras(call, f"qml.{name}", keywords=("wires",))
        if name in _PL_ONE:
            (w,) = wires_of(call, f"qml.{name}", 1, skip_args=0)
            builder.add(_PL_ONE[name], call, targets=[w])
        elif name in _PL_ROT:
            if not call.args:
                raise _Refuse(f"qml.{name} needs its angle first: qml.{name}(theta, wires=q)", call)
            angle = nums.value(call.args[0])
            (w,) = wires_of(call, f"qml.{name}", 1, skip_args=1)
            builder.add(_PL_ROT[name], call, targets=[w], params=[angle])
        elif name in _PL_TWO:
            a, b = wires_of(call, f"qml.{name}", 2, skip_args=0)
            if _PL_TWO[name] is GateName.SWAP:
                builder.add(GateName.SWAP, call, targets=[a, b])
            else:
                builder.add(_PL_TWO[name], call, controls=[a], targets=[b])
        elif name in _PL_THREE:
            a, b, c = wires_of(call, f"qml.{name}", 3, skip_args=0)
            builder.add(GateName.CCX, call, controls=[a, b], targets=[c])
        else:  # ControlledPhaseShift
            if not call.args:
                raise _Refuse("qml.ControlledPhaseShift needs its angle first", call)
            angle = nums.value(call.args[0])
            a, b = wires_of(call, "qml.ControlledPhaseShift", 2, skip_args=1)
            builder.add(GateName.CP, call, controls=[a], targets=[b], params=[angle])

    def measurement(node: ast.AST) -> None:
        if not isinstance(node, ast.Call) or (kind := _is_qml(node.func, _PL_MEASURE)) is None:
            raise _Refuse(f"the circuit must return qml.state() or qml.probs/sample/counts(wires=...), not {_what(node)}", node)
        _no_extras(node, f"qml.{kind}", keywords=("wires",))
        if kind == "state":
            if node.args or node.keywords:
                raise _Refuse("qml.state() takes no arguments", node)
            return
        n = builder.num_qubits or 0
        kw = [k for k in node.keywords if k.arg == "wires"]
        arg = kw[0].value if kw else (node.args[0] if node.args else None)
        if len(node.args) + len(kw) > 1:
            raise _Refuse(f"qml.{kind}: give the wires once", node)
        if arg is None:
            wires = list(range(n))
        elif isinstance(arg, (ast.List, ast.Tuple)):
            wires = [nums.index(e, "a wire") for e in arg.elts]
        else:
            wires = [nums.index(arg, "a wire")]
        if not wires:
            raise _Refuse(f"qml.{kind} needs at least one wire", node)
        if len(set(wires)) != len(wires):
            raise _Refuse(f"qml.{kind}: a wire is listed twice", node)
        _check_qubits(builder, wires, node)
        builder.num_clbits = len(wires)
        for i, w in enumerate(wires):
            builder.add(GateName.MEASURE, node, targets=[w], clbits=[i])
        notes.append(f"qml.{kind}(wires=…) is read as measuring those wires into classical bits 0…{len(wires) - 1} in the order listed.")

    def function_body(fn: ast.FunctionDef) -> None:
        if fn.args.args or fn.args.vararg or fn.args.kwarg or fn.args.kwonlyargs or fn.args.posonlyargs or fn.args.defaults or fn.args.kw_defaults:
            raise _Refuse("the circuit function must take no arguments: def circuit():", fn)
        if fn.returns is not None:
            raise _Refuse("a return annotation is not supported", fn)
        for dec in fn.decorator_list:
            if not (isinstance(dec, ast.Call) and _is_qml(dec.func, {"qnode"}) is not None and len(dec.args) == 1 and not dec.keywords and isinstance(dec.args[0], ast.Name) and dec.args[0].id == state["device"]):
                raise _Refuse("the only supported decorator is @qml.qnode(dev) with the device defined above", dec)
        if state["device"] is None:
            raise _Refuse('define the device first: dev = qml.device("default.qubit", wires=n)', fn)
        body = list(fn.body)
        for i, stmt in enumerate(body):
            try:
                if _is_docstring(stmt):
                    continue
                if state["returned"]:
                    raise _Refuse("nothing may follow the return statement", stmt)
                if isinstance(stmt, ast.Return):
                    if stmt.value is None:
                        raise _Refuse("the circuit must return qml.state() or qml.probs(...)", stmt)
                    measurement(stmt.value)
                    state["returned"] = True
                elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
                    gate_call(stmt.value)
                elif isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                    nums.assign(stmt.targets[0], stmt.value, stmt)
                else:
                    raise _unsupported_statement(stmt, "pennylane")
            except _Refuse as exc:
                problems.append(Problem(exc.message, exc.line, exc.column))
                if len(problems) >= 5:
                    return

    problems: list[Problem] = []

    def statement(stmt: ast.stmt) -> None:
        if _is_docstring(stmt) or _common_imports(stmt, nums):
            return
        if isinstance(stmt, ast.Import):
            if len(stmt.names) == 1 and stmt.names[0].name == "pennylane" and stmt.names[0].asname == "qml":
                return
            raise _Refuse("only 'import pennylane as qml' (and pi from math or numpy) can be imported", stmt)
        if isinstance(stmt, ast.ImportFrom):
            raise _Refuse("only 'import pennylane as qml' (and pi from math or numpy) can be imported", stmt)
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
            target, value = stmt.targets[0], stmt.value
            if isinstance(value, ast.Call) and _is_qml(value.func, {"device"}) is not None:
                if state["device"] is not None:
                    raise _Refuse("only one device can be read", stmt)
                if not isinstance(target, ast.Name):
                    raise _Refuse("the device must be assigned to a plain name, like dev = qml.device(...)", stmt)
                _no_extras(value, "qml.device", keywords=("wires",))
                if not value.args or not (isinstance(value.args[0], ast.Constant) and value.args[0].value == "default.qubit"):
                    raise _Refuse('only the device "default.qubit" is supported', value)
                kw = [k for k in value.keywords if k.arg == "wires"]
                if len(value.args) + len(kw) != 2 or (len(value.args) == 2 and kw):
                    raise _Refuse('qml.device takes the device name and the number of wires: qml.device("default.qubit", wires=2)', value)
                n = nums.index(value.args[1] if len(value.args) == 2 else kw[0].value, "the number of wires")
                if not 1 <= n <= MAX_QUBITS:
                    raise _Refuse(f"a circuit needs 1 to {MAX_QUBITS} wires, got {n}", value)
                builder.num_qubits = n
                state["device"] = target.id
                return
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == state["function"] and state["function"] is not None:
                if value.args or value.keywords:
                    raise _Refuse("the circuit function takes no arguments", value)
                notes.append(f"The call {value.func.id}() was not run: Python is not executed. Qentor read the gates from the function body.")
                return
            nums.assign(target, value, stmt)
            return
        if isinstance(stmt, ast.FunctionDef):
            if state["function"] is not None:
                raise _Refuse("only one circuit function can be read", stmt)
            state["function"] = stmt.name
            function_body(stmt)
            return
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Name) and stmt.value.func.id == state["function"] and state["function"] is not None:
            if stmt.value.args or stmt.value.keywords:
                raise _Refuse("the circuit function takes no arguments", stmt)
            notes.append(f"The call {stmt.value.func.id}() was not run: Python is not executed. Qentor read the gates from the function body.")
            return
        raise _unsupported_statement(stmt, "pennylane")

    problems.extend(_collect("pennylane", tree, statement))
    if problems:
        raise SdkParseError(problems[:5])
    if state["function"] is None:
        raise SdkParseError([Problem("no circuit was found: " + _NO_CIRCUIT["pennylane"])])
    if not state["returned"]:
        raise SdkParseError([Problem("the circuit function must end by returning qml.state() or qml.probs(wires=...)")])
    return builder.finish("pennylane", notes)


# ----------------------------------------------------------------------------------------------------------------------- public


def parse_sdk(source: str, dialect: str) -> SdkParseResult:
    """Read a Qiskit, Cirq or PennyLane program from the safe subset, as a canonical ``Circuit``. Raises ``SdkParseError`` (naming the first
    unsupported constructs) for anything else. Nothing is executed."""
    if dialect not in DIALECTS:
        raise SdkParseError([Problem(f"unknown dialect {dialect!r}; expected one of {', '.join(DIALECTS)}")])
    text = _precheck(source)
    tree = _parse_tree(text)
    if not tree.body:
        raise SdkParseError([Problem("the code is empty")])
    try:
        if dialect == "qiskit":
            return _parse_qiskit(tree)
        if dialect == "cirq":
            return _parse_cirq(tree)
        return _parse_pennylane(tree)
    except RecursionError as exc:  # an expression nested far deeper than any circuit needs: refused, never a crash
        raise SdkParseError([Problem("an expression is nested too deeply to read")]) from exc
