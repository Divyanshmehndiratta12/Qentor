/**
 * Conversation scoping and free-text tutoring on Learn — the Guide's panel with
 * the REAL stores and the real embedded `TutorPanel`; only `@/api`'s client is
 * mocked (no backend).
 *
 * The rules under test (see `features/tutor/tutorContext.ts`): a panel shows
 * exactly ONE conversation — the Lab's, one lesson's, or none — and never
 * another context's. Moving between sections of a lesson keeps its
 * conversation; moving to a different lesson shows that lesson's own. The
 * answer language is independent of all of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ExecutePayload, Lesson, TutorAnswerResult } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { hzh } from '@/test/traceFixtures'

const askTutor = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(),
      verifyBellState: vi.fn(),
      listLessons: vi.fn(),
      optimizeCircuit: vi.fn(),
      runMultiInputTest: vi.fn(),
      traceCircuit: vi.fn(),
      askTutor,
    }),
  }
})

import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '@/features/learn/store'
import { GuidePanel } from './GuidePanel'

const PROVENANCE: Provenance = {
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'shots',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
}

const CIRCUIT = {
  ...emptyCircuit(2, 2),
  ops: [
    { gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx' as const, targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

const BELL: Lesson = {
  id: 'bell',
  title: 'Bell Lesson',
  shortDescription: 'SHORT DESCRIPTION TEXT',
  concept: 'entanglement',
  difficulty: 'beginner',
  estimatedMinutes: 10,
  learningObjectives: ['OBJECTIVE TEXT'],
  sections: [
    { type: 'explanation', id: 's1', title: 'Intro', body: 'SECRET LESSON BODY TEXT.' },
    {
      type: 'concept_check',
      id: 's2',
      title: 'Check',
      prompt: 'Check prompt.',
      question: 'The question?',
      options: [
        { id: 'a', text: 'Wrong option' },
        { id: 'b', text: 'Right option' },
      ],
      concept: 'entanglement',
    },
    { type: 'reflection', id: 's3', title: 'Reflect', prompt: 'Reflect prompt.' },
  ],
  linkedCircuit: CIRCUIT,
  prerequisiteLessonIds: [],
}

const INTERF: Lesson = {
  ...BELL,
  id: 'interf',
  title: 'Interference Lesson',
  sections: [
    { type: 'explanation', id: 's1', title: 'Waves', body: 'OTHER LESSON BODY TEXT.' },
    { type: 'reflection', id: 's2', title: 'Reflect', prompt: 'Other prompt.' },
  ],
}

const lessonAnswer = (text: string, lessonId: string, sectionId: string | null): TutorAnswerResult => ({
  answer: text,
  resultId: null,
  circuitHash: null,
  provenanceClass: null,
  verificationStatus: null,
  usedFallbackTemplate: true,
  facts: [],
  lessonId,
  sectionId,
})
const LAB_ANSWER: TutorAnswerResult = {
  answer: 'LAB ANSWER',
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  usedFallbackTemplate: true,
  facts: [],
}

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()

function seedResult() {
  const result = toQuantumValue<ExecutePayload>(
    { executionId: 'aer-local-abc', probabilities: { '00': 0.5, '11': 0.5 } },
    PROVENANCE,
  )
  act(() => {
    useBuildStore.setState({ circuit: CIRCUIT, result, isExecuting: false, executionError: null })
  })
  return result
}

/** Put the Learn store on `selected`, with the bell lesson at section index `bellIndex`. */
function learnOn(selected: 'bell' | 'interf' | null, bellIndex = 1) {
  act(() => {
    useLearnStore.setState({
      lessons: [BELL, INTERF],
      selectedLessonId: selected,
      lessonProgress: {
        bell: { activeSectionIndex: bellIndex, completedSectionIds: new Set(['s1']), conceptCheckAttempts: {} },
      },
    })
  })
}

