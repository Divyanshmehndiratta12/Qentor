"""Backend-owned challenge definitions (Phase B).

A challenge is data: a goal, the circuit the learner starts from, structural constraints, and a list of *checks*.
Nothing here computes a quantum quantity. Every check is judged by ``qentor.challenges.evaluate`` from statevectors the
execution layer produced (the learner's circuit traced on Qiskit Aer, and the reference circuits each check names, run
the same way). An LLM is never consulted: pass/fail is a deterministic function of backend states.

Two things a learner never receives from the API (see ``PublicChallenge``): the reference solution, and the target
circuits behind each check. Those are how the answer is judged, not part of the question.

Bitstrings and qubit indexes follow the platform-wide convention: ``q[n-1] … q[0]``; a state's amplitude list is indexed
by that bitstring read as a binary number.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from qentor.circuit.model import Circuit, GateName, GateOp

Difficulty = Literal["beginner", "intermediate", "advanced"]


class Point(str, Enum):
    """Where in the learner's circuit a state check looks. ``BEFORE_ANCHOR`` / ``AFTER_ANCHOR`` are the state just before /
    just after the locked ``anchor`` ops (e.g. the fixed oracle), so a challenge can insist the learner *prepared* the
    right input, not only that the final answer looks right."""

    FINAL = "final"
    BEFORE_ANCHOR = "before_anchor"
    AFTER_ANCHOR = "after_anchor"


class _Check(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    # Index into ``Challenge.hints`` of the hint that helps when THIS check fails: hints are deterministic, not generated.
    hint_index: int = Field(ge=0)


class StateMatches(_Check):
    """The state at ``at`` equals the state of ``target`` (run from |0…0⟩ on the backend) up to global phase."""

    kind: Literal["state_matches"] = "state_matches"
    at: Point = Point.FINAL
    target: Circuit


class StateDiffers(_Check):
    """The state at ``at`` is a *different* state from ``other``'s (fidelity below ``1 - MIN_DIFFERENCE``), i.e. not equal
    even up to global phase."""

    kind: Literal["state_differs"] = "state_differs"
    at: Point = Point.FINAL
    other: Circuit


class ProbabilitiesMatch(_Check):
    """The measurement distribution of the state at ``at`` over ``qubits`` (all qubits when omitted) equals that of
    ``target``'s state. Two different states can pass this - that is the point of the phase challenge."""

    kind: Literal["probabilities_match"] = "probabilities_match"
    at: Point = Point.FINAL
    target: Circuit
    qubits: list[int] | None = None


class PassesThroughSuperposition(_Check):
    """Some state after the first operation and before the last is a genuine superposition: its most likely outcome has
    probability no greater than 1/2 (within tolerance), so it is not one computational-basis state."""

    kind: Literal["passes_through_superposition"] = "passes_through_superposition"


class EndsInBasisState(_Check):
    """The final state is one computational-basis state (a single outcome with probability 1)."""

    kind: Literal["ends_in_basis_state"] = "ends_in_basis_state"


Check = Annotated[
    Union[StateMatches, StateDiffers, ProbabilitiesMatch, PassesThroughSuperposition, EndsInBasisState],
    Field(discriminator="kind"),
]


class Constraints(BaseModel):
    """Structural rules on the submitted circuit. Judged on the canonical model alone - no backend needed."""

    model_config = ConfigDict(extra="forbid")

    num_qubits: int = Field(gt=0, le=8)
    num_clbits: int = Field(ge=0, le=8, default=0)
    allowed_gates: list[GateName] = Field(min_length=1)
    max_ops: int = Field(gt=0, le=64)
    # Minimum number of each gate the circuit must use (e.g. two Hadamards for interference).
    min_gate_counts: dict[GateName, int] = Field(default_factory=dict)
    # Ops that must appear, in order and back to back, exactly once (the fixed oracle). Never alterable by the learner.
    anchor: list[GateOp] = Field(default_factory=list)
    # Qubits that must be measured (terminal measurements only).
    must_measure: list[int] = Field(default_factory=list)


class Challenge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    lesson_id: str
    title: str
    goal: str
    difficulty: Difficulty
    constraints: Constraints
    starter_circuit: Circuit
    checks: list[Check] = Field(min_length=1)
    hints: list[str] = Field(min_length=1)
    success_message: str
    # What "solved" means, in words, for the learner. The verdict itself is computed from the checks, never from this text.
    success_condition: str
    reference_solution: Circuit
    # True for the two fixed-oracle challenges: one oracle, chosen by the platform. There is no oracle synthesis.
    fixed_oracle: bool = False

    @model_validator(mode="after")
    def _consistent(self) -> "Challenge":
        ids = [c.id for c in self.checks]
        if len(ids) != len(set(ids)):
            raise ValueError(f"challenge '{self.id}': check ids must be unique, got {ids}")
        for check in self.checks:
            if check.hint_index >= len(self.hints):
                raise ValueError(f"challenge '{self.id}': check '{check.id}' points at hint {check.hint_index}, which does not exist")
            at = getattr(check, "at", Point.FINAL)
            if at is not Point.FINAL and not self.constraints.anchor:
                raise ValueError(f"challenge '{self.id}': check '{check.id}' looks at {at.value} but the challenge has no anchor")
            targets = [c for c in (getattr(check, "target", None), getattr(check, "other", None)) if c is not None]
            for circuit in targets:
                if circuit.num_qubits != self.constraints.num_qubits:
                    raise ValueError(f"challenge '{self.id}': check '{check.id}' uses a {circuit.num_qubits}-qubit circuit")
            qubits = getattr(check, "qubits", None)
            if qubits is not None and any(not 0 <= q < self.constraints.num_qubits for q in qubits):
                raise ValueError(f"challenge '{self.id}': check '{check.id}' names a qubit outside the circuit")
        for circuit in (self.starter_circuit, self.reference_solution):
            if circuit.num_qubits != self.constraints.num_qubits:
                raise ValueError(f"challenge '{self.id}': starter/reference circuit width differs from the constraints")
        if any(q >= self.constraints.num_qubits for q in self.constraints.must_measure):
            raise ValueError(f"challenge '{self.id}': must_measure names a qubit outside the circuit")
        return self


# ---------------------------------------------------------------------------------------------------------------------
# What the API may say about a challenge. Built from the definition by ``public_view``; it has no field for a target
# circuit or the reference solution, so it cannot leak one.
# ---------------------------------------------------------------------------------------------------------------------


class PublicCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str


class PublicChallenge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    lesson_id: str
    title: str
    goal: str
    difficulty: Difficulty
    success_condition: str
    fixed_oracle: bool
    constraints: Constraints
    starter_circuit: Circuit
    checks: list[PublicCheck]
    hints: list[str]


def public_view(challenge: Challenge) -> PublicChallenge:
    return PublicChallenge(
        id=challenge.id,
        lesson_id=challenge.lesson_id,
        title=challenge.title,
        goal=challenge.goal,
        difficulty=challenge.difficulty,
        success_condition=challenge.success_condition,
        fixed_oracle=challenge.fixed_oracle,
        constraints=challenge.constraints,
        starter_circuit=challenge.starter_circuit,
        checks=[PublicCheck(id=c.id, label=c.label) for c in challenge.checks],
        hints=list(challenge.hints),
    )
