"""API request/response shapes.

``ExecuteRequest`` is built directly on the canonical ``Circuit`` model, which has
``extra="forbid"``. A client literally cannot include a ``probabilities``,
``counts``, ``statevector`` or ``pass``/``fail`` field in the request body — there
is no field for it, and an unknown field is a validation error, not a silently
ignored one.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from qentor.challenges import CheckOutcome, PublicChallenge
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.amplitude_view import BasisAmplitude
from qentor.execution.bloch import BlochVector
from qentor.execution.reduced_state import QubitReducedState
from qentor.execution.step_changes import StepChange
from qentor.verification.experiment_compare import CircuitDifference, MeasurementDifference, StateDifference
from qentor.lessons import PublicLesson
from qentor.lessons.grading import GradeOutcome, RegradeItem, RegradeResult
from qentor.tutor.trace_context import TraceStepRef


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    mode: Literal["statevector", "shots"]
    shots: int | None = Field(default=None, gt=0)
    # Defaults to the original, only-ever-existed backend so a request that
    # predates this field behaves identically. Each value matches the
    # selected adapter's own `.name` exactly (qentor.api.app's registry).
    backend: Literal["qiskit-aer", "cirq", "pennylane"] = "qiskit-aer"


class ExecuteResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit_hash: str
    backend: str
    backend_version: str
    execution_mode: str
    provenance_class: str
    verification_status: str
    created_at: str
    payload: dict[str, Any]


class TraceRequest(BaseModel):
    """Same shape as ``ExecuteRequest`` (the canonical circuit, a mode, a
    backend) — so a client can ask for a trace of exactly the request it would
    send to ``/api/execute`` — except that ``mode`` defaults to
    ``"statevector"``, the only mode a trace exists for. ``"shots"`` is still
    accepted by the schema so it can be refused with an explicit structured
    error (``TRACE_MODE_UNSUPPORTED``) instead of a generic validation
    failure. There is no field for a client-supplied amplitude, probability
    or verdict, and ``extra="forbid"`` makes an unknown one an error.
    """

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    mode: Literal["statevector", "shots"] = "statevector"
    shots: int | None = Field(default=None, gt=0)
    backend: Literal["qiskit-aer", "cirq", "pennylane"] = "qiskit-aer"


class TraceProvenanceResponse(BaseModel):
    """Exactly the provenance fields ``ExecuteResponse`` carries, for ONE
    step: which record (``result_id``) holds this state, which circuit
    (``circuit_hash`` — the hash of the circuit truncated after this step's
    operation) produced it, on which backend and version, how, and with what
    status. ``verification_status`` here means only what it means for
    ``/api/execute``: the backend ran and returned a normalised state. It is
    NOT a claim that the circuit is correct or equivalent to anything.
    """

    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit_hash: str
    backend: str
    backend_version: str
    execution_mode: str
    provenance_class: str
    verification_status: str
    created_at: str


class TraceStepResponse(BaseModel):
    """The backend's state after ``operation`` (``None`` for the initial
    state). ``operation`` is the canonical ``GateOp`` from the submitted
    circuit and ``operation_index`` its position in that circuit's ``ops``.
    ``statevector`` is the adapter's own ``[[re, im], ...]`` list, unmodified.

    ``bloch_vector`` is ``null`` unless the circuit has exactly one qubit, in
    which case it is (x, y, z) derived by the backend from THIS step's own
    ``statevector`` (``qentor.execution.bloch``: x = 2 Re(conj(a)b), y = 2
    Im(conj(a)b), z = |a|^2 - |b|^2), with ``derived_from`` naming the exact
    step, record, execution and prefix circuit it came from. It is not a
    correctness verdict, and a multi-qubit (e.g. entangled) state is never
    given one "global" vector. For a register, ``qubit_states`` gives each qubit
    its OWN reduced state instead. Clients that don't know these fields can
    ignore them.
    """

    model_config = ConfigDict(extra="forbid")

    step_index: int
    operation_index: int | None
    operation: GateOp | None
    execution_id: str
    provenance: TraceProvenanceResponse
    statevector: list[list[float]]
    bloch_vector: BlochVector | None = None
    # Each qubit's own reduced state at this step — Bloch vector, purity, Bloch length, entangled-with-the-rest — or an
    # explicit UNUSABLE with a reason. One entry per qubit, q[0] first. Derived by the server from THIS step's
    # statevector (``qentor.execution.reduced_state``); ``derived_from`` names the step, record and prefix circuit.
    qubit_states: list[QubitReducedState] = []
    # Magnitude, probability and phase of every amplitude, in statevector order (``qentor.execution.amplitude_view``),
    # so the browser can draw an amplitude/phase chart without computing any of it.
    amplitude_view: list[BasisAmplitude] = []
    # What this operation changed relative to the previous step (None for the initial state): computed by the
    # server from the two backend statevectors (``qentor.execution.step_changes``).
    change: StepChange | None = None


class TraceTerminalMeasurementResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_index: int
    operation: GateOp


class TraceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit_hash: str  # the circuit as submitted
    traced_circuit_hash: str  # terminal measurements stripped; == last step's circuit_hash
    backend: str
    backend_version: str
    num_qubits: int
    mode: str
    trace_method: str
    basis_ordering: str
    steps: list[TraceStepResponse]
    terminal_measurements: list[TraceTerminalMeasurementResponse]
    final_result_id: str


class VerifyBellStateRequest(BaseModel):
    """``circuit`` is the canonical circuit the client already built (the same shape
    ``ExecuteRequest.circuit`` takes) — never a probability, count or verdict. The
    verifier itself checks this circuit's hash against the persisted provenance
    record's ``circuit_hash`` before trusting it; a mismatch is reported as an ERROR
    verification report, not silently accepted.
    """

    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit: Circuit


class VerificationCheckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    status: str
    detail: str


class VerifyBellStateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result_id: str
    circuit_hash: str
    verifier: str
    verification_status: str
    checks: list[VerificationCheckResponse]
    expected_support: list[str]
    observed_support: list[str]


class TutorRequest(BaseModel):
    """``circuit`` is the same canonical shape ``ExecuteRequest``/
    ``VerifyBellStateRequest`` take — the client's current circuit context,
    never a probability, count, amplitude or verdict. ``result_id`` names the
    already-persisted execution the tutor grounds its answer in; a circuit
    that doesn't hash to that record's own ``circuit_hash`` is rejected
    outright (HTTP 422), not silently answered against the wrong result.

    ``language`` only ever selects which natural language the answer's
    wrapper text is written in (docs/ARCHITECTURE.md §10) — omitting it means
    English, exactly as every request before this field existed. It never
    changes which facts are built or the numbers/bitstrings/gate names within
    them; the ``Literal`` restricts it to the canonical codes this milestone
    supports, so an unsupported code is a validation error, not a silent
    fallback.

    ``lesson_id``/``section_id`` are optional *identifiers* into the server's
    own lesson registry (``qentor.lessons``) — never lesson text. The server
    resolves them; an unknown lesson, an unknown section, or a section that
    belongs to a different lesson is a structured error (``TUTOR_LESSON_NOT_FOUND``,
    ``TUTOR_SECTION_NOT_FOUND``, ``TUTOR_SECTION_MISMATCH``), never silently
    ignored. ``section_id`` needs a ``lesson_id``.

    ``result_id`` and ``circuit`` travel together: both (a result-grounded
    question, exactly as before lesson context existed) or neither (a
    lesson-only question). A request with neither a result nor a lesson has
    nothing to answer from and is a validation error, as it always was.

    ``trace_step`` is the identity of the execution-trace step the learner has
    selected (``qentor.tutor.trace_context.TraceStepRef``): indices, the
    operation, and the ids/hashes of the provenance record the backend wrote for
    that step — no amplitude, probability or Bloch coordinate, and no field to
    carry one. The server looks the step's record up itself and VERIFIES the
    identity against ``circuit`` (which a trace step therefore requires): the
    record's circuit hash must be the hash of that circuit cut off after the
    step. A step that does not add up is a structured error
    (``TUTOR_TRACE_RESULT_NOT_FOUND``, ``TUTOR_TRACE_STEP_MISMATCH``). With a
    ``trace_step``, ``result_id`` is optional (the step's own record is what is
    explained); if present it is checked exactly as before.
    """

    model_config = ConfigDict(extra="forbid")

    result_id: str | None = None
    circuit: Circuit | None = None
    question: str = Field(min_length=1)
    language: Literal["en", "hi", "kn"] = "en"
    lesson_id: str | None = Field(default=None, min_length=1)
    section_id: str | None = Field(default=None, min_length=1)
    trace_step: TraceStepRef | None = None

    @model_validator(mode="after")
    def _context_is_coherent(self) -> "TutorRequest":
        if self.trace_step is not None:
            if self.circuit is None:
                raise ValueError("a trace_step needs the circuit it was traced from")
        elif (self.result_id is None) != (self.circuit is None):
            raise ValueError("result_id and circuit must be provided together")
        if self.section_id is not None and self.lesson_id is None:
            raise ValueError("section_id requires lesson_id")
        if self.result_id is None and self.lesson_id is None and self.trace_step is None:
            raise ValueError("a tutor question needs a result (result_id + circuit), a lesson_id or a trace_step")
        return self


class TutorFactResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: str
    description: str
    # ``None`` for a lesson fact (course material, not an execution result).
    result_id: str | None = None


class TutorTraceStepResponse(BaseModel):
    """The trace step an answer was about, with the provenance of the record the
    server verified it against. ``step_number``/``total_steps`` are the
    learner-facing one-based numbering (``step_index`` stays zero-based)."""

    model_config = ConfigDict(extra="forbid")

    step_index: int
    step_number: int
    total_steps: int
    operation_index: int | None
    result_id: str
    circuit_hash: str
    provenance_class: str
    verification_status: str


class TutorResponse(BaseModel):
    """``result_id``/``circuit_hash``/``provenance_class``/``verification_status``
    describe the *execution* the answer is grounded in and are ``None`` for a
    lesson-only answer — lesson material is not a quantum result and carries no
    provenance. ``lesson_id``/``section_id`` echo the resolved lesson context.
    For a step-only answer (no separate result) they are the STEP's record;
    ``trace_step`` always names the step and its own provenance."""

    model_config = ConfigDict(extra="forbid")

    answer: str
    result_id: str | None = None
    circuit_hash: str | None = None
    provenance_class: str | None = None
    verification_status: str | None = None
    used_fallback_template: bool
    facts: list[TutorFactResponse]
    lesson_id: str | None = None
    section_id: str | None = None
    trace_step: TutorTraceStepResponse | None = None


class MultiInputTestCaseRequest(BaseModel):
    """One explicit, reproducible input — never a probability, count or
    verdict. ``input_bits``/``expected_output`` are read positionally against
    the request's own ``input_qubits``/``output_qubits`` (see
    ``qentor.verification.multi_input_harness.TestCaseSpec``).
    """

    model_config = ConfigDict(extra="forbid")

    input_bits: str
    expected_output: str


class MultiInputTestRequest(BaseModel):
    """``circuit`` is the same canonical shape every other endpoint takes.
    Each case in ``cases`` is executed statevector-exact after prepending an
    X gate per '1' bit in ``input_bits`` on ``input_qubits``; this harness
    never accepts a client-supplied probability, count or pass/fail verdict.
    """

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    input_qubits: list[int]
    output_qubits: list[int]
    cases: list[MultiInputTestCaseRequest] = Field(min_length=1)
    backend: Literal["qiskit-aer", "cirq", "pennylane"] = "qiskit-aer"


class MultiInputCaseResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_bits: str
    expected_output: str
    status: str
    observed_distribution: dict[str, float] | None
    error: str | None
    result_id: str | None
    circuit_hash: str


class MultiInputCounterexampleResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_bits: str
    expected_output: str
    observed_distribution: dict[str, float]
    circuit_hash: str
    result_id: str | None


class MultiInputTestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    test_id: str
    circuit_hash: str
    backend: str
    backend_version: str | None
    input_qubits: list[int]
    output_qubits: list[int]
    cases: list[MultiInputCaseResponse]
    counterexamples: list[MultiInputCounterexampleResponse]
    overall_status: str


class OptimizeRequest(BaseModel):
    """``circuit`` is the same canonical shape every other endpoint takes.
    ``backend`` selects which adapter (if any) runs the *verified* candidate
    once, purely to persist a supporting statevector result — it plays no
    part in the equivalence verdict itself, which always comes from
    ``qentor.verification.equivalence`` (Qiskit's own Operator equivalence,
    the one documented method, regardless of backend). This request has no
    field for a probability, amplitude, count or a "verified" flag — a client
    cannot submit its own equivalence verdict.
    """

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    backend: Literal["qiskit-aer", "cirq", "pennylane"] = "qiskit-aer"


class OptimizeEquivalenceCheckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    status: str
    detail: str


class OptimizeEquivalenceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    method: str
    global_phase: float | None
    checks: list[OptimizeEquivalenceCheckResponse]
    reason: str | None


class OpChangeResponse(BaseModel):
    """One line of the original-versus-candidate difference, computed by the server (``qentor.verification.optimizer.diff_ops``)."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["kept", "removed", "added"]
    original_index: int | None
    candidate_index: int | None
    description: str


class RuleNoteResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rule: str
    explanation: str | None


class OptimizeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    original_circuit_hash: str
    candidate_circuit_hash: str
    original_op_count: int
    candidate_op_count: int
    rules_applied: list[str]
    reduction_summary: str
    status: str
    equivalence: OptimizeEquivalenceResponse | None
    verifier_name: str
    verifier_version: str
    reason: str | None
    # Present only when status == "VERIFIED_SHORTER" — see
    # qentor.verification.optimizer.OptimizationReport's own docstring on why
    # an unverified candidate's definition is withheld, not just labelled.
    candidate_circuit: Circuit | None
    result_id: str | None
    # What the server computed about the difference, never the browser: how many operations went, what changed operation by
    # operation (only for a VERIFIED_SHORTER candidate), the sentence behind each rule, and the provenance of the supporting run.
    operations_removed: int
    changes: list[OpChangeResponse]
    rule_notes: list[RuleNoteResponse]
    candidate_provenance: TraceProvenanceResponse | None


class LessonCatalogResponse(BaseModel):
    """GET /api/lessons's entire response — the read-only lesson catalog.

    ``lessons`` is ``PublicLesson``, the client-facing view of the domain
    model: a concept check carries its question and options and NEITHER the
    answer key NOR the explanation (``qentor.lessons.models``). Those come
    back only from the grading endpoint, for a selection the client submits.
    There is no learner progress/state field anywhere on this response.
    """

    model_config = ConfigDict(extra="forbid")

    lessons: list[PublicLesson]


