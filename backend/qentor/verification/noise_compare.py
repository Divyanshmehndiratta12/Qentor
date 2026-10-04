"""Ideal-versus-noisy comparison: the numbers and the sentences, computed on the server from two backend runs.

Input is exactly what two simulator runs returned: the ideal run's counts and the noisy run's counts, the same number of shots each, and the
noise configuration the noisy run was asked for. Output is a per-outcome table, a few metrics that are mathematically what they say they are,
and a short deterministic explanation written from those numbers. There is no model and no random choice here, and nothing is simulated: this
module never imports an execution backend.

The metrics (every one a plain function of the two sampled frequency tables, none of them "fidelity"):

* ``total_variation_distance`` = 1/2 * sum over outcomes of |ideal frequency - noisy frequency|. 0 means the two sampled distributions are
  identical, 1 means they share no outcome. It compares two finite samples, so it is never exactly 0 even between two runs of the same ideal
  circuit; the explanation says so.
* ``noisy_share_on_ideal_outcomes`` = the fraction of noisy shots that landed on an outcome the ideal run also produced. "Outcomes the ideal
  run produced" is the set observed in that sample, not a derived ideal support: an outcome with a tiny ideal probability may be missing from it.
* the ideal run's most frequent outcome(s), with the frequency each had in both runs (ties are all reported).

Why no "success probability" and no "fidelity": Qentor does not know what a circuit is *meant* to output, so it cannot call any outcome the
"correct" one; and a fidelity needs a state (or a full distribution of the noisy device), not two sampled count tables. Neither is invented.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from qentor.execution.noise import NoiseConfig

METHOD = "noise-comparison/1"
NOTE = (
    "Simulated noise on Qiskit Aer, not a real device. Both runs are finite samples, so small differences can come from sampling alone."
)


class NoiseOutcomeRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: str  # a bitstring, q[n-1] ... q[0]
    ideal_count: int
    noisy_count: int
    ideal_probability: float  # sampled frequency: count / shots
    noisy_probability: float
    delta: float  # noisy minus ideal


class TopOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: str
    ideal_probability: float
    noisy_probability: float


class NoiseMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    shots: int
    total_variation_distance: float
    noisy_share_on_ideal_outcomes: float
    ideal_outcomes: list[str]  # the outcomes observed in the ideal run
    new_outcomes: list[str]  # observed in the noisy run only
    new_outcome_shots: int  # noisy shots that landed on them
    ideal_distinct_outcomes: int
    noisy_distinct_outcomes: int
    ideal_top_outcomes: list[TopOutcome]


class ExplanationLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    text: str


class NoiseComparison(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: str = METHOD
    rows: list[NoiseOutcomeRow]
    metrics: NoiseMetrics
    explanation: list[ExplanationLine]
    note: str = NOTE


class NoiseComparisonError(ValueError):
    """The two runs cannot be compared (they disagree about the shots): a refusal, never a repaired comparison."""


def _list(outcomes: list[str], limit: int = 6) -> str:
    shown = ", ".join(outcomes[:limit])
    return shown + (f" and {len(outcomes) - limit} more" if len(outcomes) > limit else "")


def compare_noise(ideal_counts: dict[str, int], noisy_counts: dict[str, int], shots: int, config: NoiseConfig) -> NoiseComparison:
    """Compare two count tables of ``shots`` shots each. Raises ``NoiseComparisonError`` when a table does not add up to ``shots``."""
    if shots <= 0:
        raise NoiseComparisonError("shots must be positive")
    for name, counts in (("ideal", ideal_counts), ("noisy", noisy_counts)):
        if sum(counts.values()) != shots:
            raise NoiseComparisonError(f"the {name} counts add up to {sum(counts.values())}, not {shots} shots")

    outcomes = sorted(set(ideal_counts) | set(noisy_counts))
    rows = [
        NoiseOutcomeRow(
            outcome=o,
            ideal_count=ideal_counts.get(o, 0),
            noisy_count=noisy_counts.get(o, 0),
            ideal_probability=ideal_counts.get(o, 0) / shots,
            noisy_probability=noisy_counts.get(o, 0) / shots,
            delta=noisy_counts.get(o, 0) / shots - ideal_counts.get(o, 0) / shots,
        )
        for o in outcomes
    ]
    tvd = sum(abs(r.ideal_probability - r.noisy_probability) for r in rows) / 2
    ideal_outcomes = sorted(o for o, c in ideal_counts.items() if c > 0)
    new_outcomes = sorted(o for o, c in noisy_counts.items() if c > 0 and ideal_counts.get(o, 0) == 0)
    new_shots = sum(noisy_counts[o] for o in new_outcomes)
    on_ideal = sum(c for o, c in noisy_counts.items() if ideal_counts.get(o, 0) > 0)
    top_count = max(ideal_counts.values())
    top = [
        TopOutcome(outcome=o, ideal_probability=ideal_counts[o] / shots, noisy_probability=noisy_counts.get(o, 0) / shots)
        for o in sorted(ideal_counts)
        if ideal_counts[o] == top_count
    ]
    metrics = NoiseMetrics(
        shots=shots,
        total_variation_distance=tvd,
        noisy_share_on_ideal_outcomes=on_ideal / shots,
        ideal_outcomes=ideal_outcomes,
        new_outcomes=new_outcomes,
        new_outcome_shots=new_shots,
        ideal_distinct_outcomes=len(ideal_outcomes),
        noisy_distinct_outcomes=sum(1 for c in noisy_counts.values() if c > 0),
        ideal_top_outcomes=top,
    )
    return NoiseComparison(rows=rows, metrics=metrics, explanation=_explain(metrics, config))


def _explain(m: NoiseMetrics, config: NoiseConfig) -> list[ExplanationLine]:
    spec = config.spec
    lines: list[str] = [
        f"Noise model: {spec.label}. {spec.how_applied} Strength: {config.strength:g} ({spec.parameter}).",
        f"Both runs measured the same circuit for {m.shots} shots; the noisy run used the Aer {config.describe()['simulation_method']} simulator with seed {config.seed}.",
        f"The ideal run produced {m.ideal_distinct_outcomes} distinct outcome{'s' if m.ideal_distinct_outcomes != 1 else ''} and the noisy run produced {m.noisy_distinct_outcomes}.",
    ]
    if m.new_outcomes:
        lines.append(
            f"{m.new_outcome_shots} of {m.shots} noisy shots ({100 * m.new_outcome_shots / m.shots:.1f}%) landed on outcomes the ideal run never produced: {_list(m.new_outcomes)}."
        )
    else:
        lines.append("Every noisy shot landed on an outcome the ideal run also produced.")
    if len(m.ideal_top_outcomes) == 1:
        t = m.ideal_top_outcomes[0]
        lines.append(f"The ideal run's most frequent outcome, {t.outcome}, had a frequency of {t.ideal_probability:.4f} in the ideal run and {t.noisy_probability:.4f} in the noisy run.")
    else:
        parts = "; ".join(f"{t.outcome}: {t.ideal_probability:.4f} ideal, {t.noisy_probability:.4f} noisy" for t in m.ideal_top_outcomes[:6])
        lines.append(f"The ideal run's most frequent outcomes (tied) were {parts}.")
    lines.append(
        f"The total variation distance between the two sampled distributions is {m.total_variation_distance:.4f} (0 means identical, 1 means no outcome in common)."
    )
    lines.append("Each run is a finite sample, so small differences can come from sampling alone; compare the size of a difference with the number of shots before reading it as an effect of noise.")
    return [ExplanationLine(id=f"N{i}", text=text) for i, text in enumerate(lines, start=1)]
