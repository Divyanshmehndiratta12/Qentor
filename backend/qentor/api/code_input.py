"""``POST /api/circuit/parse-code``: read pasted OpenQASM 3, Qiskit, Cirq or PennyLane text into the canonical circuit.

The text is NEVER executed. OpenQASM goes through the server's own statement parser (``qentor.circuit.qasm_parse``); the three Python dialects go
through ``qentor.circuit.sdk_parse``, which parses the text into a syntax tree and reads only an allow-listed subset of it. A program that uses anything
else is refused with the first unsupported constructs named, and nothing is guessed. The response carries the canonical circuit, its OpenQASM 3 and hash
and any notes (for example that a barrier was not kept); it never carries a result, and it never inserts anything: the client previews it and the learner
chooses to put it in the Lab.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit
from qentor.circuit.qasm import to_qasm3
from qentor.circuit.qasm_parse import QasmParseError, parse_qasm3
from qentor.circuit.sdk_parse import LABEL, MAX_CODE_CHARS, SUPPORTED, SdkParseError, parse_sdk
from qentor.execution.limits import MAX_OPERATIONS

from .classroom import client_key, enforce_limit

router = APIRouter(prefix="/api")

CODE_NOT_SUPPORTED = "CODE_NOT_SUPPORTED"


class ParseCodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dialect: Literal["openqasm", "qiskit", "cirq", "pennylane"]
    code: str = Field(max_length=MAX_CODE_CHARS * 2)


class ParseCodeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["PARSED"] = "PARSED"
    dialect: str
    label: str
    circuit: Circuit
    circuit_hash: str
    canonical_qasm: str
    notes: list[str]


@router.post("/circuit/parse-code", response_model=ParseCodeResponse)
def parse_code(request: ParseCodeRequest, http: Request) -> ParseCodeResponse:
    enforce_limit("parse_code", client_key(http))

    def refuse(problems: list[dict], message: str) -> HTTPException:
        return HTTPException(
            status_code=422,
            detail={
                "code": CODE_NOT_SUPPORTED,
                "message": message,
                "problems": problems,
                "supported": SUPPORTED.get(request.dialect, ["a subset of OpenQASM 3: see the OpenQASM tab"]),
                "label": LABEL,
            },
        )

    notes: list[str] = []
    try:
        if request.dialect == "openqasm":
            circuit = parse_qasm3(request.code)
        else:
            parsed = parse_sdk(request.code, request.dialect)
            circuit, notes = parsed.circuit, parsed.notes
    except QasmParseError as exc:
        raise refuse([{"line": exc.line, "column": None, "message": exc.message}], exc.message) from exc
    except SdkParseError as exc:
        raise refuse([{"line": p.line, "column": p.column, "message": p.message} for p in exc.problems], exc.problems[0].message if exc.problems else "unsupported code") from exc

    if len(circuit.ops) > MAX_OPERATIONS:
        raise refuse([{"line": None, "column": None, "message": f"too many operations ({len(circuit.ops)}; at most {MAX_OPERATIONS})"}], "too many operations")
    return ParseCodeResponse(
        dialect=request.dialect,
        label=LABEL,
        circuit=circuit,
        circuit_hash=circuit_hash(circuit),
        canonical_qasm=to_qasm3(circuit),
        notes=notes,
    )
