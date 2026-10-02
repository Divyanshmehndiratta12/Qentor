/**
 * The Lab flow strip (Circuit → Result → Trace → Analysis). It only reads the Lab's own state and moves the learner: Result and
 * Analysis jump inside the Results column, Trace runs the trace when there is none and jumps to it when there is. A trace that arrives
 * is brought into view; the page itself never scrolls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ExecutePayload } from '@/api'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { CX01, H0, traceResult, type Amplitude } from '@/test/traceFixtures'

const client = vi.hoisted(() => ({ traceCircuit: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { useBuildStore } from './store'
import { ResultsPanel } from './ResultsPanel'

vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

const INITIAL = useBuildStore.getState()
const build = () => useBuildStore.getState()
const gate = (g: GateOp['gate'], targets: number[], controls: number[] = []): GateOp => ({ gate: g, targets, controls, params: [], clbits: [] })
const BELL: Circuit = { ...emptyCircuit(2, 0), ops: [gate('h', [0]), gate('cx', [1], [0])] }
const R = 0.7071067811865476
const STATES: Amplitude[][] = [
  [[1, 0], [0, 0], [0, 0], [0, 0]],
  [[R, 0], [R, 0], [0, 0], [0, 0]],
  [[R, 0], [0, 0], [0, 0], [R, 0]],
]
const TRACE = () => traceResult({ numQubits: 2, ops: [H0, CX01], states: STATES, tag: 'f' })
const PROVENANCE: Provenance = {
  resultId: 'res_flow_1',
  circuitHash: 'hash_flow_1',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-10-01T00:00:00Z',
}
const trace = () => screen.getByTestId('flow-trace') as HTMLButtonElement

beforeEach(() => {
  client.traceCircuit.mockReset()
  useBuildStore.setState(INITIAL, true)
})
afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL, true)
})

describe('what each stage says', () => {
  it('an empty circuit: no ops, nothing run, and no trace to ask for', () => {
    render(<ResultsPanel />)
    expect(screen.getByTestId('flow-result').getAttribute('data-state')).toBe('not run')
    expect(trace().disabled).toBe(true)
  })

  it('a circuit with a result: the mode is named and the trace can be run', () => {
    useBuildStore.setState({ circuit: BELL, result: toQuantumValue<ExecutePayload>({ executionId: 'aer-1', statevector: [[1, 0], [0, 0], [0, 0], [0, 0]] }, PROVENANCE) })
    render(<ResultsPanel />)
    expect(screen.getByTestId('flow-result').getAttribute('data-state')).toBe('statevector')
    expect(trace().disabled).toBe(false)
    expect(trace().getAttribute('aria-label')).toMatch(/Run the trace/)
  })

  it('a failed run says failed', () => {
    useBuildStore.setState({ circuit: BELL, executionError: 'nope' })
    render(<ResultsPanel />)
    expect(screen.getByTestId('flow-result').getAttribute('data-state')).toBe('failed')
  })

  it('a loaded trace reads its step, and follows the selected step', () => {
    useBuildStore.setState({ circuit: BELL, trace: TRACE(), selectedTraceStep: 0 })
    render(<ResultsPanel />)
    expect(trace().textContent).toContain('step 1 of 3')
    act(() => build().selectTraceStep(2))
    expect(trace().textContent).toContain('step 3 of 3')
  })

  it('a trace failure says failed, a running trace says running', () => {
    useBuildStore.setState({ circuit: BELL, traceError: { kind: 'unexpected', message: 'x' } })
    const { rerender } = render(<ResultsPanel />)
    expect(trace().textContent).toContain('failed')
    act(() => useBuildStore.setState({ traceError: null, isTracing: true }))
    rerender(<ResultsPanel />)
    expect(trace().textContent).toContain('running')
    expect(trace().disabled).toBe(true)
  })
})

describe('what each stage does', () => {
  it('Trace with no trace asks the server for one (the circuit only), and that trace is then shown', async () => {
    useBuildStore.setState({ circuit: BELL })
    client.traceCircuit.mockResolvedValue(TRACE())
    render(<ResultsPanel />)
    await act(async () => {
      fireEvent.click(trace())
    })
    expect(client.traceCircuit).toHaveBeenCalledTimes(1)
    expect(client.traceCircuit.mock.calls[0]![0]).toBe(BELL)
    expect(trace().textContent).toContain('step 1 of 3')
  })

  it('Trace with a trace runs nothing: it only takes the learner to it, opening the group if it was folded', () => {
    useBuildStore.setState({ circuit: BELL, trace: TRACE() })
    render(<ResultsPanel />)
    const group = screen.getByTestId('results-group-trace') as HTMLDetailsElement
    group.open = false
    fireEvent.click(trace())
    expect(client.traceCircuit).not.toHaveBeenCalled()
    expect(group.open).toBe(true)
  })

  it('Analysis opens the verify and optimize group', () => {
    render(<ResultsPanel />)
    const group = screen.getByTestId('results-group-verify') as HTMLDetailsElement
    group.open = false
    fireEvent.click(screen.getByTestId('flow-analysis'))
    expect(group.open).toBe(true)
  })

  it('a trace that arrives is scrolled to inside the Results column, never the page', async () => {
    const scrollTo = vi.fn()
    const pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo
    useBuildStore.setState({ circuit: BELL })
    render(<ResultsPanel />)
    expect(scrollTo).not.toHaveBeenCalled()
    await act(async () => useBuildStore.setState({ trace: TRACE() }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(pageScroll).not.toHaveBeenCalled()
    // choosing another step is not a new trace: the column does not jump again
    await act(async () => build().selectTraceStep(2))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    pageScroll.mockRestore()
  })
})
