/**
 * Tests for the step-by-step lesson player: one section visible at a time,
 * explicit Back/Continue navigation, and per-section-type completion
 * behavior. `useLearnStore` is the real store (not mocked) since this is
 * exactly what `LessonPlayer` reads/writes. A concept-check answer is graded by the
 * SERVER, so `getApiClient` is replaced by `fakeGradingServer` (a test double holding the
 * answer key the real catalog does not carry); these tests never call `fetchLessons`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Lesson } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { fakeGradingServer } from '@/test/gradingServer'
import { useLearnStore } from './store'
import { LessonPlayer } from './LessonPlayer'

const client = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client.current }
})

/** Pick an option and Submit, then wait for the server's verdict to show. */
async function answer(label: string) {
  fireEvent.click(screen.getByLabelText(label))
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  await screen.findByText(/Correct\.|Not quite\./)
}

const LAB_CIRCUIT = {
  ...emptyCircuit(2, 2),
  ops: [{ gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] }],
}

const LESSON: Lesson = {
  id: 'lesson-1',
  title: 'Test Lesson',
  shortDescription: 'desc',
  concept: 'basics',
  difficulty: 'beginner',
  estimatedMinutes: 10,
  learningObjectives: ['obj'],
  sections: [
    { type: 'explanation', id: 's1', title: 'Intro', body: 'Explanation body.' },
    {
      type: 'concept_check',
      id: 's2',
      title: 'Check',
      prompt: 'q',
      question: 'What is X?',
      options: [
        { id: 'x', text: 'X' },
        { id: 'y', text: 'Y' },
      ],
      concept: 'basics',
    },
    { type: 'interactive_lab', id: 's3', title: 'Lab', instructions: 'Run it.', capability: 'execute' },
    { type: 'reflection', id: 's4', title: 'Reflect', prompt: 'Reflection prompt.' },
  ],
  linkedCircuit: LAB_CIRCUIT,
  prerequisiteLessonIds: [],
}

const INITIAL_STATE = useLearnStore.getState()

