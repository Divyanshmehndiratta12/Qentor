"""Judge a submitted circuit against a challenge. Deterministic, backend-only, no LLM.

Order of work:

1. **Structure** (canonical model only): width, allowed gates, size, required gates, the locked anchor, terminal
   measurements. If any of it fails, no backend runs and every state check is reported as not evaluated - there is no
   honest state to look at yet, and none is invented.
2. **The learner's circuit is traced** on the given adapter (Qiskit Aer in production) with ``trace_circuit``: one
   statevector-mode run per operation, each persisted as an ordinary provenance record through ``record_execution``.
   Every state check reads one of those steps, and its outcome names the step's ``result_id``.
3. **Each check** compares that learner state with a state the same adapter produced for a reference circuit (fidelity up
   to global phase, marginal probabilities, or a property of the state itself). The reference states are computed at
   evaluation time from the challenge's canonical circuits; nothing is hard-coded.

The numbers in ``evidence`` are verification quantities (fidelities, probability differences) computed here from
backend statevectors - the frontend and the tutor only display them. Pass/fail is ``all(check.passed)``.
"""

from __future__ import annotations

from typing import Callable

from pydantic import BaseModel, ConfigDict

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import ExecutionAdapter, ExecutionResult
from qentor.execution.expectation import z_expectation
from qentor.execution.noise import NoiseError, make_noise_config, run_noisy_shots
from qentor.execution.reduced_state import qubit_bloch
from qentor.execution.trace import (
    ExecutionTrace,
    TraceNotSupported,
    require_usable_state,
    split_terminal_measurements,
    trace_circuit,
)

from qentor.verification.equivalence import EquivalenceStatus, check_equivalence

from .models import (
    Challenge,
    EndsInBasisState,
    EquivalentTo,
    ExpectationMatches,
    NoisyOutcomeShare,
    PassesThroughSuperposition,
    Point,
    ProbabilitiesMatch,
    QubitStateMatches,
    StateDiffers,
    StateMatches,
)

VERIFIER = "challenge/1"
# docs/VERIFICATION_ARCHITECTURE.md: exact statevectors, tolerance 1e-9.
TOLERANCE = 1e-9
# "A different state" must differ by a clear margin, not by rounding noise.
MIN_DIFFERENCE = 1e-6

State = list[list[float]]


class Evidence(BaseModel):
    """One number a check computed, named. Always derived from backend statevectors."""

    model_config = ConfigDict(extra="forbid")

    name: str
    value: float


class CheckOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    passed: bool
    # False when the check could not be judged (structure failed first): it is neither passed nor failed on its merits.
    evaluated: bool = True
    # Qualitative on purpose: numbers live in ``evidence`` where they carry provenance.
    detail: str
    hint_index: int
    evidence: list[Evidence] = []
    # The learner's own provenance record this check examined (a step of their traced circuit); None for structure checks.
    result_id: str | None = None


class ChallengeEvaluation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    challenge_id: str
    circuit_hash: str
    passed: bool
    checks: list[CheckOutcome]
    verifier: str = VERIFIER
    backend: str | None = None
    backend_version: str | None = None
    # The record of the learner's circuit's final state (what Run would have produced); None if nothing ran.
    final_result_id: str | None = None
    # The hint to show next: the lowest hint index among failed checks. None when passed.
    next_hint_index: int | None = None


RecordExecution = Callable[[ExecutionResult, str], str]


# --------------------------------------------------------------------------------------------------- state maths


def fidelity(a: State, b: State) -> float:
    """|<a|b>|^2 - 1 for the same state up to global phase, 0 for orthogonal states."""
    re = sum(ar * br + ai * bi for (ar, ai), (br, bi) in zip(a, b))
    im = sum(ar * bi - ai * br for (ar, ai), (br, bi) in zip(a, b))
    return re * re + im * im


def probabilities(state: State) -> list[float]:
    return [re * re + im * im for re, im in state]


def marginal(state: State, qubits: list[int] | None, num_qubits: int) -> dict[str, float]:
    """Outcome distribution over ``qubits`` (default all), keyed ``q[k]…q[j]`` highest index first."""
    chosen = sorted(range(num_qubits) if qubits is None else qubits, reverse=True)
    out: dict[str, float] = {}
    for index, p in enumerate(probabilities(state)):
        if p <= 0.0:
            continue
        key = "".join(str((index >> q) & 1) for q in chosen)
        out[key] = out.get(key, 0.0) + p
    return out


# ------------------------------------------------------------------------------------------------------ structure


