/**
 * The Results column as a short list of named sections, and the text alternatives for its charts. jsdom has no layout, so this pins the
 * structure (what is in which group, what is open, that nothing was dropped, how a chart is named for assistive technology); the real
 * Chrome run measures the height and the phone layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('react-plotly.js/factory', () => ({ default: () => () => <div data-testid="plot" /> }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => ({ listLessons: vi.fn().mockResolvedValue([]), listChallenges: vi.fn().mockResolvedValue([]) }) }
})

import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { ResultsPanel } from './ResultsPanel'
import { useBuildStore } from './store'

const PROV: Provenance = {
  resultId: 'res_1',
  circuitHash: 'h',
  backend: 'qiskit-aer',
  backendVersion: '1',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: 'c',
}
const BELL = { ...emptyCircuit(2, 0), ops: [{ gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] }] }

beforeEach(() => {
  cleanup()
  useBuildStore.getState().loadCircuit(BELL)
})
afterEach(cleanup)

const group = (id: string) => screen.getByTestId(`results-group-${id}`) as HTMLDetailsElement

describe('the Results column is grouped', () => {
  it('has five named sections, each a native disclosure, in a fixed order', () => {
    render(<ResultsPanel />)
    const groups = [...document.querySelectorAll('[data-testid^="results-group-"]')]
    expect(groups.map((g) => g.getAttribute('data-testid'))).toEqual(['results-group-trace', 'results-group-verify', 'results-group-compare', 'results-group-test', 'results-group-share'])
    for (const g of groups) {
      expect(g.tagName).toBe('DETAILS')
      expect(g.querySelector('summary')).not.toBeNull()
    }
    expect([...document.querySelectorAll('[data-testid^="results-group-"] > summary')].map((s) => s.firstElementChild?.firstChild?.textContent?.trim())).toEqual([
      'Step-by-step trace',
      'Verify and optimize',
      'Compare runs and backends',
      'Equivalence and multi-input tests',
      'Share and export',
    ])
  })

  it('opens the trace and the verification by default, and folds the rest away', () => {
    render(<ResultsPanel />)
    expect(group('trace').open).toBe(true)
    expect(group('verify').open).toBe(true)
    expect(group('compare').open).toBe(false)
    expect(group('test').open).toBe(false)
    expect(group('share').open).toBe(false)
  })

  it('keeps every tool in the page, in its group: nothing was dropped, only folded', () => {
    render(<ResultsPanel />)
    expect(group('trace').querySelector('[data-testid="export-panel"]')).toBeNull()
    expect(group('share').querySelector('[data-testid="export-panel"]')).not.toBeNull()
    expect(group('compare').textContent).toMatch(/Compare/i)
    expect(group('test').textContent).toMatch(/Equivalence/i)
    expect(group('verify').textContent).toMatch(/Verif/i)
  })

  it('the Lab’s Optimize can still be left out (challenges), and the group then holds only the verification', () => {
    const { container } = render(<ResultsPanel showOptimize={false} />)
    expect(container.querySelector('[data-testid="results-group-verify"]')).not.toBeNull()
    expect(group('verify').textContent).not.toMatch(/Optimi[sz]e this circuit/i)
  })

  it('a group is toggled by its summary, with the keyboard too (a native disclosure)', () => {
    render(<ResultsPanel />)
    const summary = group('share').querySelector('summary') as HTMLElement
    expect(summary.tabIndex).toBeGreaterThanOrEqual(0)
    fireEvent.click(summary)
    expect(group('share').open).toBe(true)
    fireEvent.click(summary)
    expect(group('share').open).toBe(false)
  })

  it('the result itself is not in a group: it is always visible', () => {
    useBuildStore.setState({ result: toQuantumValue({ executionId: 'e', statevector: [[1, 0], [0, 0], [0, 0], [0, 0]] as Array<[number, number]>, theoreticalProbabilities: { '00': 1 } }, PROV) })
    render(<ResultsPanel />)
    const theoretical = screen.getByTestId('theoretical-probabilities')
    expect(theoretical.closest('details')).toBeNull()
  })
})

describe('text alternatives for the charts', () => {
  it('a statevector chart is one named image that says what it shows and where the values are as text', () => {
    useBuildStore.setState({
      result: toQuantumValue({ executionId: 'e', statevector: [[0.7071, 0], [0, 0], [0, 0], [0.7071, 0]] as Array<[number, number]>, theoreticalProbabilities: { '00': 0.5, '11': 0.5 } }, PROV),
    })
    render(<ResultsPanel />)
    const chart = screen.getByTestId('outcome-chart')
    expect(chart).toHaveAttribute('role', 'img')
    const name = chart.getAttribute('aria-label')!
    expect(name).toContain('theoretical probability')
    expect(name).toContain('2 measurement outcomes')
    expect(name).toContain('q[n-1] … q[0]')
    expect(name).toContain('listed in the table that follows')
    expect(name).not.toMatch(/\d\.\d/) // no number of its own: the values are the table's, with their provenance
  })

  it('a shots chart is named as sampled', () => {
    useBuildStore.setState({
      mode: 'shots',
      result: toQuantumValue({ executionId: 'e', counts: { '00': 52, '11': 48 }, probabilities: { '00': 0.52, '11': 0.48 }, shots: 100 }, { ...PROV, executionMode: 'shots' }),
    })
    render(<ResultsPanel />)
    expect(screen.getByTestId('outcome-chart').getAttribute('aria-label')).toContain('sampled frequency')
  })

  it('the tables that carry the values have captions that say what they are', () => {
    useBuildStore.setState({ result: toQuantumValue({ executionId: 'e', statevector: [[1, 0], [0, 0], [0, 0], [0, 0]] as Array<[number, number]>, theoreticalProbabilities: { '00': 1 } }, PROV) })
    render(<ResultsPanel />)
    const captions = [...document.querySelectorAll('caption')].map((c) => c.textContent ?? '')
    expect(captions.some((c) => /statevector the backend returned/i.test(c) && /theoretical probability/.test(c))).toBe(true)
    for (const caption of document.querySelectorAll('caption')) expect(caption.className).toContain('sr-only')
  })
})
