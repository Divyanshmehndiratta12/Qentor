"""The circuit debugger ("Debug my circuit"): observed behaviour, concrete evidence, the likely conceptual mismatch, the next
experiment, and a hint - every quantum claim taken from facts the server already holds.

Authorities (docs/AI_BOUNDARY.md):

* ``F#`` result facts and ``S#`` trace-step facts come from provenance records (the API fetches and checks them).
* ``C#`` challenge facts (goal, authored coaching) come from the challenge definition; ``E#`` facts are the per-check
  outcomes of an attempt the SERVER judged (``qentor.challenges.evaluate``) - pass/fail and the fidelity behind it.
* The learner's own goal text is untrusted input. It is echoed, never used to compute or to decide anything.

The report is built deterministically from those facts. An LLM, when one is configured, may only rewrite three prose fields
(observed / mismatch / next experiment); its draft passes the same claim guard as the tutor's or the deterministic text is used.
The evidence bullets and the hint are ALWAYS deterministic - quoted facts and authored hints - so numbers and hints can never
come from a model. Nothing here decides pass/fail: that verdict arrived with the attempt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict

from qentor.challenges import Challenge
from qentor.circuit.model import Circuit
from qentor.provenance.models import ExecutionStatus, ProvenanceRecord

from .claims import find_violations
from .facts import _describe_op, build_fact_sheet
from .llm import DebugDraft, LLMAdapter, LLMUnavailable
from .models import TutorFact
from .trace_context import TraceStepContext

GOAL_MAX_LENGTH = 400


class DebugSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    fact_ids: list[str] = []


class DebugReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observed: DebugSection
    evidence: list[DebugSection]
    mismatch: DebugSection
    next_experiment: DebugSection
    hint: DebugSection | None
    facts: list[TutorFact]
    # True when the prose is the server's template rather than an LLM draft (the UI labels it "without AI").
    used_fallback_template: bool
    # What the report is grounded in, for the UI: "challenge" (an attempt the server judged), "result" (a Lab run) or "failed_run".
    grounded_in: str


@dataclass
class AttemptView:
    """What the tutor layer may know about a judged attempt: plain data the API layer read from the attempt log."""

    attempt_id: str
    passed: bool
    checks: list[dict]  # CheckOutcome.model_dump(): id, label, passed, evaluated, detail, hint_index, evidence, result_id


@dataclass
class DebugInputs:
    circuit: Circuit
    goal: str | None = None
    record: ProvenanceRecord | None = None
    challenge: Challenge | None = None
    attempt: AttemptView | None = None
    step: TraceStepContext | None = None
    extra_facts: list[TutorFact] = field(default_factory=list)


def clean_goal(goal: str | None) -> str | None:
    """The learner's goal text, trimmed and stripped of control characters; ``None`` when nothing is left."""
    if goal is None:
        return None
    text = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]+", " ", goal)).strip()
    return text[:GOAL_MAX_LENGTH] or None


# ---------------------------------------------------------------------------------------------------------- facts


_STRUCTURE_COACHING: dict[str, tuple[str, str]] = {
    "structure.width": (
        "This challenge fixes the number of qubits, and the circuit does not have that many.",
        "Compare the qubit count in the challenge brief with the canvas header and make them match.",
    ),
    "structure.gates": (
        "A gate outside the allowed set was used: each challenge limits the toolbox on purpose.",
        "Find the gate the message names on the canvas, click it to remove it, and rebuild that step with an allowed gate.",
    ),
    "structure.size": (
        "The circuit is longer than this challenge allows, which usually means a step is repeated or can be simplified.",
        "Remove a gate that the trace shows changes nothing, then submit again.",
    ),
    "structure.oracle": (
        "The locked gates (the fixed oracle, decoder or corrections) are set by the challenge: they must appear exactly as given, once, with nothing between them.",
        "Read the fixed gates in the brief one by one and compare them with your circuit; add or remove gates until they match.",
    ),
    "structure.gate_qubits": (
        "Some gates are limited to particular qubits on purpose: in a protocol, each party may only act on the qubit they hold.",
        "Find the gate the message names on the canvas and move it to the qubit the brief allows.",
    ),
    "structure.measure": (
        "The answer is read out by measuring, and a measurement must be the last thing done: no gate may follow it.",
        "Move the measurements to the end of the circuit and measure every qubit the brief names.",
    ),
}
_USES_COACHING = (
    "This idea needs a gate you have not used enough times.",
    "Check the required gate counts in the message and add the missing gates where the idea calls for them.",
)


def _coaching(challenge: Challenge, check_id: str) -> tuple[str, str] | None:
    """(likely mismatch, next experiment) for a failed check: authored per check, or generic for a structure rule."""
    for check in challenge.checks:
        if check.id == check_id:
            return check.misconception, check.experiment
    if check_id.startswith("structure.uses_"):
        return _USES_COACHING
    return _STRUCTURE_COACHING.get(check_id)


