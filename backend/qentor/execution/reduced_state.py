"""The state of ONE qubit inside a multi-qubit statevector — Bloch vector, purity, and where it came from.

A qubit that is entangled with the rest of a register has no pure state of its own, so it has no Bloch vector "of
the register". What it does have is a REDUCED state: the 2x2 density matrix left after tracing out every other qubit.
For qubit ``q`` of a pure ``n``-qubit state ``psi`` (index ``k`` is the bitstring ``q[n-1]...q[0]``; qubit ``q`` is
bit ``q`` of ``k``):

    rho[a][b] = sum over the other n-1 bits of   psi[a, rest] * conj(psi[b, rest])

and its Bloch vector is the expectation values of the Pauli operators on that qubit:

    x = 2 * Re(rho[0][1])          (<X>)
    y = -2 * Im(rho[0][1])         (<Y>)
    z = rho[0][0] - rho[1][1]      (<Z>)

with ``purity = Tr(rho^2) = rho00^2 + rho11^2 + 2*|rho01|^2`` and ``bloch_length = |(x, y, z)|``. For a qubit the two
are tied together (``purity = (1 + length^2) / 2``), so they are computed on separate paths and the tests check the
identity rather than this module assuming it.

What the numbers mean, and what is deliberately NOT claimed:

* ``bloch_length`` ~ 1 and ``purity`` ~ 1: the qubit is in a pure state of its own (a product state with the rest).
* ``bloch_length`` ~ 0 and ``purity`` ~ 0.5: the qubit is maximally mixed — each qubit of a Bell pair looks like this.
* ``entangled_with_rest`` is ``purity < 1 - ENTANGLEMENT_TOLERANCE``. It is a statement about a GLOBALLY PURE state
  (every statevector a trace returns is pure): then and only then is a mixed qubit exactly one that is entangled with
  the others. It says nothing about which qubits it is entangled with, and it is not a verdict on the circuit.
* Like the single-qubit Bloch vector (``qentor.execution.bloch``) this reads ONLY the statevector — no gate name, no
  circuit, no textbook state — so a value cannot be supplied by knowing what a gate "should" do. It is invariant under
  a global phase, is not rounded (a 1e-16 residue stays a 1e-16 residue), and is never rescaled or repaired.

``UNUSABLE`` is explicit and carries a ``reason``: the state was not a well-formed normalised ``n``-qubit vector, the
qubit index is outside the register, or the derived qubit state is not a valid density matrix (purity outside [1/2, 1],
or a Bloch vector longer than 1, beyond tolerance). Nothing is invented for such a qubit: no vector, no purity.
"""

from __future__ import annotations

import math
from typing import Literal, Sequence

from pydantic import BaseModel, ConfigDict

from .bloch import NORM_TOLERANCE, BlochSource

REDUCED_STATE_METHOD = "reduced-qubit-state-from-statevector/1"

# A qubit of a pure register is "entangled with the rest" when its purity is below 1 by more than this — the same
# 1e-9 the rest of Qentor uses for exact statevectors (docs/VERIFICATION_ARCHITECTURE.md §4.1).
ENTANGLEMENT_TOLERANCE = 1e-9
# How far a derived qubit state may sit outside the valid range before it is reported UNUSABLE rather than shown.
VALIDITY_TOLERANCE = 1e-9

QubitStatus = Literal["OK", "UNUSABLE"]


class ReducedBloch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    z: float


class QubitReducedState(BaseModel):
    """One qubit's reduced state at one trace step, tagged with exactly which backend state it came from.

    ``status == "OK"``: ``bloch``, ``bloch_length``, ``purity`` and ``entangled_with_rest`` are all present.
    ``status == "UNUSABLE"``: they are all ``None`` and ``reason`` says why. ``derived_from`` is present either way: it
    mirrors the step's own identity (step index, result id, execution id, prefix circuit hash, backend and version), so
    the value can never be detached from the state it came from.
    """

    model_config = ConfigDict(extra="forbid")

    qubit: int
    status: QubitStatus
    reason: str | None = None
    bloch: ReducedBloch | None = None
    bloch_length: float | None = None
    purity: float | None = None
    entangled_with_rest: bool | None = None
    method: str = REDUCED_STATE_METHOD
    derived_from: BlochSource


def _parse_state(statevector: Sequence[Sequence[float]] | None, num_qubits: int) -> tuple[list[complex] | None, str | None]:
    """The amplitudes as complex numbers, or ``(None, reason)`` if this is not a usable ``num_qubits`` state."""
    if statevector is None:
        return None, "there is no statevector for this step"
    if num_qubits < 1:
        return None, f"a register of {num_qubits} qubits has no qubits"
    if len(statevector) != 2**num_qubits:
        return None, f"the statevector has {len(statevector)} amplitudes, not {2**num_qubits} for {num_qubits} qubits"
    amplitudes: list[complex] = []
    for amplitude in statevector:
        if len(amplitude) != 2:
            return None, "an amplitude is not a [re, im] pair"
        for component in amplitude:
            if isinstance(component, bool) or not isinstance(component, (int, float)):
                return None, "an amplitude component is not a number"
            if not math.isfinite(component):
                return None, "an amplitude component is not finite"
        amplitudes.append(complex(float(amplitude[0]), float(amplitude[1])))
    norm = sum(a.real * a.real + a.imag * a.imag for a in amplitudes)
    if not abs(norm - 1.0) <= NORM_TOLERANCE:
        return None, f"the statevector's squared norm is {norm!r}, not 1 within {NORM_TOLERANCE}"
    return amplitudes, None


