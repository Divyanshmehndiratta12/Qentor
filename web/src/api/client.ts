/**
 * The `ApiClient` interface every screen depends on. There are exactly two
 * implementations:
 *
 *  - `RealApiClient` (realClient.ts) — talks to the actual FastAPI process.
 *    This is the default and the only implementation used in a production
 *    build.
 *  - `MockApiClient` (mockClient.ts) — returns FIXTURE-labelled data for
 *    local UI development when the backend isn't running. It is wired in
 *    only behind `VITE_USE_MOCK_API=true` (see index.ts) and every value it
 *    returns carries `provenanceClass: "FIXTURE"`, which `ProvenanceBadge`
 *    renders with a hazard-stripe pattern distinct from any real badge.
 *
 * No component ever imports `realClient.ts` or `mockClient.ts` directly —
 * only this interface and `getApiClient()` from `index.ts`. That is what
 * makes the mock swappable without touching a single screen.
 */
import type { Circuit, GateName, GateOp } from '@/circuit/types'
import type { Provenance, QuantumValue } from '@/provenance/QuantumValue'

export type ExecutionMode = 'statevector' | 'shots'

/** Matches `backend/qentor/api/schemas.py::TutorRequest.language`'s
 * `Literal[...]` exactly — the canonical language codes this milestone
 * supports (docs/ARCHITECTURE.md §10). Omitting it anywhere in this app means
 * English, exactly as before this field existed. */
export type TutorLanguage = 'en' | 'hi' | 'kn'

/** Matches `backend/qentor/api/schemas.py`'s `backend: Literal[...]` field —
 * every endpoint that accepts one uses this same three-value set. */
export type Backend = 'qiskit-aer' | 'cirq' | 'pennylane'

/**
 * The Learn catalog — shaped after `backend/qentor/lessons/models.py::Lesson`
 * and its section types, normalised to camelCase like every other client
 * result. `linkedCircuit` is a plain canonical circuit definition (the same
 * shape `/api/execute` accepts), never a result — a lesson never carries a
 * probability, count or verdict of its own. There is no `completed`/progress
 * field anywhere on this type: that stays purely local, session-only UI state
 * (see `@/features/learn/store.ts`), never something the backend reports.
 */
export type LessonDifficulty = 'beginner' | 'intermediate' | 'advanced'

/** The already-existing backend endpoints an interactive lab may point a
 * learner at (matches `backend/qentor/lessons/models.py::LabCapability`
 * exactly) — never a capability invented client-side. */
export type LabCapability = 'execute' | 'verify_bell_state' | 'multi_input_test' | 'optimize'

export interface LessonExplanationSection {
  type: 'explanation'
  id: string
  title: string
  body: string
}

export interface ConceptCheckOption {
  id: string
  text: string
}

/**
 * `question` and `options` are both `null` (a prompt-only check, nothing to score)
 * or both present (the backend enforces this). There is deliberately NO answer key
 * and NO explanation here: the server withholds both from the catalog and grades a
 * submitted selection itself (`ApiClient.gradeConceptCheck`), returning correctness
 * and the explanation. A component therefore cannot decide correctness, because the
 * data to do it with never reaches the browser.
 */
export interface LessonConceptCheckSection {
  type: 'concept_check'
  id: string
  title: string
  prompt: string
  question: string | null
  options: ConceptCheckOption[] | null
  concept: string | null
}

/** The server's verdict on one concept-check selection, with the explanation. It never names the answer key. */
export interface ConceptCheckGrade {
  lessonId: string
  checkId: string
  selectedOptionId: string
  correct: boolean
  explanation: string
}

/** A selection the browser saved earlier, sent back to be graded again. */
export interface SavedAnswer {
  lessonId: string
  checkId: string
  selectedOptionId: string
}

/** The server's answer for one `SavedAnswer`: `GRADED` with a verdict and explanation, or a status saying it can no
 * longer be graded (and then neither). */
export interface RegradedAnswer extends SavedAnswer {
  status: 'GRADED' | 'UNKNOWN_LESSON' | 'UNKNOWN_CHECK' | 'NOT_GRADED' | 'UNKNOWN_OPTION'
  correct: boolean | null
  explanation: string | null
}

