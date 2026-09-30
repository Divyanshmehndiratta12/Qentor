/**
 * The Lab's read-only endpoints from the client's side: what goes out (the canonical circuit(s), a backend NAME, nothing else)
 * and how the answer is mapped. `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError } from './client'
import type { Circuit } from '@/circuit/types'

const CIRCUIT: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 2,
  num_clbits: 0,
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
  ],
}
const OTHER: Circuit = { ...CIRCUIT, ops: [CIRCUIT.ops[0]] }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const PROVENANCE = (backend: string, id: string) => ({
  result_id: id,
  circuit_hash: 'hash',
  backend,
  backend_version: '1.0',
  execution_mode: 'statevector',
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
  created_at: '2026-01-01T00:00:00Z',
})

describe('RealApiClient — the Lab endpoints', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const body = (call = 0) => JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string)
  const url = (call = 0) => fetchMock.mock.calls[call]![0] as string

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  describe('executeCircuit sends the chosen backend', () => {
    const RESPONSE = { ...PROVENANCE('cirq', 'res_1'), payload: { execution_id: 'e', statevector: [[1, 0]] }, execution_mode: 'statevector' }

    it('as a name in the body, next to the circuit, the mode and the shots', async () => {
      fetchMock.mockResolvedValueOnce(json(RESPONSE))
      await new RealApiClient().executeCircuit(CIRCUIT, 'statevector', undefined, 'cirq')
      expect(body()).toEqual({ circuit: CIRCUIT, mode: 'statevector', shots: null, backend: 'cirq' })
    })

    it('and omits it when none is given (the server default, exactly as before)', async () => {
      fetchMock.mockResolvedValueOnce(json(RESPONSE))
      await new RealApiClient().executeCircuit(CIRCUIT, 'statevector')
      expect(body()).not.toHaveProperty('backend')
    })
  })

  describe('generateCode', () => {
    const CODE = { circuit_hash: 'h', generator: 'qentor.codegen/1', code: { qiskit: 'qc = ...', cirq: 'circuit = ...', pennylane: 'def circuit(): ...' } }

    it('sends the circuit and nothing else, to /api/circuit/code', async () => {
      fetchMock.mockResolvedValueOnce(json(CODE))
      const result = await new RealApiClient().generateCode(CIRCUIT)
      expect(url()).toMatch(/\/api\/circuit\/code$/)
      expect(Object.keys(body())).toEqual(['circuit'])
      expect(result).toEqual({ circuitHash: 'h', generator: 'qentor.codegen/1', code: CODE.code })
    })

    it('rejects a response that is missing a framework instead of guessing', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...CODE, code: { qiskit: 'x' } }))
      await expect(new RealApiClient().generateCode(CIRCUIT)).rejects.toThrow()
    })
  })

  describe('checkEquivalence', () => {
    const REPORT = {
      status: 'EQUIVALENT',
      method: 'qiskit.quantum_info.Operator.equiv',
      checker_version: '2.5.2',
      circuit_hash_a: 'a',
      circuit_hash_b: 'b',
      global_phase: 0.25,
      checks: [{ name: 'operator_equivalent_up_to_global_phase', status: 'PASS', detail: 'ok' }],
      reason: null,
    }

    it('sends exactly the two circuits, in order, and no verdict field', async () => {
      fetchMock.mockResolvedValueOnce(json(REPORT))
      await new RealApiClient().checkEquivalence(CIRCUIT, OTHER)
      expect(url()).toMatch(/\/api\/verify\/equivalence$/)
      expect(body()).toEqual({ circuit_a: CIRCUIT, circuit_b: OTHER })
    })

    it('maps the server’s report unchanged', async () => {
      fetchMock.mockResolvedValueOnce(json(REPORT))
      expect(await new RealApiClient().checkEquivalence(CIRCUIT, OTHER)).toEqual({
        status: 'EQUIVALENT',
        method: 'qiskit.quantum_info.Operator.equiv',
        checkerVersion: '2.5.2',
        circuitHashA: 'a',
        circuitHashB: 'b',
        globalPhase: 0.25,
        checks: REPORT.checks,
        reason: null,
      })
    })

    it('refuses a verdict the schema does not know', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...REPORT, status: 'PROBABLY_EQUIVALENT' }))
      await expect(new RealApiClient().checkEquivalence(CIRCUIT, OTHER)).rejects.toThrow()
    })

    it('shows a size-limit refusal as its message', async () => {
      const detail = { code: 'CIRCUIT_TOO_MANY_QUBITS', message: 'an equivalence check on 11 qubits needs a 2**11 operator', limit: 10, requested: 11 }
      fetchMock.mockResolvedValueOnce(json({ detail }, 422))
      await expect(new RealApiClient().checkEquivalence(CIRCUIT, OTHER)).rejects.toThrow(detail.message)
    })
  })

  describe('compareBackends', () => {
    const REPORT = {
      method: 'qentor.agreement/1',
      threshold: 1e-6,
      status: 'AGREE',
      circuit_hash: 'h',
      terminal_measurements_stripped: 2,
      backends: [
        { backend: 'qiskit-aer', status: 'RAN', message: null, provenance: PROVENANCE('qiskit-aer', 'res_a') },
        { backend: 'cirq', status: 'UNAVAILABLE', message: 'cirq is unavailable', provenance: null },
      ],
      pairs: [{ backend_a: 'qiskit-aer', backend_b: 'pennylane', max_amplitude_difference: 1e-16, max_probability_difference: 2e-16, fidelity: 1, agrees: true }],
      provenance: { ...PROVENANCE('cross-backend-agreement', 'res_cmp'), execution_mode: 'agreement' },
    }

    it('sends the circuit alone by default, and the backend names when chosen', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(json(REPORT))) // a fresh Response per call: a body can be read once
      await new RealApiClient().compareBackends(CIRCUIT)
      await new RealApiClient().compareBackends(CIRCUIT, ['cirq', 'pennylane'])
      expect(url()).toMatch(/\/api\/compare\/backends$/)
      expect(body(0)).toEqual({ circuit: CIRCUIT })
      expect(body(1)).toEqual({ circuit: CIRCUIT, backends: ['cirq', 'pennylane'] })
    })

    it('maps every field, including provenance objects for the comparison and for each backend that ran', async () => {
      fetchMock.mockResolvedValueOnce(json(REPORT))
      const result = await new RealApiClient().compareBackends(CIRCUIT)
      expect(result.status).toBe('AGREE')
      expect(result.threshold).toBe(1e-6)
      expect(result.terminalMeasurementsStripped).toBe(2)
      expect(result.pairs[0]).toEqual({ backendA: 'qiskit-aer', backendB: 'pennylane', maxAmplitudeDifference: 1e-16, maxProbabilityDifference: 2e-16, fidelity: 1, agrees: true })
      expect(result.provenance).toMatchObject({ resultId: 'res_cmp', backend: 'cross-backend-agreement', executionMode: 'agreement' })
      expect(result.backends[0].provenance).toMatchObject({ resultId: 'res_a', verificationStatus: 'STATE_CHECKED' })
      expect(result.backends[1]).toEqual({ backend: 'cirq', status: 'UNAVAILABLE', message: 'cirq is unavailable', provenance: null })
    })

    it('never sends a value: the body has no statevector, probability, verdict or threshold', async () => {
      fetchMock.mockResolvedValueOnce(json(REPORT))
      await new RealApiClient().compareBackends(CIRCUIT, ['qiskit-aer', 'cirq'])
      expect(JSON.stringify(body())).not.toMatch(/statevector|probabilit|fidelity|threshold|status|agree/i)
    })

    it('an unreachable backend is a BackendUnavailableError, not a made-up report', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'))
      await expect(new RealApiClient().compareBackends(CIRCUIT)).rejects.toBeInstanceOf(BackendUnavailableError)
    })
  })
})
