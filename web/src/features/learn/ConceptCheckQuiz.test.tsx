import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { FullConceptCheckSection } from './lessonState'
import { useLearnStore } from './store'
import { ConceptCheckQuiz } from './ConceptCheckQuiz'

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
  correctOptionId: 'a',
  explanation: 'H creates an equal superposition.',
  concept: 'superposition',
}

const INITIAL_STATE = useLearnStore.getState()

describe('ConceptCheckQuiz', () => {
  beforeEach(() => {
    useLearnStore.setState(INITIAL_STATE, true)
  })

  afterEach(() => {
    useLearnStore.setState(INITIAL_STATE, true)
  })

  it('renders the question and every option', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    expect(screen.getByText('What does H|0> produce?')).toBeInTheDocument()
    expect(screen.getByText('A superposition')).toBeInTheDocument()
    expect(screen.getByText('Nothing')).toBeInTheDocument()
  })

  it('disables Submit until an option is selected', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('A superposition'))
    expect(screen.getByRole('button', { name: 'Submit' })).not.toBeDisabled()
  })

  it('shows correct feedback and the explanation on a correct answer', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    fireEvent.click(screen.getByLabelText('A superposition'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(screen.getByRole('status')).toHaveTextContent('Correct.')
    expect(screen.getByText('H creates an equal superposition.')).toBeInTheDocument()
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.conceptCheckAttempts.s1).toEqual({
      selectedOptionId: 'a',
      isCorrect: true,
      attemptCount: 1,
    })
  })

  it('shows incorrect feedback and a retry option on a wrong answer', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    fireEvent.click(screen.getByLabelText('Nothing'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(screen.getByRole('status')).toHaveTextContent('Not quite.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('prevents double submission — the Submit button and options disappear once answered', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    fireEvent.click(screen.getByLabelText('A superposition'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('A superposition')).not.toBeInTheDocument()
  })

  it('does not offer a retry option when the answer was correct', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    fireEvent.click(screen.getByLabelText('A superposition'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('retrying re-shows the options and a correct resubmission updates the attempt', () => {
    render(<ConceptCheckQuiz lessonId="lesson-1" section={SECTION} />)

    fireEvent.click(screen.getByLabelText('Nothing'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
    expect(screen.getByLabelText('A superposition')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('A superposition'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(screen.getByRole('status')).toHaveTextContent('Correct.')
    expect(useLearnStore.getState().lessonProgress['lesson-1']?.conceptCheckAttempts.s1).toEqual({
      selectedOptionId: 'a',
      isCorrect: true,
      attemptCount: 2,
    })
  })
})
