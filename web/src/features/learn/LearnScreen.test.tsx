/**
 * Tests for the Learn screen. `@/api`'s `getApiClient` is mocked so these run
 * without a live backend — `listLessons` is the one method under test here,
 * exactly mirroring how every other real endpoint is exercised elsewhere in
 * this suite (e.g. TutorPanel.test.tsx).
 *
 * Since `LessonDetailPanel` now embeds a step-by-step `LessonPlayer` (only
 * one section visible at a time), these tests drive it explicitly through
 * Continue/Finish clicks rather than asserting every section at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Lesson } from '@/api'
import { emptyCircuit } from '@/circuit/types'

const listLessons = vi.fn()
// Concept checks are graded by the SERVER; this is its stand-in (it holds the answer key the catalog does not carry).
const grading = vi.hoisted(() => ({ current: {} as { gradeConceptCheck?: unknown; regradeConceptChecks?: unknown } }))

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(),
      verifyBellState: vi.fn(),
      askTutor: vi.fn(),
      optimizeCircuit: vi.fn(),
      runMultiInputTest: vi.fn(),
      listLessons,
      gradeConceptCheck: grading.current.gradeConceptCheck,
      regradeConceptChecks: grading.current.regradeConceptChecks,
    }),
  }
})

import { fakeGradingServer } from '@/test/gradingServer'

import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from './store'
import { LearnScreen } from './LearnScreen'

const LAB_CIRCUIT = {
  ...emptyCircuit(2, 2),
  ops: [
    { gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx' as const, targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

const LESSON_A: Lesson = {
  id: 'a',
  title: 'Lesson A',
  shortDescription: 'First lesson.',
  concept: 'basics',
  difficulty: 'beginner',
  estimatedMinutes: 10,
  learningObjectives: ['Learn A'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'A body.' }],
  linkedCircuit: null,
  prerequisiteLessonIds: [],
}

const LESSON_B: Lesson = {
  id: 'b',
  title: 'Lesson B',
  shortDescription: 'Second lesson.',
  concept: 'advanced',
  difficulty: 'intermediate',
  estimatedMinutes: 15,
  learningObjectives: ['Learn B'],
  sections: [
    { type: 'explanation', id: 's1', title: 'Explain', body: 'Explain body.' },
    {
      type: 'concept_check',
      id: 's2',
      title: 'Check',
      prompt: 'What is X?',
      question: 'What is X?',
      options: [
        { id: 'x', text: 'X' },
        { id: 'y', text: 'Y' },
      ],
      concept: 'advanced',
    },
    { type: 'interactive_lab', id: 's3', title: 'Lab', instructions: 'Run it.', capability: 'execute' },
    { type: 'reflection', id: 's4', title: 'Reflect', prompt: 'Why?' },
  ],
  linkedCircuit: LAB_CIRCUIT,
  prerequisiteLessonIds: ['a'],
}

const INITIAL_LEARN_STATE = useLearnStore.getState()
const INITIAL_BUILD_STATE = useBuildStore.getState()

/** Selects Lesson A and waits for its (only) step to render. */
async function goToLessonA() {
  fireEvent.click(screen.getByRole('button', { name: /^Lesson A/ }))
  await screen.findByText('A body.')
}

/** Lesson A has exactly one section, so its Continue button reads "Finish
 * lesson" — clicking it completes the lesson outright. */
async function completeLessonA() {
  await goToLessonA()
  fireEvent.click(screen.getByRole('button', { name: 'Finish lesson' }))
}

/** Selects Lesson B and waits for its first (explanation) step to render. */
async function goToLessonB() {
  fireEvent.click(screen.getByRole('button', { name: /^Lesson B/ }))
  await screen.findByText('Explain body.')
}

/** Advances Lesson B from its first step to its concept-check step. */
async function advanceLessonBToConceptCheck() {
  await goToLessonB()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByText('What is X?')
}

async function answerLessonBConceptCheck(optionLabel: 'X' | 'Y') {
  fireEvent.click(screen.getByLabelText(optionLabel))
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  await screen.findByText(/Correct\.|Not quite\./) // the server's verdict
}

