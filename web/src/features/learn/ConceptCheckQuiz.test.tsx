/**
 * The quiz UI. A concept check's answer is graded by the SERVER, so the API client is replaced by `fakeGradingServer` (a test
 * double that holds the answer key; the real catalog the component receives carries none). Everything the learner sees as
 * "Correct." / "Not quite." and the explanation is what that double returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BackendUnavailableError, GradeRejectedError } from '@/api'
import { fakeGradingServer } from '@/test/gradingServer'
import type { FullConceptCheckSection } from './lessonState'
import { useLearnStore } from './store'
import { ConceptCheckQuiz } from './ConceptCheckQuiz'

const client = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client.current }
})

const SECTION: FullConceptCheckSection = {
  type: 'concept_check',
  id: 's1',
  title: 'Check',
  prompt: 'What does H|0> produce?',
  question: 'What does H|0> produce?',
  options: [
    { id: 'a', text: 'A superposition' },
    { id: 'b', text: 'Nothing' },
  ],
  concept: 'superposition',
}

const EXPLANATION = 'H creates an equal superposition.'
const INITIAL_STATE = useLearnStore.getState()
let server = fakeGradingServer({ keys: { 'lesson-1/s1': 'a' }, explanations: { 'lesson-1/s1': EXPLANATION } })

const pick = (label: string) => fireEvent.click(screen.getByLabelText(label))
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
const attempt = () => useLearnStore.getState().lessonProgress['lesson-1']?.conceptCheckAttempts.s1

describe('ConceptCheckQuiz', () => {
  beforeEach(() => {
    useLearnStore.setState(INITIAL_STATE, true)
    server = fakeGradingServer({ keys: { 'lesson-1/s1': 'a' }, explanations: { 'lesson-1/s1': EXPLANATION } })
    client.current = server
  })

  afterEach(() => {
    // Unmount before resetting stores: this afterEach runs before RTL's own
    // auto-cleanup, and resetting a store under a still-mounted component
    // is a state update outside act().
    cleanup()
    useLearnStore.setState(INITIAL_STATE, true)
  })

  it('renders the question and every option', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    expect(screen.getByText('What does H|0> produce?')).toBeInTheDocument()
    expect(screen.getByText('A superposition')).toBeInTheDocument()
    expect(screen.getByText('Nothing')).toBeInTheDocument()
  })

  it('has nothing in the page that says which option is right before anything is submitted', () => {
    const { container } = render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)
    expect(container.textContent).not.toContain(EXPLANATION)
    expect(screen.queryByText(/correct|not quite/i)).not.toBeInTheDocument()
    expect(server.gradeConceptCheck).not.toHaveBeenCalled()
  })

  it('disables Submit until an option is selected', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    pick('A superposition')
    expect(screen.getByRole('button', { name: 'Submit' })).not.toBeDisabled()
  })

  it('asks the server, then shows correct feedback and the server’s explanation on a correct answer', async () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    pick('A superposition')
    submit()

    expect(await screen.findByRole('status')).toHaveTextContent('Correct.')
    expect(screen.getByText(EXPLANATION)).toBeInTheDocument()
    expect(server.gradeConceptCheck.mock.calls).toEqual([['lesson-1', 's1', 'a']])
    expect(attempt()).toEqual({ selectedOptionId: 'a', isCorrect: true, attemptCount: 1, explanation: EXPLANATION })
  })

  it('shows "Checking…" and disables the controls while the server is being asked', async () => {
    let release!: () => void
    client.current = {
      ...server,
      gradeConceptCheck: vi.fn(
        () => new Promise((resolve) => (release = () => resolve({ lessonId: 'lesson-1', checkId: 's1', selectedOptionId: 'a', correct: true, explanation: 'e' }))),
      ),
    }
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)
    pick('A superposition')
    submit()

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled()
    expect(screen.getByLabelText('Nothing')).toBeDisabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument() // no verdict until the server answers
    release()
    expect(await screen.findByRole('status')).toHaveTextContent('Correct.')
  })

  it('shows incorrect feedback and a retry option on a wrong answer', async () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    pick('Nothing')
    submit()

    expect(await screen.findByRole('status')).toHaveTextContent('Not quite.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByText(EXPLANATION)).toBeInTheDocument() // the explanation comes with a wrong answer too
  })

  it('prevents double submission — the Submit button and options disappear once answered', async () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    pick('A superposition')
    submit()
    await screen.findByRole('status')

    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('A superposition')).not.toBeInTheDocument()
    expect(server.gradeConceptCheck).toHaveBeenCalledTimes(1)
  })

  it('does not offer a retry option when the answer was correct', async () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    pick('A superposition')
    submit()
    await screen.findByRole('status')

    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('retrying re-shows the options and a correct resubmission updates the attempt', async () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    pick('Nothing')
    submit()
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
    expect(screen.getByLabelText('A superposition')).toBeInTheDocument()

    pick('A superposition')
    submit()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Correct.'))
    expect(attempt()).toMatchObject({ selectedOptionId: 'a', isCorrect: true, attemptCount: 2 })
  })

  it('when the server cannot be reached it says so, records nothing, and lets the learner try again', async () => {
    client.current = { ...server, gradeConceptCheck: vi.fn().mockRejectedValue(new BackendUnavailableError('could not reach the Qentor backend: down')) }
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    pick('A superposition')
    submit()

    const alert = await screen.findByTestId('grading-failed')
    expect(alert).toHaveTextContent('could not reach the Qentor backend')
    expect(alert).toHaveTextContent('Nothing was recorded')
    expect(screen.queryByRole('status')).not.toBeInTheDocument() // no "Correct." and no "Not quite."
    expect(attempt()).toBeUndefined()
    // the selection is kept and Submit works again
    expect(screen.getByLabelText('A superposition')).toBeChecked()
    client.current = server
    submit()
    expect(await screen.findByRole('status')).toHaveTextContent('Correct.')
    expect(screen.queryByTestId('grading-failed')).not.toBeInTheDocument()
  })

  it('when the server refuses it shows the server’s own code and records nothing', async () => {
    client.current = { ...server, gradeConceptCheck: vi.fn().mockRejectedValue(new GradeRejectedError('CONCEPT_CHECK_NOT_FOUND', 'gone', 404)) }
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    pick('Nothing')
    submit()

    expect(await screen.findByTestId('grading-failed')).toHaveTextContent('CONCEPT_CHECK_NOT_FOUND')
    expect(attempt()).toBeUndefined()
  })

  it('after a reload the verdict is there but the explanation is honestly pending until the server has been asked again', () => {
    useLearnStore.setState({
      lessonProgress: {
        'lesson-1': { activeSectionIndex: 0, completedSectionIds: new Set(), conceptCheckAttempts: { s1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } } },
      },
    })
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    expect(screen.getByRole('status')).toHaveTextContent('Correct.')
    expect(screen.getByTestId('quiz-explanation-pending')).toHaveTextContent(/could not be loaded just now/)
    expect(screen.queryByText(EXPLANATION)).not.toBeInTheDocument() // never a stored or invented explanation

    act(() => useLearnStore.setState({ regradeStatus: 'checking' }))
    expect(screen.getByTestId('quiz-explanation-pending')).toHaveTextContent('Loading the explanation from the server…')
  })

  it('once the saved answers are re-checked the explanation appears', async () => {
    useLearnStore.setState({
      lessons: [
        {
          id: 'lesson-1', title: 'L', shortDescription: 'd', concept: 'c', difficulty: 'beginner', estimatedMinutes: 1, learningObjectives: ['o'],
          sections: [SECTION], linkedCircuit: null, prerequisiteLessonIds: [],
        },
      ],
      lessonProgress: {
        'lesson-1': { activeSectionIndex: 0, completedSectionIds: new Set(), conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: true, attemptCount: 1 } } }, // a saved verdict that is wrong
      },
    })
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)
    await act(async () => {
      await useLearnStore.getState().regradeSavedAnswers()
    })

    expect(await screen.findByText(EXPLANATION)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Not quite.') // the server's verdict replaced the saved one
  })
})
