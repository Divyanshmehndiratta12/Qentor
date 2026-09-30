/**
 * How the client maps the additive visualization fields: `theoretical_probabilities` and `shots` on execute results, and the
 * per-step `change` on traces. Present → passed through untouched; absent (an older server) → absent, never defaulted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import type { Circuit } from '@/circuit/types'
import { CX01, H0, traceResult, wireTrace, type Amplitude, type WireStepChange } from '@/test/traceFixtures'
import { TraceResponseSchema } from '@/provenance/schema'
import { traceResultFromResponse } from './realClient'

const CIRCUIT: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 1,
  num_clbits: 1,
  ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }],
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const PROV = (mode: string) => ({
  result_id: 'res_1',
  circuit_hash: 'h',
  backend: 'qiskit-aer',
  backend_version: '1',
  execution_mode: mode,
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
  created_at: '2026-01-01T00:00:00Z',
})

describe('executeCircuit visualization fields', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('passes theoretical probabilities through exactly as the server sent them', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        ...PROV('statevector'),
        payload: { execution_id: 'e', statevector: [[1, 0], [0, 0]], theoretical_probabilities: { '0': 0.31, '1': 0.69 } },
      }),
    )
    const result = await new RealApiClient().executeCircuit(CIRCUIT, 'statevector')
    expect(result.value.theoreticalProbabilities).toEqual({ '0': 0.31, '1': 0.69 })
    expect(result.value.probabilities).toBeUndefined()
  })

  it('leaves theoretical probabilities absent when the server sent none', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...PROV('statevector'), payload: { execution_id: 'e', statevector: [[1, 0], [0, 0]] } }))
    const result = await new RealApiClient().executeCircuit(CIRCUIT, 'statevector')
    expect('theoreticalProbabilities' in result.value).toBe(false)
  })

  it('carries the shot count of a shots run, and keeps the frequencies under probabilities', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        ...PROV('shots'),
        payload: { execution_id: 'e', counts: { '0': 3, '1': 1 }, probabilities: { '0': 0.75, '1': 0.25 }, shots: 4 },
      }),
    )
    const result = await new RealApiClient().executeCircuit(CIRCUIT, 'shots', 4)
    expect(result.value.shots).toBe(4)
    expect(result.value.probabilities).toEqual({ '0': 0.75, '1': 0.25 })
    expect(result.value.theoreticalProbabilities).toBeUndefined()
  })

  it('leaves the shot count absent when the server did not send it (the client never sums counts itself)', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ ...PROV('shots'), payload: { execution_id: 'e', counts: { '0': 3, '1': 1 }, probabilities: { '0': 0.75, '1': 0.25 } } }),
    )
    const result = await new RealApiClient().executeCircuit(CIRCUIT, 'shots', 4)
    expect('shots' in result.value).toBe(false)
  })
})

describe('trace step change mapping', () => {
  const R = 0.7071067811865476
  const STATES: Amplitude[][] = [
    [[1, 0], [0, 0], [0, 0], [0, 0]],
    [[R, 0], [R, 0], [0, 0], [0, 0]],
    [[R, 0], [0, 0], [0, 0], [R, 0]],
  ]
  const CHANGE: WireStepChange = {
    kind: 'probabilities_changed',
    support_before: 1,
    support_after: 2,
    amplitudes_changed: 2,
    probabilities_changed: 2,
    changed_basis_states: [
      { basis: '00', before: [1, 0], after: [R, 0], probability_before: 1, probability_after: 0.5 },
      { basis: '01', before: [0, 0], after: [R, 0], probability_before: 0, probability_after: 0.5 },
    ],
    summary: 'from the server',
  }

  it('maps the server’s change onto each step and nothing onto the initial state', () => {
    const trace = traceResult({ numQubits: 2, ops: [H0, CX01], states: STATES, changes: [null, CHANGE, { ...CHANGE, kind: 'phase_only' }] })
    expect(trace.steps[0]!.change).toBeNull()
    expect(trace.steps[1]!.change).toEqual({
      kind: 'probabilities_changed',
      supportBefore: 1,
      supportAfter: 2,
      amplitudesChanged: 2,
      probabilitiesChanged: 2,
      changedBasis: ['00', '01'],
      summary: 'from the server',
    })
    expect(trace.steps[2]!.change!.kind).toBe('phase_only')
  })

  it('maps a missing change (older server) to null on every step', () => {
    const trace = traceResult({ numQubits: 2, ops: [H0, CX01], states: STATES })
    expect(trace.steps.map((s) => s.change)).toEqual([null, null, null])
  })

  it('rejects a change with an unknown kind rather than guessing what it meant', () => {
    const wire = wireTrace({ numQubits: 2, ops: [H0, CX01], states: STATES, changes: [null, { ...CHANGE, kind: 'sort_of_changed' as never }, null] })
    expect(() => traceResultFromResponse(TraceResponseSchema.parse(wire))).toThrow()
  })
})
