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

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.bloch import BlochVector
from qentor.lessons import Lesson
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
    given one "global" vector. Clients that don't know this field can ignore it.
    """

    model_config = ConfigDict(extra="forbid")

    step_index: int
    operation_index: int | None
    operation: GateOp | None
    execution_id: str
    provenance: TraceProvenanceResponse
    statevector: list[list[float]]
    bloch_vector: BlochVector | None = None


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


class LessonCatalogResponse(BaseModel):
    """GET /api/lessons's entire response — the read-only lesson catalog.

    ``lessons`` reuses the domain model (``qentor.lessons.Lesson``) directly,
    the same way ``OptimizeResponse.candidate_circuit`` reuses ``Circuit``:
    one shape, not a parallel API-only copy that could drift from it. There is
    no learner progress/state field anywhere on this response — that stays
    out of scope for this milestone.
    """

    model_config = ConfigDict(extra="forbid")

    lessons: list[Lesson]
