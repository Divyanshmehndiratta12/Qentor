/**
 * The challenge endpoints from the client's side: what goes out (the circuit and nothing else) and how the answer is mapped.
 * The trust rule: a number from the server is only ever handed on together with the provenance record it came from.
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

const RECORD = (id: string) => ({
  result_id: id,
  circuit_hash: 'qc_abc',
  backend: 'qiskit-aer',
  backend_version: '0.17.2',
  execution_mode: 'statevector',
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
  created_at: '2026-01-01T00:00:00Z',
})

const CATALOG = {
  challenges: [
    {
      id: 'create-plus',
      lesson_id: 'superposition',
      title: 'Create |+⟩',
      goal: 'Make |+⟩.',
      difficulty: 'beginner',
      success_condition: 'State is |+⟩.',
      fixed_oracle: false,
      constraints: {
        num_qubits: 1,
        num_clbits: 0,
        allowed_gates: ['h', 'x'],
        max_ops: 6,
        min_gate_counts: { h: 1 },
        anchor: [],
        must_measure: [],
      },
      starter_circuit: CIRCUIT,
      checks: [{ id: 'state.is_plus', label: 'The final state is |+⟩' }],
      hints: ['one', 'two', 'three'],
    },
  ],
}

const SUBMIT = {
  attempt_id: 'att_1',
  challenge_id: 'create-plus',
  circuit_hash: 'qc_abc',
  passed: true,
  verifier: 'challenge/1',
  checks: [
    { id: 'structure.width', label: 'Uses 1 qubit', passed: true, evaluated: true, detail: 'ok', hint_index: 0, evidence: [], result_id: null },
    {
      id: 'state.is_plus',
      label: 'The final state is |+⟩',
      passed: true,
      evaluated: true,
      detail: 'ok',
      hint_index: 1,
      evidence: [{ name: 'fidelity', value: 1 }],
      result_id: 'res_final',
    },
  ],
  backend: 'qiskit-aer',
  backend_version: '0.17.2',
  final_result_id: 'res_final',
  provenance: { res_final: RECORD('res_final') },
  next_hint_index: null,
  next_hint: null,
  success_message: 'H turns |0⟩ into |+⟩.',
  created_at: '2026-01-01T00:00:01Z',
}

describe('RealApiClient — challenges', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const body = () => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
  const url = () => fetchMock.mock.calls[0]![0] as string

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  describe('listChallenges', () => {
    it('reads /api/challenges and maps snake_case to the domain shape', async () => {
      fetchMock.mockResolvedValueOnce(json(CATALOG))
      const [c] = await new RealApiClient().listChallenges()
      expect(url()).toMatch(/\/api\/challenges$/)
      expect(c).toMatchObject({
        id: 'create-plus',
        lessonId: 'superposition',
        successCondition: 'State is |+⟩.',
        fixedOracle: false,
        hints: ['one', 'two', 'three'],
        constraints: { numQubits: 1, allowedGates: ['h', 'x'], maxOps: 6, minGateCounts: { h: 1 }, anchor: [], mustMeasure: [] },
      })
      expect(c!.starterCircuit.ops).toHaveLength(1)
    })

    it('a malformed catalog is refused, not partly shown', async () => {
      fetchMock.mockResolvedValueOnce(json({ challenges: [{ id: 'x' }] }))
      await expect(new RealApiClient().listChallenges()).rejects.toThrow()
    })

    it('an unreachable server is an honest unavailable error', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('network down'))
      await expect(new RealApiClient().listChallenges()).rejects.toBeInstanceOf(BackendUnavailableError)
    })

    it('a 5xx keeps its status', async () => {
      fetchMock.mockResolvedValueOnce(json({ detail: 'boom' }, 503))
      await expect(new RealApiClient().listChallenges()).rejects.toMatchObject({ status: 503, message: 'boom' })
    })
  })

  describe('submitChallenge', () => {
    it('POSTs the circuit and NOTHING else', async () => {
      fetchMock.mockResolvedValueOnce(json(SUBMIT))
      await new RealApiClient().submitChallenge('create-plus', CIRCUIT)
      expect(url()).toMatch(/\/api\/challenges\/create-plus\/submit$/)
      expect(Object.keys(body())).toEqual(['circuit'])
    })

    it('escapes the challenge id in the path', async () => {
      fetchMock.mockResolvedValueOnce(json(SUBMIT))
      await new RealApiClient().submitChallenge('a/../b', CIRCUIT)
      expect(url()).not.toContain('a/../b')
      expect(url()).toContain('a%2F..%2Fb')
    })

    it('hands back the server’s verdict untouched', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...SUBMIT, passed: false, success_message: null, next_hint_index: 1, next_hint: 'two' }))
      const result = await new RealApiClient().submitChallenge('create-plus', CIRCUIT)
      expect(result.passed).toBe(false)
      expect(result.nextHint).toBe('two')
      expect(result.attemptId).toBe('att_1')
    })

    it('wraps every number with the provenance record it came from', async () => {
      fetchMock.mockResolvedValueOnce(json(SUBMIT))
      const result = await new RealApiClient().submitChallenge('create-plus', CIRCUIT)
      const evidence = result.checks[1]!.evidence[0]!
      expect(evidence.name).toBe('fidelity')
      expect(evidence.value.value).toBe(1)
      expect(evidence.value.provenance).toMatchObject({ resultId: 'res_final', backend: 'qiskit-aer', provenanceClass: 'SIMULATION' })
      expect(result.finalProvenance).toMatchObject({ resultId: 'res_final' })
      expect(result.checks[0]!.evidence).toEqual([])
    })

    it('refuses a response whose numbers have no provenance record', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...SUBMIT, provenance: {} }))
      await expect(new RealApiClient().submitChallenge('create-plus', CIRCUIT)).rejects.toBeInstanceOf(BackendUnavailableError)
    })

    it('refuses evidence that names no result at all', async () => {
      const bad = { ...SUBMIT, checks: [{ ...SUBMIT.checks[1]!, result_id: null }] }
      fetchMock.mockResolvedValueOnce(json(bad))
      await expect(new RealApiClient().submitChallenge('create-plus', CIRCUIT)).rejects.toBeInstanceOf(BackendUnavailableError)
    })

    it('refuses an unknown provenance class (a bare "FIXTURE" cannot arrive over the wire)', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...SUBMIT, provenance: { res_final: { ...RECORD('res_final'), provenance_class: 'FIXTURE' } } }))
      await expect(new RealApiClient().submitChallenge('create-plus', CIRCUIT)).rejects.toThrow()
    })

    it('a nothing-ran response has no final provenance and no evidence', async () => {
      const notRun = {
        ...SUBMIT,
        passed: false,
        final_result_id: null,
        provenance: {},
        backend: null,
        backend_version: null,
        checks: [{ ...SUBMIT.checks[0]!, passed: false }, { id: 'state.is_plus', label: 'x', passed: false, evaluated: false, detail: 'later', hint_index: 1, evidence: [], result_id: null }],
      }
      fetchMock.mockResolvedValueOnce(json(notRun))
      const result = await new RealApiClient().submitChallenge('create-plus', CIRCUIT)
      expect(result.finalProvenance).toBeNull()
      expect(result.finalResultId).toBeNull()
      expect(result.checks[1]!.evaluated).toBe(false)
    })

    it('a 422 refusal keeps its status and its message', async () => {
      fetchMock.mockResolvedValueOnce(json({ detail: { code: 'CIRCUIT_TOO_MANY_OPERATIONS', message: 'too big' } }, 422))
      await expect(new RealApiClient().submitChallenge('create-plus', CIRCUIT)).rejects.toMatchObject({ status: 422, message: 'too big' })
    })

    it('never sends a malformed circuit', async () => {
      await expect(
        new RealApiClient().submitChallenge('create-plus', { ...CIRCUIT, num_qubits: 0 } as Circuit),
      ).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