def _plural(count: int, noun: str) -> str:
    return noun if count == 1 else f"{noun}s"


def describe_op(op: GateOp) -> str:
    """``cx q[0]→q[2]`` style text for a gate, for feedback messages."""
    controls = [f"q[{c}]" for c in op.controls]
    targets = [f"q[{t}]" for t in op.targets]
    return f"{op.gate.value} {' '.join(controls + targets) if not controls else ','.join(controls) + '→' + ','.join(targets)}"


def describe_ops(ops: list[GateOp]) -> str:
    return ", then ".join(describe_op(op) for op in ops)


def _same_op(a: GateOp, b: GateOp) -> bool:
    """Equal ops. CZ is symmetric (it phases |11> whichever qubit is called the control), so a CZ with its two qubits named the
    other way round is the same gate; nothing else is treated as interchangeable."""
    if a == b:
        return True
    if a.gate is GateName.CZ and b.gate is GateName.CZ:
        return {*a.controls, *a.targets} == {*b.controls, *b.targets} and a.params == b.params and a.clbits == b.clbits
    return False


def _find_anchor(ops: list[GateOp], anchor: list[GateOp]) -> list[int]:
    """Start indexes where ``anchor`` occurs back to back."""
    if not anchor:
        return []
    return [
        i
        for i in range(len(ops) - len(anchor) + 1)
        if all(_same_op(have, want) for have, want in zip(ops[i : i + len(anchor)], anchor))
    ]


def _structure_checks(challenge: Challenge, circuit: Circuit) -> tuple[list[CheckOutcome], int | None]:
    rules = challenge.constraints
    outcomes: list[CheckOutcome] = []

    def add(check_id: str, label: str, ok: bool, detail_ok: str, detail_bad: str) -> None:
        outcomes.append(CheckOutcome(id=check_id, label=label, passed=ok, detail=detail_ok if ok else detail_bad, hint_index=0))

    add(
        "structure.width",
        f"Uses {rules.num_qubits} qubit{'s' if rules.num_qubits != 1 else ''}",
        circuit.num_qubits == rules.num_qubits,
        "The circuit has the required number of qubits.",
        f"This challenge needs exactly {rules.num_qubits} qubit{'s' if rules.num_qubits != 1 else ''}; the circuit has {circuit.num_qubits}.",
    )

    allowed = set(rules.allowed_gates)
    outside = sorted({op.gate.value for op in circuit.ops if op.gate not in allowed})
    add(
        "structure.gates",
        "Uses only the allowed gates",
        not outside,
        "Every gate is one this challenge allows.",
        f"Not allowed here: {', '.join(outside)}. Allowed: {', '.join(sorted(g.value for g in allowed))}.",
    )

    add(
        "structure.size",
        f"Uses at most {rules.max_ops} {_plural(rules.max_ops, 'operation')}",
        len(circuit.ops) <= rules.max_ops,
        "The circuit is within the size limit.",
        f"The circuit has {len(circuit.ops)} {_plural(len(circuit.ops), 'operation')}; this challenge allows at most {rules.max_ops}.",
    )

    for gate, needed in sorted(rules.min_gate_counts.items(), key=lambda kv: kv[0].value):
        have = sum(1 for op in circuit.ops if op.gate is gate)
        add(
            f"structure.uses_{gate.value}",
            f"Uses {gate.value.upper()} at least {needed} time{'s' if needed != 1 else ''}",
            have >= needed,
            f"{gate.value.upper()} is used as required.",
            f"This challenge needs at least {needed} {gate.value.upper()} gate{'s' if needed != 1 else ''}; the circuit has {have}.",
        )

    if rules.gate_qubits:
        offences: list[str] = []
        for op in circuit.ops:
            permitted = rules.gate_qubits.get(op.gate)
            if permitted is None:
                continue
            strays = sorted({q for q in (*op.targets, *op.controls) if q not in permitted})
            if strays:
                offences.append(
                    f"{op.gate.value} may only act on {', '.join(f'q[{q}]' for q in sorted(permitted))}, but one acts on "
                    f"{', '.join(f'q[{q}]' for q in strays)}"
                )
        add(
            "structure.gate_qubits",
            "Keeps each gate on the qubits it is allowed to touch",
            not offences,
            "Every restricted gate acts only on its allowed qubits.",
            f"{offences[0]}." if offences else "",
        )

    anchor_start: int | None = None
    if rules.anchor:
        starts = _find_anchor(list(circuit.ops), list(rules.anchor))
        anchor_start = starts[0] if len(starts) == 1 else None
        name = rules.anchor_name
        add(
            "structure.oracle",
            f"Keeps the fixed {name} exactly as given",
            len(starts) == 1,
            f"The fixed {name}: present once, unchanged and in order.",
            (
                f"Keep the fixed {name} as given: exactly these gates, once, back to back and in this order: {describe_ops(rules.anchor)}."
                if not starts
                else f"Keep the fixed {name} as given: it appears more than once here, and it must appear exactly once."
            ),
        )

    if rules.must_measure:
        try:
            _, terminal = split_terminal_measurements(circuit)
            terminal_ok = True
        except TraceNotSupported:
            terminal, terminal_ok = [], False
        measured = {m.operation.targets[0] for m in terminal}
        missing = [q for q in rules.must_measure if q not in measured]
        add(
            "structure.measure",
            "Measures the answer qubits at the end",
            terminal_ok and not missing,
            "The answer qubits are measured at the end of the circuit.",
            (
                "A measurement must be the last thing done: no gate may follow one."
                if not terminal_ok
                else f"Measure qubit{'s' if len(missing) != 1 else ''} {', '.join(f'q[{q}]' for q in missing)} at the end."
            ),
        )
    else:
        # Even with nothing required, a measurement followed by a gate cannot be judged.
        try:
            split_terminal_measurements(circuit)
        except TraceNotSupported:
            add(
                "structure.measure",
                "Measurements come last",
                False,
                "",
                "A measurement must be the last thing done: no gate may follow one.",
            )

    return outcomes, anchor_start


