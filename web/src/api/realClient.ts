/**
 * The real implementation of `ApiClient`. Every response is parsed through a
 * zod schema before it leaves this file, and the only thing handed back to a
 * caller is a `QuantumValue` built from that parsed data — never a raw
 * `fetch` JSON object a component could render without a provenance badge.
 */
import { CircuitSchema, type Circuit } from '@/circuit/types'
import { provenanceFromExecuteResponse, toQuantumValue, type QuantumValue } from '@/provenance/QuantumValue'
import {
  ExecuteResponseSchema,
  ShotsPayloadSchema,
  StatevectorPayloadSchema,
} from '@/provenance/schema'
import {
  BackendUnavailableError,
  EndpointNotImplementedError,
  type ApiClient,
  type ExecutePayload,
  type ExecutionMode,
} from './client'
import type { Lesson, LessonSummary, TutorQuery, TutorReply } from './types'

export class RealApiClient implements ApiClient {
  private readonly baseUrl: string

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl
  }

  async executeCircuit(
    circuit: Circuit,
    mode: ExecutionMode,
    shots?: number,
  ): Promise<QuantumValue<ExecutePayload>> {
    // Validate the outgoing circuit locally too, so a malformed request never
    // even reaches the network — the server's own `extra="forbid"` model is
    // still the authority, this just fails faster.
    const validCircuit = CircuitSchema.parse(circuit)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuit: validCircuit, mode, shots: shots ?? null }),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res)
      throw new BackendUnavailableError(detail, res.status)
    }

    const response = ExecuteResponseSchema.parse(await res.json())
    const provenance = provenanceFromExecuteResponse(response)

    let payload: ExecutePayload
    if (response.execution_mode === 'statevector') {
      const sv = StatevectorPayloadSchema.parse(response.payload)
      payload = { executionId: sv.execution_id, statevector: sv.statevector }
    } else {
      const shots = ShotsPayloadSchema.parse(response.payload)
      payload = {
        executionId: shots.execution_id,
        counts: shots.counts,
        probabilities: shots.probabilities,
      }
    }

    return toQuantumValue(payload, provenance)
  }

  async listLessons(): Promise<LessonSummary[]> {
    throw new EndpointNotImplementedError('GET /api/lessons')
  }

  async getLesson(_id: string): Promise<Lesson> {
    throw new EndpointNotImplementedError('GET /api/lessons/:id')
  }

  async askTutor(_query: TutorQuery): Promise<TutorReply> {
    throw new EndpointNotImplementedError('POST /api/tutor')
  }
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') return body.detail
    return JSON.stringify(body)
  } catch {
    return `HTTP ${res.status}`
  }
}