const panel = () => screen.getByRole('complementary', { name: 'Qubi · AI Tutor' })
const input = () => within(panel()).getByRole('textbox', { name: 'Ask the tutor' }) as HTMLInputElement
const askButton = () => within(panel()).getByRole('button', { name: 'Ask' })
const quickButton = (name: string) =>
  within(within(panel()).getByRole('region', { name: 'Quick questions' })).getByRole('button', { name })
const language = () => within(panel()).getByRole('combobox', { name: 'Tutor answer language' }) as HTMLSelectElement
const contextAttr = () => panel().querySelector('[data-tutor-context]')?.getAttribute('data-tutor-context')
function typeAndAsk(text: string) {
  fireEvent.change(input(), { target: { value: text } })
  fireEvent.click(askButton())
}

beforeEach(() => {
  askTutor.mockReset()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})
afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})

describe('free-text tutoring on Learn', () => {
  beforeEach(() => askTutor.mockResolvedValue(lessonAnswer('LESSON ANSWER', 'bell', 's2')))

  it('the input is ENABLED with a lesson open and no Lab result, and says what it is for', () => {
    learnOn('bell')
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    expect(useBuildStore.getState().result).toBeNull()
    expect(input()).toBeEnabled()
    expect(input().placeholder).toBe('Ask about this lesson…')
  })

  it('a typed question is sent with lesson_id and section_id (no result, no circuit) and the selected language', async () => {
    learnOn('bell') // section s2
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    fireEvent.change(language(), { target: { value: 'hi' } })

    typeAndAsk('What is a qubit?')

    await screen.findByText('LESSON ANSWER')
    expect(askTutor).toHaveBeenCalledTimes(1)
    expect(askTutor.mock.calls[0]).toEqual([null, null, 'What is a qubit?', 'hi', { lessonId: 'bell', sectionId: 's2' }])
    expect(input().value).toBe('')
  })

  it('pressing Enter in the input asks (keyboard-only use works)', async () => {
    learnOn('bell')
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    fireEvent.change(input(), { target: { value: 'What is a qubit?' } })
    fireEvent.keyDown(input(), { key: 'Enter' })

    await screen.findByText('LESSON ANSWER')
    expect(askTutor).toHaveBeenCalledTimes(1)
  })

  it('a whitespace-only question is not sent', () => {
    learnOn('bell')
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    fireEvent.change(input(), { target: { value: '   ' } })
    expect(askButton()).toBeDisabled()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(askTutor).not.toHaveBeenCalled()
  })

  it('never sends lesson text, title, objectives, quiz options/answer/rationale or correct_option_id', async () => {
    learnOn('bell') // on the concept-check section
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    typeAndAsk('What is a qubit?')

    await screen.findByText('LESSON ANSWER')
    const sent = JSON.stringify(askTutor.mock.calls[0])
    for (const leaked of [
      'SECRET LESSON BODY', 'Bell Lesson', 'SHORT DESCRIPTION', 'OBJECTIVE TEXT', 'Check prompt', 'The question?',
      'Wrong option', 'Right option', 'QUIZ RATIONALE', 'correctOptionId', 'correct_option_id', 'Reflect prompt', 'entanglement',
    ]) {
      expect(sent, leaked).not.toContain(leaked)
    }
    expect(Object.keys(askTutor.mock.calls[0]![4]).sort()).toEqual(['lessonId', 'sectionId'])
  })

  it('a follow-up stays in the same lesson: same lesson_id/section_id, one independent request each, no history sent', async () => {
    learnOn('bell')
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    typeAndAsk('What is a qubit?')
    await waitFor(() => expect(within(panel()).getAllByText('LESSON ANSWER')).toHaveLength(1))
    typeAndAsk('Explain that more simply.')
    await waitFor(() => expect(within(panel()).getAllByText('LESSON ANSWER')).toHaveLength(2))

    expect(askTutor.mock.calls.map((c) => [c[2], c[4]])).toEqual([
      ['What is a qubit?', { lessonId: 'bell', sectionId: 's2' }],
      ['Explain that more simply.', { lessonId: 'bell', sectionId: 's2' }],
    ])
    expect(askTutor.mock.calls.every((c) => c.length === 5)).toBe(true) // no conversation-history argument
    expect(within(panel()).getByText('What is a qubit?')).toBeInTheDocument()
    expect(within(panel()).getByText('Explain that more simply.')).toBeInTheDocument()
  })

  it('the Ask button and input are disabled while a request runs, and the wait is announced', async () => {
    learnOn('bell')
    let resolve!: (a: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((r) => (resolve = r)))
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    typeAndAsk('What is a qubit?')

    await waitFor(() => expect(input()).toBeDisabled())
    expect(askButton()).toBeDisabled()
    expect(within(panel()).getByRole('status')).toHaveTextContent('reading the lesson…')
    for (const b of within(within(panel()).getByRole('region', { name: 'Quick questions' })).getAllByRole('button')) {
      expect(b).toBeDisabled()
    }

    await act(async () => resolve(lessonAnswer('LESSON ANSWER', 'bell', 's2')))
    await screen.findByText('LESSON ANSWER')
    expect(input()).toBeEnabled()
    expect(within(panel()).queryByRole('status')).not.toBeInTheDocument()
  })

  it('a failure is announced as an alert, and the input works again', async () => {
    learnOn('bell')
    askTutor.mockRejectedValueOnce(new Error("no lesson with id 'bell'"))
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    typeAndAsk('What is a qubit?')

    expect(await within(panel()).findByRole('alert')).toHaveTextContent("no lesson with id 'bell'")
    expect(input()).toBeEnabled()
  })

  it('with no lesson open the input is disabled and says so — it never becomes a Lab question', () => {
    seedResult() // even with a Lab result on hand
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    expect(input()).toBeDisabled()
    expect(input().placeholder).toBe('Open a lesson first…')
    expect(within(panel()).getByText(/No lesson is open, so there is nothing to ask about yet/)).toBeInTheDocument()
    expect(within(panel()).getByText(/Open a lesson to ask about it/)).toBeInTheDocument() // the Guide's own notice: a different sentence
    expect(askTutor).not.toHaveBeenCalled()
  })

  it('the input has an accessible name, and the conversation is a labelled live log', () => {
    learnOn('bell')
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(input()).toHaveAccessibleName('Ask the tutor')
    expect(within(panel()).getByRole('log', { name: 'Tutor conversation' })).toHaveAttribute('aria-live', 'polite')
  })
})

