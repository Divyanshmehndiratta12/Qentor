"""Grounded circuit generation (docs/AI_BOUNDARY.md): a language model PROPOSES OpenQASM 3, the backend decides everything else.

The path, and who is in charge at each step:

1. ``build_context`` assembles what the model may see: the lesson the learner is in and the challenge's PUBLIC brief (goal,
   gates, size; never a reference solution or a target), and the learner's current circuit as the server's own canonical text.
   None of it is a result, and the model is told so.
2. The model (``LLMAdapter.generate_circuit``) returns OpenQASM 3 text and a short explanation. Both are untrusted.
3. The text is read by the server's own parser (``qentor.circuit.qasm_parse``): a subset, never executed, never Python. A proposal
   the parser refuses is REJECTED with the line and the reason. A parsed proposal is checked against the platform's size limits
   and the gates the Aer backend runs. What the learner is shown and may insert is the CANONICAL text emitted from the parsed
   circuit, not the model's own text, so comments, spelling and any surprise in the original are gone.
4. The explanation goes through the existing claim guard (``qentor.tutor.claims``) against the one fact the backend has about the
   proposal: its structure. A probability, amplitude, count, outcome or verdict in it is a claim no backend produced, so the whole
   explanation is discarded and replaced by a template written from the parsed circuit, and the response says so.

A proposal is never "correct" because the model wrote it. The response carries ``verification_status = UNVERIFIED_AGAINST_INTENT``
and the label the UI must show; whether the circuit does what the learner meant is decided only by running it on the backend
(the Lab's Run) and, for a challenge, by submitting it to the server's evaluator. This module executes nothing and writes no
provenance record; the dependency direction (tutor -> verification -> execution -> circuit) is unchanged.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from qentor.challenges import PublicChallenge
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.circuit.qasm import to_qasm3
from qentor.circuit.qasm_parse import MAX_TEXT_CHARS, QasmParseError, parse_qasm3
from qentor.execution.capabilities import UnsupportedGate, check_gate_support
from qentor.execution.limits import LimitExceeded, check_run_limits

from .claims import find_violations
from .llm import CircuitDraft
from .models import TutorFact

PROPOSAL_LABEL = "AI proposal — not yet verified against your intent"
VERIFICATION_STATUS = "UNVERIFIED_AGAINST_INTENT"
MAX_PROMPT_CHARS = 600
MAX_PROPOSAL_QUBITS = 8
MAX_PROPOSAL_OPERATIONS = 60
MAX_EXPLANATION_CHARS = 600
# What the server hands back as "the model's text", bounded so a runaway reply cannot become a runaway response.
MAX_RAW_CHARS = 4_000

PARSE_ERROR = "QASM_PARSE_ERROR"
EMPTY_PROPOSAL = "PROPOSAL_EMPTY"
TOO_LARGE = "PROPOSAL_TOO_LARGE"
UNSUPPORTED = "PROPOSAL_UNSUPPORTED_GATE"


class Problem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    line: int | None = None


class Proposal(BaseModel):
    """The server's reading of one model draft. ``circuit`` and everything derived from it exist only when ``status`` is
    ``PROPOSED``; a ``REJECTED`` proposal carries the problems and the model's own text for transparency, and cannot be inserted."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["PROPOSED", "REJECTED"]
    raw_qasm: str
    problems: list[Problem] = []
    circuit: Circuit | None = None
    canonical_qasm: str | None = None
    circuit_hash: str | None = None
    summary: str | None = None
    explanation: str | None = None
    explanation_source: Literal["AI", "TEMPLATE"] | None = None
    explanation_note: str | None = None
    constraint_notes: list[str] = []


# ------------------------------------------------------------------------------------------------------ the summary


def describe_op(op: GateOp) -> str:
    """``h on q[0]`` / ``cx control q[0], target q[1]`` / ``ry(1.5708) on q[1]``: structure only, never an effect."""
    q = lambda i: f"q[{i}]"  # noqa: E731
    gate = op.gate
    if gate is GateName.MEASURE:
        return f"measure {q(op.targets[0])} into c[{op.clbits[0]}]"
    if gate is GateName.SWAP:
        return f"swap {q(op.targets[0])} and {q(op.targets[1])}"
    if gate in (GateName.CX, GateName.CZ):
        return f"{gate.value} control {q(op.controls[0])}, target {q(op.targets[0])}"
    if gate is GateName.CP:
        return f"cp({op.params[0]!r}) control {q(op.controls[0])}, target {q(op.targets[0])}"
    if gate is GateName.CCX:
        return f"ccx controls {q(op.controls[0])}, {q(op.controls[1])}, target {q(op.targets[0])}"
    if op.params:
        return f"{gate.value}({op.params[0]!r}) on {q(op.targets[0])}"
    return f"{gate.value} on {q(op.targets[0])}"


def summarise(circuit: Circuit) -> str:
    """The one fact the backend has about a proposal before anything runs. It deliberately uses none of the verdict words."""
    qubits = f"{circuit.num_qubits} qubit{'s' if circuit.num_qubits != 1 else ''}"
    count = f"{len(circuit.ops)} operation{'s' if len(circuit.ops) != 1 else ''}"
    return f"The proposal uses {qubits} and {count}, in this order: {'; '.join(describe_op(op) for op in circuit.ops)}."


# ----------------------------------------------------------------------------------------------------- the context


