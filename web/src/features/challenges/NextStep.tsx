/**
 * Where to go after solving a challenge: the deterministic recommendation (`learn/recommendation.ts`) over the progress saved in
 * this browser, with the reason. There is always somewhere to go: another challenge, a lesson, or the Progress screen.
 */
import { useChallengeStore } from './store'
import { useLearnStore } from '@/features/learn/store'
import { getRecommendation } from '@/features/learn/recommendation'

const PRIMARY =
  'rounded-md bg-violet-glow px-3 py-1.5 text-xs font-semibold text-void-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow'
const SECONDARY =
  'rounded-md border border-void-400 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow'

export function NextStep({
  onOpenChallenge,
  onOpenLesson,
  onOpenProgress,
}: {
  onOpenChallenge: (challengeId: string) => void
  onOpenLesson: (lessonId: string) => void
  onOpenProgress: () => void
}) {
  const lessons = useLearnStore((s) => s.lessons)
  const lessonProgress = useLearnStore((s) => s.lessonProgress)
  const started = useLearnStore((s) => s.startedLessonIds)
  const challenges = useChallengeStore((s) => s.challenges)
  const records = useChallengeStore((s) => s.outcomes.records)
  const rec = getRecommendation(lessons, challenges, lessonProgress, started, records)

  return (
    <div className="mt-3 rounded-md border border-violet-glow/30 bg-violet-dim/20 px-3 py-2.5" data-testid="next-step" data-kind={rec.kind}>
      <p className="text-[11px] font-semibold tracking-wider text-violet-glow uppercase">What next</p>
      <p className="mt-1 text-[12px] leading-snug text-slate-200">{rec.reason}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {rec.challengeId && rec.kind !== 'revisit_lesson' && (
          <button type="button" className={PRIMARY} onClick={() => onOpenChallenge(rec.challengeId as string)}>
            Open challenge
          </button>
        )}
        {rec.lessonId && (
          <button type="button" className={rec.challengeId && rec.kind !== 'revisit_lesson' ? SECONDARY : PRIMARY} onClick={() => onOpenLesson(rec.lessonId as string)}>
            Go to lesson
          </button>
        )}
        <button type="button" className={SECONDARY} onClick={onOpenProgress}>
          See my progress
        </button>
      </div>
    </div>
  )
}
