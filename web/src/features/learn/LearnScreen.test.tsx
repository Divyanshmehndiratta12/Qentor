/**
 * Tests for the Learn screen. `@/api`'s `getApiClient` is mocked so these run
 * without a live backend — `listLessons` is the one method under test here,
 * exactly mirroring how every other real endpoint is exercised elsewhere in
 * this suite (e.g. TutorPanel.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Lesson } from '@/api'
import { emptyCircuit } from '@/circuit/types'

const listLessons = vi.fn()

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
    }),
  }
})

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
      correctOptionId: 'x',
      explanation: 'Because X.',
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

/** Opens Lesson A, visits its one section, and (since it has no concept
 * check) that alone satisfies the completion rule — used as a quick way to
 * unlock Lesson B in tests that don't care about A's own progress detail. */
async function completeLessonA() {
  fireEvent.click(screen.getByRole('button', { name: /^Lesson A/ }))
  await screen.findByText('A body.')
}

describe('LearnScreen', () => {
  beforeEach(() => {
    listLessons.mockReset()
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  afterEach(() => {
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

  it('a locked lesson cannot be selected', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson B')).toBeInTheDocument())

    const lockedButton = screen.getByRole('button', { name: /^Lesson B/ })
    expect(lockedButton).toBeDisabled()

    fireEvent.click(lockedButton)

    expect(screen.queryByText('Explain body.')).not.toBeInTheDocument()
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

  it('a lesson with no concept checks completes (and is mastered) once its only section is visited', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())

    await completeLessonA()

    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('Completed')
    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('Mastered')
  })

  it('unlocks a dependent lesson once its prerequisite is complete, and renders every section type', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    await completeLessonA()

    const lessonBButton = screen.getByRole('button', { name: /^Lesson B/ })
    expect(lessonBButton).not.toBeDisabled()
    fireEvent.click(lessonBButton)

    expect(await screen.findByText('Explain body.')).toBeInTheDocument()
    expect(screen.getByText('What is X?')).toBeInTheDocument()
    expect(screen.getByText('Run it.')).toBeInTheDocument()
    expect(screen.getByText('Why?')).toBeInTheDocument()
  })

  it('a lesson with a concept check is not complete until the check is attempted', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    await completeLessonA()
    fireEvent.click(screen.getByRole('button', { name: /^Lesson B/ }))
    await screen.findByText('Explain body.')

    // Every non-quiz section of B has been visited by opening it, but the
    // concept check hasn't been attempted yet — B must not show complete.
    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('In progress')

    fireEvent.click(screen.getByLabelText('X'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('Completed')
    expect(screen.getByLabelText('Lesson progress')).toHaveTextContent('1/1 correct')
  })

  it('wires the interactive lab action to onOpenLab with the lesson’s real linked circuit', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])
    const onOpenLab = vi.fn()

    render(<LearnScreen onOpenLab={onOpenLab} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())
    await completeLessonA()
    fireEvent.click(screen.getByRole('button', { name: /^Lesson B/ }))

    fireEvent.click(await screen.findByRole('button', { name: 'Open in Lab' }))

    expect(onOpenLab).toHaveBeenCalledTimes(1)
    expect(onOpenLab).toHaveBeenCalledWith(LAB_CIRCUIT)
  })

  it('never mutates the Build circuit or execution state while browsing, completing and answering', async () => {
    listLessons.mockResolvedValueOnce([LESSON_A, LESSON_B])

    render(<LearnScreen onOpenLab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lesson A')).toBeInTheDocument())

    const circuitBefore = useBuildStore.getState().circuit
    await completeLessonA()
    fireEvent.click(screen.getByRole('button', { name: /^Lesson B/ }))
    await screen.findByText('Explain body.')
    fireEvent.click(screen.getByLabelText('X'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(useBuildStore.getState().circuit).toBe(circuitBefore)
    expect(useBuildStore.getState().result).toBeNull()
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })
})
