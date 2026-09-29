"""Bloch vector of a single-qubit statevector — a value DERIVED from a
backend-produced state, never a value the backend "looks up".

For a single-qubit pure state  |psi> = alpha|0> + beta|1>  (alpha, beta the
backend's own returned complex amplitudes):

    x = 2 * Re(conj(alpha) * beta)
    y = 2 * Im(conj(alpha) * beta)
    z = |alpha|^2 - |beta|^2

i.e. the expectation values of the Pauli X, Y and Z operators. Written out in
real arithmetic (alpha = a_re + i*a_im, beta = b_re + i*b_im):

    conj(alpha) * beta = (a_re*b_re + a_im*b_im) + i*(a_re*b_im - a_im*b_re)
    x = 2 * (a_re*b_re + a_im*b_im)
    y = 2 * (a_re*b_im - a_im*b_re)
    z = (a_re^2 + a_im^2) - (b_re^2 + b_im^2)

Properties this relies on, and the tests pin:

- The input is ONLY the statevector. There is no gate name, circuit or
  "expected textbook state" anywhere in this module, so a coordinate cannot be
  supplied by knowing what a gate "should" do — it is whatever the backend's
  amplitudes say. (`test_bloch_vector.py` feeds it states no gate produces and
  checks the result follows the amplitudes.)
- It is invariant under a global phase: multiplying alpha and beta by the same
  e^{i*phi} leaves conj(alpha)*beta and both moduli unchanged. It is sensitive
  to RELATIVE phase, which is what moves the vector around the equator.
- No rounding: plain float arithmetic, so a ~1e-16 residue in the backend's
  state stays a ~1e-16 residue in x/y/z instead of being snapped to a value.
- For a validated (normalised) pure state the vector has length 1 by
  construction, so no separate "norm" is stored — it would be redundant state.

Only single-qubit states have a Bloch vector. A multi-qubit state has none: a
Bloch vector describes one qubit's reduced state, and an entangled register
(e.g. a Bell state) has no pure state per qubit — each qubit alone is
maximally mixed, and any single 3-vector for the whole register would hide the
correlations that make it entangled. Qentor has no reduced-density-matrix
abstraction yet, so `derive_bloch_vector` returns ``None`` for any state that
isn't exactly two amplitudes; it never invents a "global" vector.

This module does not verify anything about a circuit. A Bloch vector is a
different view of one state the backend produced; it is not a verdict that the
circuit is correct.
"""

from __future__ import annotations

import math
from typing import Sequence

from pydantic import BaseModel, ConfigDict

# The project-wide tolerance for "this statevector is normalised"
# (docs/VERIFICATION_ARCHITECTURE.md §4.1). `qentor.execution.trace` re-exports
# it under the same name; defined here so both share one number.
NORM_TOLERANCE = 1e-9

BLOCH_METHOD = "bloch-from-statevector/1"


class BlochSource(BaseModel):
    """Exactly which backend-produced state a Bloch vector was derived from.

    Every field mirrors the source trace step's own identity, so the derived
    value is never a disconnected provenance island: ``result_id`` resolves to
    the persisted record for that step, whose ``circuit_hash`` is
    ``circuit_hash`` here (the circuit cut off after this step's operation),
    and whose payload holds the statevector the vector was computed from.
    ``result_id`` is ``None`` only when a trace was run without a recorder.
    """

    model_config = ConfigDict(extra="forbid")

    step_index: int
    result_id: str | None
    execution_id: str
    circuit_hash: str
    backend: str
    backend_version: str


class BlochVector(BaseModel):
    """(x, y, z) with the provenance of the state it came from. Deliberately
    carries no verification status or verdict: it says "derived from this
    backend-produced statevector" (``derived_from``), and nothing about
    whether the circuit is correct."""

    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    z: float
    method: str
    derived_from: BlochSource


def bloch_coordinates(statevector: Sequence[Sequence[float]] | None) -> tuple[float, float, float] | None:
    """(x, y, z) from a single-qubit statevector, or ``None`` if it isn't one.

    ``None`` — never a guess, a default or a partial answer — for: no state,
    anything other than exactly two ``[re, im]`` amplitudes, a non-finite or
    non-numeric component, or a state whose squared norm isn't 1 within
    ``NORM_TOLERANCE``. (The trace layer has already rejected such states
    before a step exists; this repeats the check so the function is safe on
    its own.)
    """
    if statevector is None or len(statevector) != 2:
        return None

    parts: list[float] = []
    for amplitude in statevector:
        if len(amplitude) != 2:
            return None
        for component in amplitude:
            if isinstance(component, bool) or not isinstance(component, (int, float)):
                return None
            if not math.isfinite(component):
                return None
            parts.append(float(component))

    a_re, a_im, b_re, b_im = parts
    alpha_sq = a_re * a_re + a_im * a_im
    beta_sq = b_re * b_re + b_im * b_im
    if not abs((alpha_sq + beta_sq) - 1.0) <= NORM_TOLERANCE:
        return None

    return (
        2.0 * (a_re * b_re + a_im * b_im),
        2.0 * (a_re * b_im - a_im * b_re),
        alpha_sq - beta_sq,
    )


def derive_bloch_vector(
    statevector: Sequence[Sequence[float]] | None, *, source: BlochSource
) -> BlochVector | None:
    """The Bloch vector of ``statevector`` tagged with ``source`` (the trace
    step it came from), or ``None`` when the state has none."""
    coordinates = bloch_coordinates(statevector)
    if coordinates is None:
        return None
    x, y, z = coordinates
    return BlochVector(x=x, y=y, z=z, method=BLOCH_METHOD, derived_from=source)
