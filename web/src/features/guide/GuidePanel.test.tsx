/**
 * The Guide's side panel, with the REAL stores and the real embedded
 * `TutorPanel`; only `@/api`'s client is mocked (no backend). Covers: the shell
 * (heading, close, Escape, focus), that the existing tutor is reused rather
 * than reimplemented, quick actions (what they send, when they are enabled),
 * Lab/Learn context, the tutor language, and that nothing the panel touches is
 * reset or mutated by opening/closing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
import { TutorPanel } from '@/features/tutor/TutorPanel'
import { GuidePanel } from './GuidePanel'
import {
  LAB_QUICK_ACTIONS,
  LEARN_NEEDS_LESSON_NOTICE,
  LEARN_QUICK_ACTIONS,
  LEARN_SOURCE_LINE,
} from './guideContext'

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

const CIRCUIT = {
  ...emptyCircuit(2, 2),
  ops: [
    { gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx' as const, targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

const LESSON: Lesson = {
  id: 'bell',
  title: 'Bell Lesson',
  shortDescription: 'desc',
  concept: 'entanglement',
  difficulty: 'beginner',
  estimatedMinutes: 10,
  learningObjectives: ['obj'],
  sections: [
    { type: 'explanation', id: 's1', title: 'Intro', body: 'SECRET LESSON BODY TEXT.' },
    { type: 'interactive_lab', id: 's2', title: 'Build it', instructions: 'Do the thing.', capability: 'execute' },
    { type: 'reflection', id: 's3', title: 'Reflect', prompt: 'Reflect prompt.' },
  ],
  linkedCircuit: CIRCUIT,
  prerequisiteLessonIds: [],
}

const ANSWER: TutorAnswerResult = {
  answer: 'For this result: p(00) = 0.5 (fact_1).',
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'VERIFIED',
  usedFallbackTemplate: true,
  facts: [],
}

// What the backend returns for a lesson-only question: course material, so no
// result, no circuit hash and no provenance (a lesson is not a quantum result).
const LESSON_ANSWER: TutorAnswerResult = {
  answer: 'About this part of the lesson: BACKEND LESSON ANSWER (L3).',
  resultId: null,
  circuitHash: null,
  provenanceClass: null,
  verificationStatus: null,
  usedFallbackTemplate: true,
  facts: [{ id: 'L3', kind: 'lesson_section', description: 'section s2 "Build it" (interactive lab)', resultId: null }],
  lessonId: 'bell',
  sectionId: 's2',
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

function seedLesson(activeSectionIndex = 1) {
  act(() => {
    useLearnStore.setState({
      lessons: [LESSON],
      selectedLessonId: 'bell',
      lessonProgress: {
        bell: { activeSectionIndex, completedSectionIds: new Set(['s1']), conceptCheckAttempts: {} },
      },
    })
  })
}

const panel = () => screen.getByRole('complementary', { name: 'Qentor Guide' })
const quick = () => within(screen.getByRole('region', { name: 'Quick questions' }))
const quickButton = (name: string) => quick().getByRole('button', { name })
const language = () => screen.getByRole('combobox', { name: 'Tutor answer language' }) as HTMLSelectElement

beforeEach(() => {
  askTutor.mockReset()
  askTutor.mockResolvedValue(ANSWER)
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})

afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})

describe('the panel shell', () => {
  it('is a labelled complementary region with a heading and the current context', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    expect(panel()).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Qentor Guide' })).toBeInTheDocument()
    expect(within(panel()).getByText('Lab')).toBeInTheDocument()
  })

  it('says "Learn" on the Learn screen', () => {
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(within(panel()).getByText('Learn')).toBeInTheDocument()
  })

  it('has a clear close button that closes it', () => {
    const onClose = vi.fn()
    render(<GuidePanel screen="lab" onClose={onClose} />)

    const close = screen.getByRole('button', { name: 'Close guide panel' })
    expect(close.tagName).toBe('BUTTON')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape — also when focus is inside the tutor input', () => {
    const onClose = vi.fn()
    render(<GuidePanel screen="lab" onClose={onClose} />)

    fireEvent.keyDown(panel(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByPlaceholderText('Run the circuit first…'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('ignores other keys', () => {
    const onClose = vi.fn()
    render(<GuidePanel screen="lab" onClose={onClose} />)
    fireEvent.keyDown(panel(), { key: 'Enter' })
    fireEvent.keyDown(panel(), { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('moves focus into the panel when it opens', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(panel()).toHaveFocus()
  })

  it('is a normal complementary panel, not a modal: no focus trap, everything stays reachable', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    expect(panel()).not.toHaveAttribute('aria-modal')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    for (const b of within(panel()).getAllByRole('button')) expect(b.getAttribute('tabindex')).not.toBe('-1')
  })

  it('slides in with the restrained entrance class (which reduced motion switches off in CSS)', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(panel()).toHaveClass('qentor-guide-panel')
    expect(panel().className).toContain('top-[52px]') // starts below the top bar, so navigation is never covered
  })

  it('every control has a visible focus style', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Close guide panel' }).className).toContain('focus-visible:outline')
    expect(quickButton('Explain this circuit').className).toContain('focus-visible:outline')
  })
})

describe('it reuses the existing tutor — there is no second chatbot', () => {
  it('embeds the existing TutorPanel: its heading, language selector and input are all here, once', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    expect(within(panel()).getByRole('heading', { level: 2, name: 'Tutor' })).toBeInTheDocument()
    expect(within(panel()).getAllByRole('combobox', { name: 'Tutor answer language' })).toHaveLength(1)
    expect(within(panel()).getAllByPlaceholderText('Run the circuit first…')).toHaveLength(1)
    expect(within(panel()).getByText('no result to ground on yet')).toBeInTheDocument()
  })

  it('shows the tutor’s own provenance badge for the result it grounds on', () => {
    seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    expect(within(panel()).getByText('Simulated')).toBeInTheDocument()
    expect(within(panel()).getByPlaceholderText('Ask about this result…')).toBeEnabled()
  })

  it('renders the store’s existing conversation, including the deterministic-fallback label', () => {
    seedResult()
    act(() => {
      useBuildStore.setState({
        tutorTurns: [
          { role: 'learner', text: 'What was the result?' },
          { role: 'tutor', answer: ANSWER },
        ],
      })
    })
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    expect(within(panel()).getByText('What was the result?')).toBeInTheDocument()
    expect(within(panel()).getByText(ANSWER.answer)).toBeInTheDocument()
    expect(within(panel()).getByText('template fallback · no AI')).toBeInTheDocument()
    expect(within(panel()).getByText(/grounded in res_abc/)).toBeInTheDocument()
  })

  it('does not duplicate the tutor’s own starter chips (the Guide offers its own quick questions)', () => {
    seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(within(panel()).queryByRole('button', { name: 'What does this circuit do?' })).not.toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'What was the result?' })).not.toBeInTheDocument()
  })

  it('leaves the standalone TutorPanel (the Lab footer) exactly as it was: starters still shown by default', () => {
    seedResult()
    render(<TutorPanel />)
    expect(screen.getByRole('button', { name: 'What does this circuit do?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'What was the result?' })).toBeInTheDocument()
  })

  it('a question typed in the embedded tutor goes through the same existing request', async () => {
    const result = seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    fireEvent.change(within(panel()).getByPlaceholderText('Ask about this result…'), { target: { value: 'What was the result?' } })
    fireEvent.click(within(panel()).getByRole('button', { name: 'Ask' }))

    await screen.findByText(ANSWER.answer)
    expect(askTutor).toHaveBeenCalledWith(result.provenance.resultId, CIRCUIT, 'What was the result?', 'en')
  })
})

describe('Lab quick actions', () => {
  it('renders the three Lab quick questions', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { level: 3, name: 'Quick questions' })).toBeInTheDocument()
    expect(quick().getAllByRole('button').map((b) => b.textContent)).toEqual([...LAB_QUICK_ACTIONS])
  })

  it('are disabled with no real result, with an explanation — and clicking does nothing', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    for (const b of quick().getAllByRole('button')) expect(b).toBeDisabled()
    expect(quick().getByText(/unlock once there is a real result to ask about/)).toBeInTheDocument()

    fireEvent.click(quickButton('Explain this circuit'))
    expect(askTutor).not.toHaveBeenCalled()
    expect(useBuildStore.getState().result).toBeNull() // no result was conjured
    expect(useBuildStore.getState().tutorTurns).toEqual([])
  })

  it.each(LAB_QUICK_ACTIONS)('“%s” sends exactly that question, with the result id, circuit and language — nothing else', async (question) => {
    const result = seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    fireEvent.click(quickButton(question))

    await screen.findByText(ANSWER.answer)
    expect(askTutor).toHaveBeenCalledTimes(1)
    const args = askTutor.mock.calls[0]!
    expect(args).toHaveLength(4) // result id, circuit, question, language
    expect(args).toEqual([result.provenance.resultId, CIRCUIT, question, 'en'])
  })

  it('the question and the backend’s answer appear in the tutor conversation', async () => {
    seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Explain my result'))

    expect(await within(panel()).findByText(ANSWER.answer)).toBeInTheDocument()
    expect(within(panel()).getAllByText('Explain my result').length).toBeGreaterThanOrEqual(2) // the button + the learner bubble
    expect(useBuildStore.getState().tutorTurns.map((t) => t.role)).toEqual(['learner', 'tutor'])
  })

  it('renders the answer exactly as the API returned it — no frontend answer is added', async () => {
    seedResult()
    askTutor.mockResolvedValueOnce({ ...ANSWER, answer: 'API-SUPPLIED TEXT ONLY.', usedFallbackTemplate: false })
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Explain this circuit'))

    expect(await screen.findByText('API-SUPPLIED TEXT ONLY.')).toBeInTheDocument()
    expect(within(panel()).queryByText('template fallback · no AI')).not.toBeInTheDocument()
  })

  it('are disabled while the tutor is answering', () => {
    seedResult()
    act(() => useBuildStore.setState({ isAskingTutor: true }))
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    for (const b of quick().getAllByRole('button')) expect(b).toBeDisabled()
    expect(quick().getByText('Waiting for the tutor…')).toBeInTheDocument()
  })

  it('an API failure is shown by the tutor as it always is — no substitute answer', async () => {
    seedResult()
    askTutor.mockRejectedValueOnce(new Error('backend down'))
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Explain this circuit'))

    expect(await within(panel()).findByText('backend down')).toBeInTheDocument()
    expect(useBuildStore.getState().tutorTurns.map((t) => t.role)).toEqual(['learner', 'error'])
  })
})

describe('Learn quick actions', () => {
  beforeEach(() => askTutor.mockResolvedValue(LESSON_ANSWER))

  it('renders the three Learn questions', () => {
    seedLesson()
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(quick().getAllByRole('button').map((b) => b.textContent)).toEqual([...LEARN_QUICK_ACTIONS])
  })

  it('are disabled with no lesson open, and say why — clicking does nothing', () => {
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    for (const b of quick().getAllByRole('button')) expect(b).toBeDisabled()
    expect(quick().getByText(LEARN_NEEDS_LESSON_NOTICE)).toBeInTheDocument()
    fireEvent.click(quickButton('Give me a hint'))
    expect(askTutor).not.toHaveBeenCalled()
    expect(useBuildStore.getState().tutorTurns).toEqual([])
  })

  it('are ENABLED with a lesson open and NO Lab result — the lesson is the context', () => {
    seedLesson()
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    expect(useBuildStore.getState().result).toBeNull()
    for (const b of quick().getAllByRole('button')) expect(b).toBeEnabled()
    expect(quick().queryByText(LEARN_NEEDS_LESSON_NOTICE)).not.toBeInTheDocument()
  })

  it('no longer show the old "lesson-aware answers aren’t available" limitation', () => {
    seedLesson()
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(panel().textContent).not.toMatch(/aren’t available yet|can’t see lesson text/)
    expect(within(panel()).getByText(LEARN_SOURCE_LINE)).toBeInTheDocument()
  })

  it.each(LEARN_QUICK_ACTIONS)('“%s” sends the fixed question with lesson_id and section_id — IDs only', async (question) => {
    seedLesson(1) // section s2
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    fireEvent.click(quickButton(question))

    await screen.findByText(LESSON_ANSWER.answer)
    expect(askTutor).toHaveBeenCalledTimes(1)
    // resultId, circuit, question, language, lesson
    expect(askTutor.mock.calls[0]).toEqual([null, null, question, 'en', { lessonId: 'bell', sectionId: 's2' }])
  })

  it('sends the CURRENT section id, following the lesson step live', async () => {
    seedLesson(0)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    seedLesson(2)

    fireEvent.click(quickButton('Explain this concept'))

    await screen.findByText(LESSON_ANSWER.answer)
    expect(askTutor.mock.calls[0]![4]).toEqual({ lessonId: 'bell', sectionId: 's3' })
  })

  it('when every step is done, names the lesson and no section', async () => {
    seedLesson(3) // past the last section
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Explain this concept'))

    await screen.findByText(LESSON_ANSWER.answer)
    expect(askTutor.mock.calls[0]![4]).toEqual({ lessonId: 'bell', sectionId: null })
  })

  it('never sends lesson text, titles, a circuit or a result — even when a Lab result exists', async () => {
    seedResult()
    seedLesson(1)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Give me a hint'))

    await screen.findByText(LESSON_ANSWER.answer)
    const args = askTutor.mock.calls[0]!
    expect(args.slice(0, 2)).toEqual([null, null]) // no result id, no circuit
    expect(JSON.stringify(args)).not.toMatch(/Bell Lesson|SECRET LESSON BODY|Build it|Do the thing|res_abc/)
  })

  it('renders the backend’s lesson answer, labelled as lesson material — not as a quantum result', async () => {
    seedLesson(1)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Explain this concept'))

    expect(await within(panel()).findByText(LESSON_ANSWER.answer)).toBeInTheDocument()
    expect(within(panel()).getByText(/from lesson bell · section s2 · lesson material, not a quantum result/)).toBeInTheDocument()
    expect(within(panel()).queryByText(/grounded in/)).not.toBeInTheDocument() // no result provenance was invented
    expect(within(panel()).getByText('template fallback · no AI')).toBeInTheDocument()
    expect(useBuildStore.getState().lessonTutorTurns.bell!.map((t) => t.role)).toEqual(['learner', 'tutor'])
  })

  it('the tutor language selected in the panel is what a lesson question sends', async () => {
    seedLesson(1)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    fireEvent.change(language(), { target: { value: 'kn' } })

    fireEvent.click(quickButton('Give me a simpler explanation'))

    await screen.findByText(LESSON_ANSWER.answer)
    expect(askTutor.mock.calls[0]).toEqual([null, null, 'Give me a simpler explanation', 'kn', { lessonId: 'bell', sectionId: 's2' }])
    expect(useBuildStore.getState().tutorLanguage).toBe('kn') // unchanged by asking
  })

  it('a backend refusal (e.g. an unknown lesson) is shown as an error turn — no substitute answer', async () => {
    seedLesson(1)
    askTutor.mockRejectedValueOnce(new Error("no lesson with id 'bell'"))
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Give me a hint'))

    expect(await within(panel()).findByText("no lesson with id 'bell'")).toBeInTheDocument()
    expect(useBuildStore.getState().lessonTutorTurns.bell!.map((t) => t.role)).toEqual(['learner', 'error'])
  })

  it('are disabled while the tutor is answering', () => {
    seedLesson(1)
    act(() => useBuildStore.setState({ lessonAskingTutor: { bell: true } }))
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    for (const b of quick().getAllByRole('button')) expect(b).toBeDisabled()
  })

  it('the embedded tutor’s idle message no longer tells a Learn user to run a circuit first', () => {
    seedLesson(1)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(within(panel()).getByText(/Ask a question about this lesson, or pick a quick question above/)).toBeInTheDocument()
    expect(within(panel()).queryByText(/Run the circuit to get a result/)).not.toBeInTheDocument()
  })

  it('Lab quick actions are unchanged: no lesson argument, exactly four arguments', async () => {
    askTutor.mockResolvedValue(ANSWER)
    seedLesson(1) // a lesson being open in Learn must not leak into a Lab question
    const result = seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Explain this circuit'))

    await screen.findByText(ANSWER.answer)
    const args = askTutor.mock.calls[0]!
    expect(args).toHaveLength(4)
    expect(args).toEqual([result.provenance.resultId, CIRCUIT, 'Explain this circuit', 'en'])
  })
})

describe('context', () => {
  it('Lab, no result: describes the circuit and does not fabricate a result', () => {
    act(() => useBuildStore.setState({ circuit: CIRCUIT }))
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    const card = screen.getByRole('region', { name: 'Guide context' })
    expect(within(card).getByText('2 qubits · 2 operations in the circuit')).toBeInTheDocument()
    expect(within(card).getByText('No result yet — run the circuit, then ask about it.')).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/res_|Latest result/)
  })

  it('Lab, with a result: names the real result', () => {
    seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(within(screen.getByRole('region', { name: 'Guide context' })).getByText('Latest result: res_abc (shots, qiskit-aer)')).toBeInTheDocument()
  })

  it('Lab: a loaded trace is mentioned by step count only', () => {
    act(() => useBuildStore.setState({ trace: hzh() }))
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(screen.getByText('A trace of this circuit is loaded (4 steps).')).toBeInTheDocument()
  })

  it('Learn: shows the open lesson and step from the Learn store, and follows it live', () => {
    seedLesson(1)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    const card = screen.getByRole('region', { name: 'Guide context' })
    expect(within(card).getByText('Lesson: Bell Lesson')).toBeInTheDocument()
    expect(within(card).getByText('Step 2 of 3: Build it')).toBeInTheDocument()

    seedLesson(2)
    expect(within(card).getByText('Step 3 of 3: Reflect')).toBeInTheDocument()
  })

  it('Learn: lesson content is not copied into the panel (titles only)', () => {
    seedLesson(0)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(panel().textContent).not.toContain('SECRET LESSON BODY TEXT.')
    expect(panel().textContent).not.toContain('Do the thing.')
  })

  it('Learn, nothing open: says so', () => {
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(screen.getByText('No lesson is open — pick one from the list.')).toBeInTheDocument()
  })
})

describe('language', () => {
  it('offers English, Hindi and Kannada from the existing selector, bound to the store', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    expect(within(language()).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['en', 'hi', 'kn'])
    fireEvent.change(language(), { target: { value: 'kn' } })
    expect(useBuildStore.getState().tutorLanguage).toBe('kn')
  })

  it('survives closing and reopening the Guide — it is not reset', () => {
    const first = render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    fireEvent.change(language(), { target: { value: 'hi' } })
    first.unmount() // "close"

    render(<GuidePanel screen="lab" onClose={vi.fn()} />) // "reopen"
    expect(language().value).toBe('hi')
    expect(useBuildStore.getState().tutorLanguage).toBe('hi')
  })

  it('a quick action after switching language sends that language', async () => {
    const result = seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    fireEvent.change(language(), { target: { value: 'hi' } })

    fireEvent.click(quickButton('Explain my result'))

    await screen.findByText(ANSWER.answer)
    expect(askTutor.mock.calls[0]).toEqual([result.provenance.resultId, CIRCUIT, 'Explain my result', 'hi'])
  })
})

describe('state isolation: opening and closing the Guide changes nothing else', () => {
  it('leaves every Build and Learn slice — by reference — untouched', () => {
    const result = seedResult()
    seedLesson(1)
    act(() => {
      useBuildStore.setState({
        verification: { verificationStatus: 'VERIFIED' } as never,
        optimization: { status: 'NO_OPTIMIZATION_FOUND' } as never,
        multiInputTest: { testId: 't' } as never,
        trace: hzh(),
        tutorLanguage: 'kn',
        tutorTurns: [{ role: 'learner', text: 'hello' }],
      })
    })
    const buildBefore = useBuildStore.getState()
    const learnBefore = useLearnStore.getState()

    const view = render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    fireEvent.keyDown(panel(), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close guide panel' }))
    view.unmount()
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    const after = useBuildStore.getState()
    expect(after).toBe(buildBefore) // not one Build field was set
    expect(after.circuit).toBe(buildBefore.circuit)
    expect(after.result).toBe(result)
    expect(after.verification).toBe(buildBefore.verification)
    expect(after.optimization).toBe(buildBefore.optimization)
    expect(after.multiInputTest).toBe(buildBefore.multiInputTest)
    expect(after.trace).toBe(buildBefore.trace)
    expect(after.tutorLanguage).toBe('kn')
    expect(useLearnStore.getState()).toBe(learnBefore) // progress, mastery inputs, streak history: all same
    expect(useLearnStore.getState().lessonProgress).toBe(learnBefore.lessonProgress)
    expect(useLearnStore.getState().activityHistory).toBe(learnBefore.activityHistory)
  })

  it('mounting the panel makes no API call at all', () => {
    seedResult()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(askTutor).not.toHaveBeenCalled()
  })

  it('asking through a quick action changes only the tutor conversation, not the circuit or result', async () => {
    const result = seedResult()
    const before = useBuildStore.getState()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    fireEvent.click(quickButton('Explain this circuit'))
    await screen.findByText(ANSWER.answer)

    const after = useBuildStore.getState()
    expect(after.circuit).toBe(before.circuit)
    expect(after.result).toBe(result)
    const changed = (Object.keys(after) as Array<keyof typeof after>).filter((k) => after[k] !== before[k])
    // Exactly one Build field ends up different: the conversation. (`isAskingTutor`
    // flips true then back to false, so it finishes where it started.)
    expect(changed).toEqual(['tutorTurns'])
  })
})