export interface LessonInteractiveLabSection {
  type: 'interactive_lab'
  id: string
  title: string
  instructions: string
  capability: LabCapability
}

export interface LessonReflectionSection {
  type: 'reflection'
  id: string
  title: string
  prompt: string
}

export type LessonSection =
  | LessonExplanationSection
  | LessonConceptCheckSection
  | LessonInteractiveLabSection
  | LessonReflectionSection

export interface Lesson {
  id: string
  title: string
  shortDescription: string
  concept: string
  difficulty: LessonDifficulty
  estimatedMinutes: number
  learningObjectives: string[]
  sections: LessonSection[]
  linkedCircuit: Circuit | null
  prerequisiteLessonIds: string[]
}

/**
 * Client-facing execution payload. Shaped after
 * `backend/qentor/execution/adapter.py::ExecutionResult.to_payload()`, but
 * normalised to camelCase and used as the common type both `RealApiClient`
 * (built from a real `/api/execute` response) and `MockApiClient` (built from
 * FIXTURE data) return — wrapped in a `QuantumValue` in both cases, never as
 * a bare object a component could render without a provenance badge.
 */
export interface ExecutePayload {
  executionId: string
  statevector?: Array<[number, number]>
  /** Shots runs: how many times the circuit was sampled. */
  shots?: number
  counts?: Record<string, number>
  /** SHOTS runs only: SAMPLED frequencies (count / shots). Not theoretical probabilities. */
  probabilities?: Record<string, number>
  /** STATEVECTOR runs only: what an ideal measurement of the returned state would give, computed by the server. */
  theoreticalProbabilities?: Record<string, number>
}

/**
 * Structured evidence from POST /api/verify/bell-state. Shaped after
 * `backend/qentor/api/schemas.py::VerifyBellStateResponse`, normalised to
 * camelCase. Not wrapped in `QuantumValue` — it has no single numeric value
 * and no full `Provenance` (the backend returns no backend/backendVersion/
 * executionMode/createdAt for a verification report) — but every field on it
 * still comes only from the server's own verifier, never invented client-side.
 */
export interface VerificationCheckResult {
  name: string
  status: 'PASS' | 'FAIL'
  detail: string
}

export interface VerifyBellStateResult {
  resultId: string
  circuitHash: string
  verifier: string
  verificationStatus: 'VERIFIED' | 'FAILED' | 'UNVERIFIABLE' | 'ERROR'
  checks: VerificationCheckResult[]
  expectedSupport: string[]
  observedSupport: string[]
}

/**
 * A single citable fact from POST /api/tutor's fact sheet — shaped after
 * `backend/qentor/api/schemas.py::TutorFactResponse`. Every number the tutor's
 * answer text references traces back to one of these, built server-side from
 * the persisted execution result, never computed or guessed here.
 */
export interface TutorFactResult {
  id: string
  kind: string
  description: string
  /** `null` for a lesson fact (`L#`): course material, not an execution result. */
  resultId: string | null
}

/**
 * Structured evidence from POST /api/tutor. Shaped after
 * `backend/qentor/api/schemas.py::TutorResponse`, normalised to camelCase.
 * `verificationStatus`/`provenanceClass` here describe the *execution* this
 * answer is grounded in (STATE_CHECKED/FAILED/ERROR — the same values
 * `/api/execute` itself reports: a state check on the run, not a verdict on the
 * circuit), not a Bell-verifier verdict.
 *
 * `resultId`/`circuitHash`/`provenanceClass`/`verificationStatus` are `null`
 * for a lesson-only answer: lesson material is not a quantum result and has
 * no provenance. `lessonId`/`sectionId` echo the lesson context the server
 * resolved (absent/`null` for a Lab answer).
 */
export interface TutorAnswerResult {
  answer: string
  resultId: string | null
  circuitHash: string | null
  provenanceClass: string | null
  verificationStatus: string | null
  usedFallbackTemplate: boolean
  facts: TutorFactResult[]
  lessonId?: string | null
  sectionId?: string | null
  /** The trace step this answer was about, with the provenance of the record
   * the server verified it against; absent/`null` when no step was selected. */
  traceStep?: TutorTraceStepEcho | null
}