/** Fully completes Lesson B end to end, answering its one concept check as directed. */
async function completeLessonB(optionLabel: 'X' | 'Y' = 'X') {
  await advanceLessonBToConceptCheck()
  await answerLessonBConceptCheck(optionLabel)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> interactive lab
  await screen.findByText('Run it.')
  fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> reflection
  await screen.findByText('Why?')
  fireEvent.click(screen.getByRole('button', { name: 'Finish lesson' }))
}

describe('LearnScreen', () => {
  beforeEach(() => {
    grading.current = fakeGradingServer({ keys: { 'b/s2': 'x' } }) // lesson b's check: X is right
    listLessons.mockReset()
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  afterEach(() => {
    // Unmount before resetting stores: this afterEach runs before RTL's own
    // auto-cleanup, and resetting a store under a still-mounted component
    // is a state update outside act().
    cleanup()
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  it('fetches the catalog from the real API client on mount', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A])

    render(<LearnScreen onOpenLab={vi.fn()} />)

    await waitFor(() => expect(listLessons).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
  })

  it('renders the lesson list with title, description, concept and difficulty', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    expect(screen.getByText('Lesson B')).toBeInTheDocument()
    expect(screen.getByText('First lesson.')).toBeInTheDocument()
    expect(screen.getByText('Beginner')).toBeInTheDocument()
    expect(screen.getByText('Intermediate')).toBeInTheDocument()
  })

  it('shows a loading state before the catalog resolves', () => {
    listLessons.mockReturnValueOnce(new Promise(() => {}))

    render(<LearnScreen onOpenLab={vi.fn()} />)

    expect(screen.getByText(/Loading lessons/)).toBeInTheDocument()
  })

  it('shows a useful error state when the API call fails, with no fabricated lesson list', async () => {
    listLessons.mockRejectedValueOnce(new Error('could not reach the Qentor backend'))

    render(<LearnScreen onOpenLab={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByText(/could not reach the Qentor backend/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Lesson/ })).not.toBeInTheDocument()
  })

  it('shows a clean empty state for an empty catalog', async () => {
    listLessons.mockResolvedValueOnce([])

    render(<LearnScreen onOpenLab={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/No lessons are available/)).toBeInTheDocument())
  })

  it('a lesson whose prerequisite is unfinished can still be opened directly, and says what it builds on', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson B')).toBeInTheDocument())

    const button = screen.getByRole('button', { name: /^Lesson B/ })
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('Builds on: Lesson A')
    expect(button).not.toHaveAccessibleName(/locked/i)
    expect(screen.queryByText(/locked/i)).not.toBeInTheDocument()

    fireEvent.click(button)

    expect(await screen.findByText('Explain body.')).toBeInTheDocument()
    expect(screen.getByText(/recommended first, but you can start here any time/)).toBeInTheDocument()
  })

  it('marks only the lesson the recommended path points at as Suggested next', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson B')).toBeInTheDocument())

    // Nothing done yet: A (no prerequisites) is next; B builds on A so it is open but not suggested.
    expect(screen.getByRole('button', { name: /^Lesson A/ })).toHaveAccessibleName(/suggested next/)
    expect(screen.getByRole('button', { name: /^Lesson B/ })).not.toHaveAccessibleName(/suggested next/)

    await completeLessonA()
    // Once A is complete the recommendation moves on to B, which no longer lists A as unfinished.
    expect(screen.getByRole('button', { name: /^Lesson B/ })).toHaveAccessibleName(/suggested next/)
    expect(screen.getByRole('button', { name: /^Lesson B/ })).not.toHaveTextContent('Builds on')
  })

  it('selecting an available lesson shows its detail view with objectives and progress', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())

    await completeLessonA()

    expect(screen.getByText('Learn A')).toBeInTheDocument()
    expect(screen.getByText('No hands-on lab for this lesson yet.')).toBeInTheDocument()
    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('1/1')
  })

  it('a lesson with no concept checks completes (and is mastered) once its only section is explicitly completed', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())

    await completeLessonA()

    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('Completed')
    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('Mastered')
  })

  it('opens a dependent lesson after its prerequisite is complete, showing exactly one section at a time through the whole flow', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    await completeLessonA()

    const lessonBButton = screen.getByRole('button', { name: /^Lesson B/ })
    expect(lessonBButton).not.toBeDisabled()
    await goToLessonB()
    expect(screen.queryByText('What is X?')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('What is X?')).toBeInTheDocument()
    expect(screen.queryByText('Explain body.')).not.toBeInTheDocument()

    await answerLessonBConceptCheck('X')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Run it.')).toBeInTheDocument()
    expect(screen.queryByText('What is X?')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Why?')).toBeInTheDocument()
    expect(screen.queryByText('Run it.')).not.toBeInTheDocument()
  })

  it('a lesson is not complete until every section is explicitly completed, not just its concept check attempted', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    await completeLessonA()
    await advanceLessonBToConceptCheck()
    await answerLessonBConceptCheck('X')

    // Attempted, but the lab and reflection steps haven't been explicitly
    // completed yet — the lesson must not show as complete.
    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('In progress')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> interactive lab
    await screen.findByText('Run it.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> reflection
    await screen.findByText('Why?')
    fireEvent.click(screen.getByRole('button', { name: 'Finish lesson' }))

    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('Completed')
    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('1/1 correct')
  })

  it('wires the interactive lab action to onOpenLab with the lesson’s real linked circuit', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])
    const onOpenLab = vi.fn()

    render(<LearnScreen onOpenLab={onOpenLab} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    await completeLessonA()
    await advanceLessonBToConceptCheck()
    await answerLessonBConceptCheck('X')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> interactive lab
    await screen.findByText('Run it.')

    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))

    expect(onOpenLab).toHaveBeenCalledTimes(1)
    expect(onOpenLab).toHaveBeenCalledWith(LAB_CIRCUIT)
  })

  it('returning to the interactive lab step after Open in Lab still requires an explicit Continue, and does not fabricate a result', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    await completeLessonA()
    await advanceLessonBToConceptCheck()
    await answerLessonBConceptCheck('X')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> interactive lab
    await screen.findByText('Run it.')

    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))

    // Still on the same step — opening the lab never auto-advances or
    // auto-completes it.
    expect(screen.getByText('Run it.')).toBeInTheDocument()
    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('In progress')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Why?')).toBeInTheDocument()
  })

  it('preserves in-progress lesson state across unmounting and remounting Learn (simulating a Lab/Learn screen switch)', async () => {
    listLessons.mockResolvedValue([LESSON_A, LESSON_B])

    const { unmount } = render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    await completeLessonA()
    await advanceLessonBToConceptCheck()

    unmount()
    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(listLessons).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Lesson A/ })).toBeInTheDocument())

    // Re-select Lesson B: it must resume at the concept-check step it was
    // left on, not restart from its first section.
    fireEvent.click(screen.getByRole('button', { name: /^Lesson B/ }))
    expect(await screen.findByText('What is X?')).toBeInTheDocument()
    expect(screen.queryByText('Explain body.')).not.toBeInTheDocument()

    // Lesson A's completion also survived the remount.
    expect(screen.getByLabelText('Lesson progress')).not.toHaveTextContent('Not started')
  })

  it('never mutates the Build circuit or execution state while stepping through, completing and answering', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())

    const circuitBefore = useBuildStore.getState().circuit
    await completeLessonA()
    await completeLessonB('X')

    expect(useBuildStore.getState().circuit).toBe(circuitBefore)
    expect(useBuildStore.getState().result).toBeNull()
    expect(useBuildStore.getState().isExecuting).toBe(false)
    expect(useBuildStore.getState().verification).toBeNull()
    expect(useBuildStore.getState().tutorTurns).toEqual([])
    expect(useBuildStore.getState().multiInputTest).toBeNull()
  })

  describe('learning-activity (streak) recording', () => {
    beforeEach(() => localStorage.clear())
    afterEach(() => localStorage.clear())

    const dates = () => useLearnStore.getState().activityHistory.activityDates

    it('browsing Learn — opening it, selecting a lesson, stepping and going Back — records no activity', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
      expect(dates()).toEqual([])

      await goToLessonA()
      expect(dates()).toEqual([])
      expect(localStorage.getItem('qentor.learn.activity.v1')).toBeNull()
    })

    it('finishing a lesson records today as an activity day', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
      await completeLessonA()

      expect(dates()).toHaveLength(1)
      expect(dates()[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('completing an intermediate section of a longer lesson does not count until a check is submitted or the lesson finishes', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
      await completeLessonA()
      // Forget the activity Lesson A just produced so this test isolates B.
      localStorage.clear()
      act(() => {
        useLearnStore.setState({ activityHistory: { activityDates: [] } })
      })

      await advanceLessonBToConceptCheck() // Continue on the explanation only
      expect(dates()).toEqual([])

      await answerLessonBConceptCheck('X') // a submitted answer counts
      expect(dates()).toHaveLength(1)
    })

    it('never touches Build/Lab state while recording activity', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
      const buildBefore = useBuildStore.getState()

      await completeLessonA()
      await completeLessonB('X')

      expect(dates().length).toBeGreaterThan(0)
      expect(useBuildStore.getState()).toBe(buildBefore)
    })
  })

  describe('learner insight summary', () => {
    it('shows zero-progress state across the whole catalog before anything is touched', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())

      const summary = screen.getByLabelText('Learner insights')
      expect(summary).toHaveTextContent('0/2')
      expect(summary).toHaveTextContent('0%')
      expect(summary).toHaveTextContent('Not started: 2')
      expect(summary).toHaveTextContent('No open signals right now.')
      // Priority B: Lesson A has no prerequisites, so it's the recommendation.
      expect(summary).toHaveTextContent('"Lesson A" is next in your learning path.')
    })

    it('updates overall progress and mastery once a lesson is completed', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
      await completeLessonA()

      const summary = screen.getByLabelText('Learner insights')
      expect(summary).toHaveTextContent('1/2')
      expect(summary).toHaveTextContent('50%')
      expect(summary).toHaveTextContent('Mastered: 1')
      // Lesson B is now the recommended next challenge.
      expect(summary).toHaveTextContent('Lesson B" is next in your learning path.')
    })

    it('flags a repeated-incorrect-answer misconception under "Needs attention", and the button resumes that lesson in place', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
      await completeLessonA()
      await advanceLessonBToConceptCheck()

      // Answer wrong twice.
      await answerLessonBConceptCheck('Y')
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await answerLessonBConceptCheck('Y')

      const summary = screen.getByLabelText('Learner insights')
      expect(summary).toHaveTextContent('advanced: 2 incorrect attempts')

      // Navigate away to Lesson A's detail view first (it was already
      // finished earlier, so it resumes at its own "Lesson complete" screen).
      fireEvent.click(screen.getByRole('button', { name: /^Lesson A/ }))
      expect(await screen.findByRole('heading', { name: 'Lesson complete' })).toBeInTheDocument()
      expect(screen.queryByText('What is X?')).not.toBeInTheDocument()

      // ...then use the "Needs attention" signal to jump back to Lesson B,
      // resuming exactly at its concept-check step (not restarting it).
      fireEvent.click(screen.getByRole('button', { name: /advanced: 2 incorrect attempts/ }))

      expect(await screen.findByText('What is X?')).toBeInTheDocument()
      expect(screen.queryByText('Explain body.')).not.toBeInTheDocument()
    })

    it('shows the catalog-complete message once every lesson has been completed', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
      await completeLessonA()

      const summary = screen.getByLabelText('Learner insights')
      expect(summary).toHaveTextContent('Every lesson in the current catalog is complete.')
    })

    it('the "Go to lesson" next-challenge action selects that lesson without touching the Build circuit', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

      render(<LearnScreen onOpenLab={vi.fn()} />)
      await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())

      const circuitBefore = useBuildStore.getState().circuit

      fireEvent.click(screen.getByRole('button', { name: 'Go to lesson' }))

      expect(await screen.findByText('Learn A')).toBeInTheDocument()
      expect(useBuildStore.getState().circuit).toBe(circuitBefore)
    })
  })
})
