/**
 * Tests for RealApiClient.verifyBellState — the frontend side of
 * POST /api/verify/bell-state. `fetch` is stubbed rather than hitting a real
 * server, per this project's convention of not needing a running backend for
 * unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError } from './client'
import type { Circuit } from '@/circuit/types'

const BELL_CIRCUIT: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 2,
  num_clbits: 2,
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
    { gate: 'measure', targets: [0], controls: [], params: [], clbits: [0] },
    { gate: 'measure', targets: [1], controls: [], params: [], clbits: [1] },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('RealApiClient.verifyBellState', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends only result_id and the canonical circuit — no computed quantum result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        result_id: 'res_abc',
        circuit_hash: 'hash_abc',
        verifier: 'bell_state/1',
        verification_status: 'VERIFIED',
        checks: [{ name: 'circuit_matches_bell_pattern', status: 'PASS', detail: 'ok' }],
        expected_support: ['00', '11'],
        observed_support: ['00', '11'],
      }),
    )

    const client = new RealApiClient()
    await client.verifyBellState('res_abc', BELL_CIRCUIT)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/verify/bell-state')
    expect(init.method).toBe('POST')

    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['circuit', 'result_id'])
    expect(body.result_id).toBe('res_abc')
    expect(body.circuit).toEqual(BELL_CIRCUIT)
    for (const forbidden of ['probabilities', 'counts', 'statevector', 'verification_status', 'verdict']) {
      expect(body).not.toHaveProperty(forbidden)
    }
  })

  it('parses a successful VERIFIED report', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        result_id: 'res_abc',
        circuit_hash: 'hash_abc',
        verifier: 'bell_state/1',
        verification_status: 'VERIFIED',
        checks: [
          { name: 'circuit_matches_bell_pattern', status: 'PASS', detail: 'ok' },
          { name: 'observed_support_within_expected', status: 'PASS', detail: 'ok' },
        ],
        expected_support: ['00', '11'],
        observed_support: ['00', '11'],
      }),
    )

    const client = new RealApiClient()
    const result = await client.verifyBellState('res_abc', BELL_CIRCUIT)

    expect(result.verificationStatus).toBe('VERIFIED')
    expect(result.resultId).toBe('res_abc')
    expect(result.circuitHash).toBe('hash_abc')
    expect(result.verifier).toBe('bell_state/1')
    expect(result.expectedSupport).toEqual(['00', '11'])
    expect(result.observedSupport).toEqual(['00', '11'])
    expect(result.checks).toHaveLength(2)
  })

  it('parses a FAILED report without throwing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        result_id: 'res_abc',
        circuit_hash: 'hash_abc',
        verifier: 'bell_state/1',
        verification_status: 'FAILED',
        checks: [
          { name: 'observed_support_within_expected', status: 'FAIL', detail: 'unexpected outcome 01' },
        ],
        expected_support: ['00', '11'],
        observed_support: ['00', '01', '11'],
      }),
    )

    const client = new RealApiClient()
    const result = await client.verifyBellState('res_abc', BELL_CIRCUIT)

    expect(result.verificationStatus).toBe('FAILED')
    expect(result.checks[0]?.status).toBe('FAIL')
    expect(result.observedSupport).toEqual(['00', '01', '11'])
  })

  it('throws BackendUnavailableError with status 404 for an unknown result_id', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: "no provenance record found for result_id 'res_missing'" }, 404),
    )

    const client = new RealApiClient()

    await expect(client.verifyBellState('res_missing', BELL_CIRCUIT)).rejects.toMatchObject({
      name: 'BackendUnavailableError',
      status: 404,
    })
  })

  it('never fabricates a report when the network fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))

    const client = new RealApiClient()

    await expect(client.verifyBellState('res_abc', BELL_CIRCUIT)).rejects.toBeInstanceOf(
      BackendUnavailableError,
    )
  })
})