/**
 * Identifies the execution-trace step a tutor question is about. IDENTITY ONLY:
 * indices, the operation, and the ids/hashes of the provenance record the
 * backend wrote for the step — never an amplitude, probability or Bloch
 * coordinate (there is no field for one). The backend looks the step's record
 * up itself and VERIFIES this identity against the circuit before using it.
 * `stepIndex`/`operationIndex` are the trace's own zero-based indices.
 */
export interface TutorTraceStepContext {
  stepIndex: number
  operationIndex: number | null
  operation: GateOp | null
  resultId: string
  executionId: string
  circuitHash: string
  backend: string
  backendVersion: string
  previousResultId: string | null
}

/** What the server says the answer was grounded in for a step. `stepNumber`/
 * `totalSteps` are the learner-facing one-based numbering. */
export interface TutorTraceStepEcho {
  stepIndex: number
  stepNumber: number
  totalSteps: number
  operationIndex: number | null
  resultId: string
  circuitHash: string
  provenanceClass: string
  verificationStatus: string
}

/**
 * Identifies the lesson (and section) a tutor question is about. IDs only —
 * the backend resolves them against its own lesson registry; lesson text is
 * never sent from the browser.
 */
export interface TutorLessonContext {
  lessonId: string
  sectionId: string | null
}

/**
 * Structured evidence from POST /api/optimize. Shaped after
 * `backend/qentor/api/schemas.py::OptimizeResponse`, normalised to camelCase.
 * `equivalence` is the server's own Qiskit-Operator-equivalence report
 * (`qentor.verification.equivalence`) — the one documented equivalence
 * method, never recomputed here. `candidateCircuit` is non-null only when
 * `status === 'VERIFIED_SHORTER'`: the server withholds an unverified
 * candidate's definition entirely, so there is nothing for this app to
 * accidentally apply.
 */
export interface OptimizationEquivalenceCheckResult {
  name: string
  status: 'PASS' | 'FAIL'
  detail: string
}

export interface OptimizationEquivalenceResult {
  status: 'EQUIVALENT' | 'NOT_EQUIVALENT' | 'UNVERIFIABLE'
  method: string
  globalPhase: number | null
  checks: OptimizationEquivalenceCheckResult[]
  reason: string | null
}

export interface OptimizationResult {
  originalCircuitHash: string
  candidateCircuitHash: string
  originalOpCount: number
  candidateOpCount: number
  rulesApplied: string[]
  reductionSummary: string
  status: 'VERIFIED_SHORTER' | 'NO_OPTIMIZATION_FOUND' | 'REJECTED' | 'UNVERIFIABLE'
  equivalence: OptimizationEquivalenceResult | null
  verifierName: string
  verifierVersion: string
  reason: string | null
  candidateCircuit: Circuit | null
  resultId: string | null
}

/**
 * Structured evidence from POST /api/test/multi-input. Shaped after
 * `backend/qentor/api/schemas.py::MultiInputTestResponse`, normalised to
 * camelCase. `observedDistribution` is the server's own Born-rule bookkeeping
 * on real amplitudes an adapter produced (`qentor.verification.multi_input_harness`)
 * — never computed here, and never just a pass/fail boolean: the full
 * distribution is kept so a near-miss is visible, not hidden behind a verdict.
 */
export interface MultiInputTestCase {
  inputBits: string
  expectedOutput: string
}

export interface MultiInputCaseResult {
  inputBits: string
  expectedOutput: string
  status: 'PASS' | 'FAIL' | 'EXECUTION_ERROR'
  observedDistribution: Record<string, number> | null
  error: string | null
  resultId: string | null
  circuitHash: string
}

export interface MultiInputCounterexampleResult {
  inputBits: string
  expectedOutput: string
  observedDistribution: Record<string, number>
  circuitHash: string
  resultId: string | null
}

export interface MultiInputTestResult {
  testId: string
  circuitHash: string
  backend: string
  backendVersion: string | null
  inputQubits: number[]
  outputQubits: number[]
  cases: MultiInputCaseResult[]
  counterexamples: MultiInputCounterexampleResult[]
  overallStatus: 'ALL_PASSED' | 'SOME_FAILED' | 'INCOMPLETE'
}