describe('conversations never cross contexts', () => {
  const BELL_ANSWER = lessonAnswer('ANSWER FOR THE BELL LESSON', 'bell', 's2')
  const INTERF_ANSWER = lessonAnswer('ANSWER FOR THE INTERFERENCE LESSON', 'interf', 's1')

  it('moving to a DIFFERENT lesson never shows the previous lesson’s messages', async () => {
    learnOn('bell')
    askTutor.mockResolvedValueOnce(BELL_ANSWER)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    typeAndAsk('Question about bell')
    await screen.findByText('ANSWER FOR THE BELL LESSON')
    expect(contextAttr()).toBe('lesson:bell')

    learnOn('interf')

    expect(contextAttr()).toBe('lesson:interf')
    expect(within(panel()).queryByText('Question about bell')).not.toBeInTheDocument()
    expect(within(panel()).queryByText('ANSWER FOR THE BELL LESSON')).not.toBeInTheDocument()
    expect(within(panel()).getByText(/Ask a question about this lesson, or pick a quick question above/)).toBeInTheDocument()
  })

  it('a question asked in the new lesson uses the NEW lesson’s ids and lands only there', async () => {
    learnOn('bell')
    askTutor.mockResolvedValueOnce(BELL_ANSWER).mockResolvedValueOnce(INTERF_ANSWER)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    typeAndAsk('Question about bell')
    await screen.findByText('ANSWER FOR THE BELL LESSON')

    learnOn('interf')
    typeAndAsk('Question about interference')

    await screen.findByText('ANSWER FOR THE INTERFERENCE LESSON')
    expect(askTutor.mock.calls[1]![4]).toEqual({ lessonId: 'interf', sectionId: 's1' })
    expect(within(panel()).queryByText('ANSWER FOR THE BELL LESSON')).not.toBeInTheDocument()
    expect(within(panel()).getAllByText(/^Question about/).map((n) => n.textContent)).toEqual(['Question about interference'])
  })

  it('returning to the first lesson restores ITS conversation (in memory, this session) and only its own', async () => {
    learnOn('bell')
    askTutor.mockResolvedValueOnce(BELL_ANSWER).mockResolvedValueOnce(INTERF_ANSWER)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    typeAndAsk('Question about bell')
    await screen.findByText('ANSWER FOR THE BELL LESSON')
    learnOn('interf')
    typeAndAsk('Question about interference')
    await screen.findByText('ANSWER FOR THE INTERFERENCE LESSON')

    learnOn('bell')

    expect(within(panel()).getByText('ANSWER FOR THE BELL LESSON')).toBeInTheDocument()
    expect(within(panel()).queryByText('ANSWER FOR THE INTERFERENCE LESSON')).not.toBeInTheDocument()
  })

  it('moving between SECTIONS of the same lesson keeps the lesson’s conversation; each ask names its current section', async () => {
    learnOn('bell', 0) // section s1
    askTutor.mockResolvedValue(BELL_ANSWER)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    typeAndAsk('Question on s1')
    await screen.findByText('ANSWER FOR THE BELL LESSON')

    learnOn('bell', 2) // now section s3
    expect(within(panel()).getByText('ANSWER FOR THE BELL LESSON')).toBeInTheDocument()
    expect(within(panel()).getByText('Question on s1')).toBeInTheDocument()
    typeAndAsk('Question on s3')
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(2))

    expect(askTutor.mock.calls.map((c) => c[4].sectionId)).toEqual(['s1', 's3'])
  })

  it('Learn → Lab → Learn: each screen shows only its own conversation', async () => {
    const result = seedResult()
    learnOn('bell')
    act(() => {
      useBuildStore.setState({
        tutorTurns: [
          { role: 'learner', text: 'LAB QUESTION' },
          { role: 'tutor', answer: LAB_ANSWER },
        ],
      })
    })
    askTutor.mockResolvedValueOnce(BELL_ANSWER)
    const view = render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    // Learn: the Lab conversation is not shown as a lesson conversation
    expect(contextAttr()).toBe('lesson:bell')
    expect(within(panel()).queryByText('LAB QUESTION')).not.toBeInTheDocument()
    expect(within(panel()).queryByText('LAB ANSWER')).not.toBeInTheDocument()
    typeAndAsk('Question about bell')
    await screen.findByText('ANSWER FOR THE BELL LESSON')

    // Lab: the lesson conversation is not shown as a Lab conversation
    view.rerender(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(contextAttr()).toBe('lab')
    expect(within(panel()).getByText('LAB ANSWER')).toBeInTheDocument()
    expect(within(panel()).queryByText('Question about bell')).not.toBeInTheDocument()
    expect(within(panel()).queryByText('ANSWER FOR THE BELL LESSON')).not.toBeInTheDocument()

    // Back to Learn: the lesson's conversation is there again, the Lab's still is not
    view.rerender(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(within(panel()).getByText('ANSWER FOR THE BELL LESSON')).toBeInTheDocument()
    expect(within(panel()).queryByText('LAB ANSWER')).not.toBeInTheDocument()
    expect(useBuildStore.getState().result).toBe(result) // the Lab result was never disturbed
  })

  it('Learn with no lesson open shows neither a lesson’s nor the Lab’s conversation', () => {
    seedResult()
    learnOn(null)
    act(() => {
      useBuildStore.setState({
        tutorTurns: [{ role: 'learner', text: 'LAB QUESTION' }],
        lessonTutorTurns: { bell: [{ role: 'learner', text: 'BELL QUESTION' }] },
      })
    })
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    expect(contextAttr()).toBe('none')
    expect(within(panel()).queryByText('LAB QUESTION')).not.toBeInTheDocument()
    expect(within(panel()).queryByText('BELL QUESTION')).not.toBeInTheDocument()
  })

  it('a Lab circuit/result reset does not erase the lesson conversation', async () => {
    learnOn('bell')
    askTutor.mockResolvedValueOnce(BELL_ANSWER)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    typeAndAsk('Question about bell')
    await screen.findByText('ANSWER FOR THE BELL LESSON')

    act(() => useBuildStore.getState().loadCircuit(CIRCUIT)) // the app's own full Lab reset

    expect(within(panel()).getByText('ANSWER FOR THE BELL LESSON')).toBeInTheDocument()
  })

  it('closing and reopening the Guide destroys no conversation — it is not the Guide’s to clear', async () => {
    learnOn('bell')
    askTutor.mockResolvedValueOnce(BELL_ANSWER)
    const first = render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    typeAndAsk('Question about bell')
    await screen.findByText('ANSWER FOR THE BELL LESSON')
    first.unmount()

    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    expect(within(panel()).getByText('ANSWER FOR THE BELL LESSON')).toBeInTheDocument()
  })

  it('an answer that arrives after the learner changed lesson shows in the lesson it was asked in, not the current one', async () => {
    learnOn('bell')
    let resolve!: (a: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((r) => (resolve = r)))
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    typeAndAsk('Slow question about bell')
    await waitFor(() => expect(input()).toBeDisabled())

    learnOn('interf')
    expect(input()).toBeEnabled() // the other lesson is not blocked by bell's pending request
    await act(async () => resolve(BELL_ANSWER))

    expect(within(panel()).queryByText('ANSWER FOR THE BELL LESSON')).not.toBeInTheDocument()
    learnOn('bell')
    expect(within(panel()).getByText('ANSWER FOR THE BELL LESSON')).toBeInTheDocument()
  })

  it('switching the answer language changes neither the lesson context nor the conversation; switching lesson keeps the language', async () => {
    learnOn('bell')
    askTutor.mockResolvedValue(BELL_ANSWER)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    typeAndAsk('Question about bell')
    await screen.findByText('ANSWER FOR THE BELL LESSON')

    fireEvent.change(language(), { target: { value: 'kn' } })
    expect(contextAttr()).toBe('lesson:bell')
    expect(within(panel()).getByText('ANSWER FOR THE BELL LESSON')).toBeInTheDocument()

    learnOn('interf')
    expect(language().value).toBe('kn') // the language survived the lesson change
    typeAndAsk('Question in Kannada')
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(2))
    expect(askTutor.mock.calls[1]).toEqual([null, null, 'Question in Kannada', 'kn', { lessonId: 'interf', sectionId: 's1' }])
  })

  it('a quick action and a typed question share the same lesson conversation', async () => {
    learnOn('bell')
    askTutor.mockResolvedValue(BELL_ANSWER)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Explain this concept'))
    await waitFor(() => expect(within(panel()).getAllByText('ANSWER FOR THE BELL LESSON')).toHaveLength(1))
    typeAndAsk('And a typed follow-up')
    await waitFor(() => expect(within(panel()).getAllByText('ANSWER FOR THE BELL LESSON')).toHaveLength(2))

    expect(useBuildStore.getState().lessonTutorTurns.bell).toHaveLength(4)
  })
})

