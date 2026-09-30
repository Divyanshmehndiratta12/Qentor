"""What one operation changed in a state — the "what changed" behind the trace's before/after view.

Given the backend's statevector before an operation and after it, report which basis states'
amplitudes moved, whether any OUTCOME PROBABILITY moved, and a one-sentence summary. The point a
learner most needs from a trace lives here: a gate can change amplitudes without changing a single
outcome probability (a pure phase change, like Z on |+⟩), and a measurement right now cannot see it.

This reads two states the backend returned and compares them. It never rescales, rotates or repairs
either state, and the browser never does this comparison — it displays what this returns. The tolerance
is the one the rest of Qentor uses for exact statevectors (1e-9).

The summary is a fixed English template over integers counted from the comparison; the tutor quotes it
as a fact (kind ``trace_change``), so a model can restate it but cannot change it.
"""

from __future__ import annotations

from typing import Literal, Sequence

from pydantic import BaseModel, ConfigDict

TOLERANCE = 1e-9

State = Sequence[Sequence[float]]

ChangeKind = Literal["unchanged", "phase_only", "probabilities_changed"]


class BasisChange(BaseModel):
    """One basis state whose amplitude moved (index written as the bitstring ``q[n-1]…q[0]``)."""

    model_config = ConfigDict(extra="forbid")

    basis: str
    before: list[float]
    after: list[float]
    probability_before: float
    probability_after: float


class StepChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ChangeKind
    support_before: int  # basis states with non-zero amplitude before
    support_after: int
    amplitudes_changed: int
    probabilities_changed: int
    changed_basis_states: list[BasisChange]
    summary: str


def _probability(pair: Sequence[float]) -> float:
    return pair[0] * pair[0] + pair[1] * pair[1]


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def compute_step_change(before: State, after: State, num_qubits: int) -> StepChange:
    """Compare two statevectors of the same size. Raises ``ValueError`` if the sizes differ."""
    if len(before) != len(after):
        raise ValueError(f"cannot compare states of different sizes ({len(before)} and {len(after)})")

    changed: list[BasisChange] = []
    probabilities_changed = 0
    support_before = 0
    support_after = 0
    for index, (b, a) in enumerate(zip(before, after)):
        p_before, p_after = _probability(b), _probability(a)
        support_before += p_before > TOLERANCE
        support_after += p_after > TOLERANCE
        moved = abs(complex(a[0], a[1]) - complex(b[0], b[1])) > TOLERANCE
        if abs(p_after - p_before) > TOLERANCE:
            probabilities_changed += 1
        if moved:
            changed.append(
                BasisChange(
                    basis=format(index, f"0{num_qubits}b"),
                    before=[b[0], b[1]],
                    after=[a[0], a[1]],
                    probability_before=p_before,
                    probability_after=p_after,
                )
            )

    if not changed:
        kind: ChangeKind = "unchanged"
        summary = "This operation left the state unchanged."
    elif probabilities_changed == 0:
        kind = "phase_only"
        summary = (
            f"Only phases changed: {_plural(len(changed), 'basis state')} picked up a phase and every outcome probability "
            "stayed the same. A measurement right now cannot see a phase, but a later gate can turn it into a different outcome."
        )
    else:
        kind = "probabilities_changed"
        summary = (
            f"Outcome probabilities changed on {_plural(probabilities_changed, 'basis state')}; "
            f"{_plural(support_after, 'basis state')} now {'has' if support_after == 1 else 'have'} non-zero amplitude "
            f"(was {support_before})."
        )

    return StepChange(
        kind=kind,
        support_before=support_before,
        support_after=support_after,
        amplitudes_changed=len(changed),
        probabilities_changed=probabilities_changed,
        changed_basis_states=changed,
        summary=summary,
    )
