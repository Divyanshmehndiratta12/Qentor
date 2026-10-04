/**
 * TRUST: the browser cannot manufacture noisy output, and the server's response is the only source of every number the Noise Lab shows.
 *
 * Qentor's rule is that the simulator is the quantum computer; the browser draws what it is sent. For the Noise Lab that means three
 * things, each pinned here from a different side:
 *
 *  1. SOURCE: nothing in the noise feature (or the mapper that wraps a response) can randomise, perturb or do arithmetic on a count. A scan
 *     of the source forbids random numbers, rounding/transcendental maths and any arithmetic on a quantum value's `.value`.
 *  2. FLOW: the result on screen is a pure function of the response. Different responses give different tables, an identical ideal and noisy
 *     response gives identical columns (no noise is added by the UI), and when the server sends no noisy run no noisy number appears.
 *  3. STATE: changing a control never produces a result; only a response from the client can.
 *
 * A mutation that makes any of these false (a UI that copies ideal counts into the noisy column, jitters them, fills in a missing noisy run, or
 * recomputes a distance) fails a test here; the matching mutants are in `backend/scripts/mutation_check.py`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const client = vi.hoisted(() => ({ listNoiseModels: vi.fn(), compareNoise: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import { useBuildStore } from '@/features/build/store'
import { BELL_MEASURED, IDEAL_ONLY_WIRE, NOISE_WIRE, parseCatalog, parseNoiseResult } from '@/test/noiseFixtures'
import { NoiseLabScreen } from './NoiseLabScreen'
import { useNoiseStore } from './store'

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_NOISE = useNoiseStore.getState()

beforeEach(() => {
  client.listNoiseModels.mockReset().mockResolvedValue(parseCatalog())
  client.compareNoise.mockReset().mockResolvedValue(parseNoiseResult())
  useBuildStore.setState(INITIAL_BUILD, true)
  useNoiseStore.setState(INITIAL_NOISE, true)
  useBuildStore.getState().loadCircuit(BELL_MEASURED)
})
afterEach(cleanup)

// ------------------------------------------------------------------------------------------------ 1. source

const SOURCES = {
  ...import.meta.glob('./*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('../../api/noiseMap.ts', { query: '?raw', import: 'default', eager: true }),
} as Record<string, string>
const PRODUCTION = Object.entries(SOURCES).filter(([path]) => !/\.test\.|examples\.ts$/.test(path))
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('the source cannot randomise, perturb or compute a quantum number', () => {
  it('reads the noise feature and its mapper', () => {
    const files = PRODUCTION.map(([p]) => p.split('/').pop())
    expect(files).toEqual(expect.arrayContaining(['NoiseControls.tsx', 'NoiseResults.tsx', 'NoiseLabScreen.tsx', 'store.ts', 'NoiseComparisonChart.tsx', 'noiseMap.ts']))
  })

  it('has no random numbers anywhere', () => {
    for (const [path, code] of PRODUCTION) {
      expect(strip(code), path).not.toMatch(/Math\.random|getRandomValues|crypto\.randomUUID|\brandom\s*\(/)
    }
  })

  it('does no rounding, root, power or logarithm on anything (only min/max to clamp a control)', () => {
    for (const [path, code] of PRODUCTION) {
      const maths = [...strip(code).matchAll(/Math\.(\w+)/g)].map((m) => m[1])
      for (const fn of maths) expect(['min', 'max'], `${path}: Math.${fn}`).toContain(fn)
      expect(strip(code), path).not.toMatch(/\*\*/)
    }
  })

  it('does no arithmetic on a quantum value: `.value` is only read, never added, scaled or compared in a sum', () => {
    for (const [path, code] of PRODUCTION) {
      const lines = strip(code).split('\n')
      lines.forEach((line, i) => {
        expect(line, `${path}:${i + 1}`).not.toMatch(/\.value\s*[-+*/%]\s*[\w(.]/)
        expect(line, `${path}:${i + 1}`).not.toMatch(/[\w)\]]\s*[-+*/%]\s*[\w.]*\.value\b/)
      })
    }
  })

  it('never builds the noisy table from the ideal one (no function takes ideal numbers and returns noisy ones)', () => {
    for (const [path, code] of PRODUCTION) {
      const c = strip(code)
      expect(c, path).not.toMatch(/noisy\w*\s*[:=]\s*[^\n]*\bideal\w*\s*[[.]/i) // noisy = ... ideal.x
      expect(c, path).not.toMatch(/ideal\.counts\s*\)\s*\.map\([^)]*noisy/i)
    }
  })

  it('the store has no way to set a result except from a client response', () => {
    const store = strip(PRODUCTION.find(([p]) => p.endsWith('store.ts'))![1])
    const assigned = [...store.matchAll(/set\(\{[^}]*\bresult:\s*([^,}\s]+)/g)].map((m) => m[1])
    expect(assigned.length).toBeGreaterThan(0) // the clears exist, so this scan is looking at something
    expect(assigned.every((v) => v === 'null')).toBe(true) // anything written as `set({ result: x })` is a clear
    expect(store.match(/set\(\{ result, resultCircuitKey/g)).toHaveLength(1) // the one place a result is stored: the shorthand of the response below
    expect(store).toMatch(/const result = await getApiClient\(\)\.compareNoise\(/)
  })
})

// ------------------------------------------------------------------------------------------------ 2. flow

async function renderRan(wire: unknown, settings: { model?: string } = {}) {
  client.compareNoise.mockResolvedValue(parseNoiseResult(wire))
  render(<NoiseLabScreen />)
  await screen.findByLabelText('Noise model')
  if (settings.model) fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: settings.model } })
  act(() => useNoiseStore.getState().setShots(1000))
  fireEvent.click(screen.getByRole('button', { name: /^Run ideal/ }))
  await screen.findByTestId('noise-result')
}