describe('the Lab is unchanged', () => {
  it('a typed Lab question needs a result and sends the original four arguments, with the existing provenance line', async () => {
    askTutor.mockResolvedValue(LAB_ANSWER)
    const result = seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    expect(input().placeholder).toBe('Ask about this result…')
    typeAndAsk('What was the result?')

    await screen.findByText('LAB ANSWER')
    expect(askTutor.mock.calls[0]).toEqual([result.provenance.resultId, CIRCUIT, 'What was the result?', 'en'])
    expect(within(panel()).getByText('grounded in res_abc · SIMULATION · state checked')).toBeInTheDocument()
    expect(within(panel()).queryByText(/lesson material/)).not.toBeInTheDocument()
    expect(useBuildStore.getState().lessonTutorTurns).toEqual({}) // nothing leaked into any lesson
  })

  it('the Lab input stays disabled without a result', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(input()).toBeDisabled()
    expect(input().placeholder).toBe('Run the circuit first…')
  })

  it('a lesson answer and a mixed lesson + result answer are labelled differently from a plain result answer', () => {
    learnOn('bell')
    const mixed: TutorAnswerResult = { ...LAB_ANSWER, answer: 'MIXED ANSWER', lessonId: 'bell', sectionId: 's2' }
    act(() => {
      useBuildStore.setState({
        lessonTutorTurns: {
          bell: [
            { role: 'tutor', answer: lessonAnswer('LESSON ONLY ANSWER', 'bell', 's2') },
            { role: 'tutor', answer: mixed },
          ],
        },
      })
    })
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    // lesson-only: no result, no provenance
    expect(within(panel()).getByText('from lesson bell · section s2 · lesson material, not a quantum result')).toBeInTheDocument()
    // mixed: the result's provenance line, and SEPARATELY the lesson line
    expect(within(panel()).getByText('grounded in res_abc · SIMULATION · state checked')).toBeInTheDocument()
    expect(within(panel()).getByText('plus lesson bell · section s2 · lesson material, not a quantum result')).toBeInTheDocument()
  })
})

