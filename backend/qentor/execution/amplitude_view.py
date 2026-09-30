"""The polar form of a statevector — magnitude, probability and phase per basis state — for the amplitude/phase chart.

The browser draws this; it never computes it. A chart of "how big is each amplitude and which way does its phase point"
needs ``|a|`` and ``arg(a)``, and the frontend's trust rule is that it calculates no quantum value, so the server hands
both over, derived from the same backend-produced state the trace step already carries:

    magnitude = sqrt(re^2 + im^2)        probability = re^2 + im^2        phase = atan2(im, re)   (radians, in (-pi, pi])

Two honest limits, stated in the data rather than hidden:

* ``phase`` is ``None`` when the amplitude is numerically zero (``probability <= PHASE_DEFINED_ABOVE``): the angle of
  zero is undefined, and a number would be noise. The chart says "no phase", it does not draw an arrow.
* A phase is relative to the simulator's own global phase, which no measurement can see. Only DIFFERENCES between phases
  of different basis states are physical. The values here are exactly the ones the backend's amplitudes give; no global
  phase is removed or re-chosen.

No rounding, no rescaling. ``PHASE_DEFINED_ABOVE`` is the same 1e-9 support threshold ``step_changes`` uses.
"""

from __future__ import annotations

import math
from typing import Sequence

from pydantic import BaseModel, ConfigDict

AMPLITUDE_VIEW_METHOD = "polar-amplitudes-from-statevector/1"
PHASE_DEFINED_ABOVE = 1e-9


class BasisAmplitude(BaseModel):
    """One basis state's amplitude in polar form. Its position in the list is the statevector index, i.e. the
    bitstring ``q[n-1]...q[0]`` read as binary."""

    model_config = ConfigDict(extra="forbid")

    magnitude: float
    probability: float
    phase: float | None


def derive_amplitude_view(statevector: Sequence[Sequence[float]]) -> list[BasisAmplitude]:
    """Polar form of every amplitude, in statevector order. Raises ``ValueError`` on a malformed state — the trace layer
    has already rejected those, so reaching it is a programming error, never something to paper over."""
    view: list[BasisAmplitude] = []
    for amplitude in statevector:
        if len(amplitude) != 2:
            raise ValueError("an amplitude must be a [re, im] pair")
        re, im = amplitude
        for component in (re, im):
            if isinstance(component, bool) or not isinstance(component, (int, float)) or not math.isfinite(component):
                raise ValueError("an amplitude component must be a finite number")
        probability = re * re + im * im
        view.append(
            BasisAmplitude(
                magnitude=math.sqrt(probability),
                probability=probability,
                phase=math.atan2(im, re) if probability > PHASE_DEFINED_ABOVE else None,
            )
        )
    return view