def build_context(
    *,
    lesson_facts: list[TutorFact] | None = None,
    challenge: PublicChallenge | None = None,
    current: Circuit | None = None,
) -> list[TutorFact]:
    """The facts the model may see. Only the challenge's PUBLIC view is ever passed in, so a reference solution or a check target
    cannot reach the prompt, and ``current`` is shown as the server's own canonical text."""
    facts: list[TutorFact] = list(lesson_facts or [])
    if challenge is not None:
        gates = ", ".join(sorted(g.value for g in challenge.constraints.allowed_gates))
        facts.append(TutorFact(id="C1", kind="challenge_goal", description=f"challenge “{challenge.title}”: {challenge.goal}"))
        facts.append(
            TutorFact(
                id="C2",
                kind="challenge_goal",
                description=(
                    f"the challenge uses exactly {challenge.constraints.num_qubits} qubits, the gates {gates}, "
                    f"and at most {challenge.constraints.max_ops} operations"
                ),
            )
        )
    if current is not None and current.ops:
        facts.append(
            TutorFact(id="G1", kind="circuit_summary", description="the learner's current circuit, as OpenQASM 3:\n" + to_qasm3(current))
        )
    return facts


# ---------------------------------------------------------------------------------------------------- validation


def _constraint_notes(circuit: Circuit, challenge: PublicChallenge | None) -> list[str]:
    """Plain notes when a proposal does not fit the challenge's public constraints. They are NOT a verdict on the challenge:
    that comes only from submitting the circuit to the server's evaluator."""
    if challenge is None:
        return []
    rules = challenge.constraints
    notes: list[str] = []
    if circuit.num_qubits != rules.num_qubits:
        notes.append(f"This challenge uses exactly {rules.num_qubits} qubits; the proposal has {circuit.num_qubits}.")
    outside = sorted({op.gate.value for op in circuit.ops if op.gate not in set(rules.allowed_gates)})
    if outside:
        notes.append(f"Gates not allowed in this challenge: {', '.join(outside)}.")
    if len(circuit.ops) > rules.max_ops:
        notes.append(f"This challenge allows at most {rules.max_ops} operations; the proposal has {len(circuit.ops)}.")
    return notes


def _explanation(draft_text: str, circuit: Circuit, summary: str) -> tuple[str, Literal["AI", "TEMPLATE"], str | None]:
    """The model's explanation if the claim guard finds nothing in it the backend did not produce; the template otherwise."""
    text = draft_text.strip() if isinstance(draft_text, str) else ""
    template = (
        f"{summary} It has not been run: the server only read it. Use Run to see what the backend computes for it, "
        "and compare that with what you meant."
    )
    if not text:
        return template, "TEMPLATE", "The model gave no explanation, so this one was written from the parsed circuit."
    if len(text) > MAX_EXPLANATION_CHARS:
        return template, "TEMPLATE", "The model's explanation was too long, so this one was written from the parsed circuit."
    facts = [TutorFact(id="P1", kind="circuit_summary", description=summary)]
    violations = find_violations(text, facts)
    if violations:
        return (
            template,
            "TEMPLATE",
            "The model's explanation was discarded because it made a claim the backend has not computed "
            f"({violations[0].claim!r}); this one was written from the parsed circuit.",
        )
    return text, "AI", None


def validate_draft(draft: CircuitDraft, challenge: PublicChallenge | None = None) -> Proposal:
    """The server's decision about one draft. Never raises for a bad draft: a bad draft is a ``REJECTED`` proposal."""
    raw = draft.qasm[:MAX_RAW_CHARS] if isinstance(draft.qasm, str) else ""

    def rejected(*problems: Problem) -> Proposal:
        return Proposal(status="REJECTED", raw_qasm=raw, problems=list(problems))

    if not raw.strip():
        return rejected(Problem(code=EMPTY_PROPOSAL, message="The model returned no program."))
    if len(draft.qasm) > MAX_TEXT_CHARS:
        return rejected(Problem(code=PARSE_ERROR, message=f"The program is too long to read ({len(draft.qasm)} characters)."))
    try:
        circuit = parse_qasm3(draft.qasm)
    except QasmParseError as exc:
        return rejected(Problem(code=PARSE_ERROR, message=exc.message, line=exc.line))
    if not circuit.ops:
        return rejected(Problem(code=EMPTY_PROPOSAL, message="The program declares qubits but applies no gates."))
    if circuit.num_qubits > MAX_PROPOSAL_QUBITS or len(circuit.ops) > MAX_PROPOSAL_OPERATIONS:
        return rejected(
            Problem(
                code=TOO_LARGE,
                message=(
                    f"Proposals are limited to {MAX_PROPOSAL_QUBITS} qubits and {MAX_PROPOSAL_OPERATIONS} operations; "
                    f"this one has {circuit.num_qubits} and {len(circuit.ops)}."
                ),
            )
        )
    try:
        check_run_limits(circuit, "qiskit-aer")
        check_gate_support(circuit, "qiskit-aer")
    except LimitExceeded as exc:
        return rejected(Problem(code=TOO_LARGE, message=exc.message))
    except UnsupportedGate as exc:
        return rejected(Problem(code=UNSUPPORTED, message=str(exc)))

    summary = summarise(circuit)
    explanation, source, note = _explanation(draft.explanation, circuit, summary)
    return Proposal(
        status="PROPOSED",
        raw_qasm=raw,
        circuit=circuit,
        canonical_qasm=to_qasm3(circuit),
        circuit_hash=circuit_hash(circuit),
        summary=summary,
        explanation=explanation,
        explanation_source=source,
        explanation_note=note,
        constraint_notes=_constraint_notes(circuit, challenge),
    )