describe('LessonPlayer', () => {
  beforeEach(() => {
    useLearnStore.setState(INITIAL_STATE, true)
    client.current = fakeGradingServer({ keys: { 'lesson-1/s2': 'x' } }) // the "server": X is right
  })

  afterEach(() => {
    // Unmount before resetting stores: this afterEach runs before RTL's own
    // auto-cleanup, and resetting a store under a still-mounted component
    // is a state update outside act().
    cleanup()
    useLearnStore.setState(INITIAL_STATE, true)
  })

  it('shows only the first section initially, with an accurate step count', () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)

    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(screen.getByText('Explanation body.')).toBeInTheDocument()
    expect(screen.queryByText('What is X?')).not.toBeInTheDocument()
    expect(screen.queryByText('Run it.')).not.toBeInTheDocument()
    expect(screen.queryByText('Reflection prompt.')).not.toBeInTheDocument()
  })

  it('disables Back on the first step', () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('Continue on an explanation section marks it completed and advances to the next section', () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByText('What is X?')).toBeInTheDocument()
    expect(screen.queryByText('Explanation body.')).not.toBeInTheDocument()
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('s1')).toBe(true)
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.activeSectionIndex).toBe(1)
  })

  it('disables Continue on a full concept check until an answer is submitted — and graded', async () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check step

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    fireEvent.click(screen.getByLabelText('X'))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled() // selecting alone is not enough

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await screen.findByText('Correct.')
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
  })

  it('Continue stays disabled when the server could not grade the answer, because no attempt was recorded', async () => {
    client.current = { ...fakeGradingServer({ keys: { 'lesson-1/s2': 'x' } }), gradeConceptCheck: vi.fn().mockRejectedValue(new Error('down')) }
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
    fireEvent.click(screen.getByLabelText('X'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await screen.findByTestId('grading-failed')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('Continue after an attempt advances and completes the concept-check section regardless of correctness', async () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
    await answer('Y') // wrong answer

    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> interactive lab

    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
    expect(screen.getByText('Run it.')).toBeInTheDocument()
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('s2')).toBe(true)
  })

  it('Continue stays enabled while retrying (the attempt already exists)', async () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
    await answer('Y')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByLabelText('X')).toBeInTheDocument() // back to the question
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
  })

  it('the interactive lab step shows the capability and wires Open in Lab to onOpenLab', async () => {
    const onOpenLab = vi.fn()
    render(<LessonPlayer lesson={LESSON} onOpenLab={onOpenLab} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
    await answer('X')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> interactive lab

    expect(screen.getByText(/uses the existing execute capability/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))

    expect(onOpenLab).toHaveBeenCalledWith(LAB_CIRCUIT)
    // Opening the lab does not itself complete or advance the step.
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
  })

  it('Continue completes the interactive lab step without requiring the lab to actually be opened', async () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await answer('X')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> interactive lab

    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // never clicked Open in Lab

    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument()
    expect(screen.getByText('Reflection prompt.')).toBeInTheDocument()
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('s3')).toBe(true)
  })

  it('the last section shows "Finish lesson", and finishing shows the lesson-complete state', async () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
    await answer('X')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> interactive lab
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> reflection (last step)
    expect(screen.getByRole('button', { name: 'Finish lesson' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Finish lesson' }))

    expect(screen.getByRole('heading', { name: 'Lesson complete' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Finish lesson' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('s4')).toBe(true)
  })

  it('Back moves to the previous section without un-completing it', () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // completes s1, -> step 2

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(screen.getByText('Explanation body.')).toBeInTheDocument()
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('s1')).toBe(true)
  })

  it('resumes at the stored activeSectionIndex on mount, not always at step 1', () => {
    useLearnStore.setState({
      lessonProgress: {
        'lesson-1': {
          activeSectionIndex: 2,
          completedSectionIds: new Set(['s1', 's2']),
          conceptCheckAttempts: { s2: { selectedOptionId: 'x', isCorrect: true, attemptCount: 1 } },
        },
      },
    })

    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)

    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
    expect(screen.getByText('Run it.')).toBeInTheDocument()
  })

  it('rendering, mounting and re-rendering a section never marks anything completed', () => {
    const { rerender } = render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    rerender(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)

    // The section is on screen, but no explicit action was taken.
    expect(screen.getByText('Explanation body.')).toBeInTheDocument()
    const progress = useLearnStore.getState().lessonProgress['lesson-1']
    expect(progress?.completedSectionIds.size ?? 0).toBe(0)
    expect(screen.getByText('0/4 completed')).toBeInTheDocument()
  })

  it('a prompt-only concept check (no question) is continued, and completed, with a plain Continue', () => {
    const lesson: Lesson = {
      ...LESSON,
      sections: [
        {
          type: 'concept_check',
          id: 'c1',
          title: 'Think',
          prompt: 'Think about superposition.',
          question: null,
          options: null,
          concept: null,
        },
        { type: 'reflection', id: 'r1', title: 'Reflect', prompt: 'Reflection prompt.' },
      ],
    }
    render(<LessonPlayer lesson={lesson} onOpenLab={vi.fn()} />)

    expect(screen.getByText('Think about superposition.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('c1') ?? false).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('c1')).toBe(true)
    // No question was ever attempted, so nothing is recorded as an attempt.
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.conceptCheckAttempts).toEqual({})
    expect(screen.getByText('Reflection prompt.')).toBeInTheDocument()
  })

  it('a reflection section is completed by Continue, not by being shown', () => {
    useLearnStore.setState({
      lessonProgress: {
        'lesson-1': {
          activeSectionIndex: 3,
          completedSectionIds: new Set(['s1', 's2', 's3']),
          conceptCheckAttempts: { s2: { selectedOptionId: 'x', isCorrect: true, attemptCount: 1 } },
        },
      },
    })
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)

    expect(screen.getByText('Reflection prompt.')).toBeInTheDocument()
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('s4')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Finish lesson' }))
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.completedSectionIds.has('s4')).toBe(true)
  })

  it('a concept check retry re-shows the question; a new submission replaces the earlier answer and Continue still works', async () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
    await answer('Y')
    expect(screen.getByText('Not quite.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await answer('X')

    expect(screen.getByText('Correct.')).toBeInTheDocument()
    const attempt = useLearnStore.getState().lessonProgress['lesson-1']?.conceptCheckAttempts.s2
    expect(attempt).toMatchObject({ selectedOptionId: 'x', isCorrect: true, attemptCount: 2 })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
  })

  it('keeps navigation position separate from completed progress: Back changes the step, not the completed count', () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // completes s1, now on step 2
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByText('1/4 completed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(screen.getByText('1/4 completed')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
  })

  it('preserves position and completion when the player is unmounted and mounted again', async () => {
    const first = render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
    await answer('Y')
    first.unmount()

    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)

    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByText('1/4 completed')).toBeInTheDocument()
    // The recorded (wrong) attempt and its feedback survive too.
    expect(screen.getByText('Not quite.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
  })

  describe('learning-activity (streak) recording', () => {
    beforeEach(() => localStorage.clear())
    afterEach(() => localStorage.clear())

    const dates = () => useLearnStore.getState().activityHistory.activityDates

    it('mounting, Continue on an explanation, and Back record no activity', () => {
      render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))

      expect(dates()).toEqual([])
      expect(localStorage.getItem('qentor.learn.activity.v1')).toBeNull()
    })

    it('selecting an option without submitting records no activity; a graded Submit does, once per day', async () => {
      render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
      fireEvent.click(screen.getByLabelText('Y'))
      expect(dates()).toEqual([])

      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      await screen.findByText('Not quite.')
      expect(dates()).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await answer('X')
      expect(dates()).toHaveLength(1) // a retry the same day is still one activity day
    })

    it('an answer the server could not grade records no activity', async () => {
      client.current = { ...fakeGradingServer({ keys: { 'lesson-1/s2': 'x' } }), gradeConceptCheck: vi.fn().mockRejectedValue(new Error('down')) }
      render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // -> concept check
      fireEvent.click(screen.getByLabelText('Y'))
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      await screen.findByTestId('grading-failed')
      expect(dates()).toEqual([])
    })

    it('opening the lab step and Open in Lab record no activity', () => {
      useLearnStore.setState({
        lessonProgress: {
          'lesson-1': {
            activeSectionIndex: 2,
            completedSectionIds: new Set(['s1', 's2']),
            conceptCheckAttempts: { s2: { selectedOptionId: 'x', isCorrect: true, attemptCount: 1 } },
          },
        },
      })
      render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))
      expect(dates()).toEqual([])
    })
  })

  it('the progress indicator communicates state as text, not color alone', () => {
    render(<LessonPlayer lesson={LESSON} onOpenLab={vi.fn()} />)

    const bar = screen.getByRole('progressbar', { name: 'Test Lesson lesson progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '4')
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(screen.getByText('0/4 completed')).toBeInTheDocument()
  })
})
