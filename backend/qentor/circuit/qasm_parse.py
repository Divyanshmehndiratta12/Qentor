"""A parser from OpenQASM 3 text to the canonical circuit model, for a fixed subset.

This is how code enters Qentor (CLAUDE.md: "Code enters only as OpenQASM 3 parsed into the canonical model"). It is a parser,
never an interpreter: it reads statements one at a time, recognises a short list of known shapes, and builds a validated
``Circuit``. There is no ``eval``, no ``exec``, no import, no file access, and nothing in the text can name or run Python. Angle
expressions are read by a tiny recursive-descent reader that knows only numbers, ``pi``, ``+ - * /`` and parentheses.

What it accepts, so a person or a language model can write ordinary OpenQASM 3 and still land in the same canonical circuit the
emitter (``qentor.circuit.qasm.to_qasm3``) would print:

* an optional ``OPENQASM 3;`` / ``OPENQASM 3.0;`` line and ``include "stdgates.inc";`` (no other include);
* ``//`` and ``/* */`` comments, any whitespace and any number of statements per line;
* ONE quantum register: ``qubit[n] name;`` / ``qubit name;`` / ``qreg name[n];``, and at most one classical register:
  ``bit[n] name;`` / ``bit name;`` / ``creg name[n];`` (the register names are free);
* gates ``h x y z s sdg t tdg``, ``rx ry rz`` (one angle), ``cx cz`` (control, target), ``cp`` (angle, control, target), ``swap``,
  ``ccx`` (two controls, target); ``cnot`` and ``toffoli`` are accepted as names for ``cx`` and ``ccx``;
* a single-qubit gate on a whole register (``h q;``) means that gate on every qubit, in index order;
* measurement as ``c[i] = measure q[j];``, ``measure q[j] -> c[i];``, or whole-register ``c = measure q;`` / ``measure q -> c;``.

Everything else is refused with the line it is on and a reason: gate definitions, loops, ``if``, ``reset``, ``barrier``, ``input``,
timing, classical expressions, a second register, an operand out of range, a gate Qentor's model does not have (``u3``, ``p``,
``cy`` ...). Nothing is guessed or dropped silently, because a dropped statement would change what the circuit does.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from pydantic import ValidationError

from .model import Circuit, GateName, GateOp

MAX_TEXT_CHARS = 20_000
MAX_STATEMENTS = 2_000


class QasmParseError(ValueError):
    """The text is not in the supported subset. ``line`` is 1-based (``None`` when the problem is the text as a whole)."""

    def __init__(self, message: str, line: int | None = None, text: str = "") -> None:
        super().__init__(f"line {line}: {message}" if line is not None else message)
        self.message = message
        self.line = line
        self.text = text


_SINGLE_QUBIT = {name: GateName(name) for name in ("h", "x", "y", "z", "s", "sdg", "t", "tdg")}
_ROTATION = {name: GateName(name) for name in ("rx", "ry", "rz")}
_NAME_ALIASES = {"cnot": "cx", "toffoli": "ccx"}

_UNSUPPORTED_KEYWORDS = {
    "gate": "gate definitions are not supported",
    "def": "subroutines are not supported",
    "for": "loops are not supported",
    "while": "loops are not supported",
    "if": "classical control is not supported (the circuit model has no classical control)",
    "else": "classical control is not supported",
    "reset": "reset is not supported (the circuit model has no reset)",
    "barrier": "barriers are not supported",
    "input": "inputs are not supported",
    "output": "outputs are not supported",
    "const": "classical declarations are not supported",
    "int": "classical variables are not supported",
    "uint": "classical variables are not supported",
    "float": "classical variables are not supported",
    "angle": "classical variables are not supported",
    "bool": "classical variables are not supported",
    "let": "aliases are not supported",
    "delay": "timing is not supported",
    "box": "timing is not supported",
    "pragma": "pragmas are not supported",
    "defcal": "pulse calibration is not supported",
    "cal": "pulse calibration is not supported",
    "opaque": "opaque gates are not supported",
    "ctrl": "gate modifiers are not supported",
    "inv": "gate modifiers are not supported",
    "pow": "gate modifiers are not supported",
    "negctrl": "gate modifiers are not supported",
    "gphase": "global phase statements are not supported",
}

_IDENT = r"[A-Za-z_][A-Za-z_0-9]*"
_RE_VERSION = re.compile(r"^OPENQASM\s+(\d+(?:\.\d+)?)$")
_RE_INCLUDE = re.compile(r'^include\s+"([^"]*)"$')
_RE_QUBIT_DECL = re.compile(rf"^qubit(?:\s*\[\s*(\d+)\s*\])?\s+({_IDENT})$")
_RE_BIT_DECL = re.compile(rf"^bit(?:\s*\[\s*(\d+)\s*\])?\s+({_IDENT})$")
_RE_QREG = re.compile(rf"^qreg\s+({_IDENT})\s*\[\s*(\d+)\s*\]$")
_RE_CREG = re.compile(rf"^creg\s+({_IDENT})\s*\[\s*(\d+)\s*\]$")
_RE_OPERAND = re.compile(rf"^({_IDENT})(?:\s*\[\s*(\d+)\s*\])?$")
_RE_MEASURE_ASSIGN = re.compile(r"^(.+?)\s*=\s*measure\s+(.+)$")
_RE_MEASURE_ARROW = re.compile(r"^measure\s+(.+?)\s*->\s*(.+)$")
_RE_GATE = re.compile(rf"^({_IDENT})\s*(?:\((.*)\))?\s+(.+)$", re.DOTALL)


@dataclass(frozen=True)
class _Statement:
    line: int
    text: str


def _split_statements(text: str) -> list[_Statement]:
    """Comments removed, then ``;``-terminated statements with the line each starts on. A ``{`` or ``}`` is refused here: every
    block construct (gate definition, loop, ``if``) needs one, and none is supported."""
    out: list[_Statement] = []
    buf: list[str] = []
    started = False
    start_line = 1
    line = 1
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "/" and text[i : i + 2] == "//":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and text[i : i + 2] == "/*":
            end = text.find("*/", i + 2)
            if end == -1:
                raise QasmParseError("a /* comment is never closed", line)
            line += text.count("\n", i, end + 2)
            i = end + 2
            buf.append(" ")
            continue
        if ch in "{}":
            raise QasmParseError("blocks ({ }) are not supported: gate definitions, loops and if statements cannot be used", line)
        if ch == "\n":
            line += 1
            buf.append(" ")
            i += 1
            continue
        if ch == ";":
            statement = " ".join("".join(buf).split())
            if statement:
                out.append(_Statement(start_line, statement))
            buf = []
            started = False
            i += 1
            continue
        if not started and not ch.isspace():
            started = True
            start_line = line
        buf.append(ch)
        i += 1
    if started:
        raise QasmParseError("the last statement is missing its ';'", start_line, " ".join("".join(buf).split()))
    if len(out) > MAX_STATEMENTS:
        raise QasmParseError(f"too many statements ({len(out)}; at most {MAX_STATEMENTS})")
    return out


# ------------------------------------------------------------------------------------------------ angle expressions

_NUM = re.compile(r"\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?")


class _AngleReader:
    """``expr := term (('+'|'-') term)*``, ``term := factor (('*'|'/') factor)*``, ``factor := ('+'|'-') factor | atom``,
    ``atom := number | pi | π | '(' expr ')'``. Nothing else exists, so nothing else can be evaluated."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def _skip(self) -> None:
        while self.pos < len(self.text) and self.text[self.pos].isspace():
            self.pos += 1

    def _peek(self) -> str:
        self._skip()
        return self.text[self.pos] if self.pos < len(self.text) else ""

    def read(self) -> float:
        value = self._expr()
        if self._peek() != "":
            raise ValueError(f"unexpected {self.text[self.pos:self.pos + 8]!r}")
        if not math.isfinite(value):
            raise ValueError("the angle is not a finite number")
        return value

    def _expr(self) -> float:
        value = self._term()
        while self._peek() in ("+", "-"):
            op = self._peek()
            self.pos += 1
            rhs = self._term()
            value = value + rhs if op == "+" else value - rhs
        return value

    def _term(self) -> float:
        value = self._factor()
        while self._peek() in ("*", "/"):
            op = self._peek()
            if op == "*" and self.text[self.pos : self.pos + 2] == "**":
                raise ValueError("powers (**) are not supported")
            self.pos += 1
            rhs = self._factor()
            if op == "/" and rhs == 0:
                raise ValueError("division by zero")
            value = value * rhs if op == "*" else value / rhs
        return value

    def _factor(self) -> float:
        ch = self._peek()
        if ch in ("+", "-"):
            self.pos += 1
            inner = self._factor()
            return inner if ch == "+" else -inner
        return self._atom()

    def _atom(self) -> float:
        ch = self._peek()
        if ch == "(":
            self.pos += 1
            value = self._expr()
            if self._peek() != ")":
                raise ValueError("a '(' is never closed")
            self.pos += 1
            return value
        match = _NUM.match(self.text, self.pos)
        if match:
            self.pos = match.end()
            return float(match.group(0))
        for name in ("pi", "π"):
            if self.text.startswith(name, self.pos):
                end = self.pos + len(name)
                if end < len(self.text) and (self.text[end].isalnum() or self.text[end] == "_"):
                    break
                self.pos = end
                return math.pi
        raise ValueError(f"cannot read {self.text[self.pos:self.pos + 10]!r} as a number")


