/**
 * Tests for RealApiClient.traceCircuit — the frontend side of
 * POST /api/execute/trace. `fetch` is stubbed (no running backend needed), per
 * this project's convention. Response bodies are built by the wire-format
 * fixtures, i.e. exactly the JSON shape the backend sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { MockApiClient } from './mockClient'
import { BackendUnavailableError, EndpointNotImplementedError, TraceRejectedError } from './client'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { BASIS_ORDERING_WIRE, CX01, H0, MEASURE0, MEASURE1, X0, wireTrace } from '@/test/traceFixtures'

const BELL_MEASURED: Circuit = {
  ...emptyCircuit(2, 2),
  ops: [H0, CX01, MEASURE0, MEASURE1],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const bellWire = () =>
  wireTrace({
    numQubits: 2,
    ops: [H0, CX01],
    states: [
      [[1, 0], [0, 0], [0, 0], [0, 0]],
      [[0.7071067811865476, 0], [0.7071067811865476, 0], [0, 0], [0, 0]],
      [[0.7071067811865476, 0], [0, 0], [0, 0], [0.7071067811865476, 0]],
    ],
    terminalMeasurements: [MEASURE0, MEASURE1],
  })

describe('RealApiClient.traceCircuit', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('request', () => {
    it('POSTs the canonical circuit and mode "statevector" to /api/execute/trace — nothing else', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(bellWire()))

      await new RealApiClient().traceCircuit(BELL_MEASURED)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/execute/trace')
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')

      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(['circuit', 'mode'])
      expect(body.mode).toBe('statevector')
      expect(body.circuit).toEqual(BELL_MEASURED)
      for (const forbidden of ['probabilities', 'counts', 'statevector', 'amplitudes', 'verification_status', 'shots']) {
        expect(body).not.toHaveProperty(forbidden)
      }
    })

    it('adds `backend` only when one is chosen', async () => {
      fetchMock.mockResolvedValue(jsonResponse(bellWire()))

      await new RealApiClient().traceCircuit(BELL_MEASURED, 'cirq')

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.backend).toBe('cirq')
    })

    it('rejects an invalid circuit locally, before any network call', async () => {
      const invalid = { ...emptyCircuit(2), num_qubits: 0 } as Circuit

      await expect(new RealApiClient().traceCircuit(invalid)).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('successful response', () => {
    it('keeps every field of the backend response, in camelCase', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(bellWire()))

      const trace = await new RealApiClient().traceCircuit(BELL_MEASURED)

      expect(trace.circuitHash).toBe('hash_submitted_a')
      expect(trace.tracedCircuitHash).toBe('hash_traced_a')
      expect(trace.backend).toBe('qiskit-aer')
      expect(trace.backendVersion).toBe('0.17.2')
      expect(trace.numQubits).toBe(2)
      expect(trace.mode).toBe('statevector')
      expect(trace.traceMethod).toBe('prefix-statevector')
      expect(trace.basisOrdering).toBe(BASIS_ORDERING_WIRE)
      expect(trace.finalResultId).toBe('res_a2')
      expect(trace.steps).toHaveLength(3)
    })

    it('preserves step index, operation index, canonical operation, execution id and provenance per step', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(bellWire()))

      const { steps } = await new RealApiClient().traceCircuit(BELL_MEASURED)

      expect(steps.map((s) => s.stepIndex)).toEqual([0, 1, 2])
      expect(steps.map((s) => s.operationIndex)).toEqual([null, 0, 1])
      expect(steps.map((s) => s.operation)).toEqual([null, H0, CX01])
      expect(steps.map((s) => s.executionId)).toEqual(['aer-local-a0', 'aer-local-a1', 'aer-local-a2'])

      expect(steps[1]!.state.provenance).toEqual({
        resultId: 'res_a1',
        circuitHash: 'hash_prefix_a1',
        backend: 'qiskit-aer',
        backendVersion: '0.17.2',
        executionMode: 'statevector',
        provenanceClass: 'SIMULATION',
        verificationStatus: 'STATE_CHECKED',
        createdAt: '2026-09-29T07:18:11+00:00',
      })
    })

    it('hands back the backend statevector values untouched — no rounding, normalising or arithmetic', async () => {
      // Deliberately awkward numbers, including a non-normalised state: any
      // rounding or rescaling in the client would change them.
      const awkward = [
        [0.1234567890123456, -0.6543210987654321],
        [1e-17, 2.5],
      ]
      fetchMock.mockResolvedValueOnce(
        jsonResponse(wireTrace({ numQubits: 1, ops: [X0], states: [awkward as never, awkward as never] })),
      )

      const { steps } = await new RealApiClient().traceCircuit({ ...emptyCircuit(1), ops: [X0] })

      for (const step of steps) {
        expect(step.state.value).toEqual(awkward)
        expect(step.state.value[0]![0]).toBe(0.1234567890123456)
        expect(step.state.value[1]![0]).toBe(1e-17)
      }
    })

    it('wraps each step\'s state in a QuantumValue carrying THAT step\'s provenance', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(bellWire()))

      const { steps } = await new RealApiClient().traceCircuit(BELL_MEASURED)

      expect(steps.map((s) => s.state.provenance.resultId)).toEqual(['res_a0', 'res_a1', 'res_a2'])
      expect(steps.map((s) => s.state.provenance.circuitHash)).toEqual([
        'hash_prefix_a0',
        'hash_prefix_a1',
        'hash_prefix_a2',
      ])
    })

    it('reports terminal measurements as metadata only — no state, no provenance', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(bellWire()))

      const trace = await new RealApiClient().traceCircuit(BELL_MEASURED)

      expect(trace.terminalMeasurements).toEqual([
        { operationIndex: 2, operation: MEASURE0 },
        { operationIndex: 3, operation: MEASURE1 },
      ])
      for (const m of trace.terminalMeasurements) {
        expect(Object.keys(m).sort()).toEqual(['operation', 'operationIndex'])
      }
      // ...and they are not steps.
      expect(trace.steps.some((s) => s.operation?.gate === 'measure')).toBe(false)
    })

    it('accepts a one-step trace (empty circuit)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(wireTrace({ numQubits: 1, ops: [], states: [[[1, 0], [0, 0]]] })))

      const trace = await new RealApiClient().traceCircuit(emptyCircuit(1))

      expect(trace.steps).toHaveLength(1)
      expect(trace.steps[0]!.operation).toBeNull()
    })
  })

  describe('malformed responses are rejected, never rendered', () => {
    async function rejectsAsMalformed(body: unknown) {
      fetchMock.mockResolvedValueOnce(jsonResponse(body))
      const error = await new RealApiClient().traceCircuit(BELL_MEASURED).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('ZodError')
      return error as Error
    }

    const mutate = (change: (wire: any) => void) => {
      const wire = JSON.parse(JSON.stringify(bellWire()))
      change(wire)
      return wire
    }

    it.each([
      ['a missing required field', (w: any) => delete w.basis_ordering],
      ['no steps at all', (w: any) => (w.steps = [])],
      ['a missing provenance block', (w: any) => delete w.steps[1].provenance],
      ['an unknown provenance class', (w: any) => (w.steps[1].provenance.provenance_class = 'PSYCHIC')],
      ['an unknown verification status', (w: any) => (w.steps[1].provenance.verification_status = 'GREAT')],
      ['an unknown gate', (w: any) => (w.steps[1].operation.gate = 'teleport')],
      ['a non-numeric amplitude', (w: any) => (w.steps[1].statevector[0][0] = 'half')],
      ['an amplitude that is not a [re, im] pair', (w: any) => (w.steps[1].statevector[0] = [1])],
      ['a statevector of the wrong length', (w: any) => w.steps[1].statevector.pop()],
      ['steps out of order', (w: any) => (w.steps[2].step_index = 5)],
      ['an initial step that has an operation', (w: any) => (w.steps[0].operation = { gate: 'h', targets: [0], controls: [], params: [], clbits: [] })],
      ['a later step with no operation', (w: any) => (w.steps[1].operation = null)],
      ['a terminal measurement with no operation', (w: any) => delete w.terminal_measurements[0].operation],
    ])('%s', async (_label, change) => {
      await rejectsAsMalformed(mutate(change))
    })

    it('rejects a body that is not an object at all', async () => {
      await rejectsAsMalformed('not a trace')
      await rejectsAsMalformed(null)
    })
  })

  describe('errors', () => {
    it.each([
      [422, 'TRACE_MODE_UNSUPPORTED', "execution trace is only available in statevector mode"],
      [422, 'TRACE_MID_CIRCUIT_MEASUREMENT', 'op[2] (x) comes after a measurement (op[1])'],
      [422, 'TRACE_CIRCUIT_TOO_LARGE', 'circuit has 9 qubits'],
      [422, 'TRACE_TOO_MANY_OPERATIONS', 'circuit has 256 operations'],
      [502, 'TRACE_STATE_NOT_NORMALISED', 'backend returned an unnormalised state'],
      [503, 'TRACE_BACKEND_UNAVAILABLE', "Backend 'qiskit-aer' is unavailable"],
      [400, 'TRACE_BACKEND_EXECUTION_FAILED', 'Aer run did not succeed'],
    ])('a structured %i refusal (%s) becomes a TraceRejectedError with its code and message', async (status, code, message) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: { code, message } }, status))

      const error = await new RealApiClient().traceCircuit(BELL_MEASURED).then(
        () => null,
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(TraceRejectedError)
      expect((error as TraceRejectedError).code).toBe(code)
      expect((error as TraceRejectedError).message).toBe(message)
      expect((error as TraceRejectedError).status).toBe(status)
      // Deliberately not the generic error, so the UI can tell them apart.
      expect(error).not.toBeInstanceOf(BackendUnavailableError)
    })

    it('a FastAPI validation error (list detail) is NOT a trace refusal', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: [{ loc: ['body', 'circuit'], msg: 'field required', type: 'missing' }] }, 422),
      )

      const error = await new RealApiClient().traceCircuit(BELL_MEASURED).then(
        () => null,
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(BackendUnavailableError)
      expect(error).not.toBeInstanceOf(TraceRejectedError)
      expect((error as BackendUnavailableError).status).toBe(422)
      expect((error as Error).message).toContain('field required')
    })

    it('a string detail is reported as-is as an unstructured error', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'something exploded' }, 500))

      const error = await new RealApiClient().traceCircuit(BELL_MEASURED).then(
        () => null,
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(BackendUnavailableError)
      expect((error as Error).message).toBe('something exploded')
    })

    it('a detail object without a string code+message is not treated as structured', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: { code: 7 } }, 500))

      const error = await new RealApiClient().traceCircuit(BELL_MEASURED).then(
        () => null,
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(BackendUnavailableError)
    })

    it('a non-JSON error body falls back to the HTTP status', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }))

      const error = await new RealApiClient().traceCircuit(BELL_MEASURED).then(
        () => null,
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(BackendUnavailableError)
      expect((error as Error).message).toBe('HTTP 502')
    })

    it('an unreachable backend is reported as such', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await expect(new RealApiClient().traceCircuit(BELL_MEASURED)).rejects.toThrow(
        /could not reach the Qentor backend: Failed to fetch/,
      )
    })

    it('never resolves with data after a refusal', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: { code: 'TRACE_MODE_UNSUPPORTED', message: 'no' } }, 422),
      )
      const settled = await new RealApiClient()
        .traceCircuit(BELL_MEASURED)
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      expect(settled).not.toHaveProperty('value')
    })
  })
})

describe('MockApiClient.traceCircuit', () => {
  it('has no fake trace: it reports the endpoint as not implemented instead of inventing states', async () => {
    const settled = await new MockApiClient()
      .traceCircuit(BELL_MEASURED)
      .then((value) => ({ value }), (error: unknown) => ({ error }))

    expect(settled).not.toHaveProperty('value')
    expect((settled as { error: unknown }).error).toBeInstanceOf(EndpointNotImplementedError)
  })
})
