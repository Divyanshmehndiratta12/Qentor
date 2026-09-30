"""State sanity check for a backend result — what "STATE_CHECKED" means.

Three different things used to share the word "verified":

1. the backend ran without error                        (execution succeeded)
2. what it returned is a well-formed physical result     (state sanity — this module)
3. the circuit has a property, or two circuits agree     (property verification:
   ``qentor.verification`` — the Bell verifier, the multi-input harness,
   the equivalence checker)

Only (3) says anything about whether a circuit is right. This module is (2): the
returned statevector has the right size, finite entries and unit norm within
1e-9; returned probabilities are in [0, 1] and sum to 1 within 1e-9; returned
counts are non-negative integers that add up to the requested shots. That is
docs/VERIFICATION_ARCHITECTURE.md §4.1's criterion, and it is the same tolerance
the trace and the Bloch derivation already use.

The function reads what a backend returned and reports problems. It never
repairs, rescales or fills in a value.
"""

from __future__ import annotations

import math
import numbers

from .adapter import ExecutionResult
from .bloch import NORM_TOLERANCE

# One plain sentence, used wherever a status is shown to a learner or quoted to the tutor.
STATE_CHECKED_PLAIN = (
    "the backend ran and returned a well-formed result; this does not show the circuit does what you intend"
)

STATE_CHECK_DESCRIPTION = (
    "the backend ran and returned a well-formed result "
    "(statevector norm 1 within 1e-9, or probabilities summing to 1 and counts summing to the shots); "
    "this says nothing about whether the circuit does what you intend"
)


def state_problems(result: ExecutionResult, num_qubits: int, *, shots: int | None = None) -> list[str]:
    """Why ``result`` is not a well-formed result; empty when it is."""
    problems: list[str] = []

    if result.statevector is not None:
        state = result.statevector
        if len(state) != 2**num_qubits:
            problems.append(f"the statevector has {len(state)} amplitudes, expected {2**num_qubits}")
        elif not all(len(pair) == 2 and all(math.isfinite(x) for x in pair) for pair in state):
            problems.append("the statevector has a non-finite amplitude")
        else:
            norm = sum(re * re + im * im for re, im in state)
            if not abs(norm - 1.0) <= NORM_TOLERANCE:
                problems.append(f"the statevector's squared norm is {norm!r}, not 1 within {NORM_TOLERANCE}")

    if result.probabilities is not None:
        values = list(result.probabilities.values())
        if not all(math.isfinite(p) and -NORM_TOLERANCE <= p <= 1 + NORM_TOLERANCE for p in values):
            problems.append("a probability is outside [0, 1]")
        elif not abs(sum(values) - 1.0) <= NORM_TOLERANCE:
            problems.append(f"the probabilities sum to {sum(values)!r}, not 1 within {NORM_TOLERANCE}")

    if result.counts is not None:
        counts = list(result.counts.values())
        if not all(isinstance(c, numbers.Integral) and c >= 0 for c in counts):
            problems.append("a count is not a non-negative integer")
        elif shots is not None and sum(counts) != shots:
            problems.append(f"the counts add up to {sum(counts)}, not the {shots} shots requested")

    if result.statevector is None and result.probabilities is None and result.counts is None:
        problems.append("the backend returned no statevector, probabilities or counts")
    return problems