/**
 * POST /api/execute/trace — the backend's own state after each operation.
 * Shaped after `backend/qentor/api/schemas.py::TraceResponse`, normalised to
 * camelCase, with nothing added, dropped or computed.
 *
 * Each step's `state` is a `QuantumValue` wrapping the backend's own
 * `[[re, im], ...]` list together with that step's provenance (the same
 * `Provenance` shape an `/api/execute` result carries), so a state can never
 * reach a component without its provenance. `operation` is the canonical
 * `GateOp` from the submitted circuit; both it and `operationIndex` are `null`
 * for the initial state. `terminalMeasurements` are stripped trailing
 * `measure` ops: metadata only — there is deliberately no state for them.
 *
 * `provenance.verificationStatus` means only what it means for `/api/execute`
 * (the backend ran and returned a normalised state). It is NOT a claim that
 * the circuit is correct.
 */
export interface TraceStep {
  stepIndex: number
  operationIndex: number | null
  operation: GateOp | null
  executionId: string
  state: QuantumValue<Array<[number, number]>>
  /** The backend's Bloch vector for this step's state, or `null` — always
   * `null` for a multi-qubit step (the backend never invents one). */
  blochVector: TraceBlochVector | null
  /**
   * Each qubit's OWN state at this step, `q[0]` first, computed by the server from this step's statevector — the
   * register has no single Bloch vector, but every qubit has its own. Empty when the backend sent none (an older
   * backend): nothing is worked out here in its place.
   */
  qubitStates: TraceQubitState[]
  /**
   * Magnitude, probability and phase of every amplitude, in statevector order, computed by the server, wrapped with this
   * step's provenance; `null` when the backend sent none.
   */
  amplitudeView: QuantumValue<TraceAmplitude[]> | null
  /** What this step's operation changed relative to the step before it, computed by the server; `null` for the initial state. */
  change: TraceStepChange | null
}

/**
 * One qubit's own state inside a register at one trace step (`qentor.execution.reduced_state`). Every number is the
 * backend's, wrapped with the step's provenance; this app never computes, rounds or bounds one. `status: 'UNUSABLE'`
 * carries a `reason` and no numbers — the backend could not give this qubit a valid state, and nothing is shown in place.
 */
export interface TraceQubitState {
  qubit: number
  status: 'OK' | 'UNUSABLE'
  reason: string | null
  bloch: QuantumValue<BlochCoordinates> | null
  /** Length of the Bloch vector, from the backend: ~1 for a qubit in a pure state of its own, ~0 when it is maximally mixed. */
  blochLength: QuantumValue<number> | null
  /** Tr(rho^2) of the qubit's own state, from the backend: 1 for pure, 1/2 for maximally mixed. */
  purity: QuantumValue<number> | null
  /** The server's statement that this qubit is entangled with the rest of the register (a mixed qubit of a pure register). */
  entangledWithRest: boolean | null
  method: string
  derivedFrom: BlochSource
}

/** One basis state's amplitude in polar form, as the backend computed it. `phase` is `null` where the amplitude is zero. */
export interface TraceAmplitude {
  magnitude: number
  probability: number
  phase: number | null
}

/** The server's account of what one operation changed (`qentor.execution.step_changes`). */
export interface TraceStepChange {
  /** `phase_only`: amplitudes moved but no outcome probability did — invisible to a measurement now. */
  kind: 'unchanged' | 'phase_only' | 'probabilities_changed'
  supportBefore: number
  supportAfter: number
  amplitudesChanged: number
  probabilitiesChanged: number
  /** Basis states whose amplitude moved, as bitstrings `q[n-1]…q[0]`. */
  changedBasis: string[]
  summary: string
}

/** Backend-derived Bloch coordinates. Rendered as received: this app never
 * computes, rounds, clamps or normalises them. */
export interface BlochCoordinates {
  x: number
  y: number
  z: number
}

/** Which backend state a Bloch vector was derived from — mirrors that
 * step's own identity (the API boundary rejects a response where it doesn't). */
export interface BlochSource {
  stepIndex: number
  resultId: string | null
  executionId: string
  circuitHash: string
  backend: string
  backendVersion: string
}

/**
 * The backend's Bloch vector for one trace step. `coordinates` is a
 * `QuantumValue` carrying the SAME provenance as that step's statevector (the
 * vector is derived from it), so the numbers cannot reach a component without
 * it. This is a derived view of one backend-produced state — not a verdict on
 * whether the circuit is correct.
 */
