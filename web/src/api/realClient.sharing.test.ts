/**
 * The sharing and code-import endpoints from the client's side: what goes out (a circuit, ids and a pasted text, never a number, a verdict
 * or a role) and how each answer is mapped or refused. `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError, CodeNotSupportedError } from './client'
import { setLearnerTokenSource } from './learnerToken'
import type { Circuit } from '@/circuit/types'

const TOKEN = 'ql_' + 'a'.repeat(32)
const CIRCUIT: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 2,
  num_clbits: 0,
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const refusal = (status: number, code: string, message: string) => json({ detail: { code, message } }, status)

describe('RealApiClient: sharing and code import', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const client = new RealApiClient()
  const init = (call = 0) => fetchMock.mock.calls[call]![1] as RequestInit
  const body = (call = 0) => JSON.parse(init(call).body as string)
  const headers = (call = 0) => init(call).headers as Record<string, string>
  const url = (call = 0) => fetchMock.mock.calls[call]![0] as string

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    setLearnerTokenSource(() => null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setLearnerTokenSource(() => null)
  })

  describe('sharing an experiment', () => {
    it('sends the circuit and ids, never a result, a number or a verdict', async () => {
      fetchMock.mockResolvedValue(json({ experiment_id: 'ex_0123456789abcdef', path: '/shared/ex_0123456789abcdef', created_at: 'c' }, 201))
      const made = await client.createExperiment({ circuit: CIRCUIT, resultId: 'res_1', lessonId: 'l', challengeId: 'ch', title: '  Bell  ' })
      expect(url()).toBe('/api/experiments')
      expect(body()).toEqual({ circuit: CIRCUIT, result_id: 'res_1', lesson_id: 'l', challenge_id: 'ch', title: 'Bell' })
      expect(made).toEqual({ experimentId: 'ex_0123456789abcdef', path: '/shared/ex_0123456789abcdef', createdAt: 'c' })
    })

    it('omits every optional field that was not given', async () => {
      fetchMock.mockResolvedValue(json({ experiment_id: 'ex_0123456789abcdef', path: '/p', created_at: 'c' }, 201))
      await client.createExperiment({ circuit: CIRCUIT })
      expect(Object.keys(body())).toEqual(['circuit'])
    })

    it('carries the learner token as a header when in a class, so the class can count the share', async () => {
      setLearnerTokenSource(() => TOKEN)
      fetchMock.mockResolvedValue(json({ experiment_id: 'ex_0123456789abcdef', path: '/p', created_at: 'c' }, 201))
      await client.createExperiment({ circuit: CIRCUIT })
      expect(headers()['X-Qentor-Learner']).toBe(TOKEN)
      expect(JSON.stringify(body())).not.toContain(TOKEN)
    })

    it('a malformed circuit never leaves the browser', async () => {
      await expect(client.createExperiment({ circuit: { ...CIRCUIT, num_qubits: 99 } })).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a refusal keeps the server’s code (the UI offers “share without a run” on SHARE_INVALID)', async () => {
      fetchMock.mockResolvedValue(refusal(422, 'SHARE_INVALID', 'that run is not a run of this circuit'))
      await expect(client.createExperiment({ circuit: CIRCUIT, resultId: 'r' })).rejects.toMatchObject({ code: 'SHARE_INVALID', status: 422 })
    })

    const VIEW = {
      experiment_id: 'ex_0123456789abcdef',
      created_at: 'c',
      title: 'Bell',
      read_only: true,
      note: 'read-only',
      circuit_hash: 'h',
      circuit: CIRCUIT,
      qasm: 'OPENQASM 3.0;',
      generator: 'g',
      code: { qiskit: 'q', cirq: 'c', pennylane: 'p' },
      backend: 'qiskit-aer',
      mode: 'statevector',
      shots: null,
      lesson: null,
      challenge: null,
      result: {
        result_id: 'res_1',
        circuit_hash: 'h',
        backend: 'qiskit-aer',
        backend_version: '1.0',
        execution_mode: 'statevector',
        provenance_class: 'SIMULATION',
        verification_status: 'STATE_CHECKED',
        created_at: 'c',
        payload: { execution_id: 'e', statevector: [[0.7, 0], [0, 0], [0, 0], [0.7, 0]], theoretical_probabilities: { '00': 0.5, '11': 0.5 } },
      },
      result_note: 'stored',
    }

    it('reads a shared experiment and wraps its stored run exactly as a live run is wrapped', async () => {
      fetchMock.mockResolvedValue(json(VIEW))
      const e = await client.getExperiment('ex_0123456789abcdef')
      expect(url()).toBe('/api/experiments/ex_0123456789abcdef')
      expect(init().body).toBeUndefined()
      expect(headers()).not.toHaveProperty('X-Qentor-Learner') // a public page needs no identity
      expect(e.result?.provenance).toMatchObject({ resultId: 'res_1', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED', backend: 'qiskit-aer' })
      expect(e.result?.value.statevector).toHaveLength(4)
      expect(e.result?.value.theoreticalProbabilities).toEqual({ '00': 0.5, '11': 0.5 })
      expect(e.code).toEqual({ qiskit: 'q', cirq: 'c', pennylane: 'p' })
    })

    it('a shared experiment with no run has a null result', async () => {
      fetchMock.mockResolvedValue(json({ ...VIEW, result: null }))
      expect((await client.getExperiment('ex_0123456789abcdef')).result).toBeNull()
    })

    it('a view that claims not to be read-only is refused', async () => {
      fetchMock.mockResolvedValue(json({ ...VIEW, read_only: false }))
      await expect(client.getExperiment('ex_0123456789abcdef')).rejects.toThrow()
    })

    it('an unknown id is a structured 404', async () => {
      fetchMock.mockResolvedValue(refusal(404, 'EXPERIMENT_NOT_FOUND', 'No shared experiment has that id.'))
      await expect(client.getExperiment('ex_0123456789abcdef')).rejects.toMatchObject({ code: 'EXPERIMENT_NOT_FOUND', status: 404 })
    })

    it('the id is encoded into the path, so it cannot change the route', async () => {
      fetchMock.mockResolvedValue(refusal(404, 'EXPERIMENT_NOT_FOUND', 'x'))
      await client.getExperiment('../../api/classes').catch(() => undefined)
      expect(url()).toBe('/api/experiments/..%2F..%2Fapi%2Fclasses')
    })
  })

  describe('importing code', () => {
    it('sends a dialect and the text, and returns the circuit to preview', async () => {
      fetchMock.mockResolvedValue(json({ status: 'PARSED', dialect: 'qiskit', label: 'Safe subset parser — Python is not executed.', circuit: CIRCUIT, circuit_hash: 'h', canonical_qasm: 'OPENQASM 3.0;', notes: ['n'] }))
      const parsed = await client.parseCode('qiskit', 'qc = 1')
      expect(url()).toBe('/api/circuit/parse-code')
      expect(body()).toEqual({ dialect: 'qiskit', code: 'qc = 1' })
      expect(parsed).toMatchObject({ dialect: 'qiskit', circuitHash: 'h', canonicalQasm: 'OPENQASM 3.0;', notes: ['n'], label: 'Safe subset parser — Python is not executed.' })
      expect(parsed.circuit).toEqual(CIRCUIT)
    })

    it('an unsupported program is a CodeNotSupportedError naming each construct and its line', async () => {
      fetchMock.mockResolvedValue(
        json(
          {
            detail: {
              code: 'CODE_NOT_SUPPORTED',
              message: 'a for loop is not supported',
              problems: [{ line: 3, column: 0, message: 'a for loop is not supported' }],
              supported: ['qc.h(q)'],
              label: 'Safe subset parser — Python is not executed.',
            },
          },
          422,
        ),
      )
      const err = await client.parseCode('qiskit', 'for i in range(2): pass').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CodeNotSupportedError)
      expect((err as CodeNotSupportedError).problems).toEqual([{ line: 3, column: 0, message: 'a for loop is not supported' }])
      expect((err as CodeNotSupportedError).supported).toEqual(['qc.h(q)'])
    })

    it('a rate limit is not mistaken for unsupported code', async () => {
      fetchMock.mockResolvedValue(refusal(429, 'RATE_LIMITED', 'Too many requests.'))
      await expect(client.parseCode('qiskit', 'x')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    })

    it('a framework validation error (a list) is “unavailable”, not unsupported code', async () => {
      fetchMock.mockResolvedValue(json({ detail: [{ msg: 'x' }] }, 422))
      await expect(client.parseCode('qiskit', 'x')).rejects.toBeInstanceOf(BackendUnavailableError)
    })

    it('never sends a learner token or a role', async () => {
      setLearnerTokenSource(() => TOKEN)
      fetchMock.mockResolvedValue(json({ status: 'PARSED', dialect: 'cirq', label: 'l', circuit: CIRCUIT, circuit_hash: 'h', canonical_qasm: 'q', notes: [] }))
      await client.parseCode('cirq', 'x')
      expect(headers()).not.toHaveProperty('X-Qentor-Learner')
      expect(Object.keys(body()).sort()).toEqual(['code', 'dialect'])
    })
  })
})
