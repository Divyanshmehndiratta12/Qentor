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
import type { Lesson, LessonSummary, TutorQuery, TutorReply } from './types'

export type ExecutionMode = 'statevector' | 'shots'

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

  /** No tutor module exists yet. Real client throws `EndpointNotImplementedError`. */
  askTutor(query: TutorQuery): Promise<TutorReply>
}