export interface TraceBlochVector {
  coordinates: QuantumValue<BlochCoordinates>
  method: string
  derivedFrom: BlochSource
}

export interface TraceTerminalMeasurement {
  operationIndex: number
  operation: GateOp
}

export interface ExecutionTraceResult {
  /** The circuit as submitted. */
  circuitHash: string
  /** The circuit that was actually traced (terminal measurements stripped);
   * equals the last step's own circuit hash. */
  tracedCircuitHash: string
  backend: string
  backendVersion: string
  numQubits: number
  mode: string
  traceMethod: string
  /** The backend's own statement of how a statevector index maps to a
   * bitstring — shown beside the amplitudes, never reinterpreted. */
  basisOrdering: string
  steps: TraceStep[]
  terminalMeasurements: TraceTerminalMeasurement[]
  finalResultId: string
}

/**
 * A structured refusal from POST /api/execute/trace (`detail = {code,
 * message}`): the backend understood the request and declined to trace it
 * (shots mode, a measurement followed by a gate, too large, backend
 * unavailable/returned an unusable state). Carries no quantum data.
 * Deliberately distinct from `BackendUnavailableError`, which stays the
 * "could not reach it / unstructured failure" error every other endpoint uses.
 */
export class TraceRejectedError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'TraceRejectedError'
    this.code = code
    this.status = status
  }
}

/**
 * A structured refusal from a grading endpoint (`detail = {code, message}`): the server understood the request and
 * declined to grade it (unknown lesson or check, an option that is not one of the choices, a prompt with no question, a
 * malformed body). Carries no verdict. Distinct from `BackendUnavailableError`, which stays "could not reach it".
 */
export class GradeRejectedError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'GradeRejectedError'
    this.code = code
    this.status = status
  }
}

export class EndpointNotImplementedError extends Error {
  constructor(endpoint: string) {
    super(`${endpoint} has no backend implementation yet`)
    this.name = 'EndpointNotImplementedError'
  }
}

export class BackendUnavailableError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'BackendUnavailableError'
    this.status = status
  }
}

export interface ApiClient {
  /** POST /api/execute — executes a circuit. */
  executeCircuit(
    circuit: Circuit,
    mode: ExecutionMode,
    shots?: number,
    backend?: Backend,
  ): Promise<QuantumValue<ExecutePayload>>

  /**
   * POST /api/verify/bell-state — checks an already-executed result (by
   * `resultId`) against the ideal Bell-state circuit. Never re-executes
   * anything: sends only the result id and the canonical `circuit` already
   * known to the client, never a probability, count, amplitude or verdict.
   */
  verifyBellState(resultId: string, circuit: Circuit): Promise<VerifyBellStateResult>

  /**
   * POST /api/execute/trace — the backend's own state after each non-measure
   * operation of `circuit` (statevector mode only; the request always says so).
   * Sends only the canonical `circuit` (and an optional backend choice) —
   * never an amplitude, probability or verdict. Every number in the result
   * comes from the backend and is returned untouched, wrapped with its
   * provenance. Rejects with `TraceRejectedError` for a structured backend
   * refusal, `BackendUnavailableError` for anything unstructured; never
   * resolves with substitute data.
   */
  traceCircuit(circuit: Circuit, backend?: Backend): Promise<ExecutionTraceResult>

  /**
   * GET /api/lessons — the real, read-only lesson catalog. There is no
   * per-lesson endpoint: the full catalog (metadata and section structure)
   * comes back in one call, and a lesson's detail view is derived from it
   * client-side rather than fetched separately.
   */
  listLessons(): Promise<Lesson[]>

  /**
   * POST /api/lessons/{lessonId}/concept-checks/{checkId}/grade — the SERVER grades one selection against the lesson's
   * own answer key and returns correctness and the explanation. The request carries the option id and nothing else (no
   * verdict, no key, no score). A refusal (unknown lesson or check, an option that is not one of the choices, a prompt
   * with no question) is a `GradeRejectedError` with the server's own `code`; an unreachable server is a
   * `BackendUnavailableError`. Either way nothing is graded here and no verdict is substituted.
   */
  gradeConceptCheck(lessonId: string, checkId: string, selectedOptionId: string): Promise<ConceptCheckGrade>

