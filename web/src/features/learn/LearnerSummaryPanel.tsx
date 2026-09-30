/**
 * The learner-insight summary: overall progress, mastery breakdown, evidence
 * -backed "needs attention" signals, and one recommended next action. Every
 * number/label here comes straight from `learnerInsights.ts`'s pure
 * functions over the real lesson catalog and session-local Learn progress —
 * nothing is AI-generated, and nothing is persisted or shared across
 * sessions (each computation re-runs from `useLearnStore`'s current state).
 *
 * Progress is never color-only: the bar is paired with an explicit "N/M ·
 * P%" label, mastery counts are plain text, and every signal/recommendation
 * is a real sentence, not a bare swatch.
 */
import type { Lesson } from '@/api'
import type { LessonProgress } from './lessonState'
import { PersistenceNote } from './PersistenceNote'
import {
  getMasteryBreakdown,
  getMisconceptions,
  getNextChallenge,
  getOverallLearningProgress,
  type Mastery,
} from './learnerInsights'

const MASTERY_LABEL: Record<Mastery, string> = {
  mastered: 'Mastered',
  developing: 'Developing',
  not_started: 'Not started',
}

export function LearnerSummaryPanel({
  lessons,
  lessonProgress,
  startedLessonIds,
  onSelectLesson,
}: {
  lessons: Lesson[]
  lessonProgress: Record<string, LessonProgress>
  startedLessonIds: ReadonlySet<string>
  onSelectLesson: (lessonId: string) => void
}) {
  const overall = getOverallLearningProgress(lessons, lessonProgress, startedLessonIds)
  const mastery = getMasteryBreakdown(lessons, lessonProgress, startedLessonIds)
  const misconceptions = getMisconceptions(lessons, lessonProgress, startedLessonIds)
  const nextChallenge = getNextChallenge(lessons, lessonProgress, startedLessonIds)

  const completionPercent =
    overall.totalLessons === 0 ? 0 : Math.round((overall.lessonsCompleted / overall.totalLessons) * 100)

  return (
    <section aria-label="Learner insights" className="flex flex-col gap-3.5 border-b border-void-500 p-3.5">
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Learning progress</h2>
          <span className="font-mono-qasm text-[11px] text-slate-300">
            {overall.lessonsCompleted}/{overall.totalLessons} · {completionPercent}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Overall lesson completion"
          aria-valuenow={completionPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-void-600"
        >
          <div className="h-full rounded-full bg-cyan-glow" style={{ width: `${completionPercent}%` }} />
        </div>
        <p className="mt-1.5 font-mono-qasm text-[10px] text-void-200">
          started {overall.lessonsStarted} · concept checks {overall.conceptChecksCorrect}/
          {overall.conceptChecksAttempted} correct
          {overall.overallAccuracy !== null ? ` (${Math.round(overall.overallAccuracy * 100)}%)` : ''}
        </p>
        <PersistenceNote className="mt-1 text-[10px] text-void-200" />
      </div>

      <div>
        <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Mastery</h3>
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {(['mastered', 'developing', 'not_started'] as const).map((key) => (
            <li
              key={key}
              className="rounded-full border border-void-400 px-2 py-0.5 font-mono-qasm text-[10px] text-slate-300"
            >
              {MASTERY_LABEL[key]}: {mastery[key]}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Needs attention</h3>
        {misconceptions.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-slate-500">No open signals right now.</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1">
            {misconceptions.map((signal) => (
              <li key={`${signal.lessonId}-${signal.sectionId ?? 'lesson'}-${signal.severity}`}>
                <button
                  type="button"
                  onClick={() => onSelectLesson(signal.lessonId)}
                  className="w-full rounded-md border border-amber-glow/30 bg-amber-dim/20 px-2 py-1 text-left text-[11px] text-amber-glow hover:border-amber-glow/60"
                >
                  {signal.reason}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Next challenge</h3>
        <div className="mt-1.5 rounded-md border border-violet-glow/30 bg-violet-dim/20 p-2">
          <p className="text-[11px] text-slate-200">{nextChallenge.reason}</p>
          {nextChallenge.lessonId && (
            <button
              type="button"
              onClick={() => onSelectLesson(nextChallenge.lessonId as string)}
              className="mt-1.5 rounded-md bg-violet-glow px-2 py-1 text-[10px] font-semibold text-void-950"
            >
              Go to lesson
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