def read_angle(text: str) -> float:
    """The value of an angle expression such as ``1.5707963``, ``pi/2`` or ``-3*pi/4``. Raises ``ValueError``."""
    if not text.strip():
        raise ValueError("an angle is needed")
    return _AngleReader(text).read()


# ------------------------------------------------------------------------------------------------------------ parser


class _Registers:
    def __init__(self) -> None:
        self.qname: str | None = None
        self.qsize = 0
        self.cname: str | None = None
        self.csize = 0


def _operand(text: str, regs: _Registers, st: _Statement, *, quantum: bool) -> tuple[str, int | None]:
    """``(register, index)`` for ``q[2]`` or ``(register, None)`` for a bare register, checked against the declaration."""
    match = _RE_OPERAND.match(text.strip())
    if not match:
        raise QasmParseError(f"cannot read {text.strip()!r} as a qubit or bit operand", st.line, st.text)
    name, index = match.group(1), match.group(2)
    want = regs.qname if quantum else regs.cname
    size = regs.qsize if quantum else regs.csize
    kind = "qubit" if quantum else "classical bit"
    if want is None:
        raise QasmParseError(f"{name!r} is used before any {kind} register is declared", st.line, st.text)
    if name != want:
        raise QasmParseError(f"{name!r} is not the declared {kind} register {want!r}", st.line, st.text)
    if index is None:
        return name, None
    i = int(index)
    if i >= size:
        raise QasmParseError(f"{name}[{i}] is out of range: the register has {size} {kind}{'s' if size != 1 else ''}", st.line, st.text)
    return name, i


