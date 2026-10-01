/**
 * AI code generation in the browser: every state the learner can be in, the exact request that leaves, and the rules the panel
 * must never break. A proposal is always shown as "not yet verified" with the SERVER's label; the browser never calls a proposal
 * correct, never edits it, and never shows a number that did not come from the backend. With no language model configured the
 * panel says so and generates nothing. The model is a test double here (a real one is the server's business), including a double
 * that returns what a careless or hostile model would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CircuitProposal, ExecutePayload, GenerationStatus } from '@/api'
import { GenerationFailedError, GenerationUnavailableError } from '@/api'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const client = vi.hoisted(() => ({
  getGenerationStatus: vi.fn(),
  generateCircuit: vi.fn(),
  executeCircuit: vi.fn(),
  askTutor: vi.fn(),
  listLessons: vi.fn(),
  listChallenges: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import { useBuildStore } from '@/features/build/store'
import { useChallengeStore } from '@/features/challenges/store'
import { useLearnStore } from '@/features/learn/store'
import { TutorPanel } from '@/features/tutor/TutorPanel'
import { GeneratePanel } from './GeneratePanel'
import { EXPLAIN_QUESTION, resetGenerateStore, useGenerateStore } from './store'

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()
const INITIAL_CHALLENGES = useChallengeStore.getState()
const build = () => useBuildStore.getState()
const gen = () => useGenerateStore.getState()

const op = (gate: GateOp['gate'], targets: number[], controls: number[] = [], clbits: number[] = []): GateOp => ({ gate, targets, controls, params: [], clbits })
const circuitOf = (n: number, ops: GateOp[], clbits = 0): Circuit => ({ ...emptyCircuit(n, clbits), ops })
const BELL = circuitOf(2, [op('h', [0]), op('cx', [1], [0])])
const MEASURED = circuitOf(1, [op('h', [0]), op('measure', [0], [], [0])], 1)

const LABEL = 'AI proposal — not yet verified against your intent'
const proposal = (over: Partial<CircuitProposal> = {}): CircuitProposal => ({
  status: 'PROPOSED',
  label: LABEL,
  verificationStatus: 'UNVERIFIED_AGAINST_INTENT',
  generator: 'fake-provider',
  model: 'fake-model-1',
  rawQasm: 'qubit[2] q; h q[0]; cx q[0], q[1];',
  circuit: BELL,
  canonicalQasm: 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n',
  circuitHash: 'abcdef0123456789abcdef',
  summary: 'The proposal uses 2 qubits and 2 operations, in this order: h on q[0]; cx control q[0], target q[1].',
  explanation: 'The program puts a Hadamard on q[0] and then a CX from q[0] to q[1].',
  explanationSource: 'AI',
  explanationNote: null,
  problems: [],
  constraintNotes: [],
  ...over,
})
const REJECTED = (over: Partial<CircuitProposal> = {}): CircuitProposal =>
  proposal({
    status: 'REJECTED',
    circuit: null,
    canonicalQasm: null,
    circuitHash: null,
    summary: null,
    explanation: null,
    explanationSource: null,
    rawQasm: "import os\nos.system('echo hi')",
    problems: [{ code: 'QASM_PARSE_ERROR', message: 'unknown or unsupported gate', line: 2 }],
    ...over,
  })

const PROV: Provenance = {
  resultId: 'res_gen_1',
  circuitHash: 'abcdef0123456789abcdef',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
}
const RESULT = (payload: Partial<ExecutePayload> = { theoreticalProbabilities: { '00': 0.5, '11': 0.5 } }) =>
  toQuantumValue({ executionId: 'e', ...payload } as ExecutePayload, PROV)

const AVAILABLE: GenerationStatus = { available: true, provider: 'fake-provider', model: 'fake-model-1', reason: null }
const UNAVAILABLE: GenerationStatus = { available: false, provider: null, model: null, reason: 'AI code generation is not configured on this server: no language model is set up.' }

function mount(props: Parameters<typeof GeneratePanel>[0] = {}) {
  return render(<GeneratePanel {...props} />)
}
const type = (text: string) => fireEvent.change(screen.getByTestId('generate-prompt'), { target: { value: text } })
async function generateWith(answer: CircuitProposal | Error, prompt = 'Create a Bell state using two qubits.') {
  if (answer instanceof Error) client.generateCircuit.mockRejectedValueOnce(answer)
  else client.generateCircuit.mockResolvedValueOnce(answer)
  await screen.findByTestId('generate-form')
  type(prompt)
  fireEvent.click(screen.getByTestId('generate-submit'))
}

beforeEach(() => {
  vi.clearAllMocks()
  client.getGenerationStatus.mockResolvedValue(AVAILABLE)
  client.listLessons.mockResolvedValue([])
  client.listChallenges.mockResolvedValue([])
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
  useChallengeStore.setState(INITIAL_CHALLENGES, true)
  resetGenerateStore()
})
afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
  useChallengeStore.setState(INITIAL_CHALLENGES, true)
  resetGenerateStore()
})

describe('when no language model is configured', () => {
  beforeEach(() => client.getGenerationStatus.mockResolvedValue(UNAVAILABLE))

  it('says so plainly, with the reason, and offers no form to type into', async () => {
    mount()
    const notice = await screen.findByTestId('generate-unavailable')
    expect(notice.textContent).toContain('AI code generation is not available on this server')
    expect(notice.textContent).toContain('no language model is set up')
    expect(notice.textContent).toMatch(/does not make up a circuit/)
    expect(screen.queryByTestId('generate-form')).toBeNull()
    expect(screen.queryByTestId('generate-prompt')).toBeNull()
    expect(screen.queryByRole('button', { name: /Generate a proposal/ })).toBeNull()
  })

  it('points to what still works, and never calls itself an error or offers a canned circuit', async () => {
    mount()
    const notice = await screen.findByTestId('generate-unavailable')
    expect(notice.textContent).toMatch(/Build one on the canvas/)
    expect(notice.textContent).toMatch(/everything else in Qentor works/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('proposal-card')).toBeNull()
    expect(client.generateCircuit).not.toHaveBeenCalled()
  })

  it('does not require a key for anything else: the rest of the Lab still runs', async () => {
    mount()
    await screen.findByTestId('generate-unavailable')
    client.executeCircuit.mockResolvedValueOnce(RESULT())
    act(() => build().loadCircuit(BELL))
    await act(async () => build().runExecution())
    expect(build().result).not.toBeNull()
  })

  it('a server that answers "unavailable" to a request itself is shown the same way', async () => {
    client.getGenerationStatus.mockResolvedValue(AVAILABLE)
    mount()
    await generateWith(new GenerationUnavailableError('The model went away.'))
    expect(await screen.findByTestId('generate-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('generate-form')).toBeNull()
  })
})

describe('when the server cannot even be asked', () => {
  it('says the check failed (not "unavailable"), generates nothing and can try again', async () => {
    client.getGenerationStatus.mockRejectedValueOnce(new Error('could not reach the Qentor backend'))
    mount()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not check AI code generation')
    expect(alert.textContent).toContain('Nothing is generated or substituted')
    expect(screen.queryByTestId('generate-unavailable')).toBeNull()
    client.getGenerationStatus.mockResolvedValueOnce(AVAILABLE)
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('generate-form')).toBeTruthy()
  })
})

describe('the request form', () => {
  it('needs a few words before it can be sent, and counts them', async () => {
    mount()
    await screen.findByTestId('generate-form')
    const submit = screen.getByTestId('generate-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    type('ab')
    expect(submit.disabled).toBe(true)
    type('a bell')
    expect(submit.disabled).toBe(false)
    expect(screen.getByLabelText('6 of 600 characters')).toBeTruthy()
    type('   ')
    expect(submit.disabled).toBe(true)
  })

  it('stops at the length the server allows', async () => {
    mount()
    await screen.findByTestId('generate-form')
    type('x'.repeat(700))
    expect((screen.getByTestId('generate-prompt') as HTMLTextAreaElement).value).toHaveLength(600)
  })

  it('example requests fill the box, and are only requests (they claim nothing about a result)', async () => {
    mount()
    await screen.findByTestId('generate-form')
    const examples = within(screen.getByLabelText('Example requests')).getAllByRole('button')
    expect(examples.length).toBeGreaterThanOrEqual(3)
    fireEvent.click(examples[0]!)
    expect((screen.getByTestId('generate-prompt') as HTMLTextAreaElement).value).toBe(examples[0]!.textContent)
    for (const example of examples) expect(example.textContent).not.toMatch(/probabilit|percent|%|correct|verified/i)
  })

  it('sends the words, the learner\'s language and nothing else', async () => {
    mount()
    await generateWith(proposal(), '  Create a Bell state using two qubits.  ')
    await screen.findByTestId('proposal-card')
    expect(client.generateCircuit).toHaveBeenCalledTimes(1)
    expect(client.generateCircuit.mock.calls[0]![0]).toEqual({
      prompt: 'Create a Bell state using two qubits.',
      language: 'en',
      lessonId: null,
      challengeId: null,
      circuit: null,
    })
  })

  it('uses the tutor language the learner chose', async () => {
    act(() => build().setTutorLanguage('kn'))
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    expect(client.generateCircuit.mock.calls[0]![0].language).toBe('kn')
  })

  it('sends the current circuit only when asked to, and only when there is one', async () => {
    mount()
    await screen.findByTestId('generate-form')
    const checkbox = screen.getByLabelText('Use my current circuit as context') as HTMLInputElement
    expect(checkbox.disabled).toBe(true) // an empty canvas is no context
    act(() => build().loadCircuit(BELL))
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(false)
    client.generateCircuit.mockResolvedValue(proposal())
    type('add a Z')
    fireEvent.click(screen.getByTestId('generate-submit'))
    await screen.findByTestId('proposal-card')
    expect(client.generateCircuit.mock.calls[0]![0].circuit).toBeNull()
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByTestId('generate-submit'))
    await waitFor(() => expect(client.generateCircuit).toHaveBeenCalledTimes(2))
    expect(client.generateCircuit.mock.calls[1]![0].circuit).toEqual(BELL)
  })

  it('offers lessons and challenges as context when they are loaded, and sends their ids', async () => {
    act(() => {
      useLearnStore.setState({ lessons: [{ id: 'bell-state', title: 'Bell State' }] as never })
      useChallengeStore.setState({ challenges: [{ id: 'create-bell', title: 'Create a Bell state' }] as never })
    })
    mount()
    await screen.findByTestId('generate-form')
    fireEvent.change(screen.getByLabelText('Lesson'), { target: { value: 'bell-state' } })
    fireEvent.change(screen.getByLabelText('Challenge'), { target: { value: 'create-bell' } })
    client.generateCircuit.mockResolvedValue(proposal())
    type('help me with this')
    fireEvent.click(screen.getByTestId('generate-submit'))
    await screen.findByTestId('proposal-card')
    expect(client.generateCircuit.mock.calls[0]![0]).toMatchObject({ lessonId: 'bell-state', challengeId: 'create-bell' })
  })

  it('the challenge on screen is sent without the learner choosing it', async () => {
    mount({ challengeId: 'create-bell' })
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    expect(client.generateCircuit.mock.calls[0]![0].challengeId).toBe('create-bell')
  })

  it('Ctrl+Enter sends from the keyboard', async () => {
    mount()
    await screen.findByTestId('generate-form')
    client.generateCircuit.mockResolvedValue(proposal())
    type('a bell state')
    fireEvent.keyDown(screen.getByTestId('generate-prompt'), { key: 'Enter', ctrlKey: true })
    await screen.findByTestId('proposal-card')
    expect(client.generateCircuit).toHaveBeenCalledTimes(1)
  })

  it('while a request is out the form is locked and the learner is told', async () => {
    mount()
    await screen.findByTestId('generate-form')
    let resolve!: (p: CircuitProposal) => void
    client.generateCircuit.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    type('a bell state')
    fireEvent.click(screen.getByTestId('generate-submit'))
    expect(await screen.findByText(/Asking the language model/)).toBeTruthy()
    expect((screen.getByTestId('generate-prompt') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByTestId('generate-submit') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => resolve(proposal()))
    expect(await screen.findByTestId('proposal-card')).toBeTruthy()
  })
})

describe('a proposal', () => {
  it('is labelled with the SERVER\'s words, always, and is never called correct or verified', async () => {
    mount()
    await generateWith(proposal())
    const card = await screen.findByTestId('proposal-card')
    expect(screen.getByTestId('proposal-label').textContent).toBe(LABEL)
    for (const bad of [/\bis (correct|verified|equivalent|valid)\b/i, /\bverified\b(?!\s+against)/i, /\bcorrect\b/i, /\bpasses\b/i, /\bsolved\b/i]) {
      expect(card.textContent, String(bad)).not.toMatch(bad)
    }
  })

  it('shows whatever label the server sends, not a copy of its own', async () => {
    mount()
    await generateWith(proposal({ label: 'SERVER-CHOSEN LABEL' }))
    expect((await screen.findByTestId('proposal-label')).textContent).toBe('SERVER-CHOSEN LABEL')
  })

  it('names who proposed it, shows the structure summary and the server\'s canonical OpenQASM', async () => {
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    expect(screen.getByText(/proposed by fake-provider · fake-model-1/)).toBeTruthy()
    expect(screen.getByTestId('proposal-summary').textContent).toContain('2 qubits and 2 operations')
    const shown = screen.getByTestId('proposal-qasm').textContent!
    expect(shown).toBe(proposal().canonicalQasm) // the server's canonical text, byte for byte,
    expect(shown).toContain('OPENQASM 3.0;') // which the model's own one-line text (rawQasm) does not have
    expect(shown).not.toBe(proposal().rawQasm)
    expect(screen.getByText(/circuit abcdef012345…/)).toBeTruthy()
  })

  it('says whose explanation it is: the model\'s (guarded) or the server\'s own', async () => {
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    expect(screen.getByTestId('proposal-explanation-source').textContent).toBe('written by the model, accepted by the claim guard')
    expect(screen.getByTestId('proposal-explanation').textContent).toContain('puts a Hadamard on q[0]')
    cleanup()
    resetGenerateStore()
    mount()
    await generateWith(
      proposal({ explanationSource: 'TEMPLATE', explanation: 'The proposal uses 2 qubits. It has not been run.', explanationNote: 'The model\'s explanation was discarded because it made a claim the backend has not computed.' }),
    )
    await screen.findByTestId('proposal-card')
    expect(screen.getByTestId('proposal-explanation-source').textContent).toBe('written by Qentor from the parsed circuit')
    expect(screen.getByTestId('proposal-explanation').textContent).toContain('discarded because it made a claim the backend has not computed')
  })

  it('shows a note when it does not fit the challenge, as a note and not as a verdict', async () => {
    mount()
    await generateWith(proposal({ constraintNotes: ['This challenge uses exactly 1 qubits; the proposal has 2.'] }))
    const notes = await screen.findByTestId('proposal-constraint-notes')
    expect(notes.textContent).toContain('exactly 1 qubits')
    expect(notes.textContent).not.toMatch(/fail|wrong|incorrect|solved/i)
  })

  it('keeps what the model wrote behind a disclosure, only when it differs from what the server read', async () => {
    mount()
    await generateWith(proposal({ rawQasm: '// trust me\nqubit[2] q; h q[0]; cx q[0], q[1];' }))
    await screen.findByTestId('proposal-card')
    expect(screen.getByText('What the model wrote (before the server read it)')).toBeTruthy()
    cleanup()
    resetGenerateStore()
    mount()
    const same = proposal()
    await generateWith({ ...same, rawQasm: same.canonicalQasm! })
    await screen.findByTestId('proposal-card')
    expect(screen.queryByText('What the model wrote (before the server read it)')).toBeNull()
  })

  it('offers exactly Insert, Run, Explain and Reject', async () => {
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    const names = within(screen.getByRole('group', { name: 'What to do with this proposal' })).getAllByRole('button').map((b) => b.textContent)
    expect(names).toEqual(['Insert into editor', 'Run', 'Explain', 'Reject'])
  })
})

describe('Insert, Run, Explain, Reject', () => {
  it('Insert puts the proposal\'s circuit on the canvas as one undo step, and says how to get the old one back', async () => {
    act(() => build().loadCircuit(circuitOf(1, [op('x', [0])])))
    act(() => useBuildStore.setState({ past: [], future: [] }))
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    expect(screen.queryByTestId('proposal-inserted')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Insert into editor' }))
    expect(build().circuit).toEqual(BELL)
    expect(build().qasmText).toContain('cx q[0], q[1];')
    expect(screen.getByTestId('proposal-inserted').textContent).toContain('Undo (Ctrl+Z) brings back the circuit it replaced')
    expect((screen.getByRole('button', { name: 'Insert into editor' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => build().undo())
    expect(build().circuit.ops.map((o) => o.gate)).toEqual(['x'])
    expect(screen.queryByTestId('proposal-inserted')).toBeNull()
  })

  it('Insert resets what was derived from the circuit it replaced', async () => {
    act(() => useBuildStore.setState({ result: RESULT(), tutorTurns: [{ role: 'learner', text: 'q' }] }))
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Insert into editor' }))
    expect(build().result).toBeNull()
    expect(build().tutorTurns).toEqual([])
  })

  it('Run inserts the proposal and runs it through the ordinary execute call, then shows the BACKEND\'s numbers with their provenance', async () => {
    client.executeCircuit.mockResolvedValueOnce(RESULT())
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const box = await screen.findByTestId('proposal-result')
    expect(client.executeCircuit).toHaveBeenCalledTimes(1)
    expect(client.executeCircuit.mock.calls[0]![0]).toEqual(BELL)
    expect(box.textContent).toContain('What the backend computed for it')
    expect(box.textContent).toContain('Simulated')
    expect(within(box).getAllByText('0.500000')).toHaveLength(2) // the backend's values, as given
    expect(box.textContent).toMatch(/Whether it is what you meant is for you to judge/)
  })

  it('numbers appear only after a run: before it, the proposal has none', async () => {
    mount()
    await generateWith(proposal())
    const card = await screen.findByTestId('proposal-card')
    expect(screen.queryByTestId('proposal-result')).toBeNull()
    expect(card.textContent).not.toMatch(/\d\.\d{6}/) // none of the backend's six-decimal numbers (the QASM header's "3.0" is not one)
  })

  it('a result for some OTHER circuit is never shown against the proposal', async () => {
    act(() => build().loadCircuit(circuitOf(1, [op('x', [0])])))
    act(() => useBuildStore.setState({ result: RESULT() }))
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    expect(screen.queryByTestId('proposal-result')).toBeNull()
  })

  it('a measured circuit in statevector mode is shown with the collapsed-state caveat and no numbers', async () => {
    client.executeCircuit.mockResolvedValueOnce(RESULT({ theoreticalProbabilities: { '1': 1 } }))
    mount()
    await generateWith(proposal({ circuit: MEASURED }))
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const box = await screen.findByTestId('proposal-result')
    expect(box.textContent).toMatch(/one collapsed state/)
    expect(box.textContent).not.toContain('1.000000')
  })

  it('sampled outcomes are labelled as sampled frequencies', async () => {
    act(() => build().setMode('shots'))
    client.executeCircuit.mockResolvedValueOnce(RESULT({ probabilities: { '00': 0.52, '11': 0.48 }, shots: 1000 }))
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const box = await screen.findByTestId('proposal-result')
    expect(box.textContent).toContain('sampled frequency')
    expect(box.textContent).toContain('0.520000')
  })

  it('a refused run says so in the Lab and the proposal shows no result', async () => {
    client.executeCircuit.mockRejectedValueOnce(new Error('the circuit is over the limit'))
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(build().executionError).toBe('the circuit is over the limit'))
    expect(screen.queryByTestId('proposal-result')).toBeNull()
  })

  it('Explain runs the circuit if it has not been run, then asks the ordinary result-grounded tutor question', async () => {
    client.executeCircuit.mockResolvedValueOnce(RESULT())
    client.askTutor.mockResolvedValueOnce({ answer: 'It applies H then CX.', facts: [], usedFallbackTemplate: true, resultId: 'res_gen_1', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED', lessonId: null, sectionId: null, traceStep: null })
    const shown = vi.fn()
    mount({ onShowExplanation: shown })
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }))
    await waitFor(() => expect(client.askTutor).toHaveBeenCalledTimes(1))
    expect(client.executeCircuit).toHaveBeenCalledTimes(1)
    const args = client.askTutor.mock.calls[0]!
    expect(args[0]).toBe('res_gen_1') // the backend's result id: the tutor reads facts from the provenance log, not from this page
    expect(args[1]).toEqual(BELL)
    expect(args[2]).toBe(EXPLAIN_QUESTION)
    expect(shown).toHaveBeenCalled()
  })

  it('Explain does not run again when the circuit already has a result', async () => {
    act(() => build().loadCircuit(BELL))
    act(() => useBuildStore.setState({ result: RESULT() }))
    client.askTutor.mockResolvedValueOnce({ answer: 'x', facts: [], usedFallbackTemplate: true, resultId: 'res_gen_1', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED', lessonId: null, sectionId: null, traceStep: null })
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }))
    await waitFor(() => expect(client.askTutor).toHaveBeenCalledTimes(1))
    expect(client.executeCircuit).not.toHaveBeenCalled()
  })

  it('Reject forgets the proposal and leaves the circuit alone', async () => {
    act(() => build().loadCircuit(circuitOf(1, [op('x', [0])])))
    mount()
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.queryByTestId('proposal-card')).toBeNull()
    expect(build().circuit.ops.map((o) => o.gate)).toEqual(['x'])
    expect(await screen.findByTestId('generate-form')).toBeTruthy()
    expect((screen.getByTestId('generate-prompt') as HTMLTextAreaElement).value).toContain('Bell') // the words are kept for a new try
  })

  it('an answer that arrives after Reject (or a newer request) is dropped, not shown', async () => {
    mount()
    await screen.findByTestId('generate-form')
    let resolve!: (p: CircuitProposal) => void
    client.generateCircuit.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    type('a bell state')
    fireEvent.click(screen.getByTestId('generate-submit'))
    await screen.findByText(/Asking the language model/)
    act(() => gen().reject())
    await act(async () => resolve(proposal()))
    expect(screen.queryByTestId('proposal-card')).toBeNull()
    expect(gen().phase).toBe('idle')
  })
})

describe('when the proposal is refused or the model fails', () => {
  it('a REJECTED proposal lists what the server could not read, with the line, and cannot be inserted or run', async () => {
    mount()
    await generateWith(REJECTED())
    const box = await screen.findByTestId('proposal-rejected')
    expect(box.textContent).toContain(LABEL)
    expect(box.textContent).toContain('The server could not use this proposal')
    expect(box.textContent).toContain('line 2:')
    expect(box.textContent).toContain('unknown or unsupported gate')
    expect(box.textContent).toContain('It was not added to your circuit and cannot be')
    expect(within(box).queryByRole('button', { name: /Insert|Run|Explain/ })).toBeNull()
    expect(screen.queryByTestId('proposal-actions')).toBeNull()
    expect(build().circuit.ops).toEqual([])
    expect(client.executeCircuit).not.toHaveBeenCalled()
    expect(gen().insert()).toBe(false) // even by code: there is nothing to insert
    expect(build().circuit.ops).toEqual([])
  })

  it('even a rejected proposal that somehow carried a circuit cannot be inserted or run (the status decides, not the presence of a circuit)', async () => {
    mount()
    await generateWith(REJECTED({ circuit: BELL, canonicalQasm: 'qubit[2] q;' }))
    await screen.findByTestId('proposal-rejected')
    expect(gen().insert()).toBe(false)
    await act(async () => gen().run())
    await act(async () => gen().explain())
    expect(build().circuit.ops).toEqual([])
    expect(client.executeCircuit).not.toHaveBeenCalled()
  })

  it('shows what the model wrote behind a disclosure (so a learner can see what was refused)', async () => {
    mount()
    await generateWith(REJECTED())
    const box = await screen.findByTestId('proposal-rejected')
    expect(within(box).getByText('What the model wrote (rejected)')).toBeTruthy()
    expect(box.textContent).toContain("os.system('echo hi')")
  })

  it('Try again asks again with the same words', async () => {
    mount()
    await generateWith(REJECTED(), 'make a bell state please')
    await screen.findByTestId('proposal-rejected')
    client.generateCircuit.mockResolvedValueOnce(proposal())
    fireEvent.click(screen.getByTestId('retry-generation'))
    expect(await screen.findByTestId('proposal-card')).toBeTruthy()
    expect(client.generateCircuit).toHaveBeenCalledTimes(2)
    expect(client.generateCircuit.mock.calls[1]![0].prompt).toBe('make a bell state please')
  })

  it('a model that could not be reached says so, changes nothing and offers a retry', async () => {
    act(() => build().loadCircuit(BELL))
    mount()
    await generateWith(new GenerationFailedError('The language model could not be reached or gave an unusable reply. Try again.'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The proposal could not be generated')
    expect(alert.textContent).toContain('No circuit was produced and nothing was substituted')
    expect(build().circuit).toEqual(BELL)
    expect(screen.queryByTestId('proposal-card')).toBeNull()
    client.generateCircuit.mockResolvedValueOnce(proposal({ circuit: BELL }))
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('proposal-card')).toBeTruthy()
  })

  it('an unreachable backend is also a "failed", with the real message', async () => {
    mount()
    await generateWith(new Error('could not reach the Qentor backend: network down'))
    expect((await screen.findByRole('alert')).textContent).toContain('network down')
  })
})

describe('what a hostile or careless model cannot do through this panel', () => {
  it('nothing the model sends is ever interpreted as code: the panel only renders text', async () => {
    const hostile = proposal({
      explanation: '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script>',
      summary: '<b onclick="window.__pwned=1">x</b>',
      rawQasm: '<script>window.__pwned=1</script>',
      canonicalQasm: 'qubit q; // <script>window.__pwned=1</script>',
      constraintNotes: ['<a href="javascript:window.__pwned=1">x</a>'],
    })
    mount()
    await generateWith(hostile)
    const card = await screen.findByTestId('proposal-card')
    expect(card.querySelector('script, img, b, a')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    expect(card.textContent).toContain('<script>')
  })

  it('a proposal that claims numbers in its explanation is shown exactly as the server decided (the browser never edits or filters it)', async () => {
    mount()
    await generateWith(proposal({ explanation: 'This gives 100% for 00.' }))
    expect((await screen.findByTestId('proposal-explanation')).textContent).toContain('This gives 100% for 00.')
    // (the server's claim guard is what refuses such text; the browser has no second opinion to offer, and offers none)
  })

  it('this module computes nothing quantum and defines no label of its own', async () => {
    const sources = import.meta.glob(['./GeneratePanel.tsx', './store.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(sources)).toHaveLength(2)
    for (const [path, source] of Object.entries(sources)) {
      const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') // the code, not the comments that explain it
      for (const banned of [/Math\.(sin|cos|sqrt|pow|hypot|atan2)/, /\.statevector\b/, /\bamplitudes?\b/i, /\beval\(|new Function|dangerouslySetInnerHTML|innerHTML/]) {
        expect(text, `${path} ${banned}`).not.toMatch(banned)
      }
      expect(text, path).not.toContain('not yet verified against your intent') // the label is the server's
      expect(text, path).not.toMatch(/OPENQASM 3/) // and the browser writes no circuit of its own
    }
  })
})

describe('in the Tutor panel', () => {
  const mountTutor = (props: Parameters<typeof TutorPanel>[0] = {}) => render(<TutorPanel {...props} />)
  const tab = (name: string) => screen.getByRole('tab', { name })

  it('the Lab\'s tutor has four distinct modes and starts on Explain', () => {
    mountTutor()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Explain', 'What changed?', 'Debug', 'Generate code'])
    expect(tab('Explain').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tablist', { name: 'What to ask the tutor' })).toBeTruthy()
    expect(screen.getByLabelText('Ask the tutor')).toBeTruthy()
  })

  it('Generate code shows the generation panel instead of the question box', async () => {
    mountTutor()
    fireEvent.click(tab('Generate code'))
    expect(await screen.findByTestId('generate-panel')).toBeTruthy()
    expect(screen.queryByLabelText('Ask the tutor')).toBeNull()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toMatch(/-generate$/)
  })

  it('Debug shows the debugger, What changed? shows the trace-step action, and the conversation is the same one', async () => {
    mountTutor()
    fireEvent.click(tab('Debug'))
    expect(screen.getByTestId('debug-lab')).toBeTruthy()
    fireEvent.click(tab('What changed?'))
    expect(screen.getByTestId('changed-mode').textContent).toContain('Run the trace')
    act(() => useBuildStore.setState({ result: RESULT(), trace: { steps: [{ operationIndex: null }, { operationIndex: 0 }] } as never, selectedTraceStep: 1 }))
    expect(screen.getByTestId('changed-mode').textContent).toContain('Step 2 of 2 is selected in the trace')
    expect(screen.getByRole('button', { name: 'What changed in this step?' })).toBeTruthy()
    expect(screen.getByRole('log', { name: 'Tutor conversation' })).toBeTruthy() // still the one conversation
  })

  it('arrow keys, Home and End move between the modes, and only the selected one is in the tab order', () => {
    mountTutor()
    const first = tab('Explain')
    first.focus()
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(tab('What changed?').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' })
    expect(tab('Generate code').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(tab('Explain').getAttribute('aria-selected')).toBe('true') // wraps around
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    expect(tab('Generate code').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' })
    expect(tab('Explain').getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
  })

  it('a lesson\'s conversation and the Guide\'s embedded tutor keep their single mode (the scoping rules are unchanged)', () => {
    mountTutor({ context: { kind: 'lesson', lessonId: 'bell-state', sectionId: 's1' } })
    expect(screen.queryByRole('tablist')).toBeNull()
    cleanup()
    mountTutor({ showModes: false })
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByLabelText('Ask the tutor')).toBeTruthy()
  })

  it('the Challenges screen\'s tutor offers a subset, with its own Debug left out', () => {
    mountTutor({ modes: ['explain', 'changed', 'generate'], challengeId: 'create-bell' })
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Explain', 'What changed?', 'Generate code'])
  })

  it('after Explain the tutor goes back to the conversation so the answer is on screen', async () => {
    client.executeCircuit.mockResolvedValueOnce(RESULT())
    client.askTutor.mockResolvedValueOnce({ answer: 'It applies H then CX.', facts: [], usedFallbackTemplate: true, resultId: 'res_gen_1', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED', lessonId: null, sectionId: null, traceStep: null })
    mountTutor()
    fireEvent.click(tab('Generate code'))
    await generateWith(proposal())
    await screen.findByTestId('proposal-card')
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }))
    expect(await screen.findByText('It applies H then CX.')).toBeTruthy()
    expect(tab('Explain').getAttribute('aria-selected')).toBe('true')
  })
})
