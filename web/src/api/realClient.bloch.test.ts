/**
 * API-boundary tests for `bloch_vector` on POST /api/execute/trace: how the
 * backend's Bloch vector arrives in the frontend. `fetch` is stubbed; bodies
 * are built by the wire-format fixtures (the JSON the backend sends).
 *
 * The frontend must only pass these numbers through: no rounding, clamping,
 * normalising or derivation. These tests pin that, and pin that a Bloch
 * vector whose `derived_from` doesn't name its own step is rejected rather
 * than rendered with a mislinked source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { emptyCircuit } from '@/circuit/types'
import {
  CX01,
  H0,
  HZH_BLOCH_STATES,
  HZH_BLOCH_VECTORS,
  MEASURE0,
  MEASURE1,
  Z0,
  wireTrace,
} from '@/test/traceFixtures'

const CIRCUIT = { ...emptyCircuit(1), ops: [H0, Z0, H0] }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const hzhWire = () =>
  wireTrace({ numQubits: 1, ops: [H0, Z0, H0], states: HZH_BLOCH_STATES, blochVectors: HZH_BLOCH_VECTORS })

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

describe('RealApiClient.traceCircuit — bloch_vector', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const trace = async (wire: unknown) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(wire))
    return new RealApiClient().traceCircuit(CIRCUIT)
  }

  const rejects = async (wire: unknown) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(wire))
    const error = await new RealApiClient().traceCircuit(CIRCUIT).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('ZodError')
    return error as Error
  }

  const mutate = (change: (wire: any) => void) => {
    const wire = JSON.parse(JSON.stringify(hzhWire()))
    change(wire)
    return wire
  }

  describe('a single-qubit trace', () => {
    it('carries the backend’s vector into every step, in camelCase', async () => {
      const { steps } = await trace(hzhWire())

      expect(steps.map((s) => s.blochVector !== null)).toEqual([true, true, true, true])
      const step2 = steps[2]!.blochVector!
      expect(step2.method).toBe('bloch-from-statevector/1')
      expect(step2.derivedFrom).toEqual({
        stepIndex: 2,
        resultId: 'res_a2',
        executionId: 'aer-local-a2',
        circuitHash: 'hash_prefix_a2',
        backend: 'qiskit-aer',
        backendVersion: '0.17.2',
      })
    })

    it('passes every coordinate through EXACTLY — including ~1e-16 residues — with no rounding', async () => {
      const { steps } = await trace(hzhWire())

      steps.forEach((step, i) => {
        const { x, y, z } = step.blochVector!.coordinates.value
        expect([x, y, z]).toEqual(HZH_BLOCH_VECTORS[i])
      })
      const last = steps[3]!.blochVector!.coordinates.value
      expect(last.x).toBe(4.440892098500626e-16)
      expect(last.y).toBe(-1.2246467991473532e-16)
      expect(last.z).toBe(-1)
    })

    it('does not touch a value that is out of range — no clamping, no normalising', async () => {
      const wire = mutate((w) => {
        w.steps[1].bloch_vector.x = 1.5
        w.steps[1].bloch_vector.y = -2.25
        w.steps[1].bloch_vector.z = 1.0000000002
      })

      const { steps } = await trace(wire)

      expect(steps[1]!.blochVector!.coordinates.value).toEqual({ x: 1.5, y: -2.25, z: 1.0000000002 })
    })

    it('wraps the coordinates in a QuantumValue carrying THAT step’s provenance', async () => {
      const { steps } = await trace(hzhWire())

      steps.forEach((step, i) => {
        expect(step.blochVector!.coordinates.provenance).toBe(step.state.provenance)
        expect(step.blochVector!.coordinates.provenance.resultId).toBe(`res_a${i}`)
        expect(step.blochVector!.coordinates.provenance.circuitHash).toBe(`hash_prefix_a${i}`)
      })
    })

    it('exposes only x, y, z, method and the source — nothing derived by the client', async () => {
      const { steps } = await trace(hzhWire())
      const bloch = steps[1]!.blochVector!

      expect(Object.keys(bloch).sort()).toEqual(['coordinates', 'derivedFrom', 'method'])
      expect(Object.keys(bloch.coordinates.value).sort()).toEqual(['x', 'y', 'z'])
    })
  })

  describe('steps with no vector', () => {
    it('a multi-qubit (Bell) trace maps to null on every step, with the full statevector still present', async () => {
      const { steps } = await trace(bellWire())

      expect(steps).toHaveLength(3)
      for (const step of steps) {
        expect(step.blochVector).toBeNull()
        expect(step.state.value).toHaveLength(4)
      }
    })

    it('an explicit null and a missing key both mean "no vector"', async () => {
      const withMissingKey = mutate((w) => w.steps.forEach((s: any) => delete s.bloch_vector))
      const withExplicitNull = mutate((w) => w.steps.forEach((s: any) => (s.bloch_vector = null)))

      for (const wire of [withMissingKey, withExplicitNull]) {
        const { steps } = await trace(wire)
        expect(steps.every((s) => s.blochVector === null)).toBe(true)
      }
    })

    it('never fills in a vector the backend did not send (no zero vector, no default)', async () => {
      const wire = mutate((w) => (w.steps[2].bloch_vector = null))

      const { steps } = await trace(wire)

      expect(steps[2]!.blochVector).toBeNull()
      expect(steps[1]!.blochVector).not.toBeNull()
    })
  })

  describe('malformed vectors are rejected, never rendered', () => {
    it.each([
      ['a missing coordinate', (w: any) => delete w.steps[1].bloch_vector.z],
      ['a non-numeric coordinate', (w: any) => (w.steps[1].bloch_vector.x = 'one')],
      ['a null coordinate', (w: any) => (w.steps[1].bloch_vector.y = null)],
      ['a missing method', (w: any) => delete w.steps[1].bloch_vector.method],
      ['a missing derived_from', (w: any) => delete w.steps[1].bloch_vector.derived_from],
      ['a derived_from with a missing field', (w: any) => delete w.steps[1].bloch_vector.derived_from.execution_id],
      ['a coordinate array instead of an object', (w: any) => (w.steps[1].bloch_vector = [1, 0, 0])],
    ])('%s', async (_label, change) => {
      await rejects(mutate(change))
    })
  })

  describe('a vector whose provenance does not name its own step is rejected', () => {
    it.each([
      ['step_index', (w: any) => (w.steps[2].bloch_vector.derived_from.step_index = 1)],
      ['result_id', (w: any) => (w.steps[2].bloch_vector.derived_from.result_id = 'res_a1')],
      ['result_id null', (w: any) => (w.steps[2].bloch_vector.derived_from.result_id = null)],
      ['execution_id', (w: any) => (w.steps[2].bloch_vector.derived_from.execution_id = 'aer-local-a1')],
      ['circuit_hash', (w: any) => (w.steps[2].bloch_vector.derived_from.circuit_hash = 'hash_prefix_a1')],
      ['backend', (w: any) => (w.steps[2].bloch_vector.derived_from.backend = 'cirq')],
      ['backend_version', (w: any) => (w.steps[2].bloch_vector.derived_from.backend_version = '0.0.1')],
    ])('mismatched %s', async (_label, change) => {
      const error = await rejects(mutate(change))
      expect(error.message).toContain('bloch_vector.derived_from does not match its own step')
    })
  })

  describe('existing behaviour is unchanged', () => {
    it('the request still sends only circuit and mode', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(hzhWire()))
      await new RealApiClient().traceCircuit(CIRCUIT)

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(Object.keys(body).sort()).toEqual(['circuit', 'mode'])
    })

    it('a trace with no bloch data at all still parses exactly as before', async () => {
      const { steps, finalResultId } = await trace(
        wireTrace({ numQubits: 1, ops: [H0], states: [[[1, 0], [0, 0]], [[0.7071067811865476, 0], [0.7071067811865476, 0]]] }),
      )
      expect(steps).toHaveLength(2)
      expect(finalResultId).toBe('res_a1')
    })
  })
})
