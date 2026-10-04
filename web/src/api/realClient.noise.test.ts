/**
 * The Noise Lab from the client's side: what goes out is the circuit and the learner's choices and nothing that could be a result; every number that
 * comes back is wrapped with the provenance of the run it was read from; and a refusal or an outage is an error, never a substituted result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { MockApiClient } from './mockClient'
import { BackendUnavailableError, EndpointNotImplementedError, NoiseRejectedError } from './client'
import { BELL_MEASURED, CATALOG_WIRE, IDEAL_ONLY_WIRE, NOISE_WIRE } from '@/test/noiseFixtures'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>
const lastBody = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('the request', () => {
  it('sends the circuit and the learner’s choices, and no field a result could ride on', async () => {
    fetchMock.mockResolvedValueOnce(json(NOISE_WIRE))
    await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', noiseStrength: 0.1, shots: 500, seed: 7 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toMatch(/\/api\/noise\/compare$/)
    expect(init.method).toBe('POST')
    expect(Object.keys(lastBody()).sort()).toEqual(['circuit', 'noise_model', 'noise_strength', 'seed', 'shots'])
    expect(lastBody()).toMatchObject({ noise_model: 'depolarizing', noise_strength: 0.1, shots: 500, seed: 7 })
  })

  it('leaves the strength and the seed out when the learner did not choose them (the server picks, and says what it picked)', async () => {
    fetchMock.mockResolvedValueOnce(json(NOISE_WIRE))
    await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'readout_error', shots: 100 })
    expect(Object.keys(lastBody()).sort()).toEqual(['circuit', 'noise_model', 'shots'])
    fetchMock.mockResolvedValueOnce(json(NOISE_WIRE))
    await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'readout_error', shots: 100, noiseStrength: null, seed: null })
    expect(Object.keys(lastBody()).sort()).toEqual(['circuit', 'noise_model', 'shots'])
  })

  it('cannot be made to carry counts, probabilities or a verdict, even by a caller that tries', async () => {
    fetchMock.mockResolvedValueOnce(json(NOISE_WIRE))
    const sneaky = { circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 10, counts: { '00': 10 }, probabilities: { '00': 1 }, total_variation_distance: 0 } as never
    await new RealApiClient().compareNoise(sneaky)
    const body = lastBody()
    for (const field of ['counts', 'probabilities', 'total_variation_distance', 'noisy_counts', 'result']) expect(body).not.toHaveProperty(field)
  })

  it('validates the circuit before sending it', async () => {
    await expect(new RealApiClient().compareNoise({ circuit: { ...BELL_MEASURED, num_qubits: 0 }, noiseModel: 'none', shots: 10 })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the response', () => {
  it('wraps each run’s numbers with that run’s own provenance, and the comparison’s numbers with the comparison’s', async () => {
    fetchMock.mockResolvedValueOnce(json(NOISE_WIRE))
    const r = await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 1000 })
    expect(r.ideal.counts['00']!.value).toBe(507)
    expect(r.ideal.counts['00']!.provenance).toMatchObject({ resultId: 'res_ideal_0001', executionMode: 'shots', provenanceClass: 'SIMULATION' })
    expect(r.noisy!.counts['01']!.value).toBe(70)
    expect(r.noisy!.counts['01']!.provenance).toMatchObject({ resultId: 'res_noisy_0002', executionMode: 'noisy_shots', provenanceClass: 'SIMULATION' })
    const row = r.comparison!.rows.find((x) => x.outcome === '01')!
    expect(row.idealCount.provenance.resultId).toBe('res_ideal_0001')
    expect(row.noisyCount.provenance.resultId).toBe('res_noisy_0002')
    expect(row.delta.provenance.resultId).toBe('res_cmp_0003')
    expect(r.comparison!.metrics.totalVariationDistance).toMatchObject({ value: 0.129, provenance: { resultId: 'res_cmp_0003', executionMode: 'noise_comparison' } })
  })

  it('passes every number through exactly as the server sent it', async () => {
    fetchMock.mockResolvedValueOnce(json(NOISE_WIRE))
    const r = await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 1000 })
    expect(Object.fromEntries(Object.entries(r.ideal.counts).map(([k, v]) => [k, v.value]))).toEqual(NOISE_WIRE.ideal.counts)
    expect(Object.fromEntries(Object.entries(r.noisy!.counts).map(([k, v]) => [k, v.value]))).toEqual(NOISE_WIRE.noisy.counts)
    expect(Object.fromEntries(Object.entries(r.noisy!.frequencies).map(([k, v]) => [k, v.value]))).toEqual(NOISE_WIRE.noisy.probabilities)
    expect(r.comparison!.rows.map((x) => [x.outcome, x.idealCount.value, x.noisyCount.value, x.delta.value])).toEqual(
      NOISE_WIRE.comparison.rows.map((x) => [x.outcome, x.ideal_count, x.noisy_count, x.delta]),
    )
  })

  it('carries the noise each run was made under, the shots and the seed', async () => {
    fetchMock.mockResolvedValueOnce(json(NOISE_WIRE))
    const r = await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 1000 })
    expect(r.noise).toMatchObject({ model: 'depolarizing', strength: 0.05, appliesTo: 'gates', simulationMethod: 'density_matrix', seed: 4242 })
    expect(r.noisy!.noise).toMatchObject({ model: 'depolarizing', strength: 0.05, seed: 4242 })
    expect(r.ideal.noise).toBeNull()
    expect([r.ideal.shots, r.noisy!.shots]).toEqual([1000, 1000])
  })

  it('keeps the server’s sentences as written', async () => {
    fetchMock.mockResolvedValueOnce(json(NOISE_WIRE))
    const r = await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 1000 })
    expect(r.comparison!.explanation.map((l) => l.text)).toEqual(NOISE_WIRE.comparison.explanation.map((l) => l.text))
  })

  it('an ideal-only answer has no noisy run and no comparison: nothing is filled in', async () => {
    fetchMock.mockResolvedValueOnce(json(IDEAL_ONLY_WIRE))
    const r = await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'none', shots: 1000 })
    expect(r.noisy).toBeNull()
    expect(r.comparison).toBeNull()
    expect(r.noise.model).toBe('none')
  })

  it('refuses an answer that names a comparison but no noisy run', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...NOISE_WIRE, noisy: null }))
    await expect(new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 1000 })).rejects.toThrow(/without a noisy run/)
  })

  it('refuses a malformed answer rather than guessing', async () => {
    for (const bad of [{ ...NOISE_WIRE, ideal: { ...NOISE_WIRE.ideal, counts: { '00': 'many' } } }, { ...NOISE_WIRE, ideal: undefined }, {}, { ...NOISE_WIRE, noise: { ...NOISE_WIRE.noise, model: 'laser' } }]) {
      fetchMock.mockResolvedValueOnce(json(bad))
      await expect(new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 1000 })).rejects.toThrow()
    }
  })

  it('refuses a hardware provenance class it was not sent by a real server (the enum is the backend’s)', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...NOISE_WIRE, ideal: { ...NOISE_WIRE.ideal, provenance: { ...NOISE_WIRE.ideal.provenance, provenance_class: 'MOCK' } } }))
    await expect(new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 1000 })).rejects.toThrow()
  })
})

describe('failures', () => {
  it('a structured refusal becomes a NoiseRejectedError with the server’s words and code', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: { code: 'NOISE_TOO_MANY_QUBITS', message: 'a noisy simulation is limited to 8 qubits', limit: 8, requested: 9 } }, 422))
    const err = await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 10 }).catch((e) => e)
    expect(err).toBeInstanceOf(NoiseRejectedError)
    expect(err).toMatchObject({ code: 'NOISE_TOO_MANY_QUBITS', status: 422, message: 'a noisy simulation is limited to 8 qubits' })
  })

  it('FastAPI’s list of validation problems reads as a sentence, not as JSON', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: [{ loc: ['body', 'shots'], msg: 'Input should be less than or equal to 20000', type: 'less_than_equal' }] }, 422))
    const err = await new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 10 }).catch((e) => e)
    expect(err).toBeInstanceOf(NoiseRejectedError)
    expect(err.message).toBe('shots: Input should be less than or equal to 20000')
    expect(err.code).toBeNull()
  })

  it('a simulator that is unavailable (503) and a failed run (400) are errors with the server’s message', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: { code: 'NOISE_BACKEND_UNAVAILABLE', message: 'Backend qiskit-aer is unavailable' } }, 503))
    await expect(new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 10 })).rejects.toMatchObject({ status: 503, code: 'NOISE_BACKEND_UNAVAILABLE' })
    fetchMock.mockResolvedValueOnce(json({ detail: 'plain text detail' }, 400))
    await expect(new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 10 })).rejects.toMatchObject({ status: 400, message: 'plain text detail' })
  })

  it('an unreachable server is a BackendUnavailableError, and no result exists', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(new RealApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 10 })).rejects.toBeInstanceOf(BackendUnavailableError)
  })
})

describe('the catalog', () => {
  it('maps the server’s models, ranges, notes and limits', async () => {
    fetchMock.mockResolvedValueOnce(json(CATALOG_WIRE))
    const catalog = await new RealApiClient().listNoiseModels()
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/noise\/models$/)
    expect(catalog.models.map((m) => m.name)).toEqual(['none', 'depolarizing', 'bit_flip', 'phase_flip', 'amplitude_damping', 'readout_error'])
    expect(catalog.models.find((m) => m.name === 'depolarizing')).toMatchObject({ minStrength: 0, maxStrength: 0.3, defaultStrength: 0.05, appliesTo: 'gates' })
    expect(catalog.models.find((m) => m.name === 'readout_error')!.appliesTo).toBe('measurement')
    expect(catalog.limits).toMatchObject({ maxQubits: 8, maxShots: 20000, defaultShots: 1024, simulationMethod: 'density_matrix' })
  })

  it('a failed catalog request is an error', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'down' }, 500))
    await expect(new RealApiClient().listNoiseModels()).rejects.toBeInstanceOf(NoiseRejectedError)
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(new RealApiClient().listNoiseModels()).rejects.toBeInstanceOf(BackendUnavailableError)
  })
})

describe('the FIXTURE mock adapter does not fake noise', () => {
  it('refuses both calls', async () => {
    await expect(new MockApiClient().compareNoise({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', shots: 10 })).rejects.toBeInstanceOf(EndpointNotImplementedError)
    await expect(new MockApiClient().listNoiseModels()).rejects.toBeInstanceOf(EndpointNotImplementedError)
  })
})
