/**
 * The Qentor Guide inside the real App shell: where it appears, opening and
 * closing (with focus restored), that the top bar stays usable, and that none
 * of the app's state — Build, Learn, tutor language — is disturbed by opening
 * or closing it. `@/api`'s client is mocked (no backend); `executeCircuit`
 * never resolves so the Lab's debounced auto-run can't change anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ExecutePayload,
  Lesson,
  MultiInputTestResult,
  OptimizationResult,
  TutorAnswerResult,
  VerifyBellStateResult,
} from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { hzh } from '@/test/traceFixtures'

const listLessons = vi.fn()
const askTutor = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(() => new Promise(() => {})),
      verifyBellState: vi.fn(() => new Promise(() => {})),
      optimizeCircuit: vi.fn(() => new Promise(() => {})),
      runMultiInputTest: vi.fn(() => new Promise(() => {})),
      traceCircuit: vi.fn(() => new Promise(() => {})),
      listLessons,
      askTutor,
    }),
  }
})

import App from './App'
import { resetGuideBubbleForTests } from '@/features/guide/GuideLauncher'
import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '@/features/learn/store'

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
    { type: 'explanation', id: 's1', title: 'Intro', body: 'Explanation body.' },
    { type: 'interactive_lab', id: 's2', title: 'Lab', instructions: 'Build it.', capability: 'execute' },
    { type: 'reflection', id: 's3', title: 'Reflect', prompt: 'Reflection prompt.' },
  ],
  linkedCircuit: CIRCUIT,
  prerequisiteLessonIds: [],
}

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

const ANSWER: TutorAnswerResult = {
  answer: 'For this result: p(00) = 0.5 (fact_1).',
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  usedFallbackTemplate: true,
  facts: [],
}

// Complete, typed fixtures: the real Lab renders the real panels for these, so
// they must be valid results, not stubs.
const VERIFICATION: VerifyBellStateResult = {
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  verifier: 'bell_state/1',
  verificationStatus: 'VERIFIED',
  checks: [],
  expectedSupport: ['00', '11'],
  observedSupport: ['00', '11'],
}
const OPTIMIZATION: OptimizationResult = {
  originalCircuitHash: 'hash_abc',
  candidateCircuitHash: 'hash_abc',
  originalOpCount: 2,
  candidateOpCount: 2,
  rulesApplied: [],
  reductionSummary: 'nothing to reduce',
  status: 'NO_OPTIMIZATION_FOUND',
  equivalence: null,
  verifierName: 'equivalence',
  verifierVersion: '1',
  reason: null,
  candidateCircuit: null,
  resultId: null,
  operationsRemoved: 0,
  changes: [],
  ruleNotes: [],
  candidateProvenance: null,
}
const MULTI_INPUT: MultiInputTestResult = {
  testId: 'test_1',
  circuitHash: 'hash_abc',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  inputQubits: [0],
  outputQubits: [1],
  cases: [],
  counterexamples: [],
  overallStatus: 'ALL_PASSED',
}

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()

const openButton = () => screen.getByRole('button', { name: 'Open Qentor Guide' })
const closeButton = () => screen.getByRole('button', { name: 'Close Qentor Guide' })
const panel = () => screen.getByRole('complementary', { name: 'Qentor Guide' })
const nav = (name: 'Lab' | 'Learn' | 'Progress') => fireEvent.click(screen.getByRole('button', { name }))

function seedLab() {
  const result = toQuantumValue<ExecutePayload>({ executionId: 'aer-local-abc', probabilities: { '00': 0.5, '11': 0.5 } }, PROVENANCE)
  act(() => {
    useBuildStore.setState({ circuit: CIRCUIT, result, isExecuting: false, executionError: null })
  })
  return result
}

beforeEach(() => {
  localStorage.clear()
  listLessons.mockReset()
  listLessons.mockResolvedValue([LESSON])
  askTutor.mockReset()
  askTutor.mockResolvedValue(ANSWER)
  resetGuideBubbleForTests()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})

describe('where the Guide appears', () => {
  it('is on the Lab, in the top bar’s spare strip', () => {
    render(<App />)
    const slot = screen.getByTestId('guide-slot')
    expect(within(slot).getByRole('button', { name: 'Open Qentor Guide' })).toBeInTheDocument()
  })

  it('is on Learn too', async () => {
    render(<App />)
    nav('Learn')
    await screen.findByRole('heading', { name: 'Learn' })
    expect(openButton()).toBeInTheDocument()
  })

  it('is not on Progress (nothing there to be guided through) — and comes back with the others', async () => {
    render(<App />)
    nav('Progress')
    await screen.findByRole('heading', { level: 1, name: 'Progress' })
    expect(screen.queryByRole('button', { name: /Qentor Guide/ })).not.toBeInTheDocument()

    nav('Lab')
    expect(openButton()).toBeInTheDocument()
  })

  it('does not disturb the top bar: navigation, the Run button and the toolbar are all still there', () => {
    render(<App />)
    for (const name of ['Lab', 'Learn', 'Progress']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Run\s*⌘↵$/ })).toBeInTheDocument() // the top bar's Run (not "Run trace")
    expect(screen.getByText('Simulator')).toBeInTheDocument()
  })
})

describe('opening and closing', () => {
  it('clicking the character opens the tutor side panel without leaving the page', () => {
    render(<App />)
    expect(screen.queryByRole('complementary', { name: 'Qentor Guide' })).not.toBeInTheDocument()

    fireEvent.click(openButton())

    expect(panel()).toBeInTheDocument()
    expect(panel()).toHaveFocus()
    expect(within(panel()).getByText('Lab')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lab' })).toHaveAttribute('aria-current', 'page') // still on the Lab
    expect(screen.getByRole('button', { name: 'Close Qentor Guide' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('the close button closes it and hands focus back to the character', () => {
    render(<App />)
    fireEvent.click(openButton())

    fireEvent.click(screen.getByRole('button', { name: 'Close guide panel' }))

    expect(screen.queryByRole('complementary', { name: 'Qentor Guide' })).not.toBeInTheDocument()
    expect(openButton()).toHaveFocus()
    expect(openButton()).toHaveAttribute('aria-expanded', 'false')
  })

  it('Escape closes it and hands focus back to the character', () => {
    render(<App />)
    fireEvent.click(openButton())

    fireEvent.keyDown(panel(), { key: 'Escape' })

    expect(screen.queryByRole('complementary', { name: 'Qentor Guide' })).not.toBeInTheDocument()
    expect(openButton()).toHaveFocus()
  })

  it('clicking the character again also closes it', () => {
    render(<App />)
    fireEvent.click(openButton())
    fireEvent.click(closeButton())
    expect(screen.queryByRole('complementary', { name: 'Qentor Guide' })).not.toBeInTheDocument()
  })

  it('navigation stays usable while it is open, and the panel follows the screen (Lab -> Learn)', async () => {
    render(<App />)
    fireEvent.click(openButton())
    expect(within(panel()).getByText('Lab')).toBeInTheDocument()

    nav('Learn')

    await screen.findByRole('heading', { name: 'Learn' })
    expect(within(panel()).getByText('Learn')).toBeInTheDocument()
    expect(within(panel()).getByRole('heading', { level: 3, name: 'Quick questions' })).toBeInTheDocument()
    expect(within(panel()).getByText('Explain this concept')).toBeInTheDocument()
  })

  it('leaving for Progress hides the panel with the character; returning restores it', async () => {
    render(<App />)
    fireEvent.click(openButton())

    nav('Progress')
    await screen.findByRole('heading', { level: 1, name: 'Progress' })
    expect(screen.queryByRole('complementary', { name: 'Qentor Guide' })).not.toBeInTheDocument()

    nav('Lab')
    expect(panel()).toBeInTheDocument()
  })
})

describe('Lab: opening and closing changes nothing', () => {
  it('leaves the circuit, result, verification, optimizer, multi-input, trace and language untouched', () => {
    const result = seedLab()
    act(() => {
      useBuildStore.setState({
        verification: VERIFICATION,
        optimization: OPTIMIZATION,
        multiInputTest: MULTI_INPUT,
        trace: hzh(),
        tutorLanguage: 'hi',
      })
    })
    render(<App />)
    const before = useBuildStore.getState()

    fireEvent.click(openButton())
    fireEvent.click(screen.getByRole('button', { name: 'Close guide panel' }))
    fireEvent.click(openButton())
    fireEvent.keyDown(panel(), { key: 'Escape' })

    const after = useBuildStore.getState()
    expect(after.circuit).toBe(before.circuit)
    expect(after.qasmText).toBe(before.qasmText)
    expect(after.result).toBe(result)
    expect(after.verification).toBe(VERIFICATION)
    expect(after.optimization).toBe(OPTIMIZATION)
    expect(after.multiInputTest).toBe(MULTI_INPUT)
    expect(after.trace).toBe(before.trace)
    expect(after.tutorLanguage).toBe('hi')
    expect(askTutor).not.toHaveBeenCalled()
  })

  it('clicking the character alone (opening) does not mutate the Build circuit or result', () => {
    const result = seedLab()
    render(<App />)
    const circuit = useBuildStore.getState().circuit

    fireEvent.click(openButton())

    expect(useBuildStore.getState().circuit).toBe(circuit)
    expect(useBuildStore.getState().result).toBe(result)
  })

  it('a quick action uses the current Lab circuit and result — and shows in the Lab’s own tutor too (one shared conversation)', async () => {
    const result = seedLab()
    // The Lab's mount-time debounced auto-run (250ms) starts every run by clearing the tutor conversation. Under a loaded machine
    // that timer can fire between the click and the assertion, so this test — about the conversation, not the run — pins it.
    useBuildStore.setState({ runExecution: vi.fn(async () => {}) })
    render(<App />)
    fireEvent.click(openButton())

    fireEvent.click(within(within(panel()).getByRole('region', { name: 'Quick questions' })).getByRole('button', { name: 'Explain this circuit' }))

    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    expect(askTutor.mock.calls[0]).toEqual([result.provenance.resultId, CIRCUIT, 'Explain this circuit', 'en'])
    // One store, so the Lab's docked tutor and the Guide's embedded one show the same turns.
    await waitFor(() => expect(screen.getAllByText(ANSWER.answer)).toHaveLength(2))
  })

  it('with no result the quick actions are disabled — nothing is invented', () => {
    render(<App />)
    fireEvent.click(openButton())

    const region = within(panel()).getByRole('region', { name: 'Quick questions' })
    for (const b of within(region).getAllByRole('button')) expect(b).toBeDisabled()
    expect(within(panel()).getByText('No result yet — run the circuit, then ask about it.')).toBeInTheDocument()
    expect(useBuildStore.getState().result).toBeNull()
  })
})

describe('Learn: opening and closing changes nothing', () => {
  async function openLessonStepTwo() {
    render(<App />)
    nav('Learn')
    fireEvent.click(await screen.findByRole('button', { name: /^Bell Lesson/ }))
    await screen.findByText('Explanation body.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // completes s1, now on step 2
    await screen.findByText('Build it.')
  }

  it('the lesson, its progress and mastery inputs, and the streak history are all untouched', async () => {
    await openLessonStepTwo()
    const before = useLearnStore.getState()
    const progress = before.lessonProgress.bell

    fireEvent.click(openButton())
    expect(within(panel()).getByText('Lesson: Bell Lesson')).toBeInTheDocument()
    expect(within(panel()).getByText('Step 2 of 3: Lab')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close guide panel' }))

    const after = useLearnStore.getState()
    expect(after).toBe(before)
    expect(after.lessonProgress.bell).toBe(progress)
    expect(after.lessonProgress.bell?.activeSectionIndex).toBe(1)
    expect(after.lessonProgress.bell?.completedSectionIds).toEqual(new Set(['s1']))
    expect(after.activityHistory).toBe(before.activityHistory)
    expect(after.selectedLessonId).toBe('bell')
    // ...and the lesson on screen is exactly where the learner left it.
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()
    expect(screen.getByText('Build it.')).toBeInTheDocument()
  })

  it('sends the lesson and section IDS through the existing request — and no lesson text, circuit or result', async () => {
    await openLessonStepTwo()
    seedLab() // a Lab result exists, but a lesson question stays a lesson question
    fireEvent.click(openButton())

    fireEvent.click(within(within(panel()).getByRole('region', { name: 'Quick questions' })).getByRole('button', { name: 'Give me a hint' }))

    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    const args = askTutor.mock.calls[0]!
    expect(args).toEqual([null, null, 'Give me a hint', 'en', { lessonId: 'bell', sectionId: 's2' }])
    expect(JSON.stringify(args)).not.toMatch(/Bell Lesson|Explanation body|Build it|res_abc/)
  })
})

describe('language', () => {
  it('the selected tutor language survives closing and reopening the Guide', () => {
    render(<App />)
    fireEvent.click(openButton())
    fireEvent.change(within(panel()).getByRole('combobox', { name: 'Tutor answer language' }), { target: { value: 'kn' } })
    expect(useBuildStore.getState().tutorLanguage).toBe('kn')

    fireEvent.click(screen.getByRole('button', { name: 'Close guide panel' }))
    fireEvent.click(openButton())

    expect((within(panel()).getByRole('combobox', { name: 'Tutor answer language' }) as HTMLSelectElement).value).toBe('kn')
    expect(useBuildStore.getState().tutorLanguage).toBe('kn')
  })

  it('is one language state: changing it in the Guide changes the Lab’s docked tutor selector too', () => {
    render(<App />)
    fireEvent.click(openButton())

    fireEvent.change(within(panel()).getByRole('combobox', { name: 'Tutor answer language' }), { target: { value: 'hi' } })

    const selectors = screen.getAllByRole('combobox', { name: 'Tutor answer language' }) as HTMLSelectElement[]
    expect(selectors).toHaveLength(2) // the footer's and the Guide's
    expect(selectors.map((s) => s.value)).toEqual(['hi', 'hi'])
  })
})