  /**
   * POST /api/assessments/regrade — grade saved selections again, each on its own. After a reload the browser holds only
   * what the learner picked (and the verdicts it was last told); this lets it rebuild every verdict from the server
   * instead of trusting saved ones. An answer that can no longer be graded comes back with a status saying so.
   */
  regradeConceptChecks(answers: SavedAnswer[]): Promise<RegradedAnswer[]>

  /**
   * POST /api/tutor — a deterministic, grounded answer (no LLM yet). Sends
   * only `resultId`, the canonical `circuit`, the learner's `question` and
   * their selected `language` — never a probability, count, amplitude or
   * verdict computed client-side. The backend looks up the persisted
   * execution by `resultId` and is the only source of every fact in the
   * reply; `language` only ever selects which language the answer's wrapper
   * text is written in and defaults to English when omitted.
   *
   * `lesson` (optional) adds `lesson_id`/`section_id` to the request — IDs
   * only; the backend resolves them against its own lesson registry. With a
   * `lesson`, `resultId`/`circuit` may both be `null` (a lesson-only question).
   * Without one, the request body is exactly the four fields above.
   *
   * `traceStep` (optional) names the selected execution-trace step (identity
   * only, see `TutorTraceStepContext`) and requires `circuit`; `resultId` may
   * then be `null`. The backend verifies the step against the circuit and its
   * own provenance records.
   */
  askTutor(
    resultId: string | null,
    circuit: Circuit | null,
    question: string,
    language?: TutorLanguage,
    lesson?: TutorLessonContext,
    traceStep?: TutorTraceStepContext,
  ): Promise<TutorAnswerResult>

  /**
   * POST /api/optimize — a small, deterministic rewrite of the circuit,
   * reported as `VERIFIED_SHORTER` only once the server's own equivalence
   * checker (Qiskit Operator equivalence) confirms it. Sends only the
   * canonical `circuit` and an optional backend choice — never a probability,
   * amplitude, count, or a client-decided equivalence verdict. `backend`
   * selects which adapter runs the *already-verified* candidate once, purely
   * to persist supporting evidence; it plays no part in the verdict itself.
   */
  optimizeCircuit(circuit: Circuit, backend?: Backend): Promise<OptimizationResult>

  /**
   * POST /api/test/multi-input — a basis-sweep multi-input test (explicit,
   * caller-supplied cases; never auto-enumerated here). Sends only the
   * canonical `circuit`, the declared qubit subsets, the explicit
   * `(inputBits, expectedOutput)` cases, and an optional backend choice —
   * never an observed distribution, a pass/fail verdict, or a counterexample
   * computed client-side. Every number and verdict in the result comes from
   * the server's own statevector-exact bookkeeping.
   */
  runMultiInputTest(
    circuit: Circuit,
    inputQubits: number[],
    outputQubits: number[],
    cases: MultiInputTestCase[],
    backend?: Backend,
  ): Promise<MultiInputTestResult>

  /** POST /api/circuit/code — Qiskit, Cirq and PennyLane source for the circuit, generated by the server. Sends only the circuit. */
  generateCode(circuit: Circuit): Promise<CodeViewsResult>

  /**
   * POST /api/verify/equivalence — are two circuits the same operator up to a global phase? Sends only the two canonical
   * circuits; the verdict, the checks and the global phase all come from the server's checker.
   */
  checkEquivalence(circuitA: Circuit, circuitB: Circuit): Promise<EquivalenceResult>

  /**
   * POST /api/compare/backends — run the circuit's statevector on several backends and compare the states on the server.
   * Sends only the circuit (and, optionally, which backends). The browser never compares two quantum values.
   */
  compareBackends(circuit: Circuit, backends?: Backend[]): Promise<AgreementResult>

  /** GET /api/challenges — the challenge catalog: goals, constraints, hints. No reference solution and no target circuit. */
  listChallenges(): Promise<Challenge[]>