# -------------------------------------------------------------------------------------------------------- states


def _reference_state(adapter: ExecutionAdapter, circuit: Circuit) -> State:
    """The state the adapter itself produces for a reference circuit (measurements stripped; never recorded)."""
    unitary, _ = split_terminal_measurements(circuit)
    prefix = Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=unitary)
    result = adapter.run(prefix, "statevector")
    require_usable_state(result, circuit.num_qubits, circuit_hash(prefix))
    assert result.statevector is not None
    return result.statevector


def _step_index(point: Point, anchor_start: int | None, anchor_len: int, last: int) -> int:
    if point is Point.FINAL:
        return last
    assert anchor_start is not None  # validated: a non-final check requires an anchor
    return anchor_start if point is Point.BEFORE_ANCHOR else anchor_start + anchor_len


def _substituted_circuit(circuit: Circuit, anchor_start: int, anchor_len: int, replacement: list[GateOp]) -> Circuit:
    """``circuit`` with its locked anchor ops swapped for ``replacement`` (everything else untouched, order kept)."""
    ops = [*circuit.ops[:anchor_start], *replacement, *circuit.ops[anchor_start + anchor_len :]]
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=ops)


def _judge_states(
    challenge: Challenge,
    adapter: ExecutionAdapter,
    trace: ExecutionTrace,
    anchor_start: int | None,
    circuit: Circuit,
    run_trace: Callable[[Circuit], ExecutionTrace],
    run_noisy: "Callable[[NoisyOutcomeShare], tuple[ExecutionResult, str | None]] | None" = None,
) -> list[CheckOutcome]:
    steps = trace.steps
    last = len(steps) - 1
    anchor_len = len(challenge.constraints.anchor)
    n = trace.num_qubits
    outcomes: list[CheckOutcome] = []
    substituted: dict[str, ExecutionTrace] = {}

    def judged_step(check, default_index: int):
        """The learner's step a check reads: from the plain trace, or, when the check substitutes the anchor, the final step of
        the learner's circuit run again with the anchor swapped (traced and recorded like the plain run)."""
        replacement = getattr(check, "replace_anchor", None)
        if replacement is None:
            return steps[default_index]
        assert anchor_start is not None  # validated: a replacing check requires an anchor
        key = describe_ops(replacement)
        if key not in substituted:
            substituted[key] = run_trace(_substituted_circuit(circuit, anchor_start, anchor_len, list(replacement)))
        return substituted[key].steps[-1]

    for check in challenge.checks:
        base = {"id": check.id, "label": check.label, "hint_index": check.hint_index}

        if isinstance(check, QubitStateMatches):
            step = judged_step(check, _step_index(check.at, anchor_start, anchor_len, last))
            mine = qubit_bloch(step.statevector, check.qubit, n)
            theirs = qubit_bloch(_reference_state(adapter, check.target), check.qubit, n)
            if mine is None or theirs is None:
                outcomes.append(
                    CheckOutcome(
                        **base,
                        passed=False,
                        detail="The qubit's own state could not be worked out from the backend's state, so it is not accepted.",
                        result_id=step.result_id,
                    )
                )
                continue
            distance = sum((a - b) ** 2 for a, b in zip(mine[:3], theirs[:3])) ** 0.5
            ok = distance <= TOLERANCE
            outcomes.append(
                CheckOutcome(
                    **base,
                    passed=ok,
                    detail=(
                        "The qubit's own state is the required state."
                        if ok
                        else "The qubit's own state is not the required state (it may be entangled with the others, or hold a different state)."
                    ),
                    evidence=[Evidence(name="bloch_vector_distance", value=distance), Evidence(name="qubit_purity", value=mine[3])],
                    result_id=step.result_id,
                )
            )

        elif isinstance(check, (StateMatches, StateDiffers, ProbabilitiesMatch)):
            step = judged_step(check, _step_index(check.at, anchor_start, anchor_len, last))
            state = step.statevector
            common = {**base, "result_id": step.result_id}

            if isinstance(check, StateMatches):
                f = fidelity(state, _reference_state(adapter, check.target))
                ok = 1.0 - f <= TOLERANCE
                outcomes.append(
                    CheckOutcome(
                        **common,
                        passed=ok,
                        detail="The state is the required state (up to global phase)." if ok else "The state is not the required state.",
                        evidence=[Evidence(name="fidelity", value=f)],
                    )
                )
            elif isinstance(check, StateDiffers):
                f = fidelity(state, _reference_state(adapter, check.other))
                ok = 1.0 - f > MIN_DIFFERENCE
                outcomes.append(
                    CheckOutcome(
                        **common,
                        passed=ok,
                        detail=(
                            "The state is genuinely different from the comparison state."
                            if ok
                            else "The state is the same as the comparison state, even allowing for global phase."
                        ),
                        evidence=[Evidence(name="fidelity", value=f)],
                    )
                )
            else:
                mine = marginal(state, check.qubits, n)
                theirs = marginal(_reference_state(adapter, check.target), check.qubits, n)
                gap = max(abs(mine.get(k, 0.0) - theirs.get(k, 0.0)) for k in {*mine, *theirs})
                ok = gap <= TOLERANCE
                outcomes.append(
                    CheckOutcome(
                        **common,
                        passed=ok,
                        detail=(
                            "A measurement would give the required outcomes with the required probabilities."
                            if ok
                            else "A measurement would not give the required outcomes."
                        ),
                        evidence=[Evidence(name="largest_probability_difference", value=gap)],
                    )
                )

        elif isinstance(check, EquivalentTo):
            report = check_equivalence(check.target, circuit)
            ok = report.status is EquivalenceStatus.EQUIVALENT
            if ok:
                detail = "The circuit does exactly what the starting circuit does (operator equivalence up to global phase, decided by the backend)."
            elif report.status is EquivalenceStatus.NOT_EQUIVALENT:
                detail = "The circuit does not do what the starting circuit does: the backend's equivalence check found a difference."
            else:
                detail = f"The backend could not decide whether the circuits are equivalent, so this does not pass: {report.reason or 'unverifiable'}."
            outcomes.append(CheckOutcome(**base, passed=ok, detail=detail, result_id=steps[last].result_id))

        elif isinstance(check, ExpectationMatches):
            step = steps[last]
            value = z_expectation(step.statevector, check.qubit, n) if check.qubit < n else None
            if value is None:
                outcomes.append(
                    CheckOutcome(
                        **base,
                        passed=False,
                        detail="The expectation value could not be read from the backend's state, so it is not accepted.",
                        result_id=step.result_id,
                    )
                )
                continue
            gap = abs(value - check.value)
            ok = gap <= check.tolerance
            outcomes.append(
                CheckOutcome(
                    **base,
                    passed=ok,
                    detail=(
                        "The expectation value is the one the challenge asks for."
                        if ok
                        else "The expectation value is not the one the challenge asks for yet."
                    ),
                    evidence=[Evidence(name=f"expectation_{check.observable.lower()}", value=value)],
                    result_id=step.result_id,
                )
            )

        elif isinstance(check, NoisyOutcomeShare):
            assert run_noisy is not None  # evaluate_challenge always supplies it
            try:
                noisy, record_id = run_noisy(check)
            except NoiseError as exc:
                outcomes.append(CheckOutcome(**base, passed=False, detail=f"This circuit cannot be run under the challenge's simulated noise: {exc.message}", result_id=None))
                continue
            share = (noisy.counts or {}).get(check.outcome, 0) / check.shots
            ok = share >= check.min_share
            outcomes.append(
                CheckOutcome(
                    **base,
                    passed=ok,
                    detail=(
                        "Under the challenge's simulated noise, enough shots still landed on the required outcome."
                        if ok
                        else "Under the challenge's simulated noise, too few shots landed on the required outcome: every gate is another chance for noise to disturb the qubits it touches."
                    ),
                    evidence=[Evidence(name="noisy_share_of_required_outcome", value=share), Evidence(name="required_share", value=check.min_share)],
                    result_id=record_id,
                )
            )

        elif isinstance(check, PassesThroughSuperposition):
            middle = steps[1:last]
            maxima = [(max(probabilities(s.statevector)), s) for s in middle]
            hit = next(((m, s) for m, s in maxima if m <= 0.5 + TOLERANCE), None)
            outcomes.append(
                CheckOutcome(
                    **base,
                    passed=hit is not None,
                    detail=(
                        "The circuit passes through a genuine superposition before the end."
                        if hit
                        else "No intermediate state is a superposition: the qubit is in a definite state after every step."
                    ),
                    evidence=[Evidence(name="lowest_top_outcome_probability", value=min(m for m, _ in maxima))] if maxima else [],
                    result_id=(hit[1].result_id if hit else steps[last].result_id),
                )
            )

        elif isinstance(check, EndsInBasisState):
            top = max(probabilities(steps[last].statevector))
            ok = top >= 1.0 - TOLERANCE
            outcomes.append(
                CheckOutcome(
                    **base,
                    passed=ok,
                    detail="The final state is a single definite outcome." if ok else "The final state is still a superposition of outcomes.",
                    evidence=[Evidence(name="top_outcome_probability", value=top)],
                    result_id=steps[last].result_id,
                )
            )

    return outcomes


