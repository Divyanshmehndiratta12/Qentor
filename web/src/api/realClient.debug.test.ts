/**
 * `POST /api/debug` from the client's side: what goes out is identifiers and the learner's own words - never a quantum value or a
 * verdict - and what comes back is shown as the server wrote it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError } from './client'
import type { Circuit } from '@/circuit/types'

const CIRCUIT: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 1,
  num_clbits: 0,
  ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }],
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const REPORT = {
  observed: { text: 'You submitted a circuit.', fact_ids: ['E1'] },
  evidence: [{ text: 'Fidelity: 0.500000.', fact_ids: ['E6'] }],
  mismatch: { text: 'A likely idea.', fact_ids: ['C3'] },
  next_experiment: { text: 'Open the trace.', fact_ids: [] },
  hint: { text: 'Try H first.', fact_ids: [] },
  facts: [{ id: 'E1', kind: 'challenge_check', description: 'attempt att_1: 1 of 2 checks passed', result_id: null }],
  used_fallback_template: true,
  grounded_in: 'challenge',
  result_id: 'res_1',
  circuit_hash: 'qc_1',
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
  attempt_id: 'att_1',
}

const STEP = {
  stepIndex: 1,
  operationIndex: 0,
  operation: CIRCUIT.ops[0]!,
  resultId: 'res_step',
  executionId: 'exec_1',
  circuitHash: 'qc_step',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  previousResultId: 'res_prev',
}

describe('RealApiClient.debugCircuit', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const body = () => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
  const url = () => fetchMock.mock.calls[0]![0] as string

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(json(REPORT))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to /api/debug', async () => {
    await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1' })
    expect(url()).toMatch(/\/api\/debug$/)
  })

  it('a Lab debug sends the circuit, the result id and the language — nothing else', async () => {
    await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1' })
    expect(body()).toEqual({ circuit: CIRCUIT, result_id: 'res_1', language: 'en' })
  })

  it('a challenge debug sends the challenge and attempt ids together', async () => {
    await new RealApiClient().debugCircuit({ circuit: CIRCUIT, challengeId: 'create-plus', attemptId: 'att_1', resultId: 'res_1', language: 'hi' })
    expect(body()).toEqual({ circuit: CIRCUIT, result_id: 'res_1', challenge_id: 'create-plus', attempt_id: 'att_1', language: 'hi' })
  })

  it('never sends a challenge id without an attempt id, or the reverse', async () => {
    await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1', challengeId: 'create-plus' })
    expect(body()).not.toHaveProperty('challenge_id')
    expect(body()).not.toHaveProperty('attempt_id')
  })

  it('sends the goal trimmed, and omits it when blank', async () => {
    await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1', goal: '  a fair coin  ' })
    expect(body().goal).toBe('a fair coin')
    fetchMock.mockResolvedValueOnce(json(REPORT))
    await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1', goal: '   ' })
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).not.toHaveProperty('goal')
  })

  it('a trace step is sent as IDENTITY only', async () => {
    await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1', traceStep: STEP })
    expect(body().trace_step).toEqual({
      step_index: 1,
      operation_index: 0,
      operation: CIRCUIT.ops[0],
      result_id: 'res_step',
      execution_id: 'exec_1',
      circuit_hash: 'qc_step',
      backend: 'qiskit-aer',
      backend_version: '0.17.2',
      previous_result_id: 'res_prev',
    })
    expect(Object.keys(body().trace_step)).not.toEqual(expect.arrayContaining(['statevector', 'probability', 'amplitude']))
  })

  it('carries no field for a probability, a state, a count or a verdict', async () => {
    await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1', attemptId: 'att_1', challengeId: 'c', goal: 'g', traceStep: STEP })
    const keys = Object.keys(body())
    for (const forbidden of ['probabilities', 'statevector', 'counts', 'passed', 'verdict', 'fidelity', 'checks']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('maps the report to the domain shape', async () => {
    const report = await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1' })
    expect(report).toMatchObject({
      observed: { text: 'You submitted a circuit.', factIds: ['E1'] },
      mismatch: { factIds: ['C3'] },
      nextExperiment: { text: 'Open the trace.' },
      hint: { text: 'Try H first.' },
      usedFallbackTemplate: true,
      groundedIn: 'challenge',
      resultId: 'res_1',
      attemptId: 'att_1',
      provenanceClass: 'SIMULATION',
    })
    expect(report.evidence).toEqual([{ text: 'Fidelity: 0.500000.', factIds: ['E6'] }])
    expect(report.facts).toEqual([{ id: 'E1', kind: 'challenge_check', description: 'attempt att_1: 1 of 2 checks passed', resultId: null }])
  })

  it('a report with no hint has hint null', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...REPORT, hint: null }))
    expect((await new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1' })).hint).toBeNull()
  })

  it('refuses a malformed report, and an unknown grounding', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...REPORT, grounded_in: 'magic' }))
    await expect(new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1' })).rejects.toThrow()
    fetchMock.mockResolvedValueOnce(json({ observed: 'x' }))
    await expect(new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1' })).rejects.toThrow()
  })

  it('a refusal keeps its status and message; an outage is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: { code: 'ATTEMPT_MISMATCH', message: 'submit again first' } }, 422))
    await expect(new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1' })).rejects.toMatchObject({ status: 422, message: 'submit again first' })
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await expect(new RealApiClient().debugCircuit({ circuit: CIRCUIT, resultId: 'res_1' })).rejects.toBeInstanceOf(BackendUnavailableError)
  })

  it('never sends a malformed circuit', async () => {
    await expect(new RealApiClient().debugCircuit({ circuit: { ...CIRCUIT, num_qubits: 0 } as Circuit, resultId: 'res_1' })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