  /**
   * POST /api/challenges/{id}/submit — the SERVER judges the circuit. Sends only the canonical circuit; the request has no
   * field for a verdict, a state or a number. Pass/fail is the backend's, computed from its own statevectors — never from a
   * language model and never from anything the browser says. Rejects with `BackendUnavailableError` (with the HTTP status)
   * when the circuit could not be judged; a failing circuit is a normal result with `passed: false`.
   */
  submitChallenge(challengeId: string, circuit: Circuit): Promise<ChallengeSubmission>

  /**
   * POST /api/debug — "Debug my circuit". Sends identifiers and the learner's own words only: the circuit, the id of the Lab
   * result and/or of a challenge attempt the server judged, an optional trace step (identity only) and a goal typed by the
   * learner. There is no field for a quantum value or a verdict. Everything in the report is grounded in facts the server holds.
   */
  debugCircuit(request: DebugRequestInput): Promise<DebugReport>

  /**
   * POST /api/compare/experiments - compare two runs the server already holds. Sends only the two result ids and the two circuits;
   * every difference in the answer is computed by the server and wrapped with the comparison's own provenance.
   */
  compareExperiments(a: { resultId: string; circuit: Circuit }, b: { resultId: string; circuit: Circuit }): Promise<ExperimentComparison>

  /** POST /api/tutor/comparison - ask the tutor about a comparison by its id. The tutor reads the server's own comparison record. */
  askComparisonTutor(comparisonId: string, question: string, language?: TutorLanguage): Promise<TutorAnswerResult>

  /**
   * POST /api/export/circuit - the server's portable description of a circuit: canonical model, OpenQASM 3, generated source and,
   * when a run is named, that run's provenance metadata (never its numbers). Sends only the circuit and an optional result id.
   */
  exportCircuit(circuit: Circuit, resultId?: string | null): Promise<CircuitExport>
}

export interface CircuitExport {
  format: string
  circuitHash: string
  circuit: Circuit
  qasm: string
  generator: string
  code: { qiskit: string; cirq: string; pennylane: string }
  /** Metadata of the run that was named (backend, version, class, status, ids) - no values; `null` if none was named. */
  execution: Provenance | null
  note: string
}

export type ComparisonValueKind = 'sampled_frequency' | 'theoretical_probability'

export interface ComparisonRun {
  provenance: Provenance
  executionId: string | null
  shots: number | null
  numQubits: number
}

export interface ExperimentComparison {
  comparisonId: string
  method: string
  a: ComparisonRun
  b: ComparisonRun
  circuit: {
    sameCircuit: boolean
    numQubitsA: number
    numQubitsB: number
    numOpsA: number
    numOpsB: number
    changes: { tag: 'equal' | 'replace' | 'delete' | 'insert'; aStart: number; aOps: string[]; bStart: number; bOps: string[] }[]
    equivalenceStatus: 'EQUIVALENT' | 'NOT_EQUIVALENT' | 'UNVERIFIABLE'
    equivalenceReason: string | null
  }
  measurement: {
    comparable: boolean
    reason: string | null
    kindA: ComparisonValueKind | null
    kindB: ComparisonValueKind | null
    /** A value is `null` when that run reported nothing for the outcome (absent, not zero). */
    rows: { outcome: string; a: QuantumValue<number> | null; b: QuantumValue<number> | null; difference: QuantumValue<number> | null }[]
    totalVariationDistance: QuantumValue<number> | null
    maxDifference: QuantumValue<number> | null
    note: string | null
  }
  state: {
    comparable: boolean
    reason: string | null
    fidelity: QuantumValue<number> | null
    maxProbabilityDifference: QuantumValue<number> | null
    maxAmplitudeDifference: QuantumValue<number> | null
    note: string | null
  }
  /** The comparison's own provenance record; every number above carries it. */
  provenance: Provenance
}

export interface DebugRequestInput {
  circuit: Circuit
  /** The Lab result being debugged (a provenance record id the server issued). */
  resultId?: string | null
  /** A challenge attempt the server judged; both are needed together. */
  challengeId?: string | null
  attemptId?: string | null
  traceStep?: TutorTraceStepContext | null
  /** What the learner says they were trying to do, in their own words (untrusted text; the server only quotes it). */
  goal?: string | null
  language?: TutorLanguage
}

export interface DebugSection {
  text: string
  /** Ids of the facts (see `DebugReport.facts`) this text rests on. */
  factIds: string[]
}

