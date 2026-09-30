/** The Compare experiments panel in the Lab: pin A, run B, show what the server computed, ask the tutor about it. `@/api` is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ExecutePayload, ExperimentComparison, TutorAnswerResult } from '@/api'
import { BackendUnavailableError } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const client = vi.hoisted(() => ({
  compareExperiments: vi.fn(),
  askComparisonTutor: vi.fn(),
  listLessons: vi.fn(),
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  traceCircuit: vi.fn(),
  debugCircuit: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import App from '@/App'
import { useBuildStore } from '@/features/build/store'
import { useCompareStore } from './store'

const H: Circuit = { ...emptyCircuit(1, 0), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] }
const X: Circuit = { ...emptyCircuit(1, 0), ops: [{ gate: 'x', targets: [0], controls: [], params: [], clbits: [] }] }

const prov = (id: string, backend = 'qiskit-aer'): Provenance => ({
  resultId: id,
  circuitHash: 'qc_' + id,
  backend,
  backendVersion: '1',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
})
const run = (id: string, backend?: string) => toQuantumValue<ExecutePayload>({ executionId: 'e_' + id, probabilities: { '0': 0.5, '1': 0.5 } }, prov(id, backend))

const CMP_PROV = { ...prov('res_cmp', 'experiment-comparison'), executionMode: 'comparison' }
const q = (v: number) => toQuantumValue(v, CMP_PROV)

const COMPARISON = (over: Partial<ExperimentComparison> = {}): ExperimentComparison => ({
  comparisonId: 'res_cmp',
  method: 'qentor.experiment-comparison/1',
  a: { provenance: prov('res_a'), executionId: 'e_a', shots: null, numQubits: 1 },
  b: { provenance: prov('res_b', 'cirq'), executionId: 'e_b', shots: null, numQubits: 1 },
  circuit: {
    sameCircuit: false,
    numQubitsA: 1,
    numQubitsB: 1,
    numOpsA: 1,
    numOpsB: 1,
    changes: [{ tag: 'replace', aStart: 0, aOps: ['h(q0)'], bStart: 0, bOps: ['x(q0)'] }],
    equivalenceStatus: 'NOT_EQUIVALENT',
    equivalenceReason: null,
  },
  measurement: {
    comparable: true,
    reason: null,
    kindA: 'theoretical_probability',
    kindB: 'sampled_frequency',
    rows: [
      { outcome: '0', a: q(0.5), b: null, difference: null },
      { outcome: '1', a: q(0.5), b: q(1), difference: q(0.5) },
    ],
    totalVariationDistance: q(0.5),
    maxDifference: q(0.5),
    note: 'One run is sampled and the other theoretical.',
  },
  state: { comparable: true, reason: null, fidelity: q(0.5), maxProbabilityDifference: q(0.5), maxAmplitudeDifference: q(0.7), note: 'Fidelity is 1 when the same up to phase.' },
  provenance: CMP_PROV,
  ...over,
})

const ANSWER: TutorAnswerResult = {
  answer: 'For this comparison: run A applies h(q0) where run B applies x(q0) (X4).',
  resultId: 'res_cmp',
  circuitHash: 'cmp_1',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  usedFallbackTemplate: true,
  facts: [],
}

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_COMPARE = useCompareStore.getState()

const panel = () => screen.getByTestId('compare-panel')
const show = (circuit: Circuit, result: ReturnType<typeof run>) => act(() => void useBuildStore.setState({ circuit, result, isExecuting: false, executionError: null }))

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([])
  client.executeCircuit.mockReturnValue(new Promise(() => {}))
  client.compareExperiments.mockResolvedValue(COMPARISON())
  client.askComparisonTutor.mockResolvedValue(ANSWER)
  useBuildStore.setState(INITIAL_BUILD, true)
  useCompareStore.setState(INITIAL_COMPARE, true)
})
afterEach(cleanup)

describe('pinning', () => {
  it('waits for a real result', () => {
    render(<App />)
    expect(within(panel()).getByText('Run a circuit first, then pin it as run A.')).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: 'Pin this run as A' })).toBeDisabled()
  })

  it('pins the run on screen: its circuit and the result the server issued', () => {
    render(<App />)
    show(H, run('res_a'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pin this run as A' }))
    expect(useCompareStore.getState().pinned).toEqual({ circuit: H, result: expect.objectContaining({ provenance: expect.objectContaining({ resultId: 'res_a' }) }) })
    expect(within(panel()).getByTestId('pinned-run').textContent).toMatch(/qiskit-aer · statevector · 1 op · res_a/)
  })

  it('cannot compare a run with itself', () => {
    render(<App />)
    show(H, run('res_a'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pin this run as A' }))
    expect(within(panel()).getByRole('button', { name: 'Compare A with this run (B)' })).toBeDisabled()
    expect(within(panel()).getByText(/This is the pinned run/)).toBeInTheDocument()
  })

  it('unpin clears everything', async () => {
    render(<App />)
    show(H, run('res_a'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pin this run as A' }))
    show(X, run('res_b'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Compare A with this run (B)' }))
    await screen.findByTestId('comparison')
    fireEvent.click(within(panel()).getByRole('button', { name: 'Unpin' }))
    expect(screen.queryByTestId('comparison')).toBeNull()
    expect(useCompareStore.getState().pinned).toBeNull()
  })
})

describe('comparing', () => {
  async function compared() {
    render(<App />)
    show(H, run('res_a'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pin this run as A' }))
    show(X, run('res_b', 'cirq'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Compare A with this run (B)' }))
    await screen.findByTestId('comparison')
  }

  it('sends the two result ids and their circuits, and nothing else', async () => {
    await compared()
    expect(client.compareExperiments).toHaveBeenCalledWith({ resultId: 'res_a', circuit: H }, { resultId: 'res_b', circuit: X })
    expect(client.compareExperiments.mock.calls[0]).toHaveLength(2)
  })

  it('shows both runs’ identity and the backend difference', async () => {
    await compared()
    expect(within(screen.getByTestId('run-A')).getByText(/qiskit-aer 1 · statevector/)).toBeInTheDocument()
    expect(within(screen.getByTestId('run-B')).getByText(/cirq 1 · statevector/)).toBeInTheDocument()
    expect(screen.getByTestId('compare-backends').textContent).toMatch(/qiskit-aer and cirq/)
  })

  it('shows the circuit difference and the equivalence verdict as the server gave it', async () => {
    await compared()
    const c = screen.getByTestId('compare-circuit')
    expect(within(c).getByText(/− A: h\(q0\)/)).toBeInTheDocument()
    expect(within(c).getByText(/\+ B: x\(q0\)/)).toBeInTheDocument()
    expect(screen.getByTestId('compare-equivalence').getAttribute('data-status')).toBe('NOT_EQUIVALENT')
    expect(screen.getByTestId('compare-equivalence').textContent).toMatch(/Not equivalent/)
  })

  it('shows the measurement table with the kinds labelled, an absent value as a dash, numbers as the server gave them', async () => {
    await compared()
    const m = screen.getByTestId('compare-measurement')
    expect(within(m).getByText(/A: theoretical probability · B: sampled frequency/)).toBeInTheDocument()
    expect(within(m).getByText(/q\[n-1\] … q\[0\]/)).toBeInTheDocument()
    const rows = within(m).getAllByRole('row').slice(1)
    expect(within(rows[0]!).getAllByText('0.500000')).toHaveLength(1)
    expect(within(rows[0]!).getAllByText('—')).toHaveLength(2)
    expect(within(rows[1]!).getByText('1.000000')).toBeInTheDocument()
    expect(within(m).getByText(/Total variation distance/).textContent).toMatch(/0\.500000/)
    expect(within(m).getByText('One run is sampled and the other theoretical.')).toBeInTheDocument()
  })

  it('shows the state difference, and says when a state cannot be compared', async () => {
    await compared()
    expect(within(screen.getByTestId('compare-state')).getByText('Fidelity').nextElementSibling!.textContent).toMatch(/0\.500000/)
    cleanup()
    useCompareStore.setState(INITIAL_COMPARE, true)
    client.compareExperiments.mockResolvedValueOnce(
      COMPARISON({ state: { comparable: false, reason: 'a shots run has samples, not a state', fidelity: null, maxProbabilityDifference: null, maxAmplitudeDifference: null, note: null } }),
    )
    await compared()
    expect(screen.getByTestId('compare-state').textContent).toMatch(/Not comparable: a shots run has samples, not a state/)
  })

  it('carries the comparison’s own provenance badge and says the server computed it', async () => {
    await compared()
    const comparison = screen.getByTestId('comparison')
    expect(within(comparison).getAllByText(/Simulated/).length).toBeGreaterThanOrEqual(3)
    expect(within(comparison).getByText(/computed by the server \(qentor\.experiment-comparison\/1\)/)).toBeInTheDocument()
  })

  it('a refusal is an alert with nothing worked out locally; retry works', async () => {
    client.compareExperiments.mockRejectedValueOnce(new BackendUnavailableError('circuit does not match', 422))
    render(<App />)
    show(H, run('res_a'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pin this run as A' }))
    show(X, run('res_b'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Compare A with this run (B)' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/The server could not compare these runs/)
    expect(alert.textContent).toMatch(/nothing was worked out here/)
    expect(screen.queryByTestId('comparison')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('comparison')
  })

  it('an outage reads as unavailable', async () => {
    client.compareExperiments.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend'))
    render(<App />)
    show(H, run('res_a'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pin this run as A' }))
    show(X, run('res_b'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Compare A with this run (B)' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Comparison is unavailable/)
  })

  it('pinning a different run discards the old comparison', async () => {
    await compared()
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pin this run as A instead' }))
    expect(screen.queryByTestId('comparison')).toBeNull()
  })
})

describe('Ask Tutor about this difference', () => {
  async function ready() {
    render(<App />)
    show(H, run('res_a'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pin this run as A' }))
    show(X, run('res_b'))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Compare A with this run (B)' }))
    await screen.findByTestId('comparison')
  }

  it('sends only the comparison id, the question and the language', async () => {
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Ask Tutor about this difference' }))
    await screen.findByTestId('compare-answer')
    expect(client.askComparisonTutor).toHaveBeenCalledWith('res_cmp', 'What is different between run A and run B?', 'en')
  })

  it('a typed question goes the same way, in the chosen language', async () => {
    await ready()
    act(() => useBuildStore.getState().setTutorLanguage('hi'))
    fireEvent.change(screen.getByLabelText('Ask about this comparison'), { target: { value: 'which gates changed?' } })
    fireEvent.click(within(screen.getByTestId('compare-tutor')).getByRole('button', { name: 'Ask' }))
    await screen.findByTestId('compare-answer')
    expect(client.askComparisonTutor).toHaveBeenCalledWith('res_cmp', 'which gates changed?', 'hi')
  })

  it('shows the answer with whether AI wrote it and which record it rests on', async () => {
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Ask Tutor about this difference' }))
    const answer = await screen.findByTestId('compare-answer')
    expect(answer.textContent).toMatch(/run A applies h\(q0\) where run B applies x\(q0\)/)
    expect(answer.textContent).toMatch(/generated without AI/)
    expect(answer.textContent).toMatch(/comparison res_cmp/)
  })

  it('a failure is shown, not papered over', async () => {
    client.askComparisonTutor.mockRejectedValueOnce(new BackendUnavailableError('down'))
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Ask Tutor about this difference' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/nothing was made up/)
  })

  it('an answer that arrives after the comparison was replaced is dropped', async () => {
    let resolve!: (a: TutorAnswerResult) => void
    client.askComparisonTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((r) => (resolve = r)))
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Ask Tutor about this difference' }))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Unpin' }))
    await act(async () => resolve(ANSWER))
    expect(screen.queryByTestId('compare-answer')).toBeNull()
    await waitFor(() => expect(useCompareStore.getState().isAsking).toBe(false))
  })
})