class ConceptCheckGradeRequest(BaseModel):
    """One selection for POST /api/lessons/{lesson_id}/concept-checks/{check_id}/grade: the option id picked, and nothing
    else. There is no field for a verdict, a key or a score; an unknown field is a validation error."""

    model_config = ConfigDict(extra="forbid")

    selected_option_id: str = Field(min_length=1, max_length=200)


class ConceptCheckGradeResponse(GradeOutcome):
    """The server's verdict on one selection (``qentor.lessons.grading.GradeOutcome``): correctness and the explanation."""


class RegradeRequest(BaseModel):
    """Selections a client saved earlier, to be graded again by the server (after a reload). At most 500 per request."""

    model_config = ConfigDict(extra="forbid")

    answers: list[RegradeItem] = Field(max_length=500)


class RegradeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[RegradeResult]


# --------------------------------------------------------------------------- #
# Read-only code views                                                        #
# --------------------------------------------------------------------------- #


class CodeRequest(BaseModel):
    """The canonical circuit and nothing else: the server writes the code."""

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit


class CodeResponse(BaseModel):
    """Qiskit, Cirq and PennyLane source for the circuit, as TEXT. Nothing here is executed by the
    server or by the browser (``qentor.circuit.codegen``)."""

    model_config = ConfigDict(extra="forbid")

    circuit_hash: str
    generator: str
    code: dict[str, str]


