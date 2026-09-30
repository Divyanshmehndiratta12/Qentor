/**
 * The Lab's new controls with the REAL store and a mocked API client: the backend selector really sends its choice (Run,
 * Trace, Optimize), the agreement and equivalence panels render only what the server said and drop answers to a question that
 * is no longer the one on screen, and the code pane is read-only text that never runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgreementResult, EquivalenceResult, ExecutePayload } from '@/api'
import { BackendUnavailableError } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { hzh } from '@/test/traceFixtures'
import codePaneSource from './CodePane.tsx?raw'
import agreementSource from './AgreementPanel.tsx?raw'
import equivalenceSource from './EquivalencePanel.tsx?raw'

const client = {
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  listLessons: vi.fn(),
  traceCircuit: vi.fn(),
  generateCode: vi.fn(),
  checkEquivalence: vi.fn(),
  compareBackends: vi.fn(),
}

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { useBuildStore } from './store'
import { ResultsPanel } from './ResultsPanel'
import { AgreementPanel } from './AgreementPanel'
import { EquivalencePanel } from './EquivalencePanel'
import { CodePane } from './CodePane'

const INITIAL = useBuildStore.getState()
const store = () => useBuildStore.getState()

const BELL: Circuit = {
  ...emptyCircuit(2, 0),
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
  ],
}
const H_ONLY: Circuit = { ...BELL, ops: [BELL.ops[0]] }

const PROVENANCE = (backend: string, id = 'res_1', mode = 'statevector'): Provenance => ({
  resultId: id,
  circuitHash: 'hash',
  backend,
  backendVersion: '1.0',
  executionMode: mode,
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
})

const executed = (backend: string) => toQuantumValue<ExecutePayload>({ executionId: 'e', statevector: [[1, 0], [0, 0]] }, PROVENANCE(backend))

const AGREE: AgreementResult = {
  method: 'qentor.agreement/1',
  threshold: 1e-6,
  status: 'AGREE',
  circuitHash: 'h',
  terminalMeasurementsStripped: 0,
  backends: [
    { backend: 'qiskit-aer', status: 'RAN', message: null, provenance: PROVENANCE('qiskit-aer', 'res_a') },
    { backend: 'cirq', status: 'RAN', message: null, provenance: PROVENANCE('cirq', 'res_c') },
    { backend: 'pennylane', status: 'UNAVAILABLE', message: 'pennylane is unavailable in this environment: x', provenance: null },
  ],
  pairs: [{ backendA: 'qiskit-aer', backendB: 'cirq', maxAmplitudeDifference: 1.2e-16, maxProbabilityDifference: 2.2e-16, fidelity: 1, agrees: true }],
  provenance: PROVENANCE('cross-backend-agreement', 'res_cmp', 'agreement'),
}

const EQUIVALENT: EquivalenceResult = {
  status: 'EQUIVALENT',
  method: 'qiskit.quantum_info.Operator.equiv',
  checkerVersion: '2.5.2',
  circuitHashA: 'a',
  circuitHashB: 'b',
  globalPhase: 0.5,
  checks: [{ name: 'operator_equivalent_up_to_global_phase', status: 'PASS', detail: 'U_b = e^(i*phi) * U_a' }],
  reason: null,
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset()
  act(() => {
    useBuildStore.setState(INITIAL, true)
    store().loadCircuit(BELL)
  })
})
afterEach(() => {
  cleanup()
  act(() => useBuildStore.setState(INITIAL, true))
})

describe('the backend selector', () => {
  it('lists the three backends, defaults to Qiskit Aer, and is a labelled control', () => {
    render(<ResultsPanel />)
    const select = screen.getByRole('combobox', { name: 'Execution backend' }) as HTMLSelectElement
    expect(select.value).toBe('qiskit-aer')
    expect([...select.options].map((o) => o.textContent)).toEqual(['Qiskit Aer', 'Cirq', 'PennyLane'])
  })

  it('Run sends the chosen backend to the server', async () => {
    client.executeCircuit.mockResolvedValue(executed('cirq'))
    render(<ResultsPanel />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Execution backend' }), { target: { value: 'cirq' } })
    await act(() => store().runExecution())
    expect(client.executeCircuit).toHaveBeenCalledTimes(1)
    expect(client.executeCircuit.mock.calls[0]).toEqual([BELL, 'statevector', undefined, 'cirq'])
  })

  it('Trace sends the chosen backend', async () => {
    client.traceCircuit.mockResolvedValue(hzh())
    act(() => store().setBackend('pennylane'))
    await act(() => store().runTrace())
    expect(client.traceCircuit.mock.calls[0]).toEqual([BELL, 'pennylane'])
  })

  it('Optimize sends the chosen backend', async () => {
    client.optimizeCircuit.mockResolvedValue({ status: 'NO_OPTIMIZATION_FOUND' })
    act(() => store().setBackend('cirq'))
    await act(() => store().runOptimization())
    expect(client.optimizeCircuit.mock.calls[0]).toEqual([BELL, 'cirq'])
  })

  it('the result shown is labelled with the backend that ran it (from the response, not the selector)', async () => {
    client.executeCircuit.mockResolvedValue(executed('pennylane'))
    render(<ResultsPanel />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Execution backend' }), { target: { value: 'pennylane' } })
    await act(() => store().runExecution())
    expect(screen.getAllByText(/pennylane/).length).toBeGreaterThan(0)
  })

  it('changing the backend clears what the old one produced, and nothing else', () => {
    const trace = hzh()
    act(() => {
      useBuildStore.setState({ result: executed('qiskit-aer'), trace, selectedTraceStep: 2, verification: { verificationStatus: 'VERIFIED' } as never })
    })
    const circuit = store().circuit
    act(() => store().setBackend('cirq'))
    expect(store().result).toBeNull()
    expect(store().trace).toBeNull()
    expect(store().selectedTraceStep).toBe(0)
    expect(store().verification).toBeNull()
    expect(store().circuit).toBe(circuit) // the circuit is the learner's, untouched
    expect(store().backend).toBe('cirq')
  })

  it('choosing the backend already selected changes nothing (no churn, results kept)', () => {
    const result = executed('qiskit-aer')
    act(() => useBuildStore.setState({ result }))
    act(() => store().setBackend('qiskit-aer'))
    expect(store().result).toBe(result)
  })

  it('an answer from the previous backend that arrives late is dropped, not shown as the new backend’s', async () => {
    const slow = deferred<ReturnType<typeof executed>>()
    client.executeCircuit.mockReturnValueOnce(slow.promise)
    const running = store().runExecution()
    act(() => store().setBackend('cirq'))
    slow.resolve(executed('qiskit-aer'))
    await act(() => running)
    expect(store().result).toBeNull()
    expect(store().isExecuting).toBe(false)
  })

  it('a late trace from the previous backend is dropped too', async () => {
    const slow = deferred<ReturnType<typeof hzh>>()
    client.traceCircuit.mockReturnValueOnce(slow.promise)
    const tracing = store().runTrace()
    act(() => store().setBackend('cirq'))
    slow.resolve(hzh())
    await act(() => tracing)
    expect(store().trace).toBeNull()
  })

  it('the verify panel says whose result it checks and that there is nothing to choose', () => {
    act(() => useBuildStore.setState({ result: executed('cirq') }))
    render(<ResultsPanel />)
    expect(screen.getByTestId('verify-source').textContent).toContain('from cirq 1.0')
    expect(screen.getByTestId('verify-source').textContent).toContain('no backend to choose')
  })
})

describe('the cross-backend check', () => {
  it('asks the server, and shows its verdict, each backend’s status, and every number with provenance', async () => {
    client.compareBackends.mockResolvedValue(AGREE)
    render(<AgreementPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare backends' }))
    const report = await screen.findByTestId('agreement-report')
    expect(client.compareBackends.mock.calls[0]).toEqual([BELL])
    expect(within(report).getByText('2 backends agree (within 1e-6)')).toBeInTheDocument()
    expect(within(report).getByText('unavailable')).toBeInTheDocument()
    expect(within(report).getByText(/pennylane is unavailable in this environment/)).toBeInTheDocument()
    const cells = within(report).getAllByTitle(/SIMULATION · cross-backend-agreement · res_cmp/)
    expect(cells.map((c) => c.textContent)).toEqual(['2.20e-16', '1.000000000', '1.20e-16'])
  })

  it('says Backends disagree, and Incomplete, in the server’s words', async () => {
    client.compareBackends.mockResolvedValueOnce({ ...AGREE, status: 'DISAGREE', pairs: [{ ...AGREE.pairs[0], agrees: false, fidelity: 0.5 }] })
    render(<AgreementPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare backends' }))
    expect(await screen.findByText('Backends disagree')).toBeInTheDocument()
    expect(screen.getByText('differ')).toBeInTheDocument()
    client.compareBackends.mockResolvedValueOnce({ ...AGREE, status: 'INCOMPLETE', pairs: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Compare backends' }))
    expect(await screen.findByText(/Incomplete: fewer than two backends/)).toBeInTheDocument()
  })

  it('shows the threshold the SERVER used, not one of its own', async () => {
    client.compareBackends.mockResolvedValue({ ...AGREE, threshold: 1e-9 })
    render(<AgreementPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare backends' }))
    expect(await screen.findByText('2 backends agree (within 1e-9)')).toBeInTheDocument()
  })

  it('mentions removed final measurements and does not overclaim what agreement means', async () => {
    client.compareBackends.mockResolvedValue({ ...AGREE, terminalMeasurementsStripped: 2 })
    render(<AgreementPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare backends' }))
    const report = await screen.findByTestId('agreement-report')
    expect(report.textContent).toContain('2 final measurements were left out')
    expect(report.textContent).toContain('not that the circuit is correct')
  })

  it('a report for a circuit that has since changed is not shown as current', async () => {
    client.compareBackends.mockResolvedValue(AGREE)
    render(<AgreementPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare backends' }))
    await screen.findByTestId('agreement-report')
    act(() => store().loadCircuit(H_ONLY))
    expect(screen.queryByTestId('agreement-report')).toBeNull()
    expect(screen.getByText('The circuit changed since the last comparison. Compare again.')).toBeInTheDocument()
  })

  it('an answer that arrives after the circuit changed is dropped', async () => {
    const slow = deferred<AgreementResult>()
    client.compareBackends.mockReturnValueOnce(slow.promise)
    const running = store().runAgreement()
    act(() => store().loadCircuit(H_ONLY))
    slow.resolve(AGREE)
    await act(() => running)
    expect(store().agreement).toBeNull()
    expect(store().isComparingBackends).toBe(false) // a dropped answer must not leave the flag stuck on
  })

  it('an error is shown as an error with a retry, and no substitute report', async () => {
    client.compareBackends.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend: down'))
    render(<AgreementPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare backends' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not reach the Qentor backend: down')
    expect(screen.queryByTestId('agreement-report')).toBeNull()
    client.compareBackends.mockResolvedValueOnce(AGREE)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('agreement-report')).toBeInTheDocument()
  })

  it('needs a circuit with operations', () => {
    act(() => store().loadCircuit(emptyCircuit(2)))
    render(<AgreementPanel />)
    expect(screen.getByRole('button', { name: 'Compare backends' })).toBeDisabled()
    expect(screen.getByText('Add gates to compare the simulators.')).toBeInTheDocument()
  })

  it('the panel holds no comparison arithmetic (a static scan of its source)', () => {
    const code = agreementSource.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/Math\.|\*\*|Math\.abs|reduce\(|\.toFixed\([^)]*\)\s*[-+*/]/)
    expect(code).not.toMatch(/agrees\s*[:=]\s*[^p]/) // `agrees` is only ever read from the server's pair
  })
})

