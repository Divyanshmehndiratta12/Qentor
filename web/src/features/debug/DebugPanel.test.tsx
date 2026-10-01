/**
 * The debugger panel and where it sits: the Lab's Results panel and the challenge screen. `@/api` is mocked; the point is that the
 * panel sends identifiers and the learner's words, shows exactly what the server said (and whether AI wrote it), and never invents
 * an explanation when the server cannot give one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Challenge, ChallengeSubmission, DebugReport, ExecutePayload } from '@/api'
import { BackendUnavailableError } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const client = vi.hoisted(() => ({
  debugCircuit: vi.fn(),
  listChallenges: vi.fn(),
  submitChallenge: vi.fn(),
  listLessons: vi.fn(),
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  traceCircuit: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import App from '@/App'
import { useBuildStore } from '@/features/build/store'
import { useChallengeStore, setChallengeStore } from '@/features/challenges/store'
import { localStorageChallengeStore } from '@/features/challenges/challengeStorage'
import { useLearnStore } from '@/features/learn/store'
import { DebugPanel } from './DebugPanel'
import { useDebugStore } from './store'

const H: Circuit = { ...emptyCircuit(1, 0), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] }
const X: Circuit = { ...emptyCircuit(1, 0), ops: [{ gate: 'x', targets: [0], controls: [], params: [], clbits: [] }] }

const REPORT = (over: Partial<DebugReport> = {}): DebugReport => ({
  observed: { text: 'Your circuit applies: h(q0).', factIds: ['F1'] },
  evidence: [{ text: 'Outcome 0: theoretical probability 0.500000.', factIds: ['F3'] }],
  mismatch: { text: 'No challenge is attached.', factIds: [] },
  nextExperiment: { text: 'Step through the trace.', factIds: [] },
  hint: { text: 'Attach it to a challenge.', factIds: [] },
  facts: [
    { id: 'F1', kind: 'circuit_summary', description: '1-qubit circuit: h(q0)', resultId: 'res_lab_abcdefghij' },
    { id: 'F3', kind: 'probability', description: 'outcome 0: theoretical probability 0.500000', resultId: 'res_lab_abcdefghij' },
  ],
  usedFallbackTemplate: true,
  groundedIn: 'result',
  resultId: 'res_lab_abcdefghij',
  circuitHash: 'qc_1',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  attemptId: null,
  ...over,
})

const INITIAL_DEBUG = useDebugStore.getState()
const INITIAL_BUILD = useBuildStore.getState()

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(client)) fn.mockReset()
  client.debugCircuit.mockResolvedValue(REPORT())
  useDebugStore.setState(INITIAL_DEBUG, true)
})
afterEach(cleanup)

describe('DebugPanel on its own', () => {
  const panel = (input: Parameters<typeof DebugPanel>[0]['input'], extra: Partial<Parameters<typeof DebugPanel>[0]> = {}) =>
    render(<DebugPanel scope="lab" input={input} disabledReason="Run it first." {...extra} />)
  const run = () => fireEvent.click(screen.getByRole('button', { name: /Debug my circuit|Debug again/ }))

  it('with nothing to debug the button waits and says why', () => {
    panel(null)
    expect(screen.getByRole('button', { name: 'Debug my circuit' })).toBeDisabled()
    expect(screen.getByText('Run it first.')).toBeInTheDocument()
  })

  it('sends the input it was given plus the goal — and shows the server’s five parts', async () => {
    panel({ circuit: H, resultId: 'res_1', language: 'en' }, { askForGoal: true })
    fireEvent.change(screen.getByLabelText(/What were you trying to do/), { target: { value: '  a fair coin  ' } })
    run()
    await screen.findByTestId('debug-report')
    expect(client.debugCircuit).toHaveBeenCalledWith({ circuit: H, resultId: 'res_1', language: 'en', goal: 'a fair coin' })
    expect(within(screen.getByTestId('debug-observed')).getByText('Your circuit applies: h(q0).')).toBeInTheDocument()
    expect(within(screen.getByTestId('debug-evidence')).getByText(/theoretical probability 0.500000/)).toBeInTheDocument()
    expect(screen.getByTestId('debug-mismatch').textContent).toMatch(/No challenge is attached/)
    expect(screen.getByTestId('debug-experiment').textContent).toMatch(/Step through the trace/)
    expect(screen.getByTestId('debug-hint').textContent).toMatch(/Attach it to a challenge/)
  })

  it('shows which facts each part rests on, and lists the facts with their record ids', async () => {
    panel({ circuit: H, resultId: 'res_1' })
    run()
    await screen.findByTestId('debug-report')
    expect(within(screen.getByTestId('debug-observed')).getByText('F1')).toBeInTheDocument()
    const facts = screen.getByText(/Facts this rests on \(2\)/).closest('details')!
    expect(facts.textContent).toMatch(/1-qubit circuit: h\(q0\)/)
    expect(facts.textContent).toMatch(/res_lab_abcd/)
  })

  it('says plainly when no AI wrote it, and when AI did', async () => {
    panel({ circuit: H, resultId: 'res_1' })
    run()
    await screen.findByTestId('debug-report')
    expect(screen.getByTestId('debug-source').textContent).toMatch(/generated without AI/)
    client.debugCircuit.mockResolvedValueOnce(REPORT({ usedFallbackTemplate: false }))
    run()
    await waitFor(() => expect(screen.getByTestId('debug-source').textContent).toMatch(/Written by AI, then checked by the server/))
  })

  it('a report with no hint shows no hint section', async () => {
    client.debugCircuit.mockResolvedValueOnce(REPORT({ hint: null }))
    panel({ circuit: H, resultId: 'res_1' })
    run()
    await screen.findByTestId('debug-report')
    expect(screen.queryByTestId('debug-hint')).toBeNull()
  })

  it('offers the goal box only where asked, and caps it at 400 characters', () => {
    const { unmount } = panel({ circuit: H, resultId: 'res_1' })
    expect(screen.queryByLabelText(/What were you trying to do/)).toBeNull()
    unmount()
    panel({ circuit: H, resultId: 'res_1' }, { askForGoal: true })
    const box = screen.getByLabelText(/What were you trying to do/) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'x'.repeat(500) } })
    expect(box.value).toHaveLength(400)
  })

  it('a loading state is announced, and the button says so', async () => {
    client.debugCircuit.mockReturnValueOnce(new Promise(() => {}))
    panel({ circuit: H, resultId: 'res_1' })
    run()
    expect(await screen.findByText('The server is looking at your circuit…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Debugging…' })).toBeDisabled()
  })

  it('a refusal (4xx) is an alert saying the server could not debug it, with nothing invented, and retry works', async () => {
    client.debugCircuit.mockRejectedValueOnce(new BackendUnavailableError('submit again first', 422))
    panel({ circuit: H, resultId: 'res_1' })
    run()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/The server could not debug this circuit/)
    expect(alert.textContent).toMatch(/submit again first/)
    expect(alert.textContent).toMatch(/nothing was made up/)
    expect(screen.queryByTestId('debug-report')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('debug-report')
    expect(client.debugCircuit).toHaveBeenCalledTimes(2)
  })

  it('an outage is "Debugging is unavailable"', async () => {
    client.debugCircuit.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend'))
    panel({ circuit: H, resultId: 'res_1' })
    run()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Debugging is unavailable/)
  })

  it('marks a report stale once the circuit it was made for is no longer on screen', async () => {
    const view = panel({ circuit: H, resultId: 'res_1' })
    run()
    expect((await screen.findByTestId('debug-report')).getAttribute('data-stale')).toBe('false')
    view.rerender(<DebugPanel scope="lab" input={{ circuit: X, resultId: 'res_2' }} disabledReason="" />)
    expect(screen.getByTestId('debug-report').getAttribute('data-stale')).toBe('true')
    expect(screen.getByText(/You changed the circuit after this/)).toBeInTheDocument()
  })

  it('the newest request wins: a slow older answer never overwrites a newer one', async () => {
    let resolveOld!: (r: DebugReport) => void
    client.debugCircuit.mockReturnValueOnce(new Promise<DebugReport>((r) => (resolveOld = r)))
    panel({ circuit: H, resultId: 'res_1' })
    run()
    client.debugCircuit.mockResolvedValueOnce(REPORT({ observed: { text: 'NEWER answer', factIds: [] } }))
    act(() => void useDebugStore.getState().debug('lab', { circuit: H, resultId: 'res_1' }))
    await screen.findByText('NEWER answer')
    await act(async () => resolveOld(REPORT({ observed: { text: 'OLDER answer', factIds: [] } })))
    expect(screen.queryByText('OLDER answer')).toBeNull()
    expect(screen.getByText('NEWER answer')).toBeInTheDocument()
  })

  it('the two scopes never show each other’s report', async () => {
    render(
      <>
        <DebugPanel scope="lab" input={{ circuit: H, resultId: 'res_1' }} disabledReason="" />
        <DebugPanel scope="challenge" input={null} disabledReason="Submit first." />
      </>,
    )
    fireEvent.click(within(screen.getByTestId('debug-lab')).getByRole('button', { name: 'Debug my circuit' }))
    await within(screen.getByTestId('debug-lab')).findByTestId('debug-report')
    expect(within(screen.getByTestId('debug-challenge')).queryByTestId('debug-report')).toBeNull()
    expect(within(screen.getByTestId('debug-challenge')).getByText('Submit first.')).toBeInTheDocument()
  })
})

describe('in the Lab', () => {
  const PROV: Provenance = {
    resultId: 'res_lab_1',
    circuitHash: 'qc_lab',
    backend: 'qiskit-aer',
    backendVersion: '0.17.2',
    executionMode: 'statevector',
    provenanceClass: 'SIMULATION',
    verificationStatus: 'STATE_CHECKED',
    createdAt: '2026-01-01T00:00:00Z',
  }

  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    client.listLessons.mockResolvedValue([])
    client.executeCircuit.mockReturnValue(new Promise(() => {}))
    useBuildStore.setState(INITIAL_BUILD, true)
    useLearnStore.setState(useLearnStore.getState(), true)
  })

  const seed = () =>
    act(() => {
      useBuildStore.setState({
        circuit: H,
        result: toQuantumValue<ExecutePayload>({ executionId: 'e', probabilities: { '0': 0.5, '1': 0.5 } }, PROV),
        isExecuting: false,
        executionError: null,
      })
    })

  it('is in the Results panel and waits for a real result', () => {
    render(<App />)
    const region = screen.getByTestId('debug-lab')
    expect(within(region).getByRole('button', { name: 'Debug my circuit' })).toBeDisabled()
    expect(within(region).getByText(/Run the circuit first/)).toBeInTheDocument()
  })

  it('debugs the circuit on screen against the result the server issued for it', async () => {
    render(<App />)
    seed()
    const region = screen.getByTestId('debug-lab')
    fireEvent.change(within(region).getByLabelText(/What were you trying to do/), { target: { value: 'coin flip' } })
    fireEvent.click(within(region).getByRole('button', { name: 'Debug my circuit' }))
    await within(region).findByTestId('debug-report')
    expect(client.debugCircuit).toHaveBeenCalledTimes(1)
    const sent = client.debugCircuit.mock.calls[0]![0]
    expect(sent).toMatchObject({ circuit: H, resultId: 'res_lab_1', goal: 'coin flip', language: 'en', traceStep: null })
    expect(Object.keys(sent).sort()).toEqual(['circuit', 'goal', 'language', 'resultId', 'traceStep'])
  })

  it('sends the tutor language the learner chose', async () => {
    render(<App />)
    seed()
    act(() => useBuildStore.getState().setTutorLanguage('kn'))
    fireEvent.click(within(screen.getByTestId('debug-lab')).getByRole('button', { name: 'Debug my circuit' }))
    await screen.findByTestId('debug-report')
    expect(client.debugCircuit.mock.calls[0]![0].language).toBe('kn')
  })
})

describe('on the challenge screen', () => {
  const CHALLENGE: Challenge = {
    id: 'a',
    lessonId: 'superposition',
    title: 'Challenge a',
    goal: 'Goal of a.',
    difficulty: 'beginner',
    successCondition: 'Solved when a.',
    fixedOracle: false,
    constraints: { numQubits: 1, numClbits: 0, allowedGates: ['h', 'x'], maxOps: 6, minGateCounts: {}, anchor: [], anchorName: 'oracle', mustMeasure: [], gateQubits: {} },
    starterCircuit: emptyCircuit(1, 0),
    checks: [{ id: 'state.x', label: 'The state is right' }],
    hints: ['one', 'two'],
  }
  const PROV: Provenance = {
    resultId: 'res_final',
    circuitHash: 'qc_1',
    backend: 'qiskit-aer',
    backendVersion: '0.17.2',
    executionMode: 'statevector',
    provenanceClass: 'SIMULATION',
    verificationStatus: 'STATE_CHECKED',
    createdAt: '2026-01-01T00:00:00Z',
  }
  const FAILING = (id = 'att_1'): ChallengeSubmission => ({
    attemptId: id,
    challengeId: 'a',
    circuitHash: 'qc_1',
    passed: false,
    verifier: 'challenge/1',
    checks: [
      {
        id: 'state.x',
        label: 'The state is right',
        passed: false,
        evaluated: true,
        detail: 'not the required state',
        hintIndex: 1,
        evidence: [{ name: 'fidelity', value: toQuantumValue(0.5, PROV) }],
        resultId: 'res_final',
      },
    ],
    backend: 'qiskit-aer',
    backendVersion: '0.17.2',
    finalResultId: 'res_final',
    finalProvenance: PROV,
    nextHintIndex: 1,
    nextHint: 'two',
    successMessage: null,
    createdAt: '2026-05-01T10:00:00.000Z',
  })

  beforeEach(() => {
    window.history.replaceState(null, '', '/challenges/a')
    client.listChallenges.mockResolvedValue([CHALLENGE])
    client.listLessons.mockResolvedValue([])
    client.executeCircuit.mockReturnValue(new Promise(() => {}))
    client.traceCircuit.mockReturnValue(new Promise(() => {}))
    setChallengeStore(localStorageChallengeStore())
    useBuildStore.setState(INITIAL_BUILD, true)
    useChallengeStore.setState(useChallengeStore.getInitialState(), true)
  })

  async function failOnce() {
    client.submitChallenge.mockResolvedValueOnce(FAILING())
    render(<App />)
    await screen.findByRole('heading', { level: 2, name: 'Challenge a' })
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Gate palette' })).getByRole('button', { name: 'X' }))
    fireEvent.click(screen.getByRole('button', { name: /^Place x on qubit 0/ }))
    fireEvent.click(screen.getByRole('button', { name: /Submit for checking/ }))
    await screen.findByTestId('verdict')
  }

  it('appears with the verdict, and debugs THAT attempt of THIS challenge', async () => {
    await failOnce()
    const region = screen.getByTestId('debug-challenge')
    fireEvent.click(within(region).getByRole('button', { name: 'Debug my circuit' }))
    await within(region).findByTestId('debug-report')
    const sent = client.debugCircuit.mock.calls[0]![0]
    expect(sent).toMatchObject({ challengeId: 'a', attemptId: 'att_1', resultId: 'res_final', language: 'en' })
    expect(sent.circuit.ops).toHaveLength(1)
    expect(sent).not.toHaveProperty('goal', expect.anything()) // the challenge supplies the goal; no free-text box here
  })

  it('has no free-text goal box: the challenge is the goal', async () => {
    await failOnce()
    expect(within(screen.getByTestId('debug-challenge')).queryByLabelText(/What were you trying to do/)).toBeNull()
  })

  it('is disabled once the circuit changes (the verdict is stale) and says to submit again', async () => {
    await failOnce()
    fireEvent.click(screen.getByRole('button', { name: /^Place x on qubit 0/ }))
    const region = screen.getByTestId('debug-challenge')
    expect(within(region).getByRole('button', { name: 'Debug my circuit' })).toBeDisabled()
    expect(within(region).getByText(/Submit your circuit first/)).toBeInTheDocument()
  })

  it('a report is dropped when a new attempt is judged', async () => {
    await failOnce()
    fireEvent.click(within(screen.getByTestId('debug-challenge')).getByRole('button', { name: 'Debug my circuit' }))
    await screen.findByTestId('debug-report')
    client.submitChallenge.mockResolvedValueOnce(FAILING('att_2'))
    fireEvent.click(screen.getByRole('button', { name: /Submit for checking/ }))
    await waitFor(() => expect(screen.queryByTestId('debug-report')).toBeNull())
  })
})
