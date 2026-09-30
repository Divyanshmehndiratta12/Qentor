/**
 * Structured refusals from the backend read as their message, never as raw JSON.
 *
 * The backend now refuses an over-sized request with `422 {detail: {code, message, limit, requested,
 * backend}}` and a malformed backend result with `502 {detail: {code, message}}`. Before, every
 * endpoint but the trace showed such a body as `{"detail":{"code":...}}`. These tests pin that the
 * learner sees the sentence, that a plain string detail is unchanged, and that a body that is not
 * a structured refusal is still shown as-is (the frontend never invents a message).
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

const LIMIT_DETAIL = {
  code: 'CIRCUIT_TOO_MANY_QUBITS',
  message: 'a 17-qubit circuit is over the 16-qubit limit for qiskit-aer; reduce the number of qubits',
  limit: 16,
  requested: 17,
  backend: 'qiskit-aer',
}

const respond = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('structured backend refusals', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const calls: Array<[string, (c: RealApiClient) => Promise<unknown>]> = [
    ['executeCircuit', (c) => c.executeCircuit(CIRCUIT, 'statevector')],
    ['optimizeCircuit', (c) => c.optimizeCircuit(CIRCUIT)],
    ['runMultiInputTest', (c) => c.runMultiInputTest(CIRCUIT, [0], [0], [{ inputBits: '0', expectedOutput: '0' }])],
  ]

  it.each(calls)('%s shows a 422 limit refusal as its message', async (_name, call) => {
    fetchMock.mockResolvedValueOnce(respond({ detail: LIMIT_DETAIL }, 422))
    const error = await call(new RealApiClient()).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(BackendUnavailableError)
    expect((error as Error).message).toBe(LIMIT_DETAIL.message)
    expect((error as Error).message).not.toContain('{')
  })

  it('shows a 502 malformed-result refusal as its message', async () => {
    const detail = { code: 'EXECUTION_STATE_INVALID', message: "backend 'cirq' returned a result that failed the state check: the statevector's squared norm is 4.0" }
    fetchMock.mockResolvedValueOnce(respond({ detail }, 502))
    await expect(new RealApiClient().executeCircuit(CIRCUIT, 'statevector')).rejects.toThrow(detail.message)
  })

  it('a plain string detail is unchanged', async () => {
    fetchMock.mockResolvedValueOnce(respond({ detail: 'Backend is unavailable' }, 503))
    await expect(new RealApiClient().executeCircuit(CIRCUIT, 'statevector')).rejects.toThrow('Backend is unavailable')
  })

  it('a body that is not a structured refusal is shown as received, not rewritten', async () => {
    fetchMock.mockResolvedValueOnce(respond({ detail: [{ loc: ['body', 'mode'], msg: 'bad' }] }, 422))
    await expect(new RealApiClient().executeCircuit(CIRCUIT, 'statevector')).rejects.toThrow('"loc"')
  })

  it('a non-JSON body reports the HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(new RealApiClient().executeCircuit(CIRCUIT, 'statevector')).rejects.toThrow('HTTP 502')
  })

  it('the status code is kept on the error', async () => {
    fetchMock.mockResolvedValueOnce(respond({ detail: LIMIT_DETAIL }, 422))
    const error = (await new RealApiClient().executeCircuit(CIRCUIT, 'statevector').catch((e: unknown) => e)) as BackendUnavailableError
    expect(error.status).toBe(422)
  })
})