# --------------------------------------------------------------------------- #
# Equivalence                                                                 #
# --------------------------------------------------------------------------- #


class EquivalenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit_a: Circuit
    circuit_b: Circuit


class EquivalenceResponse(BaseModel):
    """The equivalence checker's own report (``qentor.verification.equivalence``): operator equality up to a
    global phase, with the checks that led to the verdict. ``UNVERIFIABLE`` says why nothing was decided."""

    model_config = ConfigDict(extra="forbid")

    status: str
    method: str
    checker_version: str
    circuit_hash_a: str
    circuit_hash_b: str
    global_phase: float | None
    checks: list[VerificationCheckResponse]
    reason: str | None


# --------------------------------------------------------------------------- #
# Cross-backend agreement                                                     #
# --------------------------------------------------------------------------- #


class AgreementRequest(BaseModel):
    """The circuit, and optionally which backends to compare (default: all three; at least two)."""

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    backends: list[Literal["qiskit-aer", "cirq", "pennylane"]] | None = None

    @model_validator(mode="after")
    def _at_least_two_distinct(self) -> "AgreementRequest":
        if self.backends is not None and len(set(self.backends)) < 2:
            raise ValueError("backends must name at least two different backends to compare")
        return self


class AgreementBackendResponse(BaseModel):
    """What happened on one backend. ``status`` is ``RAN`` (state-checked result, with its provenance),
    ``REFUSED`` (over a limit or a gate it cannot run), ``UNAVAILABLE`` (not installed or blocked),
    or ``FAILED`` (it ran but failed, or returned a malformed state). Never a substitute result."""

    model_config = ConfigDict(extra="forbid")

    backend: str
    status: Literal["RAN", "REFUSED", "UNAVAILABLE", "FAILED"]
    message: str | None
    provenance: TraceProvenanceResponse | None


class AgreementPairResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    backend_a: str
    backend_b: str
    max_amplitude_difference: float
    max_probability_difference: float
    fidelity: float
    agrees: bool


class AgreementResponse(BaseModel):
    """The server's comparison of the backends' statevectors. ``provenance`` is the comparison's own record;
    each backend that ran carries its own. Terminal measurements are stripped before running (a measured
    statevector collapses at random) and their number is reported."""

    model_config = ConfigDict(extra="forbid")

    method: str
    threshold: float
    status: Literal["AGREE", "DISAGREE", "INCOMPLETE"]
    circuit_hash: str
    terminal_measurements_stripped: int
    backends: list[AgreementBackendResponse]
    pairs: list[AgreementPairResponse]
    provenance: TraceProvenanceResponse


# --------------------------------------------------------------------------- #
# Challenges                                                                  #
# --------------------------------------------------------------------------- #


class ChallengeCatalogResponse(BaseModel):
    """Challenge definitions as a learner may see them: goal, constraints, hints. No reference solution and no target
    circuit (``qentor.challenges.models.public_view``)."""

    model_config = ConfigDict(extra="forbid")

    challenges: list[PublicChallenge]


class ChallengeSubmitRequest(BaseModel):
    """The learner's canonical circuit and nothing else. There is no field for a verdict, a state or a number: the server
    judges the circuit itself."""

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit


class ChallengeSubmitResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attempt_id: str
    challenge_id: str
    circuit_hash: str
    passed: bool
    verifier: str
    checks: list[CheckOutcome]
    backend: str | None
    backend_version: str | None
    final_result_id: str | None
    # The provenance record behind every result id named above or in ``checks``: numbers in ``evidence`` come from these.
    provenance: dict[str, "TraceProvenanceResponse"]
    next_hint_index: int | None
    next_hint: str | None
    success_message: str | None
    created_at: str


# --------------------------------------------------------------------------- #
# Circuit debugger                                                            #
# --------------------------------------------------------------------------- #


class DebugRequest(BaseModel):
    """Everything is an identifier or free text, never a quantum value: the circuit, the id of the Lab result and/or of a challenge
    attempt the server judged, an optional trace step (identity only) and the learner's goal in their own words.

    ``goal`` is untrusted text (echoed, never acted on). ``attempt_id`` needs ``challenge_id`` and vice versa; the server checks
    that the attempt is that challenge's and is of THIS circuit. At least one of ``result_id`` / ``attempt_id`` is required: there
    has to be a real run or a real verdict to debug.
    """

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    result_id: str | None = Field(default=None, min_length=1)
    challenge_id: str | None = Field(default=None, min_length=1)
    attempt_id: str | None = Field(default=None, min_length=1)
    trace_step: TraceStepRef | None = None
    goal: str | None = Field(default=None, max_length=400)
    language: Literal["en", "hi", "kn"] = "en"

    @model_validator(mode="after")
    def _coherent(self) -> "DebugRequest":
        if (self.challenge_id is None) != (self.attempt_id is None):
            raise ValueError("challenge_id and attempt_id must be provided together")
        if self.result_id is None and self.attempt_id is None:
            raise ValueError("debugging needs an executed result (result_id) or a judged challenge attempt (attempt_id)")
        return self


class DebugSectionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    fact_ids: list[str]


class DebugResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observed: DebugSectionResponse
    evidence: list[DebugSectionResponse]
    mismatch: DebugSectionResponse
    next_experiment: DebugSectionResponse
    hint: DebugSectionResponse | None
    # What the reasoning engine found about the run (R# facts, quoted); empty when it had nothing for this run.
    engine_evidence: list[DebugSectionResponse] = []
    facts: list[TutorFactResponse]
    used_fallback_template: bool
    grounded_in: str
    result_id: str | None
    circuit_hash: str
    provenance_class: str | None
    verification_status: str | None
    attempt_id: str | None
    # The reasoning-engine analysis record whose ``R#`` facts the report was given; ``None`` when the engine could not analyse the run.
    analysis_id: str | None = None