const tableCells = () =>
  within(screen.getByTestId('noise-table'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell', { hidden: true }).map((c) => c.textContent))

describe('the result is a pure function of the response', () => {
  it('a different noisy response gives a different noisy column, and the ideal column does not move', async () => {
    await renderRan(NOISE_WIRE)
    const first = tableCells()
    cleanup()
    const other = structuredClone(NOISE_WIRE)
    other.noisy.counts = { '00': 250, '11': 240, '01': 260, '10': 250 }
    other.noisy.probabilities = { '00': 0.25, '11': 0.24, '01': 0.26, '10': 0.25 }
    other.comparison.rows = other.comparison.rows.map((r) => ({ ...r, noisy_count: other.noisy.counts[r.outcome as '00'], noisy_probability: other.noisy.probabilities[r.outcome as '00'], delta: other.noisy.probabilities[r.outcome as '00'] - r.ideal_probability }))
    useNoiseStore.setState(INITIAL_NOISE, true)
    await renderRan(other)
    const second = tableCells()
    expect(second.map((r) => [r[0], r[1]])).toEqual(first.map((r) => [r[0], r[1]])) // ideal count and frequency: untouched
    expect(second.map((r) => r[2])).toEqual(['250', '260', '250', '240']) // the noisy counts are the new server's, outcome by outcome
    expect(second.map((r) => r[2])).not.toEqual(first.map((r) => r[2]))
  })

  it('when the server says the noisy run is the same as the ideal run, the screen shows the same: it adds no noise of its own', async () => {
    const same = structuredClone(NOISE_WIRE)
    same.noisy.counts = { ...same.ideal.counts } as typeof same.noisy.counts
    same.noisy.probabilities = { ...same.ideal.probabilities } as typeof same.noisy.probabilities
    same.comparison.rows = [
      { outcome: '00', ideal_count: 507, noisy_count: 507, ideal_probability: 0.507, noisy_probability: 0.507, delta: 0 },
      { outcome: '11', ideal_count: 493, noisy_count: 493, ideal_probability: 0.493, noisy_probability: 0.493, delta: 0 },
    ]
    await renderRan(same)
    expect(tableCells().map((r) => [r[0], r[1], r[2], r[3]])).toEqual([
      ['507', '0.5070', '507', '0.5070'],
      ['493', '0.4930', '493', '0.4930'],
    ])
  })

  it('every number in the table is one of the numbers in the response, in the same cell, formatted and nothing else', async () => {
    await renderRan(NOISE_WIRE)
    const expected = NOISE_WIRE.comparison.rows.map((r) => [
      String(r.ideal_count),
      r.ideal_probability.toFixed(4),
      String(r.noisy_count),
      r.noisy_probability.toFixed(4),
      `${r.delta >= 0 ? '+' : '−'}${Math.abs(r.delta).toFixed(4)}`,
    ])
    expect(tableCells()).toEqual(expected)
  })

  it('the metrics are the server’s metrics, not recomputed from the table', async () => {
    const lying = structuredClone(NOISE_WIRE)
    lying.comparison.metrics.total_variation_distance = 0.5 // does not follow from the rows on purpose
    lying.comparison.metrics.noisy_share_on_ideal_outcomes = 0.25
    await renderRan(lying)
    expect(screen.getByTestId('metric-tvd')).toHaveTextContent('0.5000')
    expect(screen.getByTestId('metric-share')).toHaveTextContent('0.2500')
  })

  it('if the server returns no noisy run, no noisy number and no noisy card appears (nothing is filled in)', async () => {
    await renderRan(IDEAL_ONLY_WIRE) // depolarizing is chosen, but the server sent the ideal run only
    expect(screen.queryByTestId('run-noisy')).not.toBeInTheDocument()
    expect(screen.queryByTestId('noise-metrics')).not.toBeInTheDocument()
    expect(screen.queryByTestId('noise-explanation')).not.toBeInTheDocument()
    const cells = tableCells()
    expect(cells.every((r) => r.length === 2)).toBe(true) // outcome rows carry the ideal count and frequency only
    expect(screen.getByTestId('noise-result').textContent).not.toMatch(/Simulated noise\s*·/) // no noisy badge
    expect(screen.getByTestId('ideal-only-note')).toBeInTheDocument()
  })

  it('the explanation sentences are exactly the server’s: the browser neither edits nor adds a number to them', async () => {
    const edited = structuredClone(NOISE_WIRE)
    edited.comparison.explanation = [{ id: 'N1', text: 'The server wrote only this sentence.' }]
    await renderRan(edited)
    const lines = within(screen.getByTestId('noise-explanation')).getAllByRole('listitem').map((l) => l.textContent)
    expect(lines).toEqual(['The server wrote only this sentence.'])
  })
})

// ------------------------------------------------------------------------------------------------ 3. state

describe('only a response can put a result on screen', () => {
  it('moving every control, loading an example and editing the circuit never makes a result or calls the server', async () => {
    render(<NoiseLabScreen />)
    await screen.findByLabelText('Noise model')
    for (const model of ['none', 'bit_flip', 'phase_flip', 'amplitude_damping', 'readout_error', 'depolarizing']) {
      fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: model } })
    }
    fireEvent.change(screen.getByLabelText('Shots'), { target: { value: '300' } })
    fireEvent.change(screen.getByLabelText('Seed (optional)'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Bell pair' }))
    expect(client.compareNoise).not.toHaveBeenCalled()
    expect(useNoiseStore.getState().result).toBeNull()
    expect(screen.queryByTestId('noise-result')).not.toBeInTheDocument()
  })

  it('a rejected run leaves no result behind, whatever was shown before', async () => {
    await renderRan(NOISE_WIRE)
    client.compareNoise.mockRejectedValueOnce(new Error('boom'))
    fireEvent.click(screen.getByRole('button', { name: /^Run ideal/ }))
    await screen.findByText('The noise run did not complete')
    expect(useNoiseStore.getState().result).toBeNull()
  })

  it('what the store holds after a run is exactly what the client returned (same object)', async () => {
    const returned = parseNoiseResult(NOISE_WIRE)
    client.compareNoise.mockResolvedValue(returned)
    render(<NoiseLabScreen />)
    await screen.findByLabelText('Noise model')
    fireEvent.click(screen.getByRole('button', { name: /^Run ideal/ }))
    await screen.findByTestId('noise-result')
    expect(useNoiseStore.getState().result).toBe(returned)
  })
})
