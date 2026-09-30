/**
 * The Lab asks for a new result whenever the question changes — not only when the circuit does. Backend, mode and (in shots
 * mode) the shot count each clear the result they invalidate, so leaving the panel empty until the learner presses Run would
 * show "nothing to run" on a circuit that has gates. Also: what the panel says when there is no result, and how an error
 * from the server is headlined.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { BackendUnavailableError } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'

const client = vi.hoisted(() => ({
  executeCircuit: vi.fn(),
  generateCode: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  listLessons: vi.fn(),
  traceCircuit: vi.fn(),
  checkEquivalence: vi.fn(),
  compareBackends: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import { BuildScreen } from './BuildScreen'
import { ResultsPanel } from './ResultsPanel'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const H: Circuit = { ...emptyCircuit(1, 1), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] }

const runs = () => client.executeCircuit.mock.calls.map(([, mode, shots, backend]) => ({ mode, shots, backend }))
const settle = () => act(() => vi.advanceTimersByTimeAsync(300))

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(client)) fn.mockReset()
  client.executeCircuit.mockReturnValue(new Promise(() => {}))
  client.generateCode.mockReturnValue(new Promise(() => {}))
  act(() => useBuildStore.setState({ ...INITIAL, circuit: H }, true))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  act(() => useBuildStore.setState(INITIAL, true))
})

describe('the Lab re-runs when the question changes', () => {
  it('runs once for the circuit on screen', async () => {
    render(<BuildScreen />)
    await settle()
    expect(runs()).toEqual([{ mode: 'statevector', shots: undefined, backend: 'qiskit-aer' }])
  })

  it('waits out the debounce before asking (250ms), not before', async () => {
    render(<BuildScreen />)
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(client.executeCircuit).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(client.executeCircuit).toHaveBeenCalledTimes(1)
  })

  it('choosing another backend runs the circuit there', async () => {
    render(<BuildScreen />)
    await settle()
    act(() => useBuildStore.getState().setBackend('cirq'))
    await settle()
    expect(runs().at(-1)).toEqual({ mode: 'statevector', shots: undefined, backend: 'cirq' })
    expect(runs()).toHaveLength(2)
  })

  it('switching to shots runs in shots mode with the shot count', async () => {
    render(<BuildScreen />)
    await settle()
    act(() => useBuildStore.getState().setMode('shots'))
    await settle()
    expect(runs().at(-1)).toEqual({ mode: 'shots', shots: 1024, backend: 'qiskit-aer' })
  })

  it('changing the shot count re-runs in shots mode', async () => {
    render(<BuildScreen />)
    act(() => useBuildStore.getState().setMode('shots'))
    await settle()
    const before = runs().length
    act(() => useBuildStore.getState().setShots(200))
    await settle()
    expect(runs()).toHaveLength(before + 1)
    expect(runs().at(-1)).toMatchObject({ mode: 'shots', shots: 200 })
  })

  it('changing the shot count in statevector mode runs nothing (it does not apply)', async () => {
    render(<BuildScreen />)
    await settle()
    const before = runs().length
    act(() => useBuildStore.getState().setShots(500))
    await settle()
    expect(runs()).toHaveLength(before)
  })

  it('a burst of changes is one run (still debounced)', async () => {
    render(<BuildScreen />)
    await settle()
    const before = runs().length
    act(() => {
      useBuildStore.getState().setBackend('cirq')
      useBuildStore.getState().setBackend('pennylane')
      useBuildStore.getState().setMode('shots')
    })
    await settle()
    expect(runs()).toHaveLength(before + 1)
    expect(runs().at(-1)).toEqual({ mode: 'shots', shots: 1024, backend: 'pennylane' })
  })

  it('an empty circuit still runs nothing', async () => {
    act(() => useBuildStore.setState({ circuit: emptyCircuit(1, 1) }))
    render(<BuildScreen />)
    act(() => useBuildStore.getState().setBackend('cirq'))
    await settle()
    expect(client.executeCircuit).not.toHaveBeenCalled()
  })
})

describe('what the results panel says when there is no result', () => {
  it('a circuit with no gates: add gates', () => {
    act(() => useBuildStore.setState({ circuit: emptyCircuit(1, 1) }))
    render(<ResultsPanel />)
    expect(screen.getByText('Add gates to the circuit to run it.')).toBeTruthy()
  })

  it('a circuit WITH gates but no result yet never claims there is nothing to run', () => {
    render(<ResultsPanel />)
    expect(screen.getByText('Run the circuit to see its result.')).toBeTruthy()
    expect(screen.queryByText('Add gates to the circuit to run it.')).toBeNull()
  })
})

describe('how a failed run is headlined', () => {
  async function failWith(error: Error) {
    client.executeCircuit.mockReset()
    client.executeCircuit.mockRejectedValue(error)
    render(<ResultsPanel />)
    vi.useRealTimers()
    await act(async () => {
      await useBuildStore.getState().runExecution()
    })
    return screen.getByRole('alert')
  }

  it('a 4xx is the server refusing this run, with its real reason', async () => {
    const alert = await failWith(new BackendUnavailableError('shots mode requires at least one measure operation', 400))
    expect(alert.textContent).toContain('The server refused this run')
    expect(alert.textContent).toContain('shots mode requires at least one measure operation')
    expect(alert.textContent).not.toContain('Backend unavailable')
  })

  it('every 4xx counts as a refusal, up to 499', async () => {
    for (const status of [400, 404, 422, 499]) {
      cleanup()
      const alert = await failWith(new BackendUnavailableError('refused', status))
      expect(alert.textContent, String(status)).toContain('The server refused this run')
    }
  })

  it('a 5xx is an unavailable backend', async () => {
    const alert = await failWith(new BackendUnavailableError('Backend qiskit-aer is unavailable', 503))
    expect(alert.textContent).toContain('Backend unavailable')
    expect(alert.textContent).not.toContain('refused')
  })

  it('no answer at all is an unavailable backend', async () => {
    const alert = await failWith(new BackendUnavailableError('could not reach the backend'))
    expect(alert.textContent).toContain('Backend unavailable')
  })

  it('an unexpected error is not blamed on the server refusing anything', async () => {
    const alert = await failWith(new Error('boom'))
    expect(alert.textContent).toContain('Backend unavailable')
    expect(alert.textContent).toContain('boom')
  })

  it('every failure still says no substitute result is shown', async () => {
    const alert = await failWith(new BackendUnavailableError('nope', 422))
    expect(alert.textContent).toContain('No substitute result is shown')
  })
})