# --------------------------------------------------------------------------- #
# Experiment comparison                                                       #
# --------------------------------------------------------------------------- #


class ExperimentCompareRequest(BaseModel):
    """Two runs the server already holds, each named by its result id and the circuit it ran. No number, state or verdict."""

    model_config = ConfigDict(extra="forbid")

    result_id_a: str = Field(min_length=1)
    circuit_a: Circuit
    result_id_b: str = Field(min_length=1)
    circuit_b: Circuit


class RunIdentityResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provenance: TraceProvenanceResponse
    execution_id: str | None
    shots: int | None
    num_qubits: int


class ExperimentCompareResponse(BaseModel):
    """The server's comparison of two executions. ``provenance`` is the comparison's own record (its ``result_id`` is the
    ``comparison_id`` the tutor is asked about); each run carries its own."""

    model_config = ConfigDict(extra="forbid")

    comparison_id: str
    method: str
    a: RunIdentityResponse
    b: RunIdentityResponse
    circuit: CircuitDifference
    measurement: MeasurementDifference
    state: StateDifference
    provenance: TraceProvenanceResponse


class ComparisonTutorRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comparison_id: str = Field(min_length=1)
    question: str = Field(min_length=1, max_length=500)
    language: Literal["en", "hi", "kn"] = "en"


# --------------------------------------------------------------------------- #
# Export                                                                      #
# --------------------------------------------------------------------------- #


class ExportRequest(BaseModel):
    """The circuit and, optionally, the id of a run of it whose METADATA should travel with it."""

    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    result_id: str | None = Field(default=None, min_length=1)


class ExportResponse(BaseModel):
    """A portable, read-only description of a circuit: canonical model, OpenQASM 3, generated source, and (when a run is named)
    that run's provenance metadata - never its numbers, never a path, key or internal id of the server."""

    model_config = ConfigDict(extra="forbid")

    format: str
    circuit_hash: str
    circuit: Circuit
    qasm: str
    generator: str
    code: dict[str, str]
    execution: TraceProvenanceResponse | None
    note: str


# --------------------------------------------------------------------------- #
# AI circuit generation                                                       #
# --------------------------------------------------------------------------- #


class GenerationStatusResponse(BaseModel):
    """Whether this server can generate circuits at all. ``available`` is false unless an LLM is configured in the server's own
    environment; nothing else in Qentor depends on it, and no substitute generator exists."""

    model_config = ConfigDict(extra="forbid")

    available: bool
    provider: str | None
    model: str | None
    reason: str | None


class GenerateCircuitRequest(BaseModel):
    """A natural-language request, plus identifiers and the learner's current circuit as CONTEXT. There is no field for a quantum
    number, a result or a verdict, and no field that carries code to run: the only thing the model returns is OpenQASM 3 text, and
    only the server's parser ever reads it."""

    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=3, max_length=600)
    language: Literal["en", "hi", "kn"] = "en"
    lesson_id: str | None = Field(default=None, min_length=1, max_length=80)
    section_id: str | None = Field(default=None, min_length=1, max_length=80)
    challenge_id: str | None = Field(default=None, min_length=1, max_length=80)
    circuit: Circuit | None = None

    @model_validator(mode="after")
    def _shape(self) -> "GenerateCircuitRequest":
        if not self.prompt.strip() or len(self.prompt.strip()) < 3:
            raise ValueError("prompt must contain at least 3 characters of text")
        if self.section_id is not None and self.lesson_id is None:
            raise ValueError("section_id needs a lesson_id")
        return self


class GenerationProblemResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    line: int | None


class GenerateCircuitResponse(BaseModel):
    """The server's reading of one model draft (``qentor.tutor.proposal.Proposal``). ``PROPOSED`` means only that the text parsed and
    fits the platform's limits: ``verification_status`` is always ``UNVERIFIED_AGAINST_INTENT`` and ``label`` is what the UI shows."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["PROPOSED", "REJECTED"]
    label: str
    verification_status: str
    generator: str
    model: str | None
    raw_qasm: str
    circuit: Circuit | None
    canonical_qasm: str | None
    circuit_hash: str | None
    summary: str | None
    explanation: str | None
    explanation_source: Literal["AI", "TEMPLATE"] | None
    explanation_note: str | None
    problems: list[GenerationProblemResponse]
    constraint_notes: list[str]
