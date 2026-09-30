/**
 * Theoretical probability vs sampled frequency in the results panel. The chart and table values are what the server sent —
 * `theoreticalProbabilities` for a statevector run, `probabilities` (sampled frequencies) for a shots run — and the labels never
 * let one pass for the other. Plotly is replaced by a stub that records what it was asked to draw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ExecutePayload } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const plotted: Array<{ data: Array<{ x: string[]; y: number[] }>; layout: { yaxis: { title: { text: string } } } }> = []

vi.mock('react-plotly.js/factory', () => ({
  default: () =>
    function PlotStub(props: (typeof plotted)[number]) {
      plotted.push(props)
      return <div data-testid="plot" />
    },
}))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => ({}) }
})

import { useBuildStore } from './store'
import { ResultsPanel } from './ResultsPanel'

const INITIAL = useBuildStore.getState()

const PROVENANCE = (mode: string): Provenance => ({
  resultId: 'res_viz',
  circuitHash: 'hash',
  backend: 'qiskit-aer',
  backendVersion: '1.0',
  executionMode: mode,
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
})

const H: Circuit = { ...emptyCircuit(1, 1), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] }
const H_MEASURED: Circuit = {
  ...H,
  ops: [...H.ops, { gate: 'measure', targets: [0], controls: [], params: [], clbits: [0] }],
}

// Fixture values standing in for a server response. 0.123456 is not what H gives — deliberately: the panel must show what it was sent.
const STATEVECTOR: ExecutePayload = {
  executionId: 'e1',
  statevector: [[0.7, 0], [0.7, 0]],
  theoreticalProbabilities: { '0': 0.123456, '1': 0.876544 },
}
const SHOTS: ExecutePayload = {
  executionId: 'e2',
  counts: { '0': 5, '1': 3 },
  probabilities: { '0': 0.625, '1': 0.375 },
  shots: 8,
}

function show(circuit: Circuit, payload: ExecutePayload, mode: string) {
  act(() => {
    useBuildStore.setState({
      ...INITIAL,
      circuit,
      result: toQuantumValue(payload, PROVENANCE(mode)),
      isExecuting: false,
      executionError: null,
    })
  })
  return render(<ResultsPanel />)
}

beforeEach(() => {
  plotted.length = 0
})
afterEach(() => {
  cleanup()
  act(() => useBuildStore.setState(INITIAL, true))
})

describe('statevector run: theoretical probabilities', () => {
  it('plots and tabulates the server’s values, labelled theoretical, not sampled', () => {
    show(H, STATEVECTOR, 'statevector')
    const section = screen.getByTestId('theoretical-probabilities')
    expect(section.textContent).toContain('Theoretical probabilities')
    expect(section.textContent).toContain('not a sampled frequency')
    expect(plotted).toHaveLength(1)
    expect(plotted[0]!.data[0]!.x).toEqual(['0', '1'])
    expect(plotted[0]!.data[0]!.y).toEqual([0.123456, 0.876544])
    expect(plotted[0]!.layout.yaxis.title.text).toBe('theoretical probability')
    expect(screen.getByRole('columnheader', { name: 'theoretical probability' })).toBeTruthy()
    expect(screen.getByText('0.123456')).toBeTruthy()
    expect(screen.getByText('0.876544')).toBeTruthy()
    expect(screen.queryByText(/sampled/i, { selector: 'th' })).toBeNull()
    expect(screen.queryByTestId('sampled-note')).toBeNull()
  })

  it('states the bitstring order beside the chart', () => {
    show(H, STATEVECTOR, 'statevector')
    expect(screen.getByTestId('theoretical-probabilities').textContent).toContain('q[n-1] … q[0]')
  })

  it('an outcome the server omitted shows a dash, not a 0 the browser made up', () => {
    show(H, { ...STATEVECTOR, theoreticalProbabilities: { '1': 1 } }, 'statevector')
    const firstRow = document.querySelector('tbody tr')!
    expect(firstRow.querySelectorAll('td')[3]!.textContent).toBe('—')
    expect(plotted[0]!.data[0]!.x).toEqual(['1'])
  })

  it('a result with no theoretical probabilities (older record) shows amplitudes only: no chart, no column, no invented numbers', () => {
    show(H, { executionId: 'e', statevector: [[1, 0], [0, 0]] }, 'statevector')
    expect(screen.queryByTestId('theoretical-probabilities')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'theoretical probability' })).toBeNull()
    expect(plotted).toHaveLength(0)
    expect(screen.getByText('Statevector')).toBeTruthy()
  })

  it('warns when the circuit contains measurements: the state is one collapsed outcome, not the ideal distribution', () => {
    show(H_MEASURED, STATEVECTOR, 'statevector')
    expect(screen.getByTestId('collapsed-note').textContent).toContain('collapsed')
  })

  it('does not warn for a circuit without measurements', () => {
    show(H, STATEVECTOR, 'statevector')
    expect(screen.queryByTestId('collapsed-note')).toBeNull()
  })
})

describe('shots run: sampled frequencies', () => {
  it('plots the server’s frequencies, labelled sampled, with the shot count', () => {
    show(H_MEASURED, SHOTS, 'shots')
    expect(screen.getByTestId('sampled-note').textContent).toContain('Sampled from 8 shots')
    expect(screen.getByTestId('sampled-note').textContent).toContain('not')
    expect(screen.getByTestId('sampled-note').textContent).toContain('theoretical probabilities')
    expect(plotted).toHaveLength(1)
    expect(plotted[0]!.data[0]!.y).toEqual([0.625, 0.375])
    expect(plotted[0]!.layout.yaxis.title.text).toBe('sampled frequency')
    expect(screen.getByRole('columnheader', { name: 'sampled frequency' })).toBeTruthy()
    expect(screen.getByText('Sampled measurement outcomes')).toBeTruthy()
  })

  it('never calls a sampled number a probability', () => {
    show(H_MEASURED, SHOTS, 'shots')
    expect(screen.queryByRole('columnheader', { name: /^probability$/ })).toBeNull()
    expect(plotted[0]!.layout.yaxis.title.text).not.toMatch(/^probability$/)
    expect(screen.queryByTestId('theoretical-probabilities')).toBeNull()
  })

  it('omits the shot count when the server did not send one, rather than guessing it', () => {
    show(H_MEASURED, { ...SHOTS, shots: undefined }, 'shots')
    expect(screen.getByTestId('sampled-note').textContent).not.toMatch(/Sampled from/)
  })
})
