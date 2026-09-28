/**
 * Tests for the Tutor panel + the store.askTutor wiring behind it. `@/api`'s
 * `getApiClient` is mocked so these run without a live backend. Covers: the
 * outgoing request payload, grounded-answer rendering, an unsupported
 * question, error handling (no result / unknown result / network failure),
 * and stale tutor state being cleared when the circuit or result changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BackendUnavailableError } from '@/api'
import type { ExecutePayload, TutorAnswerResult } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const askTutor = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(),
      verifyBellState: vi.fn(),
      listLessons: vi.fn(),
      getLesson: vi.fn(),
      askTutor,
    }),
  }
})

import { useBuildStore } from '@/features/build/store'
import { TutorPanel } from './TutorPanel'

const PROVENANCE: Provenance = {
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'shots',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'VERIFIED',
  createdAt: '2026-01-01T00:00:00Z',
}

const EXECUTED_CIRCUIT = {
  ...emptyCircuit(2, 2),
  ops: [
    { gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx' as const, targets: [1], controls: [0], params: [], clbits: [] },
    { gate: 'measure' as const, targets: [0], controls: [], params: [], clbits: [0] },
    { gate: 'measure' as const, targets: [1], controls: [], params: [], clbits: [1] },
  ],
}

function setExecutedResult(payload: ExecutePayload = { executionId: 'aer-local-abc', probabilities: { '00': 0.5, '11': 0.5 } }) {
  useBuildStore.setState({
    circuit: EXECUTED_CIRCUIT,
    result: toQuantumValue(payload, PROVENANCE),
    isExecuting: false,
    executionError: null,
  })
}

const INITIAL_STATE = useBuildStore.getState()

function askViaInput(question: string) {
  fireEvent.change(screen.getByPlaceholderText('Ask about this result…'), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: /ask/i }))
}

describe('TutorPanel', () => {
  beforeEach(() => {
    askTutor.mockReset()
    useBuildStore.setState(INITIAL_STATE, true)
  })

  afterEach(() => {
    useBuildStore.setState(INITIAL_STATE, true)
  })

  it('disables asking and shows no provenance badge when there is no execution result yet', () => {
    useBuildStore.setState({ result: null })
    render(<TutorPanel />)

    expect(screen.getByText('no result to ground on yet')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Run the circuit first…')).toBeDisabled()
    expect(screen.getByRole('button', { name: /ask/i })).toBeDisabled()
  })

  it('renders a language selector defaulting to English', () => {
    setExecutedResult()
    render(<TutorPanel />)

    const select = screen.getByLabelText('Tutor answer language') as HTMLSelectElement
    expect(select).toBeInTheDocument()
    expect(select.value).toBe('en')
  })

  it('sends the selected language on the next tutor request, without touching the circuit or result', async () => {
    setExecutedResult()
    const answer: TutorAnswerResult = {
      answer: 'इस परिणाम के लिए: outcome 00: probability 0.500000 (F3).',
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      provenanceClass: 'SIMULATION',
      verificationStatus: 'VERIFIED',
      usedFallbackTemplate: true,
      facts: [],
    }
    askTutor.mockResolvedValueOnce(answer)

    render(<TutorPanel />)

    const circuitBeforeLanguageChange = useBuildStore.getState().circuit
    const resultBeforeLanguageChange = useBuildStore.getState().result

    act(() => {
      fireEvent.change(screen.getByLabelText('Tutor answer language'), { target: { value: 'hi' } })
    })

    // Changing the language is a pure UI preference — it must not alter the
    // circuit or the already-executed result in any way.
    expect(useBuildStore.getState().circuit).toBe(circuitBeforeLanguageChange)
    expect(useBuildStore.getState().result).toBe(resultBeforeLanguageChange)
    expect(useBuildStore.getState().tutorLanguage).toBe('hi')

    await act(async () => {
      askViaInput('What was the result?')
    })

    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    expect(askTutor).toHaveBeenCalledWith('res_abc', EXECUTED_CIRCUIT, 'What was the result?', 'hi')
  })

  it('sends result_id, the executed circuit and the question — nothing computed', async () => {
    setExecutedResult()
    const answer: TutorAnswerResult = {
      answer: 'This is a Bell circuit: h(q0), cx(control=q0, target=q1).',
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      provenanceClass: 'SIMULATION',
      verificationStatus: 'VERIFIED',
      usedFallbackTemplate: true,
      facts: [{ id: 'F1', kind: 'circuit_summary', description: '2-qubit circuit: h(q0), cx(...)', resultId: 'res_abc' }],
    }
    askTutor.mockResolvedValueOnce(answer)

    render(<TutorPanel />)
    await act(async () => {
      askViaInput('What does this circuit do?')
    })

    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    expect(askTutor).toHaveBeenCalledWith('res_abc', EXECUTED_CIRCUIT, 'What does this circuit do?', 'en')
  })

  it('renders a grounded answer with its facts and provenance reference', async () => {
    setExecutedResult()
    askTutor.mockResolvedValueOnce({
      answer: 'For this result: outcome 00: probability 0.500000 (500 shots) (F3); outcome 11: probability 0.500000 (500 shots) (F4).',
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      provenanceClass: 'SIMULATION',
      verificationStatus: 'VERIFIED',
      usedFallbackTemplate: true,
      facts: [
        { id: 'F3', kind: 'probability', description: 'outcome 00: probability 0.500000 (500 shots)', resultId: 'res_abc' },
        { id: 'F4', kind: 'probability', description: 'outcome 11: probability 0.500000 (500 shots)', resultId: 'res_abc' },
      ],
    } satisfies TutorAnswerResult)

    render(<TutorPanel />)
    await act(async () => {
      askViaInput('What was the result?')
    })

    await waitFor(() =>
      expect(screen.getByText(/For this result: outcome 00/)).toBeInTheDocument(),
    )
    // The same phrase appears once in the answer text and once in the fact
    // list item below it — both are expected.
    expect(screen.getAllByText(/outcome 00: probability 0.500000 \(500 shots\)/)).toHaveLength(2)
    expect(screen.getAllByText(/outcome 11: probability 0.500000 \(500 shots\)/)).toHaveLength(2)
    expect(screen.getAllByText('F3', { exact: false }).length).toBeGreaterThan(0)
    expect(screen.getByText(/grounded in res_abc · SIMULATION · VERIFIED/)).toBeInTheDocument()
    expect(screen.getByText('template fallback · no AI')).toBeInTheDocument()
  })

  it('renders the unsupported-question answer as an honest reply, not an error', async () => {
    setExecutedResult()
    askTutor.mockResolvedValueOnce({
      answer:
        'I don\'t have a deterministic answer for that question yet. Try asking "what does this circuit do" or "what was the result".',
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      provenanceClass: 'SIMULATION',
      verificationStatus: 'VERIFIED',
      usedFallbackTemplate: true,
      facts: [],
    } satisfies TutorAnswerResult)

    render(<TutorPanel />)
    await act(async () => {
      askViaInput('Tell me a joke.')
    })

    await waitFor(() =>
      expect(screen.getByText(/don't have a deterministic answer/)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument()
  })

  it('shows an explicit error bubble and no fabricated answer on an API/network failure', async () => {
    setExecutedResult()
    askTutor.mockRejectedValueOnce(
      new BackendUnavailableError("no provenance record found for result_id 'res_abc'", 404),
    )

    render(<TutorPanel />)
    await act(async () => {
      askViaInput('What was the result?')
    })

    await waitFor(() => expect(screen.getByText(/no provenance record found/)).toBeInTheDocument())
  })

  it('shows a loading indicator while the request is in flight', async () => {
    setExecutedResult()
    let resolveAnswer!: (value: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(
      new Promise<TutorAnswerResult>((resolve) => {
        resolveAnswer = resolve
      }),
    )

    render(<TutorPanel />)
    fireEvent.change(screen.getByPlaceholderText('Ask about this result…'), {
      target: { value: 'What was the result?' },
    })
    fireEvent.click(screen.getByRole('button', { name: /ask/i }))

    await waitFor(() => expect(screen.getByText('reading the circuit…')).toBeInTheDocument())

    await act(async () => {
      resolveAnswer({
        answer: 'done',
        resultId: 'res_abc',
        circuitHash: 'hash_abc',
        provenanceClass: 'SIMULATION',
        verificationStatus: 'VERIFIED',
        usedFallbackTemplate: true,
        facts: [],
      })
    })
    await waitFor(() => expect(screen.queryByText('reading the circuit…')).not.toBeInTheDocument())
  })

  it('clears stale tutor turns when the circuit changes after an answer', async () => {
    setExecutedResult()
    askTutor.mockResolvedValueOnce({
      answer: 'This is a Bell circuit.',
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      provenanceClass: 'SIMULATION',
      verificationStatus: 'VERIFIED',
      usedFallbackTemplate: true,
      facts: [],
    } satisfies TutorAnswerResult)

    render(<TutorPanel />)
    await act(async () => {
      askViaInput('What does this circuit do?')
    })
    await waitFor(() => expect(screen.getByText('This is a Bell circuit.')).toBeInTheDocument())

    // Simulate what store.ts's addOp/removeOpAt/applyQasmEdit/setMode/runExecution
    // all do on any circuit or result change: clear result, verification and
    // tutor state together, since every past answer was grounded in the now-stale
    // circuit/result.
    await act(async () => {
      useBuildStore.setState({ result: null, tutorTurns: [], isAskingTutor: false })
    })

    expect(screen.queryByText('This is a Bell circuit.')).not.toBeInTheDocument()
    expect(screen.getByText('no result to ground on yet')).toBeInTheDocument()
  })

  it('discards an in-flight answer if the circuit changes before it resolves', async () => {
    setExecutedResult()
    let resolveAnswer!: (value: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(
      new Promise<TutorAnswerResult>((resolve) => {
        resolveAnswer = resolve
      }),
    )

    render(<TutorPanel />)
    fireEvent.change(screen.getByPlaceholderText('Ask about this result…'), {
      target: { value: 'What was the result?' },
    })
    fireEvent.click(screen.getByRole('button', { name: /ask/i }))
    await waitFor(() => expect(screen.getByText('reading the circuit…')).toBeInTheDocument())

    // The circuit changes (a new execution starts) while the request is still
    // in flight — the resolved answer must not resurrect a stale turn.
    await act(async () => {
      useBuildStore.setState({ result: null, tutorTurns: [], isAskingTutor: false })
    })

    await act(async () => {
      resolveAnswer({
        answer: 'stale answer for the old circuit',
        resultId: 'res_abc',
        circuitHash: 'hash_abc',
        provenanceClass: 'SIMULATION',
        verificationStatus: 'VERIFIED',
        usedFallbackTemplate: true,
        facts: [],
      })
    })

    expect(screen.queryByText('stale answer for the old circuit')).not.toBeInTheDocument()
  })
})