def _describe_circuit(circuit: Circuit) -> str:
    return ", ".join(_describe_op(op) for op in circuit.ops) or "no operations"


def _state_word(check: dict) -> str:
    if not check["evaluated"]:
        return "not checked yet"
    return "passed" if check["passed"] else "not passed"


def build_debug_facts(inputs: DebugInputs) -> list[TutorFact]:
    """All the facts the report and any LLM draft are grounded in, with stable ids by source."""
    facts: list[TutorFact] = []

    if inputs.record is not None and inputs.record.verification_status == ExecutionStatus.STATE_CHECKED:
        facts.extend(build_fact_sheet(inputs.circuit, inputs.record))
    if inputs.step is not None and inputs.step.usable:
        facts.extend(inputs.step.facts)

    counter = {"C": 0, "E": 0}

    def add(prefix: str, kind, description: str, result_id: str | None = None) -> str:
        counter[prefix] += 1
        fact_id = f"{prefix}{counter[prefix]}"
        facts.append(TutorFact(id=fact_id, kind=kind, description=description, result_id=result_id))
        return fact_id

    challenge, attempt = inputs.challenge, inputs.attempt
    if challenge is not None:
        add("C", "challenge_goal", f"challenge “{challenge.title}”: {challenge.goal} Solved when: {challenge.success_condition}")
        if attempt is not None:
            add("C", "challenge_goal", f"the circuit submitted: {_describe_circuit(inputs.circuit)}")
            evaluated = [c for c in attempt.checks if c["evaluated"]]
            add(
                "E",
                "challenge_check",
                f"attempt {attempt.attempt_id}: {sum(1 for c in evaluated if c['passed'])} of {len(evaluated)} checks passed"
                f"{'' if len(evaluated) == len(attempt.checks) else f' ({len(attempt.checks) - len(evaluated)} not checked yet)'}; "
                f"overall {'solved' if attempt.passed else 'not solved yet'}",
            )
            for check in attempt.checks:
                text = f"check “{check['label']}”: {_state_word(check)}. {check['detail']}"
                for e in check["evidence"]:
                    text += f" {e['name'].replace('_', ' ')} {e['value']:.6f}."
                fact_id = add("E", "challenge_check", text, check["result_id"])
                if not check["passed"]:
                    coaching = _coaching(challenge, check["id"])
                    if coaching:
                        add("C", "challenge_coaching", f"about “{check['label']}” (see {fact_id}): {coaching[0]} {coaching[1]}")
    facts.extend(inputs.extra_facts)
    return facts


# ---------------------------------------------------------------------------------------------------- deterministic


def _ids(facts: list[TutorFact], *, kind: str | None = None, prefix: str | None = None) -> list[str]:
    return [f.id for f in facts if (kind is None or f.kind == kind) and (prefix is None or f.id.startswith(prefix))]


def _fact_for_check(facts: list[TutorFact], label: str) -> str | None:
    marker = f"check “{label}”:"
    return next((f.id for f in facts if f.kind == "challenge_check" and f.description.startswith(marker)), None)


def _challenge_report(inputs: DebugInputs, facts: list[TutorFact]) -> tuple[DebugSection, list[DebugSection], DebugSection, DebugSection, DebugSection | None]:
    challenge, attempt = inputs.challenge, inputs.attempt
    assert challenge is not None and attempt is not None
    summary_id = next(f.id for f in facts if f.id.startswith("E"))
    evaluated = [c for c in attempt.checks if c["evaluated"]]

    observed = DebugSection(
        text=(
            f"You submitted a circuit of {len(inputs.circuit.ops)} operation{'' if len(inputs.circuit.ops) == 1 else 's'} for "
            f"“{challenge.title}”. The server checked it: {sum(1 for c in evaluated if c['passed'])} of {len(evaluated)} checks passed, "
            f"so it is {'solved' if attempt.passed else 'not solved yet'}."
        ),
        fact_ids=[summary_id],
    )

    failing = [c for c in attempt.checks if not c["passed"]]
    evidence: list[DebugSection] = []
    for check in failing:
        fact_id = _fact_for_check(facts, check["label"])
        text = f"“{check['label']}” — {_state_word(check)}. {check['detail']}"
        for e in check["evidence"]:
            text += f" {e['name'].replace('_', ' ').capitalize()}: {e['value']:.6f}."
        evidence.append(DebugSection(text=text, fact_ids=[fact_id] if fact_id else []))
    if not failing:
        evidence.append(DebugSection(text="Every check passed.", fact_ids=[summary_id]))

    if attempt.passed:
        mismatch = DebugSection(text="No mismatch found: every check the server ran passed.", fact_ids=[summary_id])
        experiment = DebugSection(
            text="Try a different route to the same state (a different gate order or a different gate) and see that the checks still pass, or move on to the next challenge.",
            fact_ids=[],
        )
        return observed, evidence, mismatch, experiment, None

    # The first failing check that could actually be judged is the one to work on; a structure failure comes first by construction.
    focus = next((c for c in failing if c["evaluated"]), failing[0])
    coaching = _coaching(challenge, focus["id"])
    focus_fact = _fact_for_check(facts, focus["label"])
    coaching_fact = next((f.id for f in facts if f.kind == "challenge_coaching" and f"(see {focus_fact})" in f.description), None)
    cite = [i for i in (focus_fact, coaching_fact) if i]
    mismatch = DebugSection(
        text=coaching[0] if coaching else f"The check “{focus['label']}” is not met.",
        fact_ids=cite,
    )
    experiment = DebugSection(
        text=coaching[1] if coaching else "Run the circuit, open the trace and compare each step with what the challenge asks for.",
        fact_ids=cite,
    )
    hint_index = min(c["hint_index"] for c in failing)
    hint = (
        DebugSection(text=challenge.hints[hint_index], fact_ids=[]) if 0 <= hint_index < len(challenge.hints) else None
    )
    return observed, evidence, mismatch, experiment, hint