# ------------------------------------------------------------------------------------------------------- entry


def evaluate_challenge(
    challenge: Challenge,
    circuit: Circuit,
    adapter: ExecutionAdapter,
    *,
    max_qubits: int,
    max_operations: int,
    record_execution: RecordExecution | None = None,
) -> ChallengeEvaluation:
    """Judge ``circuit`` against ``challenge``.

    Raises whatever the trace/adapters raise (``TraceBackendFault``, ``AdapterUnavailable``, ``AdapterExecutionError``);
    the API layer maps those to honest errors. A failing circuit is NOT an exception: it is a normal evaluation with
    ``passed = False`` and structured checks.
    """
    structure, anchor_start = _structure_checks(challenge, circuit)
    structure_ok = all(c.passed for c in structure)
    chash = circuit_hash(circuit)

    if not structure_ok:
        skipped = [
            CheckOutcome(
                id=c.id,
                label=c.label,
                passed=False,
                evaluated=False,
                detail="Not evaluated yet: fix the circuit's structure first.",
                hint_index=c.hint_index,
            )
            for c in challenge.checks
        ]
        checks = [*structure, *skipped]
        return ChallengeEvaluation(
            challenge_id=challenge.id,
            circuit_hash=chash,
            passed=False,
            checks=checks,
            next_hint_index=_next_hint(checks),
        )

    trace = trace_circuit(
        circuit,
        adapter,
        max_qubits=max_qubits,
        max_operations=max_operations,
        record_execution=record_execution,
    )
    def run_trace(variant: Circuit) -> ExecutionTrace:
        return trace_circuit(
            variant, adapter, max_qubits=max_qubits, max_operations=max_operations, record_execution=record_execution
        )

    def run_noisy(check: NoisyOutcomeShare) -> tuple[ExecutionResult, str | None]:
        # The learner's circuit under the check's own fixed, seeded configuration, run by Aer's noisy simulator and recorded like any other run.
        result = run_noisy_shots(circuit, check.shots, make_noise_config(check.noise_model, check.noise_strength, check.seed))
        return result, (record_execution(result, chash) if record_execution else None)

    states = _judge_states(challenge, adapter, trace, anchor_start, circuit, run_trace, run_noisy)
    checks = [*structure, *states]
    return ChallengeEvaluation(
        challenge_id=challenge.id,
        circuit_hash=chash,
        passed=all(c.passed for c in checks),
        checks=checks,
        backend=trace.backend,
        backend_version=trace.backend_version,
        final_result_id=trace.final_result_id,
        next_hint_index=_next_hint(checks),
    )


def _next_hint(checks: list[CheckOutcome]) -> int | None:
    failed = [c.hint_index for c in checks if not c.passed]
    return min(failed) if failed else None
