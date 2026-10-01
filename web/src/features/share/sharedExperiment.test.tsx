/**
 * Collaborative sharing, from the visitor's and the sharer's side. A shared experiment is a read-only page built from what the server
 * stored; "Fork into my Lab" copies the circuit into the visitor's own Lab and sends nothing anywhere; sharing sends the circuit and
 * ids, never a number, and degrades honestly when the server says no.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SharedExperiment } from '@/api'

const client = vi.hoisted(() => ({
  getExperiment: vi.fn(),
  createExperiment: vi.fn(),
  exportCircuit: vi.fn(),
  listLessons: vi.fn(),
  listChallenges: vi.fn(),
  getMyClass: vi.fn(),
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  traceCircuit: vi.fn(),
  generateCode: vi.fn(),
  reportLearnerEvent: vi.fn(),
  regradeConceptChecks: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import { ClassroomRejectedError, BackendUnavailableError } from '@/api'
import App from '@/App'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { useBuildStore } from '@/features/build/store'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { ExportPanel } from './ExportPanel'
import { ReadOnlyCircuit } from './ReadOnlyCircuit'
import { SharedExperimentScreen } from './SharedExperimentScreen'

const op = (gate: string, t: number, c: number[] = []) => ({ gate, targets: [t], controls: c, params: [], clbits: [] }) as Circuit['ops'][number]
const BELL: Circuit = { ...emptyCircuit(2, 0), ops: [op('h', 0), op('cx', 1, [0])] }
const ID = 'ex_0123456789abcdef'

const PROV: Provenance = {
  resultId: 'res_1',
  circuitHash: 'abc123',
  backend: 'qiskit-aer',
  backendVersion: '1.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-10-01T00:00:00Z',
}

function shared(overrides: Partial<SharedExperiment> = {}): SharedExperiment {
  return {
    experimentId: ID,
    createdAt: '2026-10-01T12:00:00Z',
    title: 'Bell pair',
    note: 'A read-only snapshot.',
    circuitHash: 'abc123',
    circuit: BELL,
    qasm: 'OPENQASM 3.0;\nh q[0];\ncx q[0], q[1];',
    generator: 'qentor.codegen/1',
    code: { qiskit: 'qc.h(0)\nqc.cx(0, 1)', cirq: 'cirq.H(q[0])', pennylane: 'qml.Hadamard(wires=0)' },
    backend: 'qiskit-aer',
    mode: 'statevector',
    shots: null,
    lesson: null,
    challenge: null,
    result: toQuantumValue(
      {
        executionId: 'e1',
        statevector: [[0.70710678, 0], [0, 0], [0, 0], [0.70710678, 0]] as Array<[number, number]>,
        theoreticalProbabilities: { '00': 0.5, '11': 0.5 },
      },
      PROV,
    ),
    resultNote: 'The result shown is the stored record of one run.',
    ...overrides,
  }
}

beforeEach(() => {
  cleanup()
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([])
  client.listChallenges.mockResolvedValue([])
  client.regradeConceptChecks.mockResolvedValue([])
  client.reportLearnerEvent.mockResolvedValue('RECORDED')
  useBuildStore.getState().loadCircuit(emptyCircuit(2, 0))
})
afterEach(cleanup)

const renderShared = (onFork = vi.fn(), onOpenLab = vi.fn()) => {
  render(<SharedExperimentScreen experimentId={ID} onFork={onFork} onOpenLab={onOpenLab} />)
  return { onFork, onOpenLab }
}

describe('the read-only page', () => {
  it('shows the circuit, the code the server wrote, and the stored run with its provenance', async () => {
    client.getExperiment.mockResolvedValue(shared())
    renderShared()
    expect(await screen.findByTestId('shared-title')).toHaveTextContent('Bell pair')
    expect(client.getExperiment).toHaveBeenCalledWith(ID)
    expect(screen.getByTestId('readonly-badge')).toHaveTextContent('Read-only snapshot')
    expect(screen.getByTestId('readonly-circuit')).toBeInTheDocument()
    expect(screen.getByTestId('shared-code')).toHaveTextContent('h q[0];')
    const result = screen.getByTestId('shared-result')
    expect(result).toHaveTextContent('Simulated')
    expect(result).toHaveTextContent('qiskit-aer')
    expect(screen.getByTestId('shared-run-line')).toHaveTextContent('Stored run on qiskit-aer, statevector mode')
    expect(screen.getByTestId('shared-result-note')).toHaveTextContent('stored record of one run')
    expect(result.textContent).toContain('0.707107') // the backend's amplitude, shown as given
  })

  it('has nothing to edit: no text field, no editable region, and the only actions are fork, tabs and copy', async () => {
    client.getExperiment.mockResolvedValue(shared())
    renderShared()
    await screen.findByTestId('shared-title')
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(document.querySelectorAll('textarea, input, select, [contenteditable]:not([contenteditable="false"])')).toHaveLength(0)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Fork into my Lab', 'Copy code'])
    expect(screen.getAllByRole('tab').map((b) => b.textContent)).toEqual(['OpenQASM 3', 'Qiskit', 'Cirq', 'PennyLane'])
  })

  it('code tabs switch between the server’s texts, with the arrow keys too', async () => {
    client.getExperiment.mockResolvedValue(shared())
    renderShared()
    await screen.findByTestId('shared-title')
    fireEvent.click(screen.getByRole('tab', { name: 'Qiskit' }))
    expect(screen.getByTestId('shared-code')).toHaveTextContent('qc.h(0)')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Cirq' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('shared-code')).toHaveTextContent('cirq.H(q[0])')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' })
    expect(screen.getByTestId('shared-code')).toHaveTextContent('qml.Hadamard')
    expect(screen.getByText(/was not run to make this page/)).toBeInTheDocument()
  })

  it('renders a title as plain text: markup in it is shown, never parsed', async () => {
    client.getExperiment.mockResolvedValue(shared({ title: '<img src=x onerror=alert(1)><script>alert(2)</script>' }))
    renderShared()
    const title = await screen.findByTestId('shared-title')
    expect(title.textContent).toBe('<img src=x onerror=alert(1)><script>alert(2)</script>')
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })

  it('shows a lesson and challenge association by their titles', async () => {
    client.getExperiment.mockResolvedValue(shared({ lesson: { id: 'l', title: 'Superposition' }, challenge: { id: 'c', title: 'Make a Bell pair' } }))
    renderShared()
    await screen.findByTestId('shared-title')
    expect(document.body.textContent).toContain('Lesson: Superposition')
    expect(document.body.textContent).toContain('Challenge: Make a Bell pair')
  })

  it('a share without a run shows no result and says how to get one', async () => {
    client.getExperiment.mockResolvedValue(shared({ result: null, resultNote: 'This experiment was shared without a result. Fork it into your Lab and run it.' }))
    renderShared()
    await screen.findByTestId('shared-title')
    expect(screen.queryByTestId('shared-result')).toBeNull()
    expect(screen.getByTestId('shared-run-line')).toHaveTextContent('No run is attached')
    expect(screen.getByTestId('shared-result-note')).toHaveTextContent('shared without a result')
  })

  it('a run whose record has gone is said to be gone, with nothing substituted', async () => {
    client.getExperiment.mockResolvedValue(shared({ result: null, resultNote: 'The run this experiment pointed to is no longer available, so no result is shown.' }))
    renderShared()
    await screen.findByTestId('shared-title')
    expect(screen.queryByTestId('shared-result')).toBeNull()
    expect(screen.getByTestId('shared-result-note')).toHaveTextContent('no longer available')
  })

  it('a shots run is shown as sampled counts with their provenance', async () => {
    client.getExperiment.mockResolvedValue(
      shared({
        mode: 'shots',
        shots: 100,
        result: toQuantumValue({ executionId: 'e', counts: { '00': 52, '11': 48 }, probabilities: { '00': 0.52, '11': 0.48 }, shots: 100 }, { ...PROV, executionMode: 'shots' }),
      }),
    )
    renderShared()
    await screen.findByTestId('shared-result')
    expect(screen.getByTestId('shared-run-line')).toHaveTextContent('shots mode (100 shots)')
    expect(screen.getByTestId('sampled-note')).toBeInTheDocument()
    expect(screen.getByTestId('shared-result').textContent).toContain('0.520000')
  })

  it('an unknown id is “not found”, with a way back', async () => {
    client.getExperiment.mockRejectedValue(new ClassroomRejectedError('EXPERIMENT_NOT_FOUND', 'No shared experiment has that id.', 404))
    const { onOpenLab } = renderShared()
    expect(await screen.findByTestId('shared-missing')).toHaveTextContent('Shared experiment not found')
    fireEvent.click(screen.getByRole('button', { name: 'Go to the Lab' }))
    expect(onOpenLab).toHaveBeenCalled()
    expect(screen.queryByTestId('shared-title')).toBeNull()
  })

  it('a malformed address never asks the server at all', async () => {
    render(<SharedExperimentScreen experimentId={null} onFork={vi.fn()} onOpenLab={vi.fn()} />)
    expect(await screen.findByTestId('shared-missing')).toBeInTheDocument()
    expect(client.getExperiment).not.toHaveBeenCalled()
  })

  it('an unreachable server is an error, with nothing shown in its place', async () => {
    client.getExperiment.mockRejectedValue(new BackendUnavailableError('down'))
    renderShared()
    expect(await screen.findByText('The shared experiment could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByTestId('shared-title')).toBeNull()
    expect(screen.queryByTestId('readonly-circuit')).toBeNull()
  })
})

describe('Fork into my Lab', () => {
  it('hands over a COPY of the circuit and sends nothing to the server', async () => {
    const experiment = shared()
    client.getExperiment.mockResolvedValue(experiment)
    const { onFork } = renderShared()
    fireEvent.click(await screen.findByRole('button', { name: 'Fork into my Lab' }))
    expect(onFork).toHaveBeenCalledTimes(1)
    const [copy, title] = onFork.mock.calls[0]!
    expect(copy).toEqual(BELL)
    expect(copy).not.toBe(experiment.circuit)
    expect(copy.ops).not.toBe(experiment.circuit.ops)
    expect(title).toBe('Bell pair')
    // editing the copy cannot change what the page holds
    copy.ops.push(op('x', 0))
    expect(experiment.circuit.ops).toHaveLength(2)
    expect(client.createExperiment).not.toHaveBeenCalled()
    expect(client.reportLearnerEvent).not.toHaveBeenCalled()
  })

  it('in the app, forking puts the circuit in the Lab WITHOUT a result and says the shared page is unchanged', async () => {
    window.history.pushState(null, '', `/shared/${ID}`)
    client.getExperiment.mockResolvedValue(shared())
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fork into my Lab' }))
    const notice = await screen.findByTestId('shared-notice')
    expect(notice).toHaveTextContent('Forked “Bell pair” into your Lab as your own copy')
    expect(notice).toHaveTextContent('The shared page is unchanged')
    expect(window.location.pathname).toBe('/')
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['h', 'cx'])
    expect(useBuildStore.getState().result).toBeNull()
    // the learner's copy is theirs: editing it never touches the shared page
    useBuildStore.getState().loadCircuit({ ...BELL, ops: [...BELL.ops, op('x', 0)] })
    expect(client.getExperiment).toHaveBeenCalledTimes(1)
    expect(client.createExperiment).not.toHaveBeenCalled()
  })

  it('/shared/<id> opens the shared page, and a malformed id opens “not found” without a request', async () => {
    window.history.pushState(null, '', '/shared/not-a-share-id')
    render(<App />)
    expect(await screen.findByTestId('shared-missing')).toBeInTheDocument()
    expect(client.getExperiment).not.toHaveBeenCalled()
  })
})

describe('the circuit diagram', () => {
  it('describes the circuit in words for a screen reader and has no handlers', () => {
    render(<ReadOnlyCircuit circuit={BELL} />)
    const img = screen.getByRole('img')
    expect(img.getAttribute('aria-label')).toContain('A circuit on 2 qubits with 2 operations')
    expect(img.getAttribute('aria-label')).toContain('controlled-NOT, control q[0], target q[1]')
    expect(img.querySelectorAll('[onclick], button, a, input')).toHaveLength(0)
    expect(screen.getByText('q[0]')).toBeInTheDocument()
    expect(screen.getByText('q[1]')).toBeInTheDocument()
  })

  it('an empty circuit is said to be empty', () => {
    render(<ReadOnlyCircuit circuit={emptyCircuit(3, 0)} />)
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('An empty circuit on 3 qubits.')
  })
})

describe('sharing from the Lab', () => {
  function prepare(withRun: boolean) {
    useBuildStore.getState().loadCircuit(BELL)
    if (withRun) useBuildStore.setState({ result: toQuantumValue({ executionId: 'e', statevector: [[1, 0]] as Array<[number, number]> }, PROV) })
  }

  it('sends the circuit and the run’s id, never a number, and shows the page link', async () => {
    prepare(true)
    client.createExperiment.mockResolvedValue({ experimentId: ID, path: `/shared/${ID}`, createdAt: 'c' })
    render(<ExportPanel />)
    expect(screen.getByText('Includes this run’s stored result.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share as a read-only page' }))
    const link = await screen.findByLabelText('Read-only page link')
    expect(client.createExperiment).toHaveBeenCalledWith({ circuit: BELL, resultId: 'res_1', lessonId: null, challengeId: null, title: null })
    expect((link as HTMLInputElement).value).toBe(`${window.location.origin}/shared/${ID}`)
    expect(screen.getByRole('link', { name: 'Open page' })).toHaveAttribute('href', `/shared/${ID}`)
    expect(screen.getByRole('link', { name: 'Open page' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByTestId('share-page-result')).toHaveTextContent('carries no name, class or learner token')
    expect(JSON.stringify(client.createExperiment.mock.calls)).not.toMatch(/statevector|probabilit|counts|amplitude/)
  })

  it('without a run it shares the circuit alone and says so', async () => {
    prepare(false)
    client.createExperiment.mockResolvedValue({ experimentId: ID, path: `/shared/${ID}`, createdAt: 'c' })
    render(<ExportPanel />)
    expect(screen.getByText('No run yet: shares the circuit alone.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share as a read-only page' }))
    await screen.findByLabelText('Read-only page link')
    expect(client.createExperiment.mock.calls[0]![0].resultId).toBeNull()
  })

  it('an optional title is trimmed by the client and sent as text', async () => {
    prepare(false)
    client.createExperiment.mockResolvedValue({ experimentId: ID, path: `/shared/${ID}`, createdAt: 'c' })
    render(<ExportPanel />)
    fireEvent.change(screen.getByLabelText(/Title \(plain text/), { target: { value: 'My Bell pair' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share as a read-only page' }))
    await screen.findByLabelText('Read-only page link')
    expect(client.createExperiment.mock.calls[0]![0].title).toBe('My Bell pair')
  })

  it('a run that no longer belongs to the circuit is refused, with a clean way forward: share without it', async () => {
    prepare(true)
    client.createExperiment.mockRejectedValueOnce(new ClassroomRejectedError('SHARE_INVALID', 'that run is not a run of this circuit', 422))
    client.createExperiment.mockResolvedValueOnce({ experimentId: ID, path: `/shared/${ID}`, createdAt: 'c' })
    render(<ExportPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Share as a read-only page' }))
    const alert = await screen.findByTestId('share-page-error')
    expect(alert).toHaveTextContent('that run is not a run of this circuit')
    expect(screen.queryByLabelText('Read-only page link')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Share the circuit without a run' }))
    await screen.findByLabelText('Read-only page link')
    expect(client.createExperiment.mock.calls[1]![0].resultId).toBeNull()
  })

  it('an unreachable server says so and shares nothing', async () => {
    prepare(false)
    client.createExperiment.mockRejectedValue(new BackendUnavailableError('could not reach the Qentor backend'))
    render(<ExportPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Share as a read-only page' }))
    expect(await screen.findByTestId('share-page-error')).toHaveTextContent('could not reach the Qentor backend')
    expect(screen.queryByLabelText('Read-only page link')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Share the circuit without a run' })).toBeNull()
  })

  it('an empty circuit cannot be shared', () => {
    useBuildStore.getState().loadCircuit(emptyCircuit(2, 0))
    render(<ExportPanel />)
    expect(screen.getByRole('button', { name: 'Share as a read-only page' })).toBeDisabled()
  })

  it('a second share replaces the first link rather than stacking them', async () => {
    prepare(false)
    client.createExperiment.mockResolvedValueOnce({ experimentId: ID, path: `/shared/${ID}`, createdAt: 'c' })
    client.createExperiment.mockResolvedValueOnce({ experimentId: 'ex_fedcba9876543210', path: '/shared/ex_fedcba9876543210', createdAt: 'c' })
    render(<ExportPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Share as a read-only page' }))
    await screen.findByLabelText('Read-only page link')
    fireEvent.click(screen.getByRole('button', { name: 'Share as a read-only page' }))
    await waitFor(() => expect((screen.getByLabelText('Read-only page link') as HTMLInputElement).value).toContain('ex_fedcba9876543210'))
    expect(screen.getAllByLabelText('Read-only page link')).toHaveLength(1)
  })
})