describe('the equivalence check', () => {
  it('pins a snapshot, and asks the server about (reference, current)', async () => {
    client.checkEquivalence.mockResolvedValue(EQUIVALENT)
    render(<EquivalencePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Pin this circuit' }))
    act(() => store().loadCircuit(H_ONLY)) // now a different circuit is on screen
    // (loadCircuit is what opening a lesson does; pinning again is the learner's choice)
    act(() => useBuildStore.setState({ referenceCircuit: BELL }))
    fireEvent.click(screen.getByRole('button', { name: 'Check equivalence' }))
    const report = await screen.findByTestId('equivalence-report')
    expect(client.checkEquivalence.mock.calls[0]).toEqual([BELL, H_ONLY])
    expect(within(report).getByText('Equivalent')).toBeInTheDocument()
    expect(report.textContent).toContain('qiskit 2.5.2')
    expect(report.textContent).toContain('global phase (rad, from the checker): 0.500000')
    expect(report.textContent).toContain('does not say either circuit is the one you want')
  })

  it('shows Not equivalent and Unverifiable with the server’s reason', async () => {
    act(() => useBuildStore.setState({ referenceCircuit: BELL }))
    client.checkEquivalence.mockResolvedValueOnce({ ...EQUIVALENT, status: 'NOT_EQUIVALENT', globalPhase: null, reason: 'operators differ by more than a global phase' })
    render(<EquivalencePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Check equivalence' }))
    expect(await screen.findByText('Not equivalent')).toBeInTheDocument()
    expect(screen.getByText('operators differ by more than a global phase')).toBeInTheDocument()
    expect(screen.queryByText(/global phase \(rad/)).toBeNull()
    client.checkEquivalence.mockResolvedValueOnce({ ...EQUIVALENT, status: 'UNVERIFIABLE', globalPhase: null, reason: 'circuits act on a different number of qubits' })
    fireEvent.click(screen.getByRole('button', { name: 'Check equivalence' }))
    expect(await screen.findByText('Unverifiable')).toBeInTheDocument()
  })

  it('a verdict goes stale when either circuit changes', async () => {
    act(() => useBuildStore.setState({ referenceCircuit: BELL }))
    client.checkEquivalence.mockResolvedValue(EQUIVALENT)
    render(<EquivalencePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Check equivalence' }))
    await screen.findByTestId('equivalence-report')
    act(() => store().pinReference()) // pinning again clears the verdict
    expect(screen.queryByTestId('equivalence-report')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check equivalence' }))
    await screen.findByTestId('equivalence-report')
    act(() => store().loadCircuit(H_ONLY))
    expect(screen.queryByTestId('equivalence-report')).toBeNull()
    expect(screen.getByText('A circuit changed since the last check. Check again.')).toBeInTheDocument()
  })

  it('an answer for a pair that has changed is dropped', async () => {
    act(() => useBuildStore.setState({ referenceCircuit: BELL }))
    const slow = deferred<EquivalenceResult>()
    client.checkEquivalence.mockReturnValueOnce(slow.promise)
    const checking = store().runEquivalence()
    act(() => store().clearReference())
    slow.resolve(EQUIVALENT)
    await act(() => checking)
    expect(store().equivalence).toBeNull()
    expect(store().isCheckingEquivalence).toBe(false)
  })

  it('needs a pinned reference', async () => {
    await act(() => store().runEquivalence())
    expect(client.checkEquivalence).not.toHaveBeenCalled()
    render(<EquivalencePanel />)
    expect(screen.queryByRole('button', { name: 'Check equivalence' })).toBeNull()
  })

  it('shows an error with no verdict when the server refuses', async () => {
    act(() => useBuildStore.setState({ referenceCircuit: BELL }))
    client.checkEquivalence.mockRejectedValueOnce(new BackendUnavailableError('an equivalence check on 11 qubits needs a 2**11 x 2**11 operator', 422))
    render(<EquivalencePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Check equivalence' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('needs a 2**11')
    expect(screen.queryByTestId('equivalence-report')).toBeNull()
  })

  it('the panel decides nothing (a static scan)', () => {
    const code = equivalenceSource.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/===\s*'EQUIVALENT'\s*\?|circuitHash\w*\s*===/) // it never compares circuits or hashes itself
  })
})

describe('the code pane', () => {
  const CODE = {
    circuitHash: 'h',
    generator: 'qentor.codegen/1',
    code: { qiskit: 'from qiskit import QuantumCircuit\nqc = QuantumCircuit(2)', cirq: 'import cirq\ncircuit = cirq.Circuit()', pennylane: 'import pennylane as qml\n@qml.qnode(dev)' },
  }

  it('is a tablist of four tabs, OpenQASM first and selected', () => {
    render(<CodePane />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['OpenQASM 3', 'Qiskit', 'Cirq', 'PennyLane'])
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false'])
    expect(tabs[0].getAttribute('tabindex')).toBe('0')
    expect(tabs[1].getAttribute('tabindex')).toBe('-1')
  })

  it('arrow keys, Home and End move between tabs and focus follows', () => {
    render(<CodePane />)
    const tabs = screen.getAllByRole('tab')
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1])
    fireEvent.keyDown(tabs[1], { key: 'End' })
    expect(tabs[3].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs[3], { key: 'ArrowRight' })
    expect(tabs[0].getAttribute('aria-selected')).toBe('true') // wraps
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
    expect(tabs[3].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs[3], { key: 'Home' })
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  })

  it('does not call the server until a code tab is opened (OpenQASM is the local, editable form)', () => {
    render(<CodePane />)
    expect(client.generateCode).not.toHaveBeenCalled()
  })

  it('opening a code tab asks the server for the circuit and shows the returned text, read-only', async () => {
    client.generateCode.mockResolvedValue(CODE)
    render(<CodePane />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cirq' }))
    const pre = await screen.findByLabelText('cirq code for this circuit')
    expect(client.generateCode.mock.calls[0]).toEqual([BELL])
    expect(pre.textContent).toBe(CODE.code.cirq)
    expect(pre.tagName).toBe('PRE')
    expect(screen.getByText(/read-only · written by the server · never run/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'PennyLane' }))
    expect((await screen.findByLabelText('pennylane code for this circuit')).textContent).toBe(CODE.code.pennylane)
    await new Promise((resolve) => setTimeout(resolve, 400)) // longer than the pane's debounce: no late second request
    expect(client.generateCode).toHaveBeenCalledTimes(1) // one request serves all three tabs for one circuit
  })

  it('keeps the OpenQASM editor mounted, with its text, while another tab shows', async () => {
    client.generateCode.mockResolvedValue(CODE)
    const { container } = render(<CodePane />)
    const editorBefore = container.querySelector('.cm-content')
    expect(editorBefore).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Qiskit' }))
    await screen.findByLabelText('qiskit code for this circuit')
    expect(container.querySelector('.cm-content')).toBe(editorBefore)
    expect(container.querySelector('#code-panel-qasm')!.hasAttribute('hidden')).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'OpenQASM 3' }))
    expect(container.querySelector('#code-panel-qasm')!.hasAttribute('hidden')).toBe(false)
  })

  it('shows Generating while loading, and asks again for another circuit without showing the old code as current', async () => {
    client.generateCode.mockResolvedValueOnce(CODE)
    render(<CodePane />)
    fireEvent.click(screen.getByRole('tab', { name: 'Qiskit' }))
    expect(screen.getByRole('status')).toHaveTextContent('Generating qiskit code…')
    await screen.findByLabelText('qiskit code for this circuit')
    client.generateCode.mockResolvedValueOnce({ ...CODE, code: { ...CODE.code, qiskit: 'qc = QuantumCircuit(1)' } })
    act(() => store().loadCircuit(H_ONLY))
    expect(screen.queryByLabelText('qiskit code for this circuit')).toBeNull() // the old code is not shown for the new circuit
    expect((await screen.findByLabelText('qiskit code for this circuit')).textContent).toBe('qc = QuantumCircuit(1)')
    expect(client.generateCode.mock.calls[1]).toEqual([H_ONLY])
  })

  it('an error is shown with a retry, not substitute code', async () => {
    client.generateCode.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend: down'))
    render(<CodePane />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cirq' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Code view unavailable')
    expect(screen.queryByLabelText('cirq code for this circuit')).toBeNull()
    client.generateCode.mockResolvedValueOnce(CODE)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('cirq code for this circuit')).toBeInTheDocument()
  })

  it('copies the text it shows', async () => {
    client.generateCode.mockResolvedValue(CODE)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<CodePane />)
    fireEvent.click(screen.getByRole('tab', { name: 'Qiskit' }))
    await screen.findByLabelText('qiskit code for this circuit')
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE.code.qiskit))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('says so when copying is not available instead of pretending', async () => {
    client.generateCode.mockResolvedValue(CODE)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true })
    render(<CodePane />)
    fireEvent.click(screen.getByRole('tab', { name: 'Qiskit' }))
    await screen.findByLabelText('qiskit code for this circuit')
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copy unavailable' })).toBeInTheDocument()
  })

  it('the pane can only DISPLAY code: no evaluator, no script tag, no dynamic import (a static scan)', () => {
    const code = codePaneSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\beval\s*\(|new Function|Function\s*\(|import\s*\(|<script|dangerouslySetInnerHTML|innerHTML|\.exec\(|Worker/)
  })
})