def _reduced_density(amplitudes: list[complex], qubit: int) -> tuple[float, float, complex]:
    """``(rho00, rho11, rho01)`` of ``qubit``: the other bits are summed over, never looked up."""
    mask = 1 << qubit
    rho00 = 0.0
    rho11 = 0.0
    rho01 = 0j
    for index, amplitude in enumerate(amplitudes):
        if index & mask:
            continue  # visit each (bit = 0, rest) once; its bit = 1 partner is index | mask
        partner = amplitudes[index | mask]
        rho00 += amplitude.real * amplitude.real + amplitude.imag * amplitude.imag
        rho11 += partner.real * partner.real + partner.imag * partner.imag
        rho01 += amplitude * partner.conjugate()
    return rho00, rho11, rho01


def qubit_reduced_state(
    statevector: Sequence[Sequence[float]] | None, qubit: int, num_qubits: int, *, source: BlochSource
) -> QubitReducedState:
    """The reduced state of ``qubit`` in ``statevector`` (an ``num_qubits``-qubit state), tagged with ``source``."""
    return _derive(statevector, qubit, num_qubits, source=source, parsed=None)


def qubit_bloch(
    statevector: Sequence[Sequence[float]] | None, qubit: int, num_qubits: int
) -> tuple[float, float, float, float] | None:
    """``(x, y, z, purity)`` of ``qubit``'s own reduced state, or ``None`` when the state is unusable (same rules and the
    same arithmetic as ``qubit_reduced_state``, without a provenance tag). For a verifier that compares one qubit of two
    backend states and reports its own provenance."""
    state = qubit_reduced_state(
        statevector,
        qubit,
        num_qubits,
        source=BlochSource(step_index=0, result_id=None, execution_id="", circuit_hash="", backend="", backend_version=""),
    )
    if state.status != "OK" or state.bloch is None or state.purity is None:
        return None
    return state.bloch.x, state.bloch.y, state.bloch.z, state.purity


def derive_qubit_states(
    statevector: Sequence[Sequence[float]] | None, num_qubits: int, *, source: BlochSource
) -> list[QubitReducedState]:
    """Every qubit's reduced state, ``q[0]`` first. The state is validated once; each qubit gets its own status."""
    parsed = _parse_state(statevector, num_qubits)
    return [_derive(statevector, qubit, num_qubits, source=source, parsed=parsed) for qubit in range(max(num_qubits, 0))]


def _unusable(qubit: int, reason: str, source: BlochSource) -> QubitReducedState:
    return QubitReducedState(qubit=qubit, status="UNUSABLE", reason=reason, derived_from=source)


def _derive(
    statevector: Sequence[Sequence[float]] | None,
    qubit: int,
    num_qubits: int,
    *,
    source: BlochSource,
    parsed: tuple[list[complex] | None, str | None] | None,
) -> QubitReducedState:
    if not 0 <= qubit < num_qubits:
        return _unusable(qubit, f"qubit {qubit} is outside a {num_qubits}-qubit register", source)
    amplitudes, problem = parsed if parsed is not None else _parse_state(statevector, num_qubits)
    if amplitudes is None:
        return _unusable(qubit, problem or "the statevector is not usable", source)

    rho00, rho11, rho01 = _reduced_density(amplitudes, qubit)
    x = 2.0 * rho01.real
    y = -2.0 * rho01.imag
    z = rho00 - rho11
    length = math.sqrt(x * x + y * y + z * z)
    purity = rho00 * rho00 + rho11 * rho11 + 2.0 * (rho01.real * rho01.real + rho01.imag * rho01.imag)

    if not (0.5 - VALIDITY_TOLERANCE <= purity <= 1.0 + VALIDITY_TOLERANCE):
        return _unusable(qubit, f"the derived purity {purity!r} is outside [1/2, 1]; this is not a valid qubit state", source)
    if not length <= 1.0 + VALIDITY_TOLERANCE:
        return _unusable(qubit, f"the derived Bloch vector has length {length!r}, more than 1; this is not a valid qubit state", source)

    return QubitReducedState(
        qubit=qubit,
        status="OK",
        bloch=ReducedBloch(x=x, y=y, z=z),
        bloch_length=length,
        purity=purity,
        entangled_with_rest=purity < 1.0 - ENTANGLEMENT_TOLERANCE,
        derived_from=source,
    )
