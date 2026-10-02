"""Expectation value of the Pauli Z observable on one qubit, read from a backend-produced statevector.

For a pure state ``psi`` of ``n`` qubits (index ``k`` is the bitstring ``q[n-1]...q[0]``; qubit ``q`` is bit ``q`` of ``k``):

    <Z_q> = sum over k of |psi[k]|^2 * (+1 if bit q of k is 0 else -1)  =  P(q reads 0) - P(q reads 1)

It is the Z component of that qubit's Bloch vector, so it is computed here on its own path (a signed sum of the backend's
probabilities) and the tests compare it with ``qentor.execution.reduced_state`` rather than this module assuming the identity.

Like the Bloch vector and the reduced state, this reads ONLY the statevector: no gate name, no circuit, no textbook formula. A function of
the circuit such as ``cos(theta)`` appears nowhere in this module, so a value cannot be produced by knowing what a gate "should" do. A state
that is not a well-formed normalised ``n``-qubit vector has no expectation value (``None``): nothing is repaired, rescaled or guessed.
This is a quantity DERIVED from one state the backend produced; it is not a verdict on any circuit.
"""

from __future__ import annotations

import math
from typing import Sequence

from .bloch import NORM_TOLERANCE

EXPECTATION_METHOD = "pauli-z-expectation-from-statevector/1"


def z_expectation(statevector: Sequence[Sequence[float]] | None, qubit: int, num_qubits: int) -> float | None:
    """<Z> of ``qubit`` in ``statevector``, or ``None`` if the state is unusable or the qubit is outside the register."""
    if statevector is None or num_qubits < 1 or not 0 <= qubit < num_qubits or len(statevector) != 2**num_qubits:
        return None
    total = 0.0
    norm = 0.0
    for index, amplitude in enumerate(statevector):
        if len(amplitude) != 2:
            return None
        re, im = amplitude
        if isinstance(re, bool) or isinstance(im, bool) or not isinstance(re, (int, float)) or not isinstance(im, (int, float)):
            return None
        if not (math.isfinite(re) and math.isfinite(im)):
            return None
        probability = float(re) * float(re) + float(im) * float(im)
        norm += probability
        total += -probability if (index >> qubit) & 1 else probability
    if not abs(norm - 1.0) <= NORM_TOLERANCE:
        return None
    return total
