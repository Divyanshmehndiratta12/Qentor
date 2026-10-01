/**
 * The interactive part of a concept_check section with a real question: pick an option, submit, see correct/incorrect
 * feedback and the explanation, retry if wrong.
 *
 * The SERVER grades. This component holds the question and the options and nothing that could decide correctness: the lesson
 * catalog carries no answer key and no explanation. `Submit` sends the selected option id to the store, which asks the grading
 * endpoint; the verdict and explanation shown are the ones it returned. While the server is being asked the button says so; if
 * it cannot be reached or refuses, the reason is shown, nothing is recorded, and the learner can try again — a verdict is never
 * guessed. After a reload the explanation is fetched again with the verdict; until it is, the feedback says so instead of
 * showing stale or invented text.
 */
import { useState } from 'react'
import { gradingKey, useLearnStore } from './store'
import type { FullConceptCheckSection } from './lessonState'

export function ConceptCheckQuiz({ lessonId, section }: { lessonId: string; section: FullConceptCheckSection }) {
  const attempt = useLearnStore((s) => s.lessonProgress[lessonId]?.conceptCheckAttempts[section.id])
  const grading = useLearnStore((s) => s.gradingStatus[gradingKey(lessonId, section.id)])
  const regradeStatus = useLearnStore((s) => s.regradeStatus)
  const submitConceptCheckAnswer = useLearnStore((s) => s.submitConceptCheckAnswer)

  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [isRetrying, setIsRetrying] = useState(false)

  const isGrading = grading?.state === 'grading'

  // Feedback is shown whenever there's a recorded attempt, unless the
  // learner explicitly asked to retry — this is what makes a fresh
  // selection+submit possible again without ever un-recording the fact that
  // the check was attempted (completion only cares about "attempted", never
  // "attempted exactly once").
  const showFeedback = Boolean(attempt) && !isRetrying

  async function handleSubmit() {
    if (!selectedOptionId || isGrading) return
    const recorded = await submitConceptCheckAnswer(lessonId, section.id, selectedOptionId)
    if (recorded) setIsRetrying(false)
  }

  function handleRetry() {
    setSelectedOptionId(null)
    setIsRetrying(true)
  }

  return (
    <div className="mt-2 flex flex-col gap-2.5">
      <p className="text-sm text-slate-200">{section.question}</p>

      {!showFeedback && (
        <fieldset className="flex flex-col gap-1.5" aria-label={section.question} disabled={isGrading}>
          {section.options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-void-400 px-2.5 py-1.5 text-sm text-slate-300 has-[:checked]:border-violet-glow/60 has-[:checked]:text-slate-100"
            >
              <input
                type="radio"
                name={`concept-check-${lessonId}-${section.id}`}
                value={option.id}
                checked={selectedOptionId === option.id}
                onChange={() => setSelectedOptionId(option.id)}
                className="accent-violet-glow"
              />
              {option.text}
            </label>
          ))}
        </fieldset>
      )}

      {!showFeedback && grading?.state === 'failed' && (
        <p role="alert" data-testid="grading-failed" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-2.5 text-xs text-danger-glow">
          {grading.message}
        </p>
      )}

      {!showFeedback && (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!selectedOptionId || isGrading}
          className="self-start rounded-lg bg-violet-glow px-3 py-1.5 text-xs font-semibold text-void-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isGrading ? 'Checking…' : 'Submit'}
        </button>
      )}

      {showFeedback && attempt && (
        <div
          role="status"
          className={`rounded-lg border p-2.5 text-sm ${
            attempt.isCorrect
              ? 'border-cyan-glow/40 bg-cyan-dim/30 text-cyan-glow'
              : 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow'
          }`}
        >
          <p className="font-medium">{attempt.isCorrect ? 'Correct.' : 'Not quite.'}</p>
          {attempt.explanation !== undefined ? (
            <p className="mt-1 text-slate-300" data-testid="quiz-explanation">
              {attempt.explanation}
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-400" data-testid="quiz-explanation-pending">
              {regradeStatus === 'checking'
                ? 'Loading the explanation from the server…'
                : 'The explanation comes from the server and could not be loaded just now.'}
            </p>
          )}
          {!attempt.isCorrect && (
            <button
              type="button"
              onClick={handleRetry}
              className="mt-2 rounded-md border border-void-400 px-2.5 py-1 text-xs font-medium text-slate-300 hover:border-void-300"
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  )
}
