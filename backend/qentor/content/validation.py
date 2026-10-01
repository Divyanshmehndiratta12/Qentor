"""A validation layer for the lesson and challenge content, written to fail in words a content author can act on.

The pydantic models already refuse the shapes they can see at construction (a duplicate section id, a question without its
key). This layer checks what a single model cannot: things that span lessons, challenges, the gate-support table, the API's
routes and the simulator. It works on plain attribute reads, never on the assumption that a model was validated, so a
catalog assembled with ``model_construct`` or ``model_copy`` (which skip validation) is judged on what it says.

Every finding is a ``Problem``: a stable ``code``, the lesson (and section) it is about, and a message that names the exact
culprit ("lesson 'phase' references gate 'cy', which the canonical model does not have"). ``validate_content`` runs every check
and returns a ``ContentReport``; nothing raises for a content defect, and nothing here edits content.

What is checked
  prerequisites     every id names a lesson, none is the lesson itself, none repeats, and the graph has no cycle
  section ids       unique within a lesson
  concept checks    a real question, at least two distinct non-blank options, a key that is one of them, and a non-blank
                    explanation (``allow_prompt_only_checks`` lets a prompt-only check through)
  linked circuits   only gates the canonical model has, a well-formed circuit, every gate supported on every backend, within
                    the run limits, and - when the simulator is available - actually run on Qiskit Aer (statevector for the
                    unitary part, shots when it measures) with a well-formed result
  lab capability    a lab names a capability that exists, that capability has an API route (and the route is registered, when
                    the caller says which routes exist), and the lesson has a circuit for the lab to run
  challenges        every challenge names a lesson that exists; every lesson has a challenge OR says, in ``no_challenge_reason``,
                    why not; a reason that contradicts an existing challenge is flagged as stale; a challenge's circuits use
                    only supported gates
  registry          lesson ids and challenge ids are unique, and the registry's lookup tables agree with the catalogs

A check that could not run (the simulator is unavailable here) is listed in ``skipped``, never passed silently.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Collection, Iterable, Mapping, Sequence, get_args

from qentor.challenges import CHALLENGES, CHALLENGE_BY_ID
from qentor.circuit.model import Circuit, GateName
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionAdapter
from qentor.execution.capabilities import SUPPORTED_GATES
from qentor.execution.limits import LimitExceeded, check_run_limits
from qentor.execution.sanity import state_problems
from qentor.execution.trace import TraceNotSupported, split_terminal_measurements
from qentor.lessons import LESSONS
from qentor.lessons.models import ConceptCheckSection, InteractiveLabSection, LabCapability
from qentor.lessons.registry import LESSON_BY_ID

# The API route each lab capability points the learner at (the endpoints `LabCapability` documents). A capability with no entry
# here is itself a problem: a lab cannot name something the platform has no endpoint for.
CAPABILITY_ROUTES: dict[str, tuple[str, str]] = {
    "execute": ("POST", "/api/execute"),
    "verify_bell_state": ("POST", "/api/verify/bell-state"),
    "multi_input_test": ("POST", "/api/test/multi-input"),
    "optimize": ("POST", "/api/optimize"),
}

_SHOTS_PROBE = 16
_KNOWN_GATES = frozenset(g.value for g in GateName)


@dataclass(frozen=True)
class Problem:
    code: str
    message: str
    lesson_id: str | None = None
    section_id: str | None = None

    def __str__(self) -> str:
        where = "".join(
            part
            for part in (
                f"lesson {self.lesson_id!r}" if self.lesson_id is not None else "",
                f", section {self.section_id!r}" if self.section_id is not None else "",
            )
        ).lstrip(", ")
        return f"[{self.code}] {where + ': ' if where else ''}{self.message}"


@dataclass
class ContentReport:
    problems: list[Problem] = field(default_factory=list)
    # Checks that could not run here (e.g. the simulator is unavailable). Not failures, and not passes.
    skipped: list[str] = field(default_factory=list)
    # How much was looked at, so a pass can be told from a vacuous pass.
    checked: dict[str, int] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.problems

    def codes(self) -> set[str]:
        return {p.code for p in self.problems}

    def by_code(self, code: str) -> list[Problem]:
        return [p for p in self.problems if p.code == code]

    def __str__(self) -> str:
        lines = [str(p) for p in self.problems] or ["no problems found"]
        lines += [f"skipped: {s}" for s in self.skipped]
        lines.append("checked: " + ", ".join(f"{k}={v}" for k, v in sorted(self.checked.items())))
        return "\n".join(lines)


# --------------------------------------------------------------------------- helpers


def _gate_name(gate: Any) -> str:
    return gate.value if isinstance(gate, GateName) else str(gate)


def _sections(lesson: Any) -> Sequence[Any]:
    return list(getattr(lesson, "sections", []) or [])


def _label(lesson: Any) -> str:
    return getattr(lesson, "id", "<no id>")


# --------------------------------------------------------------------------- individual checks


def check_prerequisites(lessons: Sequence[Any]) -> list[Problem]:
    problems: list[Problem] = []
    known = {_label(l) for l in lessons}
    graph: dict[str, list[str]] = {}
    for lesson in lessons:
        lid = _label(lesson)
        prereqs = list(getattr(lesson, "prerequisite_lesson_ids", []) or [])
        graph[lid] = [p for p in prereqs if p in known and p != lid]
        seen: set[str] = set()
        for p in prereqs:
            if p == lid:
                problems.append(Problem("PREREQUISITE_SELF", f"lists itself as its own prerequisite", lid))
            elif p not in known:
                problems.append(Problem("PREREQUISITE_UNKNOWN", f"lists prerequisite {p!r}, which is not a lesson in the catalog", lid))
            if p in seen:
                problems.append(Problem("PREREQUISITE_DUPLICATE", f"lists prerequisite {p!r} more than once", lid))
            seen.add(p)

    # A cycle means no lesson in it can ever be unlocked. Report each one once, as the path a reader can follow.
    state: dict[str, int] = {}
    stack: list[str] = []
    reported: set[frozenset[str]] = set()

    def visit(node: str) -> None:
        state[node] = 1
        stack.append(node)
        for nxt in graph.get(node, []):
            if state.get(nxt, 0) == 0:
                visit(nxt)
            elif state[nxt] == 1:
                cycle = stack[stack.index(nxt) :] + [nxt]
                key = frozenset(cycle)
                if key not in reported:
                    reported.add(key)
                    problems.append(Problem("PREREQUISITE_CYCLE", "prerequisites form a cycle: " + " -> ".join(cycle), nxt))
        stack.pop()
        state[node] = 2

    for lid in graph:
        if state.get(lid, 0) == 0:
            visit(lid)
    return problems


def check_section_ids(lessons: Sequence[Any]) -> list[Problem]:
    problems: list[Problem] = []
    for lesson in lessons:
        ids = [getattr(s, "id", None) for s in _sections(lesson)]
        for dup in sorted({i for i in ids if i is not None and ids.count(i) > 1}):
            problems.append(Problem("SECTION_ID_DUPLICATE", f"section id {dup!r} is used {ids.count(dup)} times", _label(lesson), dup))
        for blank in [s for s in _sections(lesson) if not str(getattr(s, "id", "") or "").strip()]:
            problems.append(Problem("SECTION_ID_BLANK", "a section has a blank id", _label(lesson)))
    return problems


def check_concept_checks(lessons: Sequence[Any], *, allow_prompt_only: bool = False) -> list[Problem]:
    problems: list[Problem] = []
    for lesson in lessons:
        lid = _label(lesson)
        for section in _sections(lesson):
            if getattr(section, "type", None) != "concept_check":
                continue
            sid = getattr(section, "id", None)
            question = getattr(section, "question", None)
            options = getattr(section, "options", None)
            key = getattr(section, "correct_option_id", None)
            explanation = getattr(section, "explanation", None)

            if question is None or not str(question).strip() or options is None:
                if not allow_prompt_only:
                    problems.append(
                        Problem("CONCEPT_CHECK_NOT_GRADED", "is a prompt with no question, so the server has nothing to grade", lid, sid)
                    )
                continue

            option_ids = [getattr(o, "id", None) for o in options]
            if len(option_ids) < 2:
                problems.append(Problem("CONCEPT_CHECK_TOO_FEW_OPTIONS", f"has {len(option_ids)} option(s); a question needs at least 2", lid, sid))
            for dup in sorted({i for i in option_ids if option_ids.count(i) > 1}):
                problems.append(Problem("CONCEPT_CHECK_OPTION_ID_DUPLICATE", f"option id {dup!r} is used more than once", lid, sid))
            for option in options:
                if not str(getattr(option, "text", "") or "").strip():
                    problems.append(Problem("CONCEPT_CHECK_OPTION_BLANK", f"option {getattr(option, 'id', None)!r} has no text", lid, sid))
            if key is None or key not in option_ids:
                problems.append(
                    Problem("CONCEPT_CHECK_KEY_NOT_AN_OPTION", f"its answer key {key!r} is not one of the options {option_ids}", lid, sid)
                )
            if explanation is None or not str(explanation).strip():
                problems.append(Problem("CONCEPT_CHECK_NO_EXPLANATION", "has no explanation to return with the verdict", lid, sid))
    return problems


def check_linked_circuits_static(lessons: Sequence[Any]) -> list[Problem]:
    problems: list[Problem] = []
    for lesson in lessons:
        lid = _label(lesson)
        circuit = getattr(lesson, "linked_circuit", None)
        if circuit is None:
            continue
        ops = list(getattr(circuit, "ops", []) or [])
        unknown = sorted({_gate_name(op.gate) for op in ops if _gate_name(getattr(op, "gate", None)) not in _KNOWN_GATES})
        for gate in unknown:
            problems.append(
                Problem("LINKED_CIRCUIT_UNKNOWN_GATE", f"its linked circuit references gate {gate!r}, which the canonical model does not have", lid)
            )
        if not unknown:
            # Re-validate from plain data: a circuit assembled without validation (index out of range, wrong arity) is caught here.
            try:
                Circuit.model_validate(circuit.model_dump(by_alias=True))
            except Exception as exc:  # noqa: BLE001 - report whatever the model objects to
                first = str(exc).strip().splitlines()[1:3]
                problems.append(Problem("LINKED_CIRCUIT_INVALID", "its linked circuit is not a valid canonical circuit: " + " ".join(s.strip() for s in first), lid))
                continue
        used = {_gate_name(op.gate) for op in ops} & _KNOWN_GATES
        for backend, supported in sorted(SUPPORTED_GATES.items()):
            missing = sorted(used - {g.value for g in supported})
            if missing:
                problems.append(
                    Problem("LINKED_CIRCUIT_GATE_UNSUPPORTED", f"its linked circuit uses {', '.join(missing)}, which backend {backend!r} cannot run", lid)
                )
    return problems


def _run_circuit(circuit: Circuit, adapter: ExecutionAdapter) -> list[str]:
    """Run ``circuit`` the way the Lab would; return the reasons it cannot be run (empty when it runs and the results are sane)."""
    reasons: list[str] = []
    check_run_limits(circuit, adapter.name)

    try:
        unitary_ops, _ = split_terminal_measurements(circuit)
        unitary = Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=unitary_ops)
        result = adapter.run(unitary, "statevector")
        reasons += [f"statevector run: {p}" for p in state_problems(result, circuit.num_qubits)]
    except TraceNotSupported:
        pass  # a mid-circuit measurement has no deterministic state to trace; it is still run in shots mode below

    if any(getattr(op.gate, "value", op.gate) == "measure" for op in circuit.ops):
        result = adapter.run(circuit, "shots", _SHOTS_PROBE)
        reasons += [f"shots run: {p}" for p in state_problems(result, circuit.num_qubits, shots=_SHOTS_PROBE)]
    return reasons


def check_linked_circuits_execute(lessons: Sequence[Any], adapter: ExecutionAdapter) -> tuple[list[Problem], list[str], int]:
    """Run every linked circuit on ``adapter``. Returns ``(problems, skipped, circuits_run)``."""
    problems: list[Problem] = []
    skipped: list[str] = []
    ran = 0
    for lesson in lessons:
        lid = _label(lesson)
        circuit = getattr(lesson, "linked_circuit", None)
        if circuit is None:
            continue
        if any(_gate_name(op.gate) not in _KNOWN_GATES for op in getattr(circuit, "ops", [])):
            continue  # already reported as LINKED_CIRCUIT_UNKNOWN_GATE; there is nothing the backend could run
        try:
            reasons = _run_circuit(circuit, adapter)
        except LimitExceeded as exc:
            problems.append(Problem("LINKED_CIRCUIT_OVER_LIMIT", f"its linked circuit cannot be run: {exc.message}", lid))
            continue
        except AdapterUnavailable as exc:
            skipped.append(f"executing linked circuits: backend {adapter.name!r} is unavailable ({exc})")
            return problems, skipped, ran
        except AdapterExecutionError as exc:
            problems.append(Problem("LINKED_CIRCUIT_EXECUTION_FAILED", f"its linked circuit did not run on {adapter.name}: {exc}", lid))
            continue
        except Exception as exc:  # noqa: BLE001 - a circuit that makes the backend throw is a finding, not a crash of the validator
            problems.append(Problem("LINKED_CIRCUIT_EXECUTION_FAILED", f"its linked circuit raised {type(exc).__name__} on {adapter.name}: {exc}", lid))
            continue
        ran += 1
        for reason in reasons:
            problems.append(Problem("LINKED_CIRCUIT_RESULT_INVALID", f"its linked circuit ran on {adapter.name} but returned a bad result ({reason})", lid))
    return problems, skipped, ran


def check_lab_capabilities(lessons: Sequence[Any], *, known_routes: Collection[tuple[str, str]] | None = None) -> list[Problem]:
    problems: list[Problem] = []
    declared = set(get_args(LabCapability))
    for capability in sorted(declared - set(CAPABILITY_ROUTES)):
        problems.append(Problem("LAB_CAPABILITY_NO_ROUTE", f"capability {capability!r} is declared but has no API route in CAPABILITY_ROUTES"))
    for capability in sorted(set(CAPABILITY_ROUTES) - declared):
        problems.append(Problem("LAB_CAPABILITY_NOT_DECLARED", f"CAPABILITY_ROUTES names {capability!r}, which is not a declared lab capability"))

    for lesson in lessons:
        lid = _label(lesson)
        labs = [s for s in _sections(lesson) if getattr(s, "type", None) == "interactive_lab"]
        if labs and getattr(lesson, "linked_circuit", None) is None:
            problems.append(Problem("LAB_WITHOUT_CIRCUIT", "has an interactive lab but no linked circuit for it to run", lid))
        for lab in labs:
            capability = getattr(lab, "capability", None)
            sid = getattr(lab, "id", None)
            if capability not in declared:
                problems.append(
                    Problem("LAB_CAPABILITY_UNKNOWN", f"its lab names capability {capability!r}; the platform has {sorted(declared)}", lid, sid)
                )
                continue
            route = CAPABILITY_ROUTES.get(capability)
            if route is not None and known_routes is not None and route not in set(known_routes):
                problems.append(
                    Problem("LAB_CAPABILITY_ENDPOINT_MISSING", f"its lab names capability {capability!r}, but {route[0]} {route[1]} is not a registered API route", lid, sid)
                )
    return problems


def _circuit_gates(circuit: Any) -> set[str]:
    return {_gate_name(op.gate) for op in getattr(circuit, "ops", [])}


def check_challenge_references(lessons: Sequence[Any], challenges: Sequence[Any]) -> list[Problem]:
    problems: list[Problem] = []
    lesson_ids = {_label(l) for l in lessons}
    referenced: dict[str, list[str]] = {}
    for challenge in challenges:
        cid = getattr(challenge, "id", "<no id>")
        lesson_id = getattr(challenge, "lesson_id", None)
        if lesson_id not in lesson_ids:
            problems.append(Problem("CHALLENGE_LESSON_UNKNOWN", f"challenge {cid!r} names lesson {lesson_id!r}, which is not in the catalog"))
        else:
            referenced.setdefault(lesson_id, []).append(cid)

        circuits: list[tuple[str, Any]] = [("starter circuit", getattr(challenge, "starter_circuit", None)), ("reference solution", getattr(challenge, "reference_solution", None))]
        for check in getattr(challenge, "checks", []) or []:
            for attr in ("target", "other"):
                if getattr(check, attr, None) is not None:
                    circuits.append((f"check {getattr(check, 'id', '?')!r} {attr}", getattr(check, attr)))
        for what, circuit in circuits:
            if circuit is None:
                continue
            used = _circuit_gates(circuit)
            for gate in sorted(used - _KNOWN_GATES):
                problems.append(Problem("CHALLENGE_UNKNOWN_GATE", f"challenge {cid!r}: its {what} references gate {gate!r}, which the canonical model does not have"))
            for backend, supported in sorted(SUPPORTED_GATES.items()):
                missing = sorted((used & _KNOWN_GATES) - {g.value for g in supported})
                if missing:
                    problems.append(Problem("CHALLENGE_GATE_UNSUPPORTED", f"challenge {cid!r}: its {what} uses {', '.join(missing)}, which backend {backend!r} cannot run"))

    for lesson in lessons:
        lid = _label(lesson)
        reason = getattr(lesson, "no_challenge_reason", None)
        has_reason = reason is not None and bool(str(reason).strip())
        if lid in referenced:
            if has_reason:
                problems.append(
                    Problem(
                        "CHALLENGE_REASON_STALE",
                        f"says it has no challenge ({str(reason).strip()[:60]!r}...) but challenge(s) {referenced[lid]} name it; remove the reason",
                        lid,
                    )
                )
        elif not has_reason:
            if reason is not None:
                problems.append(Problem("CHALLENGE_REASON_BLANK", "has a blank no_challenge_reason; say why there is no challenge", lid))
            else:
                problems.append(Problem("CHALLENGE_MISSING", "has no challenge and does not say why (set no_challenge_reason, or add a challenge)", lid))
    return problems


def check_registry(
    lessons: Sequence[Any],
    challenges: Sequence[Any],
    *,
    lesson_index: Mapping[str, Any] | None = None,
    challenge_index: Mapping[str, Any] | None = None,
) -> list[Problem]:
    problems: list[Problem] = []
    lesson_ids = [_label(l) for l in lessons]
    for dup in sorted({i for i in lesson_ids if lesson_ids.count(i) > 1}):
        problems.append(Problem("LESSON_ID_DUPLICATE", f"lesson id {dup!r} is used {lesson_ids.count(dup)} times"))
    challenge_ids = [getattr(c, "id", "<no id>") for c in challenges]
    for dup in sorted({i for i in challenge_ids if challenge_ids.count(i) > 1}):
        problems.append(Problem("CHALLENGE_ID_DUPLICATE", f"challenge id {dup!r} is used {challenge_ids.count(dup)} times"))

    if lesson_index is not None:
        if set(lesson_index) != set(lesson_ids):
            problems.append(
                Problem("REGISTRY_LESSON_INDEX_MISMATCH", f"the lesson lookup table has {sorted(set(lesson_index) ^ set(lesson_ids))} that the catalog does not (or vice versa)")
            )
        for lesson in lessons:
            # (a lesson missing from the table altogether is already the MISMATCH above; this is a table holding ANOTHER object)
            if _label(lesson) in lesson_index and lesson_index[_label(lesson)] is not lesson:
                problems.append(Problem("REGISTRY_LESSON_INDEX_STALE", "the lookup table holds a different object than the catalog", _label(lesson)))
    if challenge_index is not None:
        if set(challenge_index) != set(challenge_ids):
            problems.append(
                Problem("REGISTRY_CHALLENGE_INDEX_MISMATCH", f"the challenge lookup table has {sorted(set(challenge_index) ^ set(challenge_ids))} that the catalog does not (or vice versa)")
            )
    return problems


# --------------------------------------------------------------------------- the whole thing


def validate_content(
    lessons: Sequence[Any] | None = None,
    challenges: Sequence[Any] | None = None,
    *,
    adapter: ExecutionAdapter | None = None,
    known_routes: Collection[tuple[str, str]] | None = None,
    allow_prompt_only_checks: bool = False,
    execute: bool = True,
    lesson_index: Mapping[str, Any] | None = None,
    challenge_index: Mapping[str, Any] | None = None,
) -> ContentReport:
    """Run every check. With no arguments it validates the shipped catalogs, on Qiskit Aer, against their own registries.

    ``known_routes`` is a set of ``(METHOD, path)`` pairs the API registers; when given, every lab capability's route must be in
    it. ``execute=False`` skips running circuits. A backend that is unavailable adds to ``skipped`` instead of failing.
    """
    shipped = lessons is None and challenges is None
    lessons = list(LESSONS if lessons is None else lessons)
    challenges = list(CHALLENGES if challenges is None else challenges)
    if shipped:
        lesson_index = LESSON_BY_ID if lesson_index is None else lesson_index
        challenge_index = CHALLENGE_BY_ID if challenge_index is None else challenge_index

    report = ContentReport()
    sections = [s for l in lessons for s in _sections(l)]
    report.checked.update(
        lessons=len(lessons),
        sections=len(sections),
        concept_checks=sum(1 for s in sections if isinstance(s, ConceptCheckSection) or getattr(s, "type", None) == "concept_check"),
        labs=sum(1 for s in sections if isinstance(s, InteractiveLabSection) or getattr(s, "type", None) == "interactive_lab"),
        linked_circuits=sum(1 for l in lessons if getattr(l, "linked_circuit", None) is not None),
        challenges=len(challenges),
    )

    report.problems += check_registry(lessons, challenges, lesson_index=lesson_index, challenge_index=challenge_index)
    report.problems += check_prerequisites(lessons)
    report.problems += check_section_ids(lessons)
    report.problems += check_concept_checks(lessons, allow_prompt_only=allow_prompt_only_checks)
    report.problems += check_linked_circuits_static(lessons)
    report.problems += check_lab_capabilities(lessons, known_routes=known_routes)
    report.problems += check_challenge_references(lessons, challenges)

    if execute:
        if adapter is None:
            from qentor.execution.aer import AerAdapter

            adapter = AerAdapter()
        problems, skipped, ran = check_linked_circuits_execute(lessons, adapter)
        report.problems += problems
        report.skipped += skipped
        report.checked["circuits_executed"] = ran
    else:
        report.skipped.append("executing linked circuits: not requested (execute=False)")
        report.checked["circuits_executed"] = 0
    return report