_OUTCOME_RE = re.compile(r"^outcome (\S+):")


def _result_report(inputs: DebugInputs, facts: list[TutorFact]) -> tuple[DebugSection, list[DebugSection], DebugSection, DebugSection, DebugSection | None]:
    record = inputs.record
    assert record is not None
    goal = clean_goal(inputs.goal)
    circuit_fact = next(f.id for f in facts if f.kind == "circuit_summary")
    status_fact = next(f.id for f in facts if f.kind == "execution_status")

    observed = DebugSection(
        text=f"Your circuit applies: {_describe_circuit(inputs.circuit)}. It was run on {record.backend} in {record.execution_mode} mode.",
        fact_ids=[circuit_fact, status_fact],
    )

    # The most likely outcomes, ordered by the backend's own numbers (only the order is computed here).
    payload = record.payload
    values = payload.get("probabilities") if "probabilities" in payload else payload.get("theoretical_probabilities", {})
    ranked = sorted(values or {}, key=lambda b: (-values[b], b))[:4]
    evidence: list[DebugSection] = []
    for bitstring in ranked:
        fact = next((f for f in facts if f.kind == "probability" and (m := _OUTCOME_RE.match(f.description)) and m.group(1) == bitstring), None)
        if fact:
            evidence.append(DebugSection(text=fact.description[0].upper() + fact.description[1:] + ".", fact_ids=[fact.id]))
    if not evidence:
        evidence.append(DebugSection(text="This run recorded no outcome data to report.", fact_ids=[status_fact]))

    step_note = ""
    step_ids: list[str] = []
    if inputs.step is not None and inputs.step.usable:
        step_ids = _ids(inputs.step.facts, kind="trace_step")[:1]
        step_note = f" You selected trace step {inputs.step.step_index + 1}; its facts are listed below."

    mismatch_text = (
        (f"Your goal, as you wrote it: “{goal}”. " if goal else "")
        + "No challenge is attached, so Qentor cannot check a goal written in your own words against the circuit. "
        "It can show exactly what the circuit did; the mismatch is whatever differs from what you expected."
        + step_note
    )
    mismatch = DebugSection(text=mismatch_text, fact_ids=step_ids)
    experiment = DebugSection(
        text=(
            "Open the trace and step through the circuit. Before each step, write down the state you expect, then compare it with what the "
            "backend produced; the first step where they differ is where your idea and the circuit part ways."
        ),
        fact_ids=[],
    )
    hint = DebugSection(
        text="Attach the circuit to a challenge if there is one for this idea: the server can then check each requirement and say which one fails.",
        fact_ids=[],
    )
    return observed, evidence, mismatch, experiment, hint


def _failed_run_report(inputs: DebugInputs) -> tuple[DebugSection, list[DebugSection], DebugSection, DebugSection, DebugSection | None]:
    record = inputs.record
    assert record is not None
    return (
        DebugSection(text=f"The run {record.result_id} did not produce a usable result ({record.verification_status.value}).", fact_ids=[]),
        [DebugSection(text="No numbers are shown for it: none of the backend's output can be trusted.", fact_ids=[])],
        DebugSection(text="The problem is in the run, not in your idea, so there is nothing to compare with what you expected.", fact_ids=[]),
        DebugSection(text="Run the circuit again. If it fails the same way, change one gate at a time to find what the backend cannot run.", fact_ids=[]),
        None,
    )


