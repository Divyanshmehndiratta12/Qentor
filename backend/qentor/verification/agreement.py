"""Cross-backend agreement (docs/VERIFICATION_ARCHITECTURE.md §4.6).

Do Qiskit Aer, Cirq and PennyLane reach the same state for the same circuit? The comparison is done HERE,
on the server, on the statevectors the backends returned; the browser only shows the report and never
compares two quantum values itself.

For a pair of states ``a`` and ``b`` (each already state-checked, unit norm):

* ``max_probability_difference`` — the largest |p_a(i) − p_b(i)| over basis states, p = |amplitude|²;
* ``fidelity`` — |⟨a|b⟩|², which is 1 exactly when the two are the same state up to a global phase;
* ``max_amplitude_difference`` — the largest |a_i − b_i|. Reported for information only: two SDKs may
  legitimately differ by a global phase, which changes this number and nothing physical.

Two backends AGREE when ``max_probability_difference ≤ AGREEMENT_THRESHOLD`` and ``1 − fidelity ≤
AGREEMENT_THRESHOLD`` (1e-6, docs/ARCHITECTURE.md). The comparison reads numbers and computes; it never
rescales, rotates or repairs a state to make two agree.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Sequence

AGREEMENT_THRESHOLD = 1e-6
METHOD = "qentor.agreement/1"

State = Sequence[Sequence[float]]  # [[re, im], ...] as a backend returned it


@dataclass(frozen=True)
class PairAgreement:
    backend_a: str
    backend_b: str
    max_amplitude_difference: float
    max_probability_difference: float
    fidelity: float
    agrees: bool


def compare_states(a: State, b: State) -> tuple[float, float, float]:
    """``(max_amplitude_difference, max_probability_difference, fidelity)`` for two equal-length states."""
    if len(a) != len(b):
        raise ValueError(f"cannot compare states of different sizes ({len(a)} and {len(b)})")
    max_amp = 0.0
    max_prob = 0.0
    overlap = 0j
    for (ar, ai), (br, bi) in zip(a, b):
        za, zb = complex(ar, ai), complex(br, bi)
        max_amp = max(max_amp, abs(za - zb))
        max_prob = max(max_prob, abs(abs(za) ** 2 - abs(zb) ** 2))
        overlap += za.conjugate() * zb
    return max_amp, max_prob, abs(overlap) ** 2


def compare_all(states: dict[str, State]) -> list[PairAgreement]:
    """Every pair of the given backends' states, in the order the backends were given."""
    pairs: list[PairAgreement] = []
    for (name_a, a), (name_b, b) in combinations(states.items(), 2):
        amp, prob, fidelity = compare_states(a, b)
        pairs.append(
            PairAgreement(
                backend_a=name_a,
                backend_b=name_b,
                max_amplitude_difference=amp,
                max_probability_difference=prob,
                fidelity=fidelity,
                agrees=prob <= AGREEMENT_THRESHOLD and (1.0 - fidelity) <= AGREEMENT_THRESHOLD,
            )
        )
    return pairs
