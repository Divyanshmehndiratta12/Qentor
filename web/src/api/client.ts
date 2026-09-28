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
import type { Circuit } from '@/circuit/types'
import type { QuantumValue } from '@/provenance/QuantumValue'
import type { Lesson, LessonSummary } from './types'

export type ExecutionMode = 'statevector' | 'shots'

/** Matches `backend/qentor/api/schemas.py`'s `backend: Literal[...]` field —
 * every endpoint that accepts one uses this same three-value set. */
export type Backend = 'qiskit-aer' | 'cirq' | 'pennylane'

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

  /** No `/api/lessons` route exists yet. Real client throws `EndpointNotImplementedError`. */
  listLessons(): Promise<LessonSummary[]>
  getLesson(id: string): Promise<Lesson>

  /**
   * POST /api/tutor — a deterministic, grounded answer (no LLM yet). Sends
   * only `resultId`, the canonical `circuit` and the learner's `question` —
   * never a probability, count, amplitude or verdict computed client-side.
   * The backend looks up the persisted execution by `resultId` and is the
   * only source of every fact in the reply.
   */
  askTutor(resultId: string, circuit: Circuit, question: string): Promise<TutorAnswerResult>

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
}
