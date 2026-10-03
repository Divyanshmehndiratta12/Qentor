/**
 * The per-qubit state view of a run's FINAL state, as `/api/execute` carries it (`qubit_states`): wire shape -> the client's
 * `ExecutePayload.qubitStates`. Every number is passed through untouched and wrapped with THE RUN's provenance; nothing is
 * computed, rounded, bounded or reordered, and a response with none (an older server, or a shots run) maps to "none", never to
 * an empty claim or a zero vector. `fetch` is stubbed: no server is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { quantumValueFromExecuteResponse } from './executeValue'
import { ExecuteResponseSchema } from '@/provenance/schema'
import type { Circuit } from '@/circuit/types'

const BELL: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 2,
  num_clbits: 0,
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

const SOURCE = { step_index: 2, result_id: 'res_run', execution_id: 'aer-1', circuit_hash: 'hash_run', backend: 'qiskit-aer', backend_version: '0.17.2' }
const mixed = (qubit: number, length: number, purity: number) => ({
  qubit,
  status: 'OK',
  reason: null,
  bloch: { x: 1e-17, y: -2e-17, z: length },
  bloch_length: length,
  purity,
  entangled_with_rest: true,
  method: 'reduced-qubit-state-from-statevector/1',
  derived_from: SOURCE,
})

function response(extra: Record<string, unknown> = {}, mode = 'statevector', payload?: Record<string, unknown>) {
  return {
    result_id: 'res_run',
    circuit_hash: 'hash_run',
    backend: 'qiskit-aer',
    backend_version: '0.17.2',
    execution_mode: mode,
    provenance_class: 'SIMULATION',
    verification_status: 'STATE_CHECKED',
    created_at: '2026-10-02T00:00:00+00:00',
    payload: payload ?? { execution_id: 'aer-1', statevector: [[0.7071067811865476, 0], [0, 0], [0, 0], [0.7071067811865476, 0]] },
    ...extra,
  }
}

describe('quantumValueFromExecuteResponse: the final state’s per-qubit view', () => {
  it('passes every value through untouched and wraps it with the run’s own provenance', () => {
    const parsed = ExecuteResponseSchema.parse(response({ qubit_states: [mixed(0, 1.2246467991473532e-16, 0.5000000000000001), mixed(1, 0, 0.5)] }))
    const value = quantumValueFromExecuteResponse(parsed)
    const states = value.value.qubitStates!
    expect(states.map((s) => s.qubit)).toEqual([0, 1])
    expect(states[0]!.bloch!.value).toEqual({ x: 1e-17, y: -2e-17, z: 1.2246467991473532e-16 })
    expect(states[0]!.blochLength!.value).toBe(1.2246467991473532e-16)
    expect(states[0]!.purity!.value).toBe(0.5000000000000001) // not rounded to 0.5
    expect(states[1]!.purity!.value).toBe(0.5)
    expect(states[0]!.entangledWithRest).toBe(true)
    // the same provenance as the run itself, on every number
    for (const s of states) {
      expect(s.bloch!.provenance).toEqual(value.provenance)
      expect(s.purity!.provenance).toEqual(value.provenance)
      expect(s.blochLength!.provenance).toEqual(value.provenance)
      expect(s.derivedFrom).toEqual({ stepIndex: 2, resultId: 'res_run', executionId: 'aer-1', circuitHash: 'hash_run', backend: 'qiskit-aer', backendVersion: '0.17.2' })
    }
    expect(value.provenance.resultId).toBe('res_run')
  })

  it('keeps the values the server gave even when they contradict each other (nothing is "corrected")', () => {
    const odd = { ...mixed(0, 0.9, 0.2), bloch: { x: 0.1, y: 0.2, z: 0.3 } }
    const states = quantumValueFromExecuteResponse(ExecuteResponseSchema.parse(response({ qubit_states: [odd] }))).value.qubitStates!
    expect(states[0]!.bloch!.value).toEqual({ x: 0.1, y: 0.2, z: 0.3 })
    expect(states[0]!.blochLength!.value).toBe(0.9)
    expect(states[0]!.purity!.value).toBe(0.2)
  })

  it('a server that sent none (older, or a shots run) gives no qubitStates at all, not an empty list or zero vectors', () => {
    const none = quantumValueFromExecuteResponse(ExecuteResponseSchema.parse(response()))
    expect('qubitStates' in none.value).toBe(false)
    const shots = quantumValueFromExecuteResponse(
      ExecuteResponseSchema.parse(response({ qubit_states: [] }, 'shots', { execution_id: 'aer-2', counts: { '00': 5, '11': 3 }, probabilities: { '00': 0.625, '11': 0.375 }, shots: 8 })),
    )
    expect('qubitStates' in shots.value).toBe(false)
    expect(shots.value.counts).toEqual({ '00': 5, '11': 3 })
  })

  it('an UNUSABLE qubit keeps its reason and carries no numbers', () => {
    const unusable = { qubit: 0, status: 'UNUSABLE', reason: 'the statevector has 3 amplitudes, not 4', bloch: null, bloch_length: null, purity: null, entangled_with_rest: null, method: 'm', derived_from: SOURCE }
    const states = quantumValueFromExecuteResponse(ExecuteResponseSchema.parse(response({ qubit_states: [unusable] }))).value.qubitStates!
    expect(states[0]).toMatchObject({ status: 'UNUSABLE', reason: 'the statevector has 3 amplitudes, not 4', bloch: null, blochLength: null, purity: null, entangledWithRest: null })
  })

  it('the response schema refuses a malformed state: an OK qubit without its numbers, an UNUSABLE one that carries a value or no reason', () => {
    const noNumbers = { ...mixed(0, 1, 1), bloch: null }
    expect(() => ExecuteResponseSchema.parse(response({ qubit_states: [noNumbers] }))).toThrow()
    const valued = { qubit: 0, status: 'UNUSABLE', reason: 'x', bloch: { x: 0, y: 0, z: 1 }, bloch_length: null, purity: null, entangled_with_rest: null, method: 'm', derived_from: SOURCE }
    expect(() => ExecuteResponseSchema.parse(response({ qubit_states: [valued] }))).toThrow()
    const noReason = { qubit: 0, status: 'UNUSABLE', reason: null, bloch: null, bloch_length: null, purity: null, entangled_with_rest: null, method: 'm', derived_from: SOURCE }
    expect(() => ExecuteResponseSchema.parse(response({ qubit_states: [noReason] }))).toThrow()
  })
})

describe('RealApiClient.executeCircuit', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('returns the server’s per-qubit view for the final state, and sends nothing but the circuit, mode and backend', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response({ qubit_states: [mixed(0, 0, 0.5), mixed(1, 0, 0.5)] })), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const result = await new RealApiClient().executeCircuit(BELL, 'statevector', undefined, 'qiskit-aer')
    expect(result.value.qubitStates).toHaveLength(2)
    expect(result.value.qubitStates![1]!.purity!.value).toBe(0.5)
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(Object.keys(body).sort()).toEqual(['backend', 'circuit', 'mode', 'shots'])
    expect(body.mode).toBe('statevector') // the mode the learner asked for, not a state
    expect(JSON.stringify(body)).not.toMatch(/qubit_states|bloch|purity|amplitude/)
  })

  it('a response with no per-qubit view still parses (an older server): the run is shown, the view says it is not provided', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response()), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const result = await new RealApiClient().executeCircuit(BELL, 'statevector', undefined, 'qiskit-aer')
    expect(result.value.qubitStates).toBeUndefined()
    expect(result.value.statevector).toHaveLength(4)
  })
})
