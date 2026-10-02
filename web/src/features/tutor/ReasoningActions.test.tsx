/**
 * The Tutor's reasoning actions: shown only when their context exists, asking the server with structured requests, showing the
 * counterfactual BEFORE it runs, and rendering exactly what the server returned (every number through VerifiedValueInline).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { BackendUnavailableError } from '@/api'
import type { ExecutePayload, ReasoningResult, WhatIfPreview } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { H0, CX01, hzh, op } from '@/test/traceFixtures'

const client = vi.hoisted(() => ({
  analyzeReasoning: vi.fn(),
  previewWhatIf: vi.fn(),
  askTutor: vi.fn(),
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  listLessons: vi.fn(),
  debugCircuit: vi.fn(),
  getGenerationStatus: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { useBuildStore } from '@/features/build/store'
import { TutorPanel } from './TutorPanel'

const INITIAL = useBuildStore.getState()
// The Lab has finished with the circuit (here: failed to run it, which is all these tests need): the analysis actions wait for that.
const SETTLED = { isExecuting: false, executionError: 'the Lab has no result in this test' }
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const RUN: Provenance = {
  resultId: 'res_run',
  circuitHash: HASH_A,
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
}
const ANALYSIS: Provenance = { ...RUN, resultId: 'res_analysis', backend: 'reasoning-engine', backendVersion: 'qentor.reasoning/1', executionMode: 'analysis' }

const BELL: Circuit = { ...emptyCircuit(2, 0), ops: [H0, CX01] }
const ONE_H: Circuit = { ...emptyCircuit(1, 0), ops: [H0] }

function setRun(circuit: Circuit, mode: 'statevector' | 'shots' = 'statevector') {
  const payload: ExecutePayload = { executionId: 'aer-local-1', theoreticalProbabilities: { '0': 0.5, '1': 0.5 }, statevector: [[0.7071, 0], [0.7071, 0]] } as unknown as ExecutePayload
  useBuildStore.setState({ ...SETTLED, circuit, result: toQuantumValue(payload, { ...RUN, executionMode: mode }), isExecuting: false, executionError: null })
}

const common = (intent: ReasoningResult['intent'], over: Partial<ReasoningResult> = {}) => ({
  analysisId: 'res_analysis',
  intent,
  status: 'OK',
  reason: null,
  method: 'qentor.reasoning/1',
  circuitHash: HASH_A,
  sources: [{ role: 'theoretical', resultId: 'res_run', executionId: 'e1', circuitHash: HASH_A, backend: 'qiskit-aer', backendVersion: '0.17.2', executionMode: 'statevector', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED' }],
  provenance: ANALYSIS,
  facts: [{ id: 'R2', kind: 'probability', description: 'outcome 1: theoretical probability 0.500000', resultId: 'res_analysis' }],
  answer: 'From the backend’s own run: outcome 1: theoretical probability 0.500000 (R2).',
  usedFallbackTemplate: true,
  ...over,
})
const q = (v: number) => toQuantumValue(v, ANALYSIS)

const PROBABILITY_RESULT = {
  ...common('PROBABILITY'),
  numQubits: 1,
  bitOrder: 'outcomes are written q[0]…q[0]',
  rows: [{ label: 'outcome 1', outcome: '1', qubit: null, value: null, theoretical: q(0.5), sampled: null, sampledCount: null, shots: null, difference: null }],
  notes: [],
} as unknown as ReasoningResult

const NO_IMPROVEMENT = {
  ...common('OPTIMIZE', { status: 'NO_IMPROVEMENT', reason: 'no rewrite rule matched this circuit, so there is no shorter circuit to offer', answer: 'Optimization result: no safe improvement (R3).' }),
  optimizationStatus: 'NO_OPTIMIZATION_FOUND',
  originalCircuitHash: HASH_A,
  originalOpCount: 2,
  candidateCircuit: null,
  candidateCircuitHash: null,
  candidateOpCount: null,
  operationsRemoved: 0,
  rewrites: [],
  changes: [],
  equivalence: null,
  verifier: 'qentor.verification.optimizer/1',
  candidateResultId: null,
} as unknown as ReasoningResult

const SHORTER: Circuit = { ...emptyCircuit(1, 0), ops: [op('x', { targets: [0] })] }
const SHORTER_RESULT = {
  ...common('OPTIMIZE', { answer: 'Optimization result: 3 operations before, 1 after (R3).' }),
  optimizationStatus: 'VERIFIED_SHORTER',
  originalCircuitHash: HASH_A,
  originalOpCount: 3,
  candidateCircuit: SHORTER,
  candidateCircuitHash: HASH_B,
  candidateOpCount: 1,
  operationsRemoved: 2,
  rewrites: [{ rule: 'cancelled adjacent h pair on qubit(s) [0]', explanation: 'H twice changes nothing.' }],
  changes: [{ kind: 'removed', originalIndex: 0, candidateIndex: null, description: 'h on q[0]' }],
  equivalence: { status: 'EQUIVALENT', method: 'qiskit.quantum_info.Operator.equiv', reason: null },
  verifier: 'qentor.verification.optimizer/1',
  candidateResultId: 'res_cand',
} as unknown as ReasoningResult

const PREVIEW: WhatIfPreview = {
  description: 'remove operation 1 (cx control q[0], target q[1])',
  originalCircuitHash: HASH_A,
  counterfactualCircuit: { ...emptyCircuit(2, 0), ops: [H0] },
  counterfactualCircuitHash: HASH_B,
  counterfactualQasm: 'OPENQASM 3.0;\nqubit[2] q;\nh q[0];',
  originalOpCount: 2,
  counterfactualOpCount: 1,
  changes: [
    { kind: 'kept', originalIndex: 0, candidateIndex: 0, description: 'h on q[0]' },
    { kind: 'removed', originalIndex: 1, candidateIndex: null, description: 'cx control q[0], target q[1]' },
  ],
}
const WHAT_IF_RESULT = {
  ...common('WHAT_IF', { answer: 'If that one change were made: what-if change: remove operation 1 (R4).' }),
  description: PREVIEW.description,
  originalCircuitHash: HASH_A,
  counterfactualCircuitHash: HASH_B,
  counterfactualQasm: PREVIEW.counterfactualQasm,
  originalOpCount: 2,
  counterfactualOpCount: 1,
  changes: PREVIEW.changes,
  comparison: {
    circuit: { sameCircuit: false, numQubitsA: 2, numQubitsB: 2, numOpsA: 2, numOpsB: 1, changes: [], equivalenceStatus: 'NOT_EQUIVALENT', equivalenceReason: null },
    measurement: {
      comparable: true,
      reason: null,
      kindA: 'theoretical_probability',
      kindB: 'theoretical_probability',
      rows: [
        { outcome: '00', a: q(0.5), b: q(0.5), difference: q(0) },
        { outcome: '11', a: q(0.5), b: null, difference: null },
      ],
      totalVariationDistance: q(0.5),
      maxDifference: q(0.5),
      note: null,
    },
    state: { comparable: true, reason: null, fidelity: q(0.5), maxProbabilityDifference: q(0.5), maxAmplitudeDifference: q(0.7), note: null },
  },
  comparedValues: 'theoretical probabilities of the circuits without their terminal measurements',
} as unknown as ReasoningResult

const bloch = (z: number) => toQuantumValue({ x: 0, y: 0, z }, ANALYSIS)
const TRACE_RESULT = {
  ...common('TRACE_CHANGE', { answer: 'What this step changed: trace step 3 of 3 (R4).' }),
  stepIndex: 2,
  stepNumber: 3,
  totalSteps: 3,
  numQubits: 2,
  bitOrder: 'outcomes are written q[1]…q[0]',
  operation: { index: 1, gate: 'cx', description: 'cx control q[0], target q[1]' },
  changeKind: 'probabilities_changed',
  changeSummary: 'Outcome probabilities changed on 2 basis states.',
  probabilityChanges: [{ outcome: '11', before: q(0), after: q(0.5), difference: q(0.5) }],
  beforeQubits: [{ qubit: 0, status: 'OK', reason: null, bloch: bloch(1), purity: q(1), entangledWithRest: false }],
  afterQubits: [{ qubit: 0, status: 'OK', reason: null, bloch: bloch(0), purity: q(0.5), entangledWithRest: true }],
} as unknown as ReasoningResult

function reset() {
  cleanup()
  useBuildStore.setState(INITIAL, true)
  for (const fn of Object.values(client)) fn.mockReset()
}

function loadTrace() {
  const trace = hzh('t') // a 1-qubit trace with three steps; only its identity is used here
  useBuildStore.setState({ ...SETTLED, circuit: ONE_H, trace, selectedTraceStep: 1 })
}

describe('reasoning actions are contextual', () => {
  beforeEach(reset)
  afterEach(reset)

  it('while the Lab has not yet run a changed circuit the actions wait, and say so, instead of asking into the gap before the run starts', () => {
    useBuildStore.setState({ circuit: ONE_H, result: null, isExecuting: false, executionError: null })
    render(<TutorPanel />)
    expect(screen.getByTestId('reasoning-waiting')).toHaveTextContent(/waiting for the lab to run this circuit/i)
    for (const name of [/optimize circuit/i, /what if/i, /analyze probability/i]) expect(screen.queryByRole('button', { name })).toBeNull()
    act(() => useBuildStore.setState({ isExecuting: true })) // the run has started: its start already cleared the conversation
    expect(screen.queryByTestId('reasoning-waiting')).toBeNull()
    expect(screen.getByRole('button', { name: /optimize circuit/i })).toBeInTheDocument()
  })

  it('a Lab run that failed does not keep the actions waiting: the circuit can still be analysed', () => {
    useBuildStore.setState({ circuit: ONE_H, result: null, isExecuting: false, executionError: 'the backend is unavailable' })
    render(<TutorPanel />)
    expect(screen.queryByTestId('reasoning-waiting')).toBeNull()
    expect(screen.getByRole('button', { name: /optimize circuit/i })).toBeInTheDocument()
  })

  it('shows nothing when there is no circuit, no result and no trace step', () => {
    render(<TutorPanel />)
    expect(screen.queryByTestId('reasoning-actions')).toBeNull()
    for (const name of [/analyze probability/i, /optimize circuit/i, /what if/i, /explain change/i]) expect(screen.queryByRole('button', { name })).toBeNull()
  })

  it('a circuit alone offers Optimize and What if…, not a probability or a step', () => {
    useBuildStore.setState({ ...SETTLED, circuit: ONE_H })
    render(<TutorPanel />)
    expect(screen.getByRole('button', { name: /optimize circuit/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /what if/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /analyze probability/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /explain change/i })).toBeNull()
  })

  it('a Lab result adds Analyze probability', () => {
    setRun(ONE_H)
    render(<TutorPanel />)
    expect(screen.getByRole('button', { name: /analyze probability/i })).toBeInTheDocument()
  })

  it('a selected trace step adds Explain change', () => {
    loadTrace()
    render(<TutorPanel />)
    expect(screen.getByRole('button', { name: /explain change/i })).toBeInTheDocument()
  })

  it('a lesson conversation never shows the Lab’s actions', () => {
    setRun(ONE_H)
    render(<TutorPanel context={{ kind: 'lesson', lessonId: 'phase', sectionId: null }} />)
    expect(screen.queryByTestId('reasoning-actions')).toBeNull()
  })

  it('the actions say who computes the answer', () => {
    useBuildStore.setState({ ...SETTLED, circuit: ONE_H })
    render(<TutorPanel />)
    expect(screen.getByTestId('reasoning-actions')).toHaveTextContent(/server computes each answer/i)
  })
})

describe('Analyze probability', () => {
  beforeEach(reset)
  afterEach(reset)

  it('asks with a typed target and the result id — and shows the server’s number with its provenance', async () => {
    setRun(ONE_H)
    client.analyzeReasoning.mockResolvedValue(PROBABILITY_RESULT)
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /analyze probability/i }))
    fireEvent.click(screen.getByRole('button', { name: /^analyze$/i }))
    await waitFor(() => expect(client.analyzeReasoning).toHaveBeenCalledTimes(1))
    const request = client.analyzeReasoning.mock.calls[0]![0]
    expect(request).toMatchObject({ intent: 'PROBABILITY', circuit: ONE_H, resultId: 'res_run', target: { kind: 'most_likely' }, language: 'en' })
    expect(Object.keys(request).sort()).toEqual(['backend', 'circuit', 'intent', 'language', 'resultId', 'target'])
    const card = await screen.findByTestId('reasoning-card')
    expect(within(card).getByText('0.500000')).toBeInTheDocument()
    expect(within(card).getByRole('region', { name: /probabilities from the backend/i })).toBeInTheDocument()
    expect(card).toHaveTextContent('q[0]…q[0]') // the bit order is stated beside the table
    expect(card).toHaveTextContent('analysis res_analysis')
    expect(card).toHaveTextContent('reasoning-engine')
    expect(screen.getByText('Analyze probability: the most likely outcome')).toBeInTheDocument() // the learner's side, in words only
  })

  it('an outcome needs exactly the circuit’s width before it can be sent', async () => {
    setRun(BELL)
    client.analyzeReasoning.mockResolvedValue(PROBABILITY_RESULT)
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /analyze probability/i }))
    fireEvent.change(screen.getByLabelText(/what do you want to know/i), { target: { value: 'basis_state' } })
    const submit = screen.getByRole('button', { name: /^analyze$/i })
    const input = screen.getByLabelText(/outcome, 2 bits/i)
    expect(submit).toBeDisabled()
    fireEvent.change(input, { target: { value: '1' } })
    expect(submit).toBeDisabled()
    fireEvent.change(input, { target: { value: '1x1' } }) // anything but 0 and 1 is dropped
    expect(input).toHaveValue('11')
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(client.analyzeReasoning).toHaveBeenCalled())
    expect(client.analyzeReasoning.mock.calls[0]![0].target).toEqual({ kind: 'basis_state', bits: '11' })
  })

  it('a qubit question sends the qubit and the value', async () => {
    setRun(BELL)
    client.analyzeReasoning.mockResolvedValue(PROBABILITY_RESULT)
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /analyze probability/i }))
    fireEvent.change(screen.getByLabelText(/what do you want to know/i), { target: { value: 'qubit_value' } })
    fireEvent.change(screen.getByLabelText(/^qubit$/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^reads$/i), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: /^analyze$/i }))
    await waitFor(() => expect(client.analyzeReasoning).toHaveBeenCalled())
    expect(client.analyzeReasoning.mock.calls[0]![0].target).toEqual({ kind: 'qubit_value', qubit: 1, value: 0 })
  })

  it('sampled against theoretical is offered only for a shots run', () => {
    setRun(ONE_H, 'statevector')
    const view = render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /analyze probability/i }))
    expect(screen.queryByRole('option', { name: /sampled frequency against/i })).toBeNull()
    view.unmount()
    cleanup()
    setRun(ONE_H, 'shots')
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /analyze probability/i }))
    expect(screen.getByRole('option', { name: /sampled frequency against/i })).toBeInTheDocument()
  })

  it('there is no field for a probability the learner believes in', () => {
    setRun(ONE_H)
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /analyze probability/i }))
    for (const input of screen.queryAllByRole('textbox')) expect(input).not.toHaveAccessibleName(/probab|expected|result/i)
  })
})

describe('Optimize circuit', () => {
  beforeEach(reset)
  afterEach(reset)

  it('asks with the circuit only and shows an explicit no-improvement result', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    client.analyzeReasoning.mockResolvedValue(NO_IMPROVEMENT)
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /optimize circuit/i }))
    const card = await screen.findByTestId('reasoning-card')
    expect(client.analyzeReasoning.mock.calls[0]![0]).toEqual({ intent: 'OPTIMIZE', circuit: BELL, language: 'en', backend: 'qiskit-aer' })
    expect(card).toHaveAttribute('data-status', 'NO_IMPROVEMENT')
    expect(screen.getByTestId('reasoning-reason')).toHaveTextContent(/no rewrite rule matched/)
    expect(within(card).queryByRole('button', { name: /apply the shorter circuit/i })).toBeNull() // no candidate: nothing to apply
    expect(screen.getByText('Optimize this circuit')).toBeInTheDocument()
  })

  it('a verified shorter circuit shows the server’s counts, rewrites and checker verdict, and applying it is one undo step', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: { ...emptyCircuit(1, 0), ops: [H0, H0, op('x', { targets: [0] })] } })
    client.analyzeReasoning.mockResolvedValue(SHORTER_RESULT)
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /optimize circuit/i }))
    const view = await screen.findByTestId('optimization-view')
    expect(view).toHaveTextContent('3 operations before, 1 after (2 removed)')
    expect(view).toHaveTextContent('cancelled adjacent h pair')
    expect(view).toHaveTextContent('− removed · h on q[0]')
    expect(screen.getByTestId('optimization-equivalence')).toHaveTextContent(/decided by the backend.s checker.*EQUIVALENT.*tutor did not decide/)
    const before = useBuildStore.getState().circuit
    fireEvent.click(screen.getByRole('button', { name: /apply the shorter circuit/i }))
    expect(useBuildStore.getState().circuit).toEqual(SHORTER)
    expect(useBuildStore.getState().past.at(-1)).toEqual(before)
    // applying changes the circuit, so the conversation about the old one is gone
    expect(screen.queryByTestId('reasoning-card')).toBeNull()
  })

  it('does not appear for an empty circuit', () => {
    render(<TutorPanel />)
    expect(screen.queryByRole('button', { name: /optimize circuit/i })).toBeNull()
  })

  it('an answer that arrives after the circuit changed is dropped', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    let resolve!: (r: ReasoningResult) => void
    client.analyzeReasoning.mockReturnValue(new Promise<ReasoningResult>((r) => (resolve = r)))
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /optimize circuit/i }))
    await waitFor(() => expect(client.analyzeReasoning).toHaveBeenCalled())
    act(() => useBuildStore.getState().loadCircuit(ONE_H))
    await act(async () => resolve(NO_IMPROVEMENT))
    expect(screen.queryByTestId('reasoning-card')).toBeNull()
    expect(useBuildStore.getState().tutorTurns).toEqual([])
    expect(useBuildStore.getState().isAskingTutor).toBe(false)
  })

  it('a refusal is shown as an error, with no answer', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    client.analyzeReasoning.mockRejectedValue(new BackendUnavailableError('11 qubits is over the equivalence limit', 422))
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /optimize circuit/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('over the equivalence limit')
    expect(screen.queryByTestId('reasoning-card')).toBeNull()
  })
})

describe('What if…', () => {
  beforeEach(reset)
  afterEach(reset)

  const openForm = () => {
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /what if/i }))
  }

  it('builds nothing and runs nothing until the learner asks to see the new circuit', () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    openForm()
    expect(screen.getByTestId('whatif-form')).toBeInTheDocument()
    expect(client.previewWhatIf).not.toHaveBeenCalled()
    expect(client.analyzeReasoning).not.toHaveBeenCalled()
  })

  it('shows the counterfactual circuit the SERVER built before anything runs; running then sends the hashes it showed', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL, selectedOpIndex: 1 })
    client.previewWhatIf.mockResolvedValue(PREVIEW)
    client.analyzeReasoning.mockResolvedValue(WHAT_IF_RESULT)
    openForm()
    // the picked operation is pre-chosen
    expect(screen.getByRole('combobox', { name: /which operation/i })).toHaveValue('1')
    fireEvent.click(screen.getByRole('button', { name: /show the new circuit/i }))
    const preview = await screen.findByTestId('whatif-preview')
    expect(client.previewWhatIf).toHaveBeenCalledWith(BELL, { op: 'remove_gate', index: 1 })
    expect(preview).toHaveTextContent('nothing has run yet')
    expect(preview).toHaveTextContent('2 operations become 1')
    expect(preview).toHaveTextContent('− cx control q[0], target q[1]')
    expect(preview).toHaveTextContent('OpenQASM 3 of the new circuit')
    expect(client.analyzeReasoning).not.toHaveBeenCalled() // seeing it is not running it

    fireEvent.click(within(preview).getByRole('button', { name: /run both and compare/i }))
    await waitFor(() => expect(client.analyzeReasoning).toHaveBeenCalledTimes(1))
    expect(client.analyzeReasoning.mock.calls[0]![0]).toEqual({
      intent: 'WHAT_IF',
      circuit: BELL,
      modification: { op: 'remove_gate', index: 1 },
      language: 'en',
      backend: 'qiskit-aer',
      expectedCircuitHash: HASH_A,
      counterfactualCircuitHash: HASH_B,
    })
    const card = await screen.findByTestId('whatif-view')
    expect(card).toHaveTextContent('remove operation 1')
    expect(screen.getByTestId('whatif-equivalence')).toHaveTextContent(/not equivalent/)
    expect(card).toHaveTextContent('0.500000') // the total variation distance, through its provenance badge
    expect(within(card).getAllByText('zero (absent)').length).toBeGreaterThan(0) // an outcome missing from a run is not shown as a number
  })

  it('a preview belongs to one circuit: changing the circuit removes it, and there is nothing to run', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    client.previewWhatIf.mockResolvedValue(PREVIEW)
    openForm()
    fireEvent.click(screen.getByRole('button', { name: /show the new circuit/i }))
    await screen.findByTestId('whatif-preview')
    act(() => useBuildStore.getState().loadCircuit(ONE_H))
    expect(screen.queryByTestId('whatif-preview')).toBeNull()
    expect(useBuildStore.getState().whatIfPending).toBeNull()
    await act(async () => useBuildStore.getState().runReasoning({ kind: 'what_if' }))
    expect(client.analyzeReasoning).not.toHaveBeenCalled() // no preview, no run
  })

  it('changing a choice discards the old preview', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    client.previewWhatIf.mockResolvedValue(PREVIEW)
    openForm()
    fireEvent.click(screen.getByRole('button', { name: /show the new circuit/i }))
    await screen.findByTestId('whatif-preview')
    fireEvent.change(screen.getByLabelText(/one change to try/i), { target: { value: 'insert_gate' } })
    expect(screen.queryByTestId('whatif-preview')).toBeNull()
  })

  it('a preview refused by the server is shown as an error and builds no circuit', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    client.previewWhatIf.mockRejectedValue(new BackendUnavailableError('operation 9 does not exist', 422))
    openForm()
    fireEvent.click(screen.getByRole('button', { name: /show the new circuit/i }))
    expect(await screen.findByTestId('whatif-error')).toHaveTextContent('operation 9 does not exist')
    expect(screen.queryByTestId('whatif-preview')).toBeNull()
  })

  it('replace offers only gates the server would accept for that operation', () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL, selectedOpIndex: 0 })
    openForm()
    fireEvent.change(screen.getByLabelText(/one change to try/i), { target: { value: 'replace_gate' } })
    const options = within(screen.getByLabelText(/replace it with/i)).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['H', 'X', 'Y', 'Z', 'S', 'S†', 'T', 'T†', 'RX', 'RY', 'RZ'])
    fireEvent.change(screen.getByRole('combobox', { name: /which operation/i }), { target: { value: '1' } }) // the CX
    expect(within(screen.getByLabelText(/replace it with/i)).getAllByRole('option').map((o) => o.textContent)).toEqual(['CX', 'CZ'])
  })

  it('replace of an operation that cannot be replaced says so and cannot be sent', () => {
    useBuildStore.setState({ ...SETTLED, circuit: { ...emptyCircuit(2, 0), ops: [op('swap', { targets: [0, 1] })] } })
    openForm()
    fireEvent.change(screen.getByLabelText(/one change to try/i), { target: { value: 'replace_gate' } })
    expect(screen.getByText(/cannot be replaced here/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show the new circuit/i })).toBeDisabled()
  })

  it('a rotation replacing a fixed gate needs an angle, read the way the editor reads one', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: ONE_H })
    client.previewWhatIf.mockResolvedValue(PREVIEW)
    openForm()
    fireEvent.change(screen.getByLabelText(/one change to try/i), { target: { value: 'replace_gate' } })
    fireEvent.change(screen.getByLabelText(/replace it with/i), { target: { value: 'rx' } })
    const angle = screen.getByLabelText(/angle in radians/i)
    fireEvent.change(angle, { target: { value: 'pi/' } })
    expect(screen.getByText(/not an angle/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show the new circuit/i })).toBeDisabled()
    fireEvent.change(angle, { target: { value: 'pi/2' } })
    fireEvent.click(screen.getByRole('button', { name: /show the new circuit/i }))
    await waitFor(() => expect(client.previewWhatIf).toHaveBeenCalled())
    expect(client.previewWhatIf.mock.calls[0]![1]).toEqual({ op: 'replace_gate', index: 0, gate: 'rx', angle: Math.PI / 2 })
  })

  it('change angle needs a rotation', () => {
    useBuildStore.setState({ ...SETTLED, circuit: ONE_H })
    openForm()
    fireEvent.change(screen.getByLabelText(/one change to try/i), { target: { value: 'set_angle' } })
    expect(screen.getByText(/has no angle/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show the new circuit/i })).toBeDisabled()
  })

  it('change angle on a rotation sends the angle', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: { ...emptyCircuit(1, 0), ops: [op('ry', { targets: [0], params: [1] })] } })
    client.previewWhatIf.mockResolvedValue(PREVIEW)
    openForm()
    fireEvent.change(screen.getByLabelText(/one change to try/i), { target: { value: 'set_angle' } })
    fireEvent.change(screen.getByLabelText(/angle in radians/i), { target: { value: 'pi' } })
    fireEvent.click(screen.getByRole('button', { name: /show the new circuit/i }))
    await waitFor(() => expect(client.previewWhatIf).toHaveBeenCalled())
    expect(client.previewWhatIf.mock.calls[0]![1]).toEqual({ op: 'set_angle', index: 0, angle: Math.PI })
  })

  it('add a gate: a controlled gate needs two different qubits and sends control and target', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    client.previewWhatIf.mockResolvedValue(PREVIEW)
    openForm()
    fireEvent.change(screen.getByLabelText(/one change to try/i), { target: { value: 'insert_gate' } })
    fireEvent.change(screen.getByLabelText(/^gate$/i), { target: { value: 'cx' } })
    const control = screen.getByLabelText(/^control$/i)
    const target = screen.getByLabelText(/^target$/i)
    fireEvent.change(control, { target: { value: '1' } })
    fireEvent.change(target, { target: { value: '1' } })
    expect(screen.getByText(/must be different/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show the new circuit/i })).toBeDisabled()
    fireEvent.change(target, { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText(/add it as operation number/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /show the new circuit/i }))
    await waitFor(() => expect(client.previewWhatIf).toHaveBeenCalled())
    expect(client.previewWhatIf.mock.calls[0]![1]).toEqual({ op: 'insert_gate', index: 1, gate: 'cx', targets: [0], controls: [1] })
  })

  it('the form has no free-text field a program could be typed into', () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    openForm()
    const form = within(screen.getByTestId('whatif-form'))
    for (const kind of ['remove_gate', 'replace_gate', 'set_angle', 'insert_gate']) {
      fireEvent.change(form.getByLabelText(/one change to try/i), { target: { value: kind } })
      for (const box of form.queryAllByRole('textbox')) expect(box).toHaveAccessibleName(/angle in radians/i)
    }
  })
})

describe('Explain change', () => {
  beforeEach(reset)
  afterEach(reset)

  it('sends the selected step’s identity only, and shows before, operation, after and per-qubit states', async () => {
    loadTrace()
    client.analyzeReasoning.mockResolvedValue(TRACE_RESULT)
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /explain change/i }))
    const view = await screen.findByTestId('trace-change-view')
    const request = client.analyzeReasoning.mock.calls[0]![0]
    expect(request.intent).toBe('TRACE_CHANGE')
    expect(Object.keys(request.traceStep).sort()).toEqual(
      ['backend', 'backendVersion', 'circuitHash', 'executionId', 'operation', 'operationIndex', 'previousResultId', 'resultId', 'stepIndex'],
    )
    expect(view).toHaveTextContent('Step 3 of 3: cx control q[0], target q[1]')
    expect(view).toHaveTextContent('Outcome probabilities changed on 2 basis states.')
    expect(within(view).getByRole('region', { name: /outcome probabilities that changed/i })).toHaveTextContent('+0.500000')
    expect(within(view).getByRole('region', { name: /each qubit.s own state/i })).toHaveTextContent('entangled with the rest')
    expect(view).toHaveTextContent('q[1]…q[0]')
  })
})

describe('multilingual and responsive', () => {
  beforeEach(reset)
  afterEach(reset)

  it('the chosen answer language travels with every reasoning request', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL, tutorLanguage: 'kn' })
    client.analyzeReasoning.mockResolvedValue(NO_IMPROVEMENT)
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /optimize circuit/i }))
    await screen.findByTestId('reasoning-card')
    expect(client.analyzeReasoning.mock.calls[0]![0].language).toBe('kn')
  })

  it('a typed Hindi question goes to the tutor as typed, with the answer language, and its reasoning answer is shown with its facts', async () => {
    setRun(ONE_H)
    client.askTutor.mockResolvedValue({
      answer: 'बैकएंड के अपने रन से: outcome 1: theoretical probability 0.500000 (R2).',
      resultId: 'res_analysis',
      circuitHash: HASH_A,
      provenanceClass: 'SIMULATION',
      verificationStatus: 'STATE_CHECKED',
      usedFallbackTemplate: true,
      facts: [{ id: 'R2', kind: 'probability', description: 'outcome 1: theoretical probability 0.500000', resultId: 'res_analysis' }],
    })
    useBuildStore.setState({ tutorLanguage: 'hi' })
    render(<TutorPanel />)
    fireEvent.change(screen.getByPlaceholderText('Ask about this result…'), { target: { value: '1 आने की संभावना कितनी है?' } })
    fireEvent.click(screen.getByRole('button', { name: /^ask$/i }))
    await waitFor(() => expect(client.askTutor).toHaveBeenCalled())
    expect(client.askTutor.mock.calls[0]).toEqual(['res_run', ONE_H, '1 आने की संभावना कितनी है?', 'hi'])
    expect(await screen.findByText(/बैकएंड के अपने रन से/)).toBeInTheDocument()
    expect(screen.getByText(/R2/, { selector: 'span' })).toBeInTheDocument()
  })

  it('every table sits in a focusable, scrollable region so a phone can reach all of it', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    client.analyzeReasoning.mockResolvedValue(WHAT_IF_RESULT)
    useBuildStore.setState({
      whatIfPending: { modification: { op: 'remove_gate', index: 1 }, preview: PREVIEW, circuit: BELL },
    })
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /what if/i }))
    fireEvent.click(screen.getByRole('button', { name: /run both and compare/i }))
    const card = await screen.findByTestId('whatif-view')
    const regions = within(card).getAllByRole('region')
    expect(regions.length).toBeGreaterThan(0)
    for (const region of regions) {
      expect(region).toHaveAttribute('tabindex', '0')
      expect(region.className).toContain('overflow-x-auto')
    }
  })

  it('the action row wraps instead of overflowing a narrow screen', () => {
    setRun(ONE_H)
    render(<TutorPanel />)
    expect(screen.getByRole('group', { name: /analysis actions/i }).className).toMatch(/flex-wrap/)
  })

  it('has no axe violations with the actions, the what-if form and an analysis on screen', async () => {
    useBuildStore.setState({ ...SETTLED, circuit: BELL })
    setRun(BELL)
    client.analyzeReasoning.mockResolvedValue(TRACE_RESULT)
    useBuildStore.setState({ whatIfPending: { modification: { op: 'remove_gate', index: 1 }, preview: PREVIEW, circuit: BELL } })
    loadTrace()
    useBuildStore.setState({ ...SETTLED, circuit: BELL, whatIfPending: { modification: { op: 'remove_gate', index: 1 }, preview: PREVIEW, circuit: BELL } })
    render(<TutorPanel />)
    fireEvent.click(screen.getByRole('button', { name: /what if/i }))
    fireEvent.click(screen.getByRole('button', { name: /explain change/i }))
    await screen.findByTestId('reasoning-card')
    const result = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } },
    })
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