def _expand(text: str, regs: _Registers, st: _Statement, *, quantum: bool) -> list[int]:
    """The indices an operand names: one for ``q[i]``, all of them for a bare register."""
    _, index = _operand(text, regs, st, quantum=quantum)
    if index is not None:
        return [index]
    return list(range(regs.qsize if quantum else regs.csize))


def _split_operands(text: str) -> list[str]:
    return [part for part in (p.strip() for p in text.split(",")) if part != ""] if text.strip() else []


def _reason(exc: ValueError) -> str:
    """The one-line reason inside a pydantic ``ValidationError`` (or a plain ``ValueError``'s own text)."""
    if isinstance(exc, ValidationError) and exc.errors():
        return str(exc.errors()[0]["msg"]).removeprefix("Value error, ")
    return str(exc).splitlines()[0] if str(exc) else "invalid operation"


def _make_op(gate: GateName, st: _Statement, **fields) -> GateOp:
    try:
        return GateOp(gate=gate, **fields)
    except ValueError as exc:  # a pydantic ValidationError is a ValueError
        raise QasmParseError(_reason(exc), st.line, st.text) from exc


def parse_qasm3(text: str) -> Circuit:
    """Parse OpenQASM 3 text (the subset in this module's docstring) into a canonical ``Circuit``. Raises ``QasmParseError``."""
    if not isinstance(text, str):
        raise QasmParseError("the program must be text")
    if len(text) > MAX_TEXT_CHARS:
        raise QasmParseError(f"the program is too long ({len(text)} characters; at most {MAX_TEXT_CHARS})")
    statements = _split_statements(text)
    if not statements:
        raise QasmParseError("the program is empty")

    regs = _Registers()
    ops: list[GateOp] = []

    for st in statements:
        s = st.text
        first = re.match(r"[A-Za-z_]\w*", s)
        word = first.group(0) if first else ""

        version = _RE_VERSION.match(s)
        if version:
            if version.group(1) not in ("3", "3.0"):
                raise QasmParseError(f"only OpenQASM 3 is supported (this is version {version.group(1)})", st.line, s)
            continue
        include = _RE_INCLUDE.match(s)
        if include:
            if include.group(1) != "stdgates.inc":
                raise QasmParseError(f'only include "stdgates.inc" is supported, not "{include.group(1)}"', st.line, s)
            continue

        qubit_decl = _RE_QUBIT_DECL.match(s)
        qreg = _RE_QREG.match(s)
        bit_decl = _RE_BIT_DECL.match(s)
        creg = _RE_CREG.match(s)
        if qubit_decl or qreg:
            if regs.qname is not None:
                raise QasmParseError("only one qubit register is supported", st.line, s)
            if qreg:
                regs.qname, regs.qsize = qreg.group(1), int(qreg.group(2))
            else:
                assert qubit_decl is not None
                regs.qname, regs.qsize = qubit_decl.group(2), int(qubit_decl.group(1)) if qubit_decl.group(1) is not None else 1
            if not 1 <= regs.qsize <= 32:
                raise QasmParseError(f"a qubit register has 1 to 32 qubits, not {regs.qsize}", st.line, s)
            continue
        if bit_decl or creg:
            if regs.cname is not None:
                raise QasmParseError("only one classical register is supported", st.line, s)
            if creg:
                regs.cname, regs.csize = creg.group(1), int(creg.group(2))
            else:
                assert bit_decl is not None
                regs.cname, regs.csize = bit_decl.group(2), int(bit_decl.group(1)) if bit_decl.group(1) is not None else 1
            if not 0 <= regs.csize <= 32:
                raise QasmParseError(f"a classical register has 0 to 32 bits, not {regs.csize}", st.line, s)
            continue

        if word in _UNSUPPORTED_KEYWORDS:
            raise QasmParseError(_UNSUPPORTED_KEYWORDS[word], st.line, s)

        # measurement, in either spelling
        assign = _RE_MEASURE_ASSIGN.match(s)
        arrow = _RE_MEASURE_ARROW.match(s)
        if assign or arrow:
            if assign:
                target_text, source_text = assign.group(1), assign.group(2)
                if re.match(r"^(?:bit|creg)\b", target_text.strip()):
                    raise QasmParseError("declare the classical register on its own line, then assign the measurement", st.line, s)
            else:
                source_text, target_text = arrow.group(1), arrow.group(2)  # type: ignore[union-attr]
            if regs.csize == 0:
                raise QasmParseError("measure needs a classical register (declare one, for example bit[2] c;)", st.line, s)
            qs = _expand(source_text, regs, st, quantum=True)
            cs = _expand(target_text, regs, st, quantum=False)
            if len(qs) != len(cs):
                raise QasmParseError(f"cannot measure {len(qs)} qubit{'s' if len(qs) != 1 else ''} into {len(cs)} classical bit{'s' if len(cs) != 1 else ''}", st.line, s)
            for q, c in zip(qs, cs):
                ops.append(_make_op(GateName.MEASURE, st, targets=[q], clbits=[c]))
            continue

        gate_match = _RE_GATE.match(s)
        if not gate_match:
            raise QasmParseError("this statement is not in the supported OpenQASM 3 subset", st.line, s)
        name = _NAME_ALIASES.get(gate_match.group(1), gate_match.group(1))
        arg_text, operand_text = gate_match.group(2), gate_match.group(3)
        operands = _split_operands(operand_text)

        def angle() -> list[float]:
            if arg_text is None:
                raise QasmParseError(f"{name} needs one angle, for example {name}(pi/2)", st.line, s)
            parts = [p for p in arg_text.split(",")]
            if len(parts) != 1:
                raise QasmParseError(f"{name} takes exactly one angle", st.line, s)
            try:
                return [read_angle(parts[0])]
            except ValueError as exc:
                raise QasmParseError(f"bad angle {parts[0].strip()!r}: {exc}", st.line, s) from exc

        def no_angle() -> None:
            if arg_text is not None:
                raise QasmParseError(f"{name} takes no angle", st.line, s)

        if name in _SINGLE_QUBIT or name in _ROTATION:
            params = angle() if name in _ROTATION else (no_angle() or [])
            if len(operands) != 1:
                raise QasmParseError(f"{name} acts on exactly one qubit (or one whole register)", st.line, s)
            for q in _expand(operands[0], regs, st, quantum=True):
                ops.append(_make_op(_SINGLE_QUBIT.get(name) or _ROTATION[name], st, targets=[q], params=list(params)))
        elif name in ("cx", "cz", "cp", "swap", "ccx"):
            params = angle() if name == "cp" else (no_angle() or [])
            need = {"cx": 2, "cz": 2, "cp": 2, "swap": 2, "ccx": 3}[name]
            if len(operands) != need:
                raise QasmParseError(f"{name} takes {need} qubit operands, got {len(operands)}", st.line, s)
            idx: list[int] = []
            for operand in operands:
                _, i = _operand(operand, regs, st, quantum=True)
                if i is None:
                    raise QasmParseError(f"{name} needs single qubits such as q[0], not a whole register", st.line, s)
                idx.append(i)
            if name == "swap":
                ops.append(_make_op(GateName.SWAP, st, targets=[idx[0], idx[1]]))
            elif name == "ccx":
                ops.append(_make_op(GateName.CCX, st, controls=[idx[0], idx[1]], targets=[idx[2]]))
            else:
                ops.append(_make_op(GateName(name), st, controls=[idx[0]], targets=[idx[1]], params=list(params)))
        else:
            raise QasmParseError(f"unknown or unsupported gate {gate_match.group(1)!r}", st.line, s)

    if regs.qname is None:
        raise QasmParseError('there is no qubit declaration (for example "qubit[2] q;")', 1)
    try:
        return Circuit(num_qubits=regs.qsize, num_clbits=regs.csize, ops=ops)
    except ValueError as exc:  # pragma: no cover - every operand was range-checked above
        raise QasmParseError(_reason(exc)) from exc
