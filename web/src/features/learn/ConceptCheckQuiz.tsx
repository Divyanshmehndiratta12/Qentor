/**
 * The interactive part of a fully-specified concept_check section: pick an
 * option, submit, see correct/incorrect feedback and the explanation, retry
 * if wrong. Grading is a plain string comparison against `correctOptionId`
 * (already present in the fetched lesson data) — there is no server-side
 * grading endpoint in this milestone. That means the correct answer is
 * visible in the GET /api/lessons network response; this is a pedagogical
 * scoring detail, not a quantum-trust concern (CLAUDE.md's execution/
 * verification boundary governs quantum results, not quiz answers), but a
 * motivated learner could inspect it — a known limitation, not a bug.
 */
import { useState } from 'react'
import { useLearnStore } from './store'
import type { FullConceptCheckSection } from './lessonState'

export function ConceptCheckQuiz({ lessonId, section }: { lessonId: string; section: FullConceptCheckSection }) {
  const attempt = useLearnStore((s) => s.lessonProgress[lessonId]?.conceptCheckAttempts[section.id])
  const submitConceptCheckAnswer = useLearnStore((s) => s.submitConceptCheckAnswer)

  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [isRetrying, setIsRetrying] = useState(false)

  // Feedback is shown whenever there's a recorded attempt, unless the
  // learner explicitly asked to retry — this is what makes a fresh
  // selection+submit possible again without ever un-recording the fact that
  // the check was attempted (completion only cares about "attempted", never
  // "attempted exactly once").
  const showFeedback = Boolean(attempt) && !isRetrying

  function handleSubmit() {
    if (!selectedOptionId) return
    submitConceptCheckAnswer(lessonId, section.id, selectedOptionId, section.correctOptionId)
    setIsRetrying(false)
  }

  function handleRetry() {
    setSelectedOptionId(null)
    setIsRetrying(true)
  }

  return (
    <div className="mt-2 flex flex-col gap-2.5">
      <p className="text-sm text-slate-200">{section.question}</p>

      {!showFeedback && (
        <fieldset className="flex flex-col gap-1.5" aria-label={section.question}>
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

      {!showFeedback && (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!selectedOptionId}
          className="self-start rounded-lg bg-violet-glow px-3 py-1.5 text-xs font-semibold text-void-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Submit
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
          <p className="mt-1 text-slate-300">{section.explanation}</p>
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
