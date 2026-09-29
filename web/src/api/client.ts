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
import type { Circuit, GateOp } from '@/circuit/types'
import type { QuantumValue } from '@/provenance/QuantumValue'

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
 * `question`/`options`/`correctOptionId`/`explanation` are all `null`
 * together, or all present together (the backend enforces this) — a
 * prompt-only concept check (no scoring) has all four `null`, exactly as
 * every concept_check was before this milestone. Grading happens client-side
 * against `correctOptionId`: there is no server-side grading endpoint in this
 * milestone, which does mean the correct answer is visible in the network
 * response — see `@/features/learn/ConceptCheckQuiz.tsx`'s own note.
 */
export interface LessonConceptCheckSection {
  type: 'concept_check'
  id: string
  title: string
  prompt: string
  question: string | null
  options: ConceptCheckOption[] | null
  correctOptionId: string | null
  explanation: string | null
  concept: string | null
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
  counts?: Record<string, number>
  probabilities?: Record<string, number>
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
  resultId: string
}

/**
 * Structured evidence from POST /api/tutor. Shaped after
 * `backend/qentor/api/schemas.py::TutorResponse`, normalised to camelCase.
 * `verificationStatus`/`provenanceClass` here describe the *execution* this
 * answer is grounded in (VERIFIED/FAILED/ERROR — the same three values
 * `/api/execute` itself reports), not a Bell-verifier verdict.
 */
export interface TutorAnswerResult {
  answer: string
  resultId: string
  circuitHash: string
  provenanceClass: string
  verificationStatus: string
  usedFallbackTemplate: boolean
  facts: TutorFactResult[]
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
   * POST /api/tutor — a deterministic, grounded answer (no LLM yet). Sends
   * only `resultId`, the canonical `circuit`, the learner's `question` and
   * their selected `language` — never a probability, count, amplitude or
   * verdict computed client-side. The backend looks up the persisted
   * execution by `resultId` and is the only source of every fact in the
   * reply; `language` only ever selects which language the answer's wrapper
   * text is written in and defaults to English when omitted.
   */
  askTutor(resultId: string, circuit: Circuit, question: string, language?: TutorLanguage): Promise<TutorAnswerResult>

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
}