export interface DebugReport {
  observed: DebugSection
  /** Concrete evidence: facts quoted verbatim, never written by a model. */
  evidence: DebugSection[]
  mismatch: DebugSection
  nextExperiment: DebugSection
  /** For a challenge, the authored hint for the failing check; `null` when there is none. */
  hint: DebugSection | null
  facts: TutorFactResult[]
  /** True when the prose is the server's template (no AI wrote it). */
  usedFallbackTemplate: boolean
  groundedIn: 'challenge' | 'result' | 'failed_run'
  resultId: string | null
  circuitHash: string
  provenanceClass: string | null
  verificationStatus: string | null
  attemptId: string | null
}

export interface ChallengeConstraints {
  numQubits: number
  numClbits: number
  allowedGates: GateName[]
  maxOps: number
  minGateCounts: Record<string, number>
  /** The fixed oracle (or other locked gates) the circuit must contain exactly once, in order. Empty when none. */
  anchor: GateOp[]
  mustMeasure: number[]
}

export interface Challenge {
  id: string
  lessonId: string
  title: string
  goal: string
  difficulty: LessonDifficulty
  successCondition: string
  /** True for the two oracle challenges: ONE fixed oracle, chosen by the platform. */
  fixedOracle: boolean
  constraints: ChallengeConstraints
  starterCircuit: Circuit
  checks: { id: string; label: string }[]
  hints: string[]
}

/** One number a check computed on the server. It exists only together with the provenance record it came from. */
export interface ChallengeEvidence {
  name: string
  value: QuantumValue<number>
}

export interface ChallengeCheckOutcome {
  id: string
  label: string
  passed: boolean
  /** False when the check could not be judged yet (the circuit's structure failed first). */
  evaluated: boolean
  detail: string
  hintIndex: number
  evidence: ChallengeEvidence[]
  /** The learner's own provenance record this check examined; `null` for structure checks. */
  resultId: string | null
}

export interface ChallengeSubmission {
  attemptId: string
  challengeId: string
  circuitHash: string
  passed: boolean
  verifier: string
  checks: ChallengeCheckOutcome[]
  backend: string | null
  backendVersion: string | null
  /** The record of the submitted circuit's final state, or `null` when nothing ran. */
  finalResultId: string | null
  /** The provenance of the final-state record above (backend, version, class, status); `null` when nothing ran. */
  finalProvenance: Provenance | null
  nextHintIndex: number | null
  nextHint: string | null
  successMessage: string | null
  createdAt: string
}

/** Read-only source for the circuit in three SDKs (`POST /api/circuit/code`). Text only: never run, here or on the server. */
export interface CodeViewsResult {
  circuitHash: string
  generator: string
  code: { qiskit: string; cirq: string; pennylane: string }
}

export type CodeFramework = keyof CodeViewsResult['code']

/** The equivalence checker's report (`POST /api/verify/equivalence`); the verdict is the server's, never decided here. */
export interface EquivalenceResult {
  status: 'EQUIVALENT' | 'NOT_EQUIVALENT' | 'UNVERIFIABLE'
  method: string
  checkerVersion: string
  circuitHashA: string
  circuitHashB: string
  /** Radians, from the checker; `null` unless the circuits are equivalent. */
  globalPhase: number | null
  checks: VerificationCheckResult[]
  reason: string | null
}

export interface AgreementBackendResult {
  backend: string
  /** RAN (a state-checked result), REFUSED (over a limit / unsupported gate), UNAVAILABLE, or FAILED. */
  status: 'RAN' | 'REFUSED' | 'UNAVAILABLE' | 'FAILED'
  message: string | null
  provenance: Provenance | null
}

export interface AgreementPairResult {
  backendA: string
  backendB: string
  maxAmplitudeDifference: number
  maxProbabilityDifference: number
  fidelity: number
  agrees: boolean
}

/** The server's comparison of several backends' statevectors (`POST /api/compare/backends`). */
export interface AgreementResult {
  method: string
  threshold: number
  status: 'AGREE' | 'DISAGREE' | 'INCOMPLETE'
  circuitHash: string
  terminalMeasurementsStripped: number
  backends: AgreementBackendResult[]
  pairs: AgreementPairResult[]
  /** The comparison's own provenance record; every number above carries it. */
  provenance: Provenance
}