def deterministic_report(inputs: DebugInputs, facts: list[TutorFact]) -> DebugReport:
    if inputs.challenge is not None and inputs.attempt is not None:
        parts, grounded = _challenge_report(inputs, facts), "challenge"
    elif inputs.record is not None and inputs.record.verification_status == ExecutionStatus.STATE_CHECKED:
        parts, grounded = _result_report(inputs, facts), "result"
    elif inputs.record is not None:
        parts, grounded = _failed_run_report(inputs), "failed_run"
    else:  # pragma: no cover - the API refuses a request with neither
        raise ValueError("a debug report needs a judged attempt or an executed result")
    observed, evidence, mismatch, experiment, hint = parts
    return DebugReport(
        observed=observed,
        evidence=evidence,
        mismatch=mismatch,
        next_experiment=experiment,
        hint=hint,
        facts=facts,
        used_fallback_template=True,
        grounded_in=grounded,
    )


# -------------------------------------------------------------------------------------------------------- LLM path


class DebugGuardRejection(Exception):
    pass


# The claim guard licenses a verdict WORD from any result-backed fact, and "not passed" contains "passed" - so a draft that calls a
# failed attempt "passed" (or a passed one "failed") could slip past it. The attempt's own verdict is known here, so it is checked
# directly: a draft that contradicts it is rejected.
_SAYS_SOLVED = re.compile(
    r"\b(?:is|are|was|now|already|it's)\s+(?:fully\s+)?(?:solved|correct|right|successful|working)\b"
    r"|\bpassed\s+(?:all|every)\b|\ball\s+(?:the\s+)?checks?\s+(?:passed|pass)\b|\bsolves\b|\bsuccess(?:ful(?:ly)?)?\b",
    re.IGNORECASE,
)
_SAYS_NOT_SOLVED = re.compile(
    r"\bnot\s+(?:yet\s+)?(?:solved|correct|right)\b|\bfail(?:s|ed|ing|ure)?\b|\bincorrect\b|\bwrong\b|\bunsolved\b"
    r"|\bnot\s+passed\b|\bnot\s+met\b",
    re.IGNORECASE,
)


def validate_debug_draft(draft: DebugDraft, facts: list[TutorFact], attempt_passed: bool | None = None) -> DebugDraft:
    """The tutor's claim guard, applied to each prose field the model wrote, plus consistency with the attempt's own verdict
    (``attempt_passed``: what the server decided; ``None`` when there is no attempt). Raises ``DebugGuardRejection``."""
    known = {f.id for f in facts}
    if not isinstance(draft.cited_fact_ids, list) or any(fid not in known for fid in draft.cited_fact_ids):
        raise DebugGuardRejection("draft cites a fact id that is not in the fact sheet")
    for name in ("observed", "mismatch", "next_experiment"):
        text = getattr(draft, name)
        if not isinstance(text, str) or not text.strip():
            raise DebugGuardRejection(f"draft field {name!r} is empty")
        violations = find_violations(text, facts)
        if violations:
            raise DebugGuardRejection(f"draft field {name!r} makes a claim the facts do not support: {violations[0]}")
        if attempt_passed is False and _SAYS_SOLVED.search(text):
            raise DebugGuardRejection(f"draft field {name!r} says the attempt succeeded; the server judged it not solved")
        if attempt_passed is True and _SAYS_NOT_SOLVED.search(text):
            raise DebugGuardRejection(f"draft field {name!r} says the attempt failed; the server judged it solved")
    return draft


def debug_circuit(inputs: DebugInputs, llm: LLMAdapter | None, language: str = "en") -> DebugReport:
    """The deterministic report, with its prose optionally rewritten by the LLM after the guard accepts it.

    Never raises for an LLM problem: unavailable, malformed or rejected drafts fall back to the template. Evidence and hint are never
    replaced.
    """
    facts = build_debug_facts(inputs)
    report = deterministic_report(inputs, facts)
    if llm is None or report.grounded_in == "failed_run" or not hasattr(llm, "generate_debug"):
        return report
    try:
        draft = llm.generate_debug(facts, clean_goal(inputs.goal), language)  # type: ignore[attr-defined]
        validate_debug_draft(draft, facts, inputs.attempt.passed if inputs.attempt else None)
    except (LLMUnavailable, DebugGuardRejection):
        return report
    cited = list(dict.fromkeys(draft.cited_fact_ids))
    return report.model_copy(
        update={
            "observed": DebugSection(text=draft.observed.strip(), fact_ids=cited),
            "mismatch": DebugSection(text=draft.mismatch.strip(), fact_ids=cited),
            "next_experiment": DebugSection(text=draft.next_experiment.strip(), fact_ids=cited),
            "used_fallback_template": False,
        }
    )
