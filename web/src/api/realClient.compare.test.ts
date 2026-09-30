/** Experiment comparison from the client's side: only ids and circuits go out; every number comes back wrapped with provenance. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError } from './client'
import type { Circuit } from '@/circuit/types'

const H: Circuit = { schema: 'qentor.circuit/1', num_qubits: 1, num_clbits: 0, ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] }
const X: Circuit = { ...H, ops: [{ gate: 'x', targets: [0], controls: [], params: [], clbits: [] }] }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const REC = (id: string, backend = 'qiskit-aer', cls = 'SIMULATION') => ({
  result_id: id,
  circuit_hash: 'qc_' + id,
  backend,
  backend_version: '1',
  execution_mode: 'statevector',
  provenance_class: cls,
  verification_status: 'STATE_CHECKED',
  created_at: '2026-01-01T00:00:00Z',
})

const RESPONSE = {
  comparison_id: 'res_cmp',
  method: 'qentor.experiment-comparison/1',
  a: { provenance: REC('res_a'), execution_id: 'e1', shots: null, num_qubits: 1 },
  b: { provenance: REC('res_b', 'cirq'), execution_id: 'e2', shots: 100, num_qubits: 1 },
  circuit: {
    same_circuit: false,
    num_qubits_a: 1,
    num_qubits_b: 1,
    num_ops_a: 1,
    num_ops_b: 1,
    changes: [{ tag: 'replace', a_start: 0, a_ops: ['h(q0)'], b_start: 0, b_ops: ['x(q0)'] }],
    equivalence_status: 'NOT_EQUIVALENT',
    equivalence_reason: null,
  },
  measurement: {
    comparable: true,
    reason: null,
    kind_a: 'theoretical_probability',
    kind_b: 'sampled_frequency',
    rows: [
      { outcome: '0', a: 0.5, b: null, difference: null },
      { outcome: '1', a: 0.5, b: 1, difference: 0.5 },
    ],
    total_variation_distance: 0.5,
    max_difference: 0.5,
    note: 'sampling',
  },
  state: { comparable: false, reason: 'a shots run has samples', fidelity: null, max_probability_difference: null, max_amplitude_difference: null, note: null },
  provenance: { ...REC('res_cmp', 'experiment-comparison'), execution_mode: 'comparison' },
}

describe('RealApiClient — experiment comparison', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const body = () => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(json(RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends the two result ids and the two circuits — nothing else', async () => {
    await new RealApiClient().compareExperiments({ resultId: 'res_a', circuit: H }, { resultId: 'res_b', circuit: X })
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/compare\/experiments$/)
    expect(body()).toEqual({ result_id_a: 'res_a', circuit_a: H, result_id_b: 'res_b', circuit_b: X })
  })

  it('wraps every number with the COMPARISON’s provenance', async () => {
    const c = await new RealApiClient().compareExperiments({ resultId: 'res_a', circuit: H }, { resultId: 'res_b', circuit: X })
    const tv = c.measurement.totalVariationDistance!
    expect(tv.value).toBe(0.5)
    expect(tv.provenance).toMatchObject({ resultId: 'res_cmp', backend: 'experiment-comparison', executionMode: 'comparison' })
    expect(c.measurement.rows[1]!.difference!.provenance.resultId).toBe('res_cmp')
    expect(c.provenance.resultId).toBe('res_cmp')
  })

  it('an outcome a run did not report stays null — it is not turned into 0', async () => {
    const c = await new RealApiClient().compareExperiments({ resultId: 'res_a', circuit: H }, { resultId: 'res_b', circuit: X })
    expect(c.measurement.rows[0]!.b).toBeNull()
    expect(c.measurement.rows[0]!.difference).toBeNull()
  })

  it('a state that cannot be compared has no fidelity', async () => {
    const c = await new RealApiClient().compareExperiments({ resultId: 'res_a', circuit: H }, { resultId: 'res_b', circuit: X })
    expect(c.state).toMatchObject({ comparable: false, fidelity: null, reason: 'a shots run has samples' })
  })

  it('keeps each run’s own identity', async () => {
    const c = await new RealApiClient().compareExperiments({ resultId: 'res_a', circuit: H }, { resultId: 'res_b', circuit: X })
    expect(c.a.provenance.backend).toBe('qiskit-aer')
    expect(c.b).toMatchObject({ shots: 100, executionId: 'e2' })
    expect(c.circuit.changes[0]).toEqual({ tag: 'replace', aStart: 0, aOps: ['h(q0)'], bStart: 0, bOps: ['x(q0)'] })
  })

  it('refuses a malformed response, and keeps a refusal’s status', async () => {
    fetchMock.mockResolvedValueOnce(json({ comparison_id: 'x' }))
    await expect(new RealApiClient().compareExperiments({ resultId: 'a', circuit: H }, { resultId: 'b', circuit: X })).rejects.toThrow()
    fetchMock.mockResolvedValueOnce(json({ detail: { code: 'COMPARISON_CIRCUIT_MISMATCH', message: 'wrong circuit' } }, 422))
    await expect(new RealApiClient().compareExperiments({ resultId: 'a', circuit: H }, { resultId: 'b', circuit: X })).rejects.toMatchObject({ status: 422, message: 'wrong circuit' })
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await expect(new RealApiClient().compareExperiments({ resultId: 'a', circuit: H }, { resultId: 'b', circuit: X })).rejects.toBeInstanceOf(BackendUnavailableError)
  })

  it('asking the tutor sends the comparison id, the question and the language only', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ answer: 'For this comparison: x (X1).', result_id: 'res_cmp', circuit_hash: 'cmp_1', provenance_class: 'SIMULATION', verification_status: 'STATE_CHECKED', used_fallback_template: true, facts: [{ id: 'X1', kind: 'comparison_circuit', description: 'd', result_id: 'res_cmp' }] }),
    )
    const answer = await new RealApiClient().askComparisonTutor('res_cmp', 'why?', 'hi')
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/tutor\/comparison$/)
    expect(body()).toEqual({ comparison_id: 'res_cmp', question: 'why?', language: 'hi' })
    expect(answer).toMatchObject({ usedFallbackTemplate: true, resultId: 'res_cmp' })
    expect(answer.facts[0]).toEqual({ id: 'X1', kind: 'comparison_circuit', description: 'd', resultId: 'res_cmp' })
  })
})
