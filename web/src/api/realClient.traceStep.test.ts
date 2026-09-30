/**
 * RealApiClient.askTutor with a trace step — the exact request body that reaches
 * POST /api/tutor and the response mapping. `fetch` is stubbed.
 *
 * The contract: `trace_step` is IDENTITY only (indices, the operation, ids and
 * hashes); there is no field for a statevector, amplitude, probability or Bloch
 * coordinate; a step question needs the circuit; and a body without a step is
 * unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import type { Circuit } from '@/circuit/types'
import type { TutorTraceStepContext } from './client'

const CIRCUIT: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 1,
  num_clbits: 0,
  ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }],
}
const STEP: TutorTraceStepContext = {
  stepIndex: 1,
  operationIndex: 0,
  operation: { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
  resultId: 'res_step1',
  executionId: 'aer-local-step1',
  circuitHash: 'hash_step1',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  previousResultId: 'res_step0',
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ANSWER = {
  answer: 'For step 2 of 2: ... (S3).',
  result_id: 'res_step1',
  circuit_hash: 'hash_step1',
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
  used_fallback_template: true,
  facts: [{ id: 'S1', kind: 'trace_step', description: 'step 2 of 2', result_id: 'res_step1' }],
  trace_step: {
    step_index: 1,
    step_number: 2,
    total_steps: 2,
    operation_index: 0,
    result_id: 'res_step1',
    circuit_hash: 'hash_step1',
    provenance_class: 'SIMULATION',
    verification_status: 'STATE_CHECKED',
  },
}

describe('RealApiClient.askTutor — trace step', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const body = () => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends trace_step as an identity-only object next to the circuit and question', async () => {
    fetchMock.mockResolvedValueOnce(json(ANSWER))
    await new RealApiClient().askTutor('res_lab', CIRCUIT, 'What changed in this step?', 'hi', undefined, STEP)

    expect(Object.keys(body()).sort()).toEqual(['circuit', 'language', 'question', 'result_id', 'trace_step'])
    expect(Object.keys(body().trace_step).sort()).toEqual([
      'backend',
      'backend_version',
      'circuit_hash',
      'execution_id',
      'operation',
      'operation_index',
      'previous_result_id',
      'result_id',
      'step_index',
    ])
    expect(body().trace_step).toMatchObject({ step_index: 1, result_id: 'res_step1', previous_result_id: 'res_step0' })
  })

  it('sends no statevector, amplitude, probability or Bloch value anywhere in the body', async () => {
    fetchMock.mockResolvedValueOnce(json(ANSWER))
    await new RealApiClient().askTutor(null, CIRCUIT, 'q', 'en', undefined, STEP)
    expect(JSON.stringify(body())).not.toMatch(/statevector|amplitude|probabilit|bloch|counts|expectation/i)
  })

  it('a step-only question omits result_id', async () => {
    fetchMock.mockResolvedValueOnce(json(ANSWER))
    await new RealApiClient().askTutor(null, CIRCUIT, 'q', 'en', undefined, STEP)
    expect(body()).not.toHaveProperty('result_id')
  })

  it('refuses (before any network call) a step question with no circuit', async () => {
    await expect(new RealApiClient().askTutor(null, null, 'q', 'en', undefined, STEP)).rejects.toThrow(/needs the circuit/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a question with no step has no trace_step key (the body is unchanged)', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...ANSWER, trace_step: undefined }))
    await new RealApiClient().askTutor('res_lab', CIRCUIT, 'q')
    expect(body()).not.toHaveProperty('trace_step')
  })

  it('maps the echoed step (one-based numbers, provenance) into the answer', async () => {
    fetchMock.mockResolvedValueOnce(json(ANSWER))
    const answer = await new RealApiClient().askTutor('res_lab', CIRCUIT, 'q', 'en', undefined, STEP)
    expect(answer.traceStep).toEqual({
      stepIndex: 1,
      stepNumber: 2,
      totalSteps: 2,
      operationIndex: 0,
      resultId: 'res_step1',
      circuitHash: 'hash_step1',
      provenanceClass: 'SIMULATION',
      verificationStatus: 'STATE_CHECKED',
    })
    expect(answer.facts[0]!.id).toBe('S1')
  })

  it('an answer without a step has no traceStep', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...ANSWER, trace_step: undefined }))
    const answer = await new RealApiClient().askTutor('res_lab', CIRCUIT, 'q')
    expect(answer.traceStep ?? null).toBeNull()
  })
})
