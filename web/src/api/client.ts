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
  /** POST /api/execute — the only endpoint that exists server-side today. */
  executeCircuit(
    circuit: Circuit,
    mode: ExecutionMode,
    shots?: number,
  ): Promise<QuantumValue<ExecutePayload>>

  /** No `/api/lessons` route exists yet. Real client throws `EndpointNotImplementedError`. */
  listLessons(): Promise<LessonSummary[]>
  getLesson(id: string): Promise<Lesson>

  /** No tutor module exists yet. Real client throws `EndpointNotImplementedError`. */
  askTutor(query: TutorQuery): Promise<TutorReply>
}