describe('state isolation while switching context and asking', () => {
  it('leaves circuit, result, verification, optimizer, multi-input, trace, Learn progress and streak history untouched', async () => {
    const result = seedResult()
    learnOn('bell')
    askTutor.mockResolvedValue(lessonAnswer('LESSON ANSWER', 'bell', 's2'))
    act(() => {
      useBuildStore.setState({
        verification: {
          resultId: 'res_abc',
          circuitHash: 'hash_abc',
          verifier: 'bell-state',
          verificationStatus: 'VERIFIED',
          checks: [],
          expectedSupport: [],
          observedSupport: [],
        },
        trace: hzh(),
      })
    })
    const b0 = useBuildStore.getState()
    const l0 = useLearnStore.getState()
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    typeAndAsk('What is a qubit?')
    await screen.findByText('LESSON ANSWER')
    learnOn('interf')
    learnOn('bell')
    fireEvent.click(quickButton('Give me a hint'))
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(2))

    const b1 = useBuildStore.getState()
    expect(b1.circuit).toBe(b0.circuit)
    expect(b1.result).toBe(result)
    expect(b1.verification).toBe(b0.verification)
    expect(b1.optimization).toBe(b0.optimization)
    expect(b1.multiInputTest).toBe(b0.multiInputTest)
    expect(b1.trace).toBe(b0.trace)
    expect(b1.tutorTurns).toBe(b0.tutorTurns) // the Lab conversation was not touched by lesson chat
    expect(b1.isAskingTutor).toBe(false)
    const l1 = useLearnStore.getState()
    // (`learnOn` in this test re-seeds the selection, so progress is compared by value.)
    expect(l1.lessonProgress.bell).toEqual(l0.lessonProgress.bell)
    expect(l1.activityHistory).toBe(l0.activityHistory) // streak history: the same object, never written
  })
})
