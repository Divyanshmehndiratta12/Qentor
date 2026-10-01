/**
 * The Challenges screen inside the real App shell: the address bar, the list, the brief and its hints, the constrained
 * palette, submitting to the (mocked) server, and how the server's verdict, refusals and outages are shown. `@/api` is
 * mocked — the point is what the UI does with what the server says, never a verdict of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Challenge, ChallengeSubmission, Lesson } from '@/api'
import { BackendUnavailableError } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const client = vi.hoisted(() => ({
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
import { useLearnStore } from '@/features/learn/store'
import { setChallengeStore, useChallengeStore } from './store'
import { localStorageChallengeStore } from './challengeStorage'

const one = (id: string, over: Partial<Challenge> = {}): Challenge => ({
  id,
  lessonId: 'superposition',
  title: `Challenge ${id}`,
  goal: `Goal of ${id}.`,
  difficulty: 'beginner',
  successCondition: `Solved when ${id}.`,
  fixedOracle: false,
  constraints: { numQubits: 1, numClbits: 0, allowedGates: ['h', 'x'], maxOps: 6, minGateCounts: {}, anchor: [], anchorName: 'oracle', mustMeasure: [], gateQubits: {} },
  starterCircuit: emptyCircuit(1, 0),
  checks: [{ id: 'state.x', label: 'The state is right' }],
  hints: [`${id} hint one`, `${id} hint two`],
  ...over,
})

const ORACLE: Challenge = one('oracle', {
  title: 'Oracle challenge',
  fixedOracle: true,
  constraints: {
    numQubits: 3,
    numClbits: 3,
    allowedGates: ['h', 'x', 'cx', 'measure'],
    maxOps: 16,
    minGateCounts: {},
    anchor: [
      { gate: 'cx', targets: [2], controls: [0], params: [], clbits: [] },
      { gate: 'cx', targets: [2], controls: [1], params: [], clbits: [] },
    ],
    anchorName: 'oracle',
    mustMeasure: [0, 1],
    gateQubits: {},
  },
  starterCircuit: emptyCircuit(3, 3),
})

const CATALOG = [one('a'), one('b', { starterCircuit: emptyCircuit(2, 2), constraints: { ...one('b').constraints, numQubits: 2, numClbits: 2 } }), ORACLE]

const LESSON: Lesson = {
  id: 'superposition',
  title: 'Superposition Lesson',
  shortDescription: 'd',
  concept: 'superposition',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'Lesson body text.' }],
  linkedCircuit: null,
  prerequisiteLessonIds: [],
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

const verdict = (over: Partial<ChallengeSubmission> = {}): ChallengeSubmission => ({
  attemptId: 'att_abcdef123456789',
  challengeId: 'a',
  circuitHash: 'qc_1',
  passed: true,
  verifier: 'challenge/1',
  checks: [
    { id: 'structure.width', label: 'Uses 1 qubit', passed: true, evaluated: true, detail: 'The circuit has the required number of qubits.', hintIndex: 0, evidence: [], resultId: null },
    {
      id: 'state.x',
      label: 'The state is right',
      passed: true,
      evaluated: true,
      detail: 'The state is the required state (up to global phase).',
      hintIndex: 1,
      evidence: [{ name: 'fidelity', value: toQuantumValue(0.9999994, PROV) }],
      resultId: 'res_final',
    },
  ],
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  finalResultId: 'res_final',
  finalProvenance: PROV,
  nextHintIndex: null,
  nextHint: null,
  successMessage: 'Well done: that is the state.',
  createdAt: '2026-05-01T10:00:00.000Z',
  ...over,
})

const FAILING = (over: Partial<ChallengeSubmission> = {}) =>
  verdict({
    passed: false,
    successMessage: null,
    nextHintIndex: 1,
    nextHint: 'a hint 2 that fits',
    checks: [
      { id: 'structure.width', label: 'Uses 1 qubit', passed: true, evaluated: true, detail: 'ok', hintIndex: 0, evidence: [], resultId: null },
      {
        id: 'state.x',
        label: 'The state is right',
        passed: false,
        evaluated: true,
        detail: 'The state is not the required state.',
        hintIndex: 1,
        evidence: [{ name: 'fidelity', value: toQuantumValue(0.5, PROV) }],
        resultId: 'res_final',
      },
    ],
    ...over,
  })

const FAILING_VERDICT = (): ChallengeSubmission =>
  verdict({
    passed: false,
    successMessage: null,
    nextHintIndex: 1,
    nextHint: 'two',
    checks: [{ id: 'state.x', label: 'The state is right', passed: false, evaluated: true, detail: 'no', hintIndex: 1, evidence: [], resultId: null }],
  })

const INITIAL_CHALLENGE = useChallengeStore.getState()
const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()

function visit(path: string) {
  window.history.replaceState(null, '', path)
  return render(<App />)
}

async function openList(path = '/challenges') {
  visit(path)
  await screen.findByRole('navigation', { name: 'Challenges' })
}

const listButton = (title: RegExp | string) => within(screen.getByRole('navigation', { name: 'Challenges' })).getByRole('button', { name: title })
const openChallenge = async (title: RegExp | string) => {
  fireEvent.click(listButton(title))
  await screen.findByRole('heading', { level: 2, name: /^(Challenge|Oracle)/ })
}
const paletteButton = (name: string) => within(screen.getByRole('toolbar', { name: 'Gate palette' })).getByRole('button', { name })

function place(gate: string, qubit = 0) {
  fireEvent.click(paletteButton(gate))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Place ${gate.toLowerCase()} on qubit ${qubit}`) }))
}

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(client)) fn.mockReset()
  client.listChallenges.mockResolvedValue(CATALOG)
  client.listLessons.mockResolvedValue([LESSON])
  client.executeCircuit.mockReturnValue(new Promise(() => {}))
  client.traceCircuit.mockReturnValue(new Promise(() => {}))
  setChallengeStore(localStorageChallengeStore())
  useChallengeStore.setState(INITIAL_CHALLENGE, true)
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})
afterEach(cleanup)

describe('the list', () => {
  it('shows every challenge from the server, in order, with a status', async () => {
    await openList()
    const items = within(screen.getByRole('navigation', { name: 'Challenges' })).getAllByRole('button')
    expect(items.map((b) => b.getAttribute('aria-label'))).toEqual([
      '1. Challenge a — Not started',
      '2. Challenge b — Not started',
      '3. Oracle challenge — Not started',
    ])
    expect(screen.getByTestId('solved-count').textContent).toBe('0 of 3 solved')
  })

  it('marks the fixed-oracle challenge as such', async () => {
    await openList()
    expect(within(listButton(/Oracle challenge/)).getByText('fixed oracle')).toBeInTheDocument()
  })

  it('says where progress is kept, honestly: this browser, no account', async () => {
    await openList()
    expect(screen.getByTestId('challenge-persistence').textContent).toMatch(/this browser only/)
    expect(screen.getByTestId('challenge-persistence').textContent).toMatch(/no account/i)
  })

  it('is marked as the current page in the nav and has one main landmark', async () => {
    await openList()
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: 'Challenges' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByText('Choose a challenge to begin.')).toBeInTheDocument()
  })

  it('a load failure is an alert with retry, and nothing invented', async () => {
    client.listChallenges.mockRejectedValueOnce(new BackendUnavailableError('server is down'))
    visit('/challenges')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Couldn’t load the challenges/)
    expect(alert.textContent).toMatch(/server is down/)
    expect(alert.textContent).toMatch(/No substitute list is shown/)
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByRole('navigation', { name: 'Challenges' })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the address bar', () => {
  it('a direct visit to /challenges/b opens challenge b once the catalog loads', async () => {
    visit('/challenges/b')
    await screen.findByRole('heading', { level: 2, name: 'Challenge b' })
    expect(window.location.pathname).toBe('/challenges/b')
  })

  it('an unknown id opens nothing and does not crash', async () => {
    visit('/challenges/no-such-thing')
    await screen.findByRole('navigation', { name: 'Challenges' })
    expect(screen.getByText('Choose a challenge to begin.')).toBeInTheDocument()
  })

  it('selecting a challenge puts its id in the address, and Back returns to the previous one', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    expect(window.location.pathname).toBe('/challenges/a')
    fireEvent.click(listButton(/Challenge b/))
    await screen.findByRole('heading', { level: 2, name: 'Challenge b' })
    expect(window.location.pathname).toBe('/challenges/b')

    act(() => window.history.back())
    await screen.findByRole('heading', { level: 2, name: 'Challenge a' })
    expect(window.location.pathname).toBe('/challenges/a')
  })

  it('a re-render does not re-push the path (Back keeps working)', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    const before = window.history.length
    fireEvent.click(paletteButton('H'))
    fireEvent.click(paletteButton('H'))
    expect(window.history.length).toBe(before)
  })

  it('navigating away and back keeps the learner’s challenge and circuit', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    place('H')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: 'Progress' }))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: 'Challenges' }))
    await screen.findByRole('heading', { level: 2, name: 'Challenge a' })
    expect(useBuildStore.getState().circuit.ops).toHaveLength(1)
    expect(window.location.pathname).toBe('/challenges/a')
  })
})

describe('the brief', () => {
  it('shows the goal, the success condition and the constraints from the server', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    expect(screen.getByText('Goal of a.')).toBeInTheDocument()
    expect(screen.getByText('Solved when a.')).toBeInTheDocument()
    expect(screen.getByText('h x')).toBeInTheDocument()
    expect(screen.getByText('6 ops')).toBeInTheDocument()
  })

  it('links to the related lesson by its title, and opens it', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    fireEvent.click(await screen.findByRole('button', { name: 'Lesson: Superposition Lesson' }))
    await screen.findByText('Lesson body text.')
    expect(window.location.pathname).toBe('/learn')
  })

  it('hints are hidden until asked for, and appear one at a time', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    expect(screen.queryByText('a hint one')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Show a hint/ }))
    expect(screen.getByText('a hint one')).toBeInTheDocument()
    expect(screen.queryByText('a hint two')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Show the next hint/ }))
    expect(screen.getByText('a hint two')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /hint/ })).toBeNull()
  })

  it('revealed hints are still there after a reload', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    fireEvent.click(screen.getByRole('button', { name: /Show a hint/ }))
    cleanup()
    useChallengeStore.setState({ ...INITIAL_CHALLENGE, outcomes: localStorageChallengeStore().load().outcomes, challenges: [], selectedId: null }, true)
    await openList('/challenges/a')
    await screen.findByRole('heading', { level: 2, name: 'Challenge a' })
    expect(screen.getByText('a hint one')).toBeInTheDocument()
  })

  it('the fixed oracle is spelled out, gate by gate', async () => {
    await openList()
    await openChallenge(/Oracle challenge/)
    const oracle = screen.getByText(/The fixed oracle — place these gates exactly/)
    expect(oracle).toBeInTheDocument()
    expect(screen.getByText(/CX — control q0, target q2/)).toBeInTheDocument()
    expect(screen.getByText(/CX — control q1, target q2/)).toBeInTheDocument()
    expect(screen.getByText(/one oracle for this challenge/i)).toBeInTheDocument()
  })

  it('states the bitstring order beside the workspace', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    expect(screen.getByText(/q\[n-1\] … q\[0\]/)).toBeInTheDocument()
  })
})

describe('the workspace obeys the challenge', () => {
  it('loads the starter circuit and fixes the number of qubits', async () => {
    await openList()
    await openChallenge(/Challenge b/)
    expect(useBuildStore.getState().circuit.num_qubits).toBe(2)
    expect(screen.queryByRole('button', { name: 'Add a qubit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove a qubit' })).toBeNull()
  })

  it('shows gates the challenge does not allow as disabled, and allows the rest', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    expect(paletteButton('H')).toBeEnabled()
    expect(paletteButton('X')).toBeEnabled()
    expect(paletteButton('Y')).toBeDisabled()
    expect(paletteButton('CX')).toBeDisabled()
    expect(paletteButton('M')).toBeDisabled()
    expect(paletteButton('Y').getAttribute('title')).toMatch(/not allowed in this challenge/)
  })

  it('a disabled gate cannot be selected or dragged', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    fireEvent.click(paletteButton('Y'))
    expect(useBuildStore.getState().selectedGate).toBeNull()
    expect(paletteButton('Y').getAttribute('draggable')).toBe('false')
  })

  it('the Lab’s own palette is unrestricted', async () => {
    visit('/')
    expect(paletteButton('Y')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Add a qubit' })).toBeInTheDocument()
  })

  it('executes nothing until a challenge is open', async () => {
    await openList()
    await new Promise((r) => setTimeout(r, 350))
    expect(client.executeCircuit).not.toHaveBeenCalled()
  })
})

describe('submitting to the server', () => {
  async function ready(title: RegExp = /Challenge a/) {
    await openList()
    await openChallenge(title)
  }
  const submitButton = () => screen.getByRole('button', { name: /Submit for checking|Checking…/ })

  it('cannot submit an empty circuit', async () => {
    await ready()
    expect(submitButton()).toBeDisabled()
    place('H')
    expect(submitButton()).toBeEnabled()
  })

  it('sends the challenge id and the circuit on screen — nothing else', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await ready()
    place('H')
    fireEvent.click(submitButton())
    await screen.findByTestId('verdict')
    expect(client.submitChallenge).toHaveBeenCalledTimes(1)
    const [id, circuit] = client.submitChallenge.mock.calls[0]!
    expect(id).toBe('a')
    expect(circuit.ops).toEqual([{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }])
    expect(client.submitChallenge.mock.calls[0]).toHaveLength(2)
  })

  it('shows the server’s pass: Solved, each check, the number with its provenance badge, the judge and the attempt', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await ready()
    place('H')
    fireEvent.click(submitButton())
    const panel = await screen.findByTestId('verdict')
    expect(panel.getAttribute('data-passed')).toBe('true')
    expect(within(panel).getByText('Solved')).toBeInTheDocument()
    expect(within(panel).getByText(/2 of 2 checks passed/)).toBeInTheDocument()
    expect(within(panel).getByText('Well done: that is the state.')).toBeInTheDocument()
    expect(within(screen.getByTestId('check-state.x')).getByText('0.999999')).toBeInTheDocument() // the server's number, verbatim to 6 places
    expect(within(panel).getAllByText(/Simulated/).length).toBeGreaterThan(0) // provenance badge beside the number and on the verdict
    expect(within(panel).getByText(/judged by challenge\/1 on qiskit-aer 0\.17\.2/)).toBeInTheDocument()
    expect(within(panel).getByText(/attempt att_abcdef12/)).toBeInTheDocument()
  })

  it('records the solve: the list shows Solved and the count moves', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await ready()
    place('H')
    fireEvent.click(submitButton())
    await screen.findByTestId('verdict')
    expect(screen.getByTestId('status-a').textContent).toMatch(/Solved/)
    expect(screen.getByTestId('solved-count').textContent).toBe('1 of 3 solved')
  })

  it('a pass is announced politely, not as an alert', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await ready()
    place('H')
    fireEvent.click(submitButton())
    const panel = await screen.findByTestId('verdict')
    expect(within(panel).getAllByRole('status').length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a failure honestly: Not solved yet, the failing check, the hint that fits — and it does not solve', async () => {
    client.submitChallenge.mockResolvedValueOnce(FAILING())
    await ready()
    place('X')
    fireEvent.click(submitButton())
    const panel = await screen.findByTestId('verdict')
    expect(panel.getAttribute('data-passed')).toBe('false')
    expect(within(panel).getByText('Not solved yet')).toBeInTheDocument()
    expect(within(panel).getByText(/1 of 2 checks passed/)).toBeInTheDocument()
    expect(screen.getByTestId('check-state.x').getAttribute('data-state')).toBe('fail')
    expect(within(panel).getByText(/a hint 2 that fits/)).toBeInTheDocument()
    expect(screen.getByTestId('status-a').textContent).toMatch(/In progress/)
    expect(screen.getByTestId('solved-count').textContent).toBe('0 of 3 solved')
  })

  it('"Add it to the hints" reveals the hints up to the one that fits', async () => {
    client.submitChallenge.mockResolvedValueOnce(FAILING())
    await ready()
    place('X')
    fireEvent.click(submitButton())
    await screen.findByTestId('verdict')
    expect(screen.queryByText('a hint two')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add it to the hints' }))
    expect(screen.getByText('a hint one')).toBeInTheDocument()
    expect(screen.getByText('a hint two')).toBeInTheDocument()
  })

  it('checks that could not be judged yet are shown as not checked, not as failed', async () => {
    client.submitChallenge.mockResolvedValueOnce(
      FAILING({
        finalProvenance: null,
        finalResultId: null,
        backend: null,
        backendVersion: null,
        checks: [
          { id: 'structure.gates', label: 'Uses only the allowed gates', passed: false, evaluated: true, detail: 'Not allowed here: y.', hintIndex: 0, evidence: [], resultId: null },
          { id: 'state.x', label: 'The state is right', passed: false, evaluated: false, detail: 'Not evaluated yet: fix the circuit’s structure first.', hintIndex: 1, evidence: [], resultId: null },
        ],
      }),
    )
    await ready()
    place('X')
    fireEvent.click(submitButton())
    const panel = await screen.findByTestId('verdict')
    expect(screen.getByTestId('check-state.x').getAttribute('data-state')).toBe('pending')
    expect(within(screen.getByTestId('check-state.x')).getByRole('img', { name: 'Not checked yet' })).toBeInTheDocument()
    expect(within(panel).getByText(/0 of 1 checks passed \(1 not checked yet\)/)).toBeInTheDocument()
    expect(within(panel).getByText(/Nothing was run/)).toBeInTheDocument()
  })

  it('a verdict is marked stale as soon as the circuit changes', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await ready()
    place('H')
    fireEvent.click(submitButton())
    const panel = await screen.findByTestId('verdict')
    expect(panel.getAttribute('data-current')).toBe('true')
    place('X')
    expect(screen.getByTestId('verdict').getAttribute('data-current')).toBe('false')
    expect(screen.getByText(/You changed the circuit after this check/)).toBeInTheDocument()
  })

  it('a refusal (4xx) is an alert saying the server could not check it — and no verdict is shown', async () => {
    client.submitChallenge.mockRejectedValueOnce(new BackendUnavailableError('circuit too big', 422))
    await ready()
    place('H')
    fireEvent.click(submitButton())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/The server could not check this circuit/)
    expect(alert.textContent).toMatch(/circuit too big/)
    expect(alert.textContent).toMatch(/has not been checked/)
    expect(screen.queryByTestId('verdict')).toBeNull()
    expect(screen.getByTestId('status-a').textContent).toMatch(/Not started/)
  })

  it('an outage is "Checking is unavailable" with a retry that submits again', async () => {
    client.submitChallenge.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend'))
    await ready()
    place('H')
    fireEvent.click(submitButton())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Checking is unavailable/)
    client.submitChallenge.mockResolvedValueOnce(verdict())
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('verdict')
    expect(client.submitChallenge).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a loading state is announced while the server checks', async () => {
    client.submitChallenge.mockReturnValueOnce(new Promise(() => {}))
    await ready()
    place('H')
    fireEvent.click(submitButton())
    await waitFor(() => expect(screen.getByText('The server is checking your circuit…')).toBeInTheDocument())
    expect(submitButton()).toBeDisabled()
    expect(submitButton().textContent).toBe('Checking…')
  })

  it('after a solve there is always a "what next" with somewhere to go; after a failure there is none', async () => {
    client.submitChallenge.mockResolvedValueOnce(FAILING_VERDICT())
    await ready()
    place('H')
    fireEvent.click(submitButton())
    await screen.findByTestId('verdict')
    expect(screen.queryByTestId('next-step')).toBeNull()

    client.submitChallenge.mockResolvedValueOnce(verdict({ attemptId: 'att_solved' }))
    place('X')
    fireEvent.click(submitButton())
    const next = await screen.findByTestId('next-step')
    expect(within(next).getByRole('button', { name: 'See my progress' })).toBeInTheDocument()
    fireEvent.click(within(next).getByRole('button', { name: 'See my progress' }))
    expect(window.location.pathname).toBe('/progress')
  })
})

describe('the right-hand panel', () => {
  it('has real tabs: Check by default, Results & trace on request', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    // the tutor below has its own modes (Explain, What changed?, Generate code); these are the right-hand panel's tabs
    const tabs = screen.getAllByRole('tab').filter((t) => t.id.startsWith('tab-'))
    expect(tabs.map((t) => t.textContent)).toEqual(['Check', 'Results & trace'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tabpanel').some((p) => p.getAttribute('aria-labelledby') === 'tab-check')).toBe(true)
    expect(screen.getAllByRole('tab').filter((t) => !t.id.startsWith('tab-')).map((t) => t.textContent)).toEqual(['Explain', 'What changed?', 'Generate code'])
    fireEvent.click(tabs[1]!)
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Trace' })).toBeInTheDocument()
  })

  it('can hand the circuit to the Lab', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    place('H')
    fireEvent.click(screen.getByRole('button', { name: 'Open this circuit in the Lab' }))
    expect(window.location.pathname).toBe('/')
    expect(useBuildStore.getState().circuit.ops).toHaveLength(1)
  })

  it('offers the Tutor for the circuit being solved', async () => {
    await openList()
    await openChallenge(/Challenge a/)
    expect(screen.getByRole('contentinfo', { name: 'Tutor' })).toBeInTheDocument()
  })
})

describe('an optimization challenge (shorten without changing)', () => {
  const g = (gate: 'h' | 'x' | 's' | 'sdg' | 'cx' | 'rz', targets: number[], controls: number[] = [], params: number[] = []) => ({ gate, targets, controls, params, clbits: [] })
  const STARTER = {
    ...emptyCircuit(2, 0),
    ops: [g('h', [0]), g('h', [0]), g('h', [0]), g('x', [1]), g('x', [1]), g('cx', [1], [0]), g('s', [1]), g('sdg', [1]), g('rz', [1], [], [0.5]), g('rz', [1], [], [0.25])],
  }
  const OPT = one('opt', {
    lessonId: 'superposition',
    goal: 'Make it shorter without changing what it does.',
    constraints: { ...one('opt').constraints, numQubits: 2, allowedGates: ['h', 'x', 's', 'sdg', 'cx', 'rz'], maxOps: 3 },
    starterCircuit: STARTER,
    checks: [{ id: 'equivalent.to_start', label: 'Does exactly what the starting circuit does' }],
  })

  beforeEach(() => client.listChallenges.mockResolvedValue([OPT]))

  it('opens with the redundant starter circuit on the canvas and its size limit in the brief', async () => {
    await openList()
    await openChallenge(/Challenge opt/)
    expect(useBuildStore.getState().circuit.ops).toHaveLength(10)
    expect(screen.getByText('Make it shorter without changing what it does.')).toBeInTheDocument()
    expect(screen.getByText('3 ops')).toBeInTheDocument()
  })

  it('offers the equivalence tools but not the Lab’s Optimize button, which would hand over the answer', async () => {
    await openList()
    await openChallenge(/Challenge opt/)
    fireEvent.click(screen.getAllByRole('tab').find((t) => t.id === 'tab-results')!)
    expect(screen.getByRole('button', { name: 'Pin this circuit' })).toBeInTheDocument()
    expect(screen.queryByTestId('optimize-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Optimize' })).toBeNull()
    expect(client.optimizeCircuit).not.toHaveBeenCalled()
  })

  it('submits the circuit and nothing else; the verdict is the server’s, shown with its failing check', async () => {
    client.submitChallenge.mockResolvedValueOnce(
      verdict({
        passed: false,
        successMessage: null,
        nextHintIndex: 1,
        nextHint: 'opt hint two',
        checks: [{ id: 'equivalent.to_start', label: 'Does exactly what the starting circuit does', passed: false, evaluated: true, detail: 'The circuit does not do what the starting circuit does: the backend’s equivalence check found a difference.', hintIndex: 1, evidence: [], resultId: 'res_final' }],
      }),
    )
    await openList()
    await openChallenge(/Challenge opt/)
    fireEvent.click(screen.getByRole('button', { name: /Submit for checking/ }))
    const panel = await screen.findByTestId('verdict')
    expect(panel.getAttribute('data-passed')).toBe('false')
    expect(within(screen.getByTestId('check-equivalent.to_start')).getByText(/equivalence check found a difference/)).toBeInTheDocument()
    expect(client.submitChallenge.mock.calls[0]).toHaveLength(2)
    expect(client.submitChallenge.mock.calls[0]![1].ops).toEqual(STARTER.ops)
  })
})

describe('the palette sits under the canvas on the challenge screen', () => {
  const four = one('four', { constraints: { ...one('four').constraints, numQubits: 4 }, starterCircuit: emptyCircuit(4, 0) })

  it('is a strip below the canvas, in the same column, never over the wires', async () => {
    client.listChallenges.mockResolvedValue([one('a')])
    await openList()
    await openChallenge(/Challenge a/)
    const region = screen.getByTestId('challenge-canvas-region')
    const palette = within(region).getByRole('toolbar', { name: 'Gate palette' })
    const canvas = within(region).getByRole('group', { name: 'Circuit editor' })
    expect(canvas.compareDocumentPosition(palette) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(canvas.contains(palette)).toBe(false)
    expect(palette.closest('[class*="absolute"]')).toBeNull()
  })

  it('keeps a taller canvas for a register of four or more qubits, and not for fewer', async () => {
    client.listChallenges.mockResolvedValue([one('a'), four])
    await openList()
    await openChallenge(/Challenge a/)
    expect(screen.getByTestId('challenge-canvas-region').className).not.toContain('min-h-[24rem]')
    fireEvent.click(listButton(/Challenge four/))
    await screen.findByRole('heading', { level: 2, name: /Challenge four/ })
    expect(screen.getByTestId('challenge-canvas-region').className).toContain('min-h-[24rem]')
  })
})

describe('the palette stays in view in a tall challenge workspace', () => {
  it('is sticky at the bottom of the scrolling column on the challenge screen, and not in the Lab', async () => {
    client.listChallenges.mockResolvedValue([one('a')])
    await openList()
    await openChallenge(/Challenge a/)
    expect(screen.getByRole('toolbar', { name: 'Gate palette' }).parentElement!.className).toContain('sticky')
  })
})
