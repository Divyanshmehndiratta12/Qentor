/**
 * "Practice this lesson": the challenges that belong to a lesson, so a learner who has just read about an idea can go straight to
 * applying it. It reads the challenge catalog and the saved outcomes; it decides nothing.
 */
import { challengeStatus } from './ChallengeList'
import { useChallengeStore } from './store'

const STATUS_LABEL = { solved: 'Solved', attempted: 'In progress', new: 'Not started' } as const

export function LessonChallenges({
  lessonId,
  lessonComplete,
  onOpenChallenge,
}: {
  lessonId: string
  lessonComplete: boolean
  onOpenChallenge: (challengeId: string) => void
}) {
  const challenges = useChallengeStore((s) => s.challenges)
  const records = useChallengeStore((s) => s.outcomes.records)
  const mine = challenges.filter((c) => c.lessonId === lessonId)
  if (mine.length === 0) return null

  return (
    <section aria-labelledby="practice-heading" className="rounded-lg border border-violet-glow/30 bg-violet-dim/20 p-3.5" data-testid="lesson-challenges">
      <h3 id="practice-heading" className="text-xs font-semibold tracking-wider text-violet-glow uppercase">
        Practice this lesson
      </h3>
      <p className="mt-1 text-[12px] text-slate-300">
        {lessonComplete ? 'You finished this lesson. Apply it:' : 'Ready to try it? A challenge checks your circuit against the real quantum state:'}
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {mine.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 text-[12px]">
            <button
              type="button"
              onClick={() => onOpenChallenge(c.id)}
              className="truncate text-left text-slate-100 underline decoration-violet-glow/50 underline-offset-2 hover:decoration-violet-glow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
            >
              {c.title}
            </button>
            <span className="shrink-0 font-mono-qasm text-[10px] text-slate-400">{STATUS_LABEL[challengeStatus(records[c.id])]}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
