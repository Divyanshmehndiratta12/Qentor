/**
 * The variational (VQE-style) demonstration from the client's side: angles and loop settings go out (the learner's own choices, never a
 * value); every number that comes back is wrapped with the provenance of the run it was read from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError } from './client'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const prov = (id: string, backend = 'qiskit-aer') => ({
  result_id: id,
  circuit_hash: 'h_' + id,
  backend,
  backend_version: '0.17.2',
  execution_mode: backend === 'variational-demo' ? 'variational' : 'statevector',
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
  created_at: '2026-01-01T00:00:00Z',
})

const point = (id: string, theta: number, z: number, bz: number) => ({
  theta,
  expectation_z: z,
  bloch: { x: 0, y: 0, z: bz },
  probabilities: { '0': (1 + z) / 2, '1': (1 - z) / 2 },
  result_id: id,
  execution_id: 'aer-local-' + id,
  circuit_hash: 'h_' + id,
  provenance: prov(id),
})

const COMMON = {
  method: 'qentor.variational/1',
  expectation_method: 'pauli-z-expectation-from-statevector/1',
  ansatz: 'RY(theta) on one qubit, started in |0>',
  observable: 'Pauli Z on q[0]',
  label: 'Educational one-parameter demonstration: not a chemistry calculation, not a scalable VQE, and it uses no quantum hardware.',
  backend: 'qiskit-aer',
  backend_version: '0.17.2',
  provenance: prov('res_demo', 'variational-demo'),
}

const SWEEP = {
  ...COMMON,
  points: [point('res_p0', 0, 1, 1), point('res_p1', 1.5, 0.07, 0.07), point('res_p2', 3, -0.99, -0.99)],
  minimum_index: 2,
  maximum_index: 0,
}

const OPTIMIZE = {
  ...COMMON,
  steps: [
    { step: 0, point: point('res_a0', 0.8, 0.69, 0.69), gradient: -0.72, plus: point('res_a1', 2.37, -0.72, -0.72), minus: point('res_a2', -0.77, 0.72, 0.72) },
    { step: 1, point: point('res_b0', 1.2, 0.36, 0.36), gradient: -0.93, plus: point('res_b1', 2.77, -0.93, -0.93), minus: point('res_b2', -0.37, 0.93, 0.93) },
  ],
  lowest_index: 1,
  converged: false,
  learning_rate: 0.6,
  shift: 1.5707963267948966,
  notes: [],
}

describe('RealApiClient — variational demonstration', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const body = (call = 0) => JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string)
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(json(SWEEP))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  describe('what goes out', () => {
    it('a sweep sends an angle range and a point count only', async () => {
      await new RealApiClient().variationalSweep({ thetaMin: 0, thetaMax: 6.28, points: 25, backend: 'cirq' })
      expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/variational\/sweep$/)
      expect(body()).toEqual({ theta_min: 0, theta_max: 6.28, points: 25, backend: 'cirq' })
    })

    it('a sweep with nothing chosen sends an empty body: the defaults are the server’s', async () => {
      await new RealApiClient().variationalSweep({})
      expect(body()).toEqual({})
    })

    it('an optimisation sends the start angle and the loop settings', async () => {
      fetchMock.mockResolvedValueOnce(json(OPTIMIZE))
      await new RealApiClient().variationalOptimize({ thetaStart: 0.8, steps: 15, learningRate: 0.6 })
      expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/variational\/optimize$/)
      expect(body()).toEqual({ theta_start: 0.8, steps: 15, learning_rate: 0.6 })
    })

    it('no field of either request could carry a cost, a gradient or a curve', async () => {
      await new RealApiClient().variationalSweep({ thetaMin: 0, thetaMax: 1, points: 5 })
      fetchMock.mockResolvedValueOnce(json(OPTIMIZE))
      await new RealApiClient().variationalOptimize({ thetaStart: 1 })
      for (const call of [0, 1]) for (const key of Object.keys(body(call))) expect(key).not.toMatch(/expect|cost|gradient|curve|result|value|probab/)
    })
  })

  describe('what comes back', () => {
    it('wraps every sweep number with the provenance of ITS run, not the demonstration’s', async () => {
      const r = await new RealApiClient().variationalSweep({})
      expect(r.points).toHaveLength(3)
      const p = r.points[2]!
      expect(p.expectationZ.value).toBe(-0.99)
      expect(p.theta.value).toBe(3)
      expect(p.probabilityOne.value).toBeCloseTo(0.995)
      for (const q of [p.theta, p.expectationZ, p.bloch, p.probabilityZero, p.probabilityOne]) {
        expect(q.provenance).toMatchObject({ resultId: 'res_p2', backend: 'qiskit-aer', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED', executionMode: 'statevector' })
      }
      expect(p.bloch.value).toEqual({ x: 0, y: 0, z: -0.99 })
      expect(p).toMatchObject({ resultId: 'res_p2', executionId: 'aer-local-res_p2', circuitHash: 'h_res_p2' })
      expect(r.points[0]!.expectationZ.provenance.resultId).toBe('res_p0')
    })

    it('keeps the server’s own pick of the lowest and highest point, and its label', async () => {
      const r = await new RealApiClient().variationalSweep({})
      expect([r.minimumIndex, r.maximumIndex]).toEqual([2, 0])
      expect(r.label).toMatch(/not a chemistry calculation.*not a scalable VQE.*no quantum hardware/)
      expect(r.provenance).toMatchObject({ resultId: 'res_demo', backend: 'variational-demo', executionMode: 'variational' })
      expect(r).toMatchObject({ observable: 'Pauli Z on q[0]', expectationMethod: 'pauli-z-expectation-from-statevector/1' })
    })

    it('an optimisation keeps each step’s three runs, wraps the slope with its step’s provenance and keeps the server’s verdicts', async () => {
      fetchMock.mockResolvedValueOnce(json(OPTIMIZE))
      const r = await new RealApiClient().variationalOptimize({ thetaStart: 0.8 })
      expect(r.steps).toHaveLength(2)
      const s = r.steps[0]!
      expect(s.gradient.value).toBe(-0.72)
      expect(s.gradient.provenance.resultId).toBe('res_a0')
      expect([s.plus.resultId, s.minus.resultId]).toEqual(['res_a1', 'res_a2'])
      expect(s.plus.theta.value).toBeCloseTo(2.37)
      expect(r).toMatchObject({ lowestIndex: 1, converged: false, learningRate: 0.6, notes: [] })
      expect(r.shift).toBeCloseTo(Math.PI / 2)
    })

    it('notes from the server (a flat start) are kept as they are', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...OPTIMIZE, converged: true, notes: ['the starting angle has a gradient of zero, so the loop cannot tell which way is downhill and does not move'] }))
      const r = await new RealApiClient().variationalOptimize({ thetaStart: 0 })
      expect(r.notes).toEqual(['the starting angle has a gradient of zero, so the loop cannot tell which way is downhill and does not move'])
      expect(r.converged).toBe(true)
    })
  })

  describe('refusals and failures', () => {
    it('a refused request keeps the server’s message and status', async () => {
      fetchMock.mockResolvedValueOnce(json({ detail: { code: 'VARIATIONAL_STEPS_INVALID', message: 'the loop takes 1 to 25 steps' } }, 422))
      await expect(new RealApiClient().variationalOptimize({ thetaStart: 1, steps: 99 })).rejects.toMatchObject({ status: 422, message: 'the loop takes 1 to 25 steps' })
    })

    it('a response with no points is refused, not shown as an empty curve', async () => {
      fetchMock.mockResolvedValueOnce(json({ ...SWEEP, points: [] }))
      await expect(new RealApiClient().variationalSweep({})).rejects.toThrow()
    })

    it('a response with a number missing is refused', async () => {
      const broken = { ...SWEEP, points: [{ ...SWEEP.points[0], expectation_z: undefined }] }
      fetchMock.mockResolvedValueOnce(json(broken))
      await expect(new RealApiClient().variationalSweep({})).rejects.toThrow()
    })

    it('an unreachable server is "unavailable", never substitute data', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('offline'))
      await expect(new RealApiClient().variationalSweep({})).rejects.toBeInstanceOf(BackendUnavailableError)
    })
  })
})
