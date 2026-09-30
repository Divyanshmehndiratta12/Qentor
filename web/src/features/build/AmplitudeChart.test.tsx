/**
 * The amplitude/phase chart: bars and arrows are drawn from the magnitude and phase the BACKEND supplied. The browser sets
 * a CSS custom property to each supplied number and does no arithmetic on it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  BELL_AMPLITUDE_VIEWS,
  BELL_STATES,
  CX01,
  H0,
  bellWithQubitStates,
  traceResult,
  type WireAmplitudeEntry,
} from '@/test/traceFixtures'
import { TraceViewer } from './TraceViewer'

afterEach(() => cleanup())

const goTo = (step: number) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Step ${step + 1}:`) }))
const chart = () => within(screen.getByTestId('amplitude-chart'))
const cell = (id: string) => screen.getByTestId(id).textContent ?? ''
const cssVar = (testId: string, name: string) => (screen.getByTestId(testId) as unknown as HTMLElement).style.getPropertyValue(name)

function show(trace = bellWithQubitStates()) {
  return render(<TraceViewer trace={trace} isLoading={false} error={null} />)
}

describe('rows, bars and arrows come from the backend’s values', () => {
  it('has one row per basis state, labelled with the bitstring q[n-1]…q[0]', () => {
    show()
    const rows = screen.getAllByTestId(/^amplitude-row-\d+$/)
    expect(rows).toHaveLength(4)
    expect(within(rows[3]!).getByText('|11⟩')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('|01⟩')).toBeInTheDocument()
  })

  it('sets each bar’s size from the supplied amplitude, untouched', () => {
    show()
    goTo(1)
    expect(cssVar('amplitude-bar-0', '--amp')).toBe('0.7071067811865476')
    expect(cssVar('amplitude-bar-1', '--amp')).toBe('0.7071067811865476')
    expect(cssVar('amplitude-bar-2', '--amp')).toBe('0')
  })

  it('sets each arrow’s angle from the supplied phase, untouched, and draws none where the backend reports none', () => {
    show()
    goTo(2)
    expect(cssVar('phase-arrow-3', '--phase')).toBe('1.5707963267948966')
    expect(cssVar('phase-arrow-0', '--phase')).toBe('0')
    expect(screen.queryByTestId('phase-arrow-1')).toBeNull() // amplitude zero: the backend said phase is null
    expect(screen.getByTestId('amplitude-row-1').getAttribute('data-has-phase')).toBe('false')
    expect(within(screen.getByTestId('amplitude-row-1')).getByText('none')).toBeInTheDocument()
  })

  it('prints the numbers as the backend supplied them, three decimals', () => {
    show()
    goTo(2)
    expect(cell('amplitude-size-3')).toBe('0.707')
    expect(cell('amplitude-angle-3')).toBe('1.571 rad')
    expect(cell('amplitude-weight-3')).toBe('0.500')
    expect(cell('amplitude-angle-1')).toBe('no phase')
    expect(cell('amplitude-size-1')).toBe('0.000')
  })

  it('the phase of a Z-like gate shows up as a turned arrow while the outcome weights stay put', () => {
    const before: WireAmplitudeEntry[] = [
      { magnitude: 0.7071067811865476, probability: 0.5000000000000001, phase: 0 },
      { magnitude: 0.7071067811865476, probability: 0.5000000000000001, phase: 0 },
    ]
    const after: WireAmplitudeEntry[] = [
      { magnitude: 0.7071067811865476, probability: 0.5000000000000001, phase: 0 },
      { magnitude: 0.7071067811865476, probability: 0.5000000000000001, phase: 3.141592653589793 },
    ]
    show(traceResult({ numQubits: 1, ops: [H0], states: [[[1, 0], [0, 0]], [[0.7071067811865476, 0], [0.7071067811865476, 0]]], amplitudeViews: [before, after], tag: 'z' }))
    goTo(1)
    expect(cssVar('phase-arrow-1', '--phase')).toBe('3.141592653589793')
    expect(cell('amplitude-angle-1')).toBe('3.142 rad')
    expect(cell('amplitude-weight-0')).toBe(cell('amplitude-weight-1'))
  })

  it('a negative phase keeps its sign, as a typographic minus', () => {
    const view: WireAmplitudeEntry[] = [{ magnitude: 1, probability: 1, phase: -1.2 }, { magnitude: 0, probability: 0, phase: null }]
    show(traceResult({ numQubits: 1, ops: [], states: [[[1, 0], [0, 0]]], amplitudeViews: [view], tag: 'n' }))
    expect(cell('amplitude-angle-0')).toBe('−1.200 rad')
  })
})

describe('the chart follows the backend, not the statevector on screen', () => {
  it('a view that contradicts the statevector is shown as supplied', () => {
    // statevector |00> (amplitude 1 on |00>) but the "backend" view says the weight is on |11> with phase pi/2
    const view: WireAmplitudeEntry[] = [
      { magnitude: 0, probability: 0, phase: null },
      { magnitude: 0, probability: 0, phase: null },
      { magnitude: 0, probability: 0, phase: null },
      { magnitude: 1, probability: 1, phase: 1.5707963267948966 },
    ]
    show(traceResult({ numQubits: 2, ops: [], states: [BELL_STATES[0]!], amplitudeViews: [view], tag: 'c' }))
    expect(cell('amplitude-size-3')).toBe('1.000')
    expect(cell('amplitude-angle-3')).toBe('1.571 rad')
    expect(cell('amplitude-size-0')).toBe('0.000')
    expect(cssVar('amplitude-bar-3', '--amp')).toBe('1')
  })

  it('an outcome weight that is not the square of the size is shown as supplied (nothing is derived)', () => {
    const view: WireAmplitudeEntry[] = [{ magnitude: 0.5, probability: 0.9, phase: 0.1 }, { magnitude: 0, probability: 0, phase: null }]
    show(traceResult({ numQubits: 1, ops: [], states: [[[1, 0], [0, 0]]], amplitudeViews: [view], tag: 'q' }))
    expect(cell('amplitude-size-0')).toBe('0.500')
    expect(cell('amplitude-weight-0')).toBe('0.900')
  })
})

describe('provenance and explanation', () => {
  it('every number sits in a wrapper naming the simulation and the step’s own result', () => {
    show(bellWithQubitStates('v'))
    goTo(1)
    const wrapped = chart().getAllByTitle(/SIMULATION · qiskit-aer · res_v1/)
    expect(wrapped.length).toBe(4 * 3) // size, angle and weight for each of the four rows
  })

  it('says only differences between phases are physical, and that the values are backend-derived', () => {
    show()
    expect(chart().getByText(/Only differences between phases are physical/)).toBeInTheDocument()
    expect(chart().getByText(/Backend-derived state data/)).toBeInTheDocument()
  })

  it('a backend that sent no amplitude view gets an explanation, not a chart of zeros', () => {
    show(traceResult({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES }))
    expect(screen.getByTestId('amplitude-chart-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('amplitude-row-0')).toBeNull()
  })

  it('unlabelled basis ordering falls back to raw indices', () => {
    show(traceResult({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES, amplitudeViews: BELL_AMPLITUDE_VIEWS, basisOrdering: 'unknown ordering', tag: 'u' }))
    expect(within(screen.getByTestId('amplitude-row-3')).getByText('3')).toBeInTheDocument()
    expect(chart().getByText('index')).toBeInTheDocument()
  })

  it('updates with the selected step', () => {
    show()
    expect(cell('amplitude-size-1')).toBe('0.000') // |00> only
    goTo(1)
    expect(cell('amplitude-size-1')).toBe('0.707')
    goTo(2)
    expect(cell('amplitude-size-1')).toBe('0.000')
    expect(cell('amplitude-size-3')).toBe('0.707')
  })
})

describe('no quantum calculation happens while rendering the chart', () => {
  it('never calls a math primitive', () => {
    const spies = (['sqrt', 'hypot', 'pow', 'random', 'atan2', 'atan', 'cos', 'sin', 'acos', 'asin', 'exp', 'log'] as const).map((fn) => vi.spyOn(Math, fn))
    show()
    goTo(1)
    goTo(2)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    spies.forEach((spy) => spy.mockRestore())
  })
})
