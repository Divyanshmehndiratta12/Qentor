/**
 * The Progress destination: a learner dashboard, distinct from the Lab
 * (circuits) and from Learn (lessons). Everything here is read-only over
 * `useLearnStore` and the pure functions in `learn/learnerInsights.ts` and
 * `learn/streak.ts` — it defines no mastery, misconception or recommendation
 * rule of its own, holds no lesson content of its own (titles/concepts come
 * from GET /api/lessons via the store), and never touches `useBuildStore`.
 *
 * Two honesty notes shown on screen:
 * - Lesson progress (sections, concept checks, mastery) is this browser
 *   SESSION only — lost on reload — exactly as in Learn.
 * - The streak's activity days ARE saved, in this browser's localStorage
 *   only; there is no account, no server and no cross-device sync.
 *
 * The one outward action is `onOpenLesson`, wired by `App.tsx` to select that
 * lesson and switch to Learn.
 */
import { useEffect } from 'react'
import type { Lesson } from '@/api'
import { useLearnStore } from '../learn/store'
import { getLessonState, getLessonMastery, isLessonComplete } from '../learn/lessonState'
import {
  getLessonStatus,
  getMasteryBreakdown,
  getMisconceptions,
  getNextChallenge,
  getOverallLearningProgress,
  getSectionProgress,
  type LessonStatus,
  type Mastery,
} from '../learn/learnerInsights'
import { getActivitySummary, toLocalDateKey } from '../learn/streak'
import { StreakPanel } from './StreakPanel'

const MASTERY_LABEL: Record<Mastery, string> = {
  mastered: 'Mastered',
  developing: 'Developing',
  not_started: 'Not started',
}

const STATUS_LABEL: Record<LessonStatus, string> = {
  completed: 'Completed',
  developing: 'Developing',
  not_started: 'Not started',
}

const STATUS_STYLE: Record<LessonStatus, string> = {
  completed: 'border-cyan-glow/40 bg-cyan-dim/30 text-cyan-glow',
  developing: 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow',
  not_started: 'border-void-400 text-void-200',
}

const MASTERY_STYLE: Record<Mastery, string> = {
  mastered: 'border-violet-glow/40 bg-violet-dim/30 text-violet-glow',
  developing: 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow',
  not_started: 'border-void-400 text-void-200',
}

const SECTION_HEADING = 'text-[11px] font-semibold tracking-wider text-slate-400 uppercase'
const CARD = 'rounded-xl border border-void-500 bg-void-900 p-5'

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100)
}

export function ProgressScreen({ onOpenLesson }: { onOpenLesson: (lessonId: string) => void }) {
  const lessons = useLearnStore((s) => s.lessons)
  const isLoading = useLearnStore((s) => s.isLoading)
  const error = useLearnStore((s) => s.error)
  const activityHistory = useLearnStore((s) => s.activityHistory)
  const fetchLessons = useLearnStore((s) => s.fetchLessons)

  // The learner may come straight here from Lab, before Learn ever loaded the
  // catalog. Fetch only when there is nothing yet (a real fetch of the real
  // catalog — never a stand-in). A failed fetch leaves `needsCatalog` true
  // but doesn't change it, so this can't loop.
  const needsCatalog = lessons.length === 0
  useEffect(() => {
    if (needsCatalog) void fetchLessons()
  }, [needsCatalog, fetchLessons])

  const todayKey = toLocalDateKey(new Date())
  const activity = getActivitySummary(activityHistory, todayKey)

  const catalogReady = !isLoading && !error && lessons.length > 0

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-6">
      <header>
        <h1 className="font-sans-ui text-2xl font-semibold text-slate-100">Progress</h1>
        <p className="mt-1.5 max-w-2xl font-serif-prose text-[15px] leading-relaxed text-slate-400">
          Where you stand across the lesson catalog — and how consistently you're showing up.
        </p>
      </header>

      <StreakPanel summary={activity} todayKey={todayKey} />

      {isLoading && <p className="text-xs text-slate-500">Loading lessons…</p>}

      {!isLoading && error && (
        <div
          role="alert"
          className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3 text-xs text-danger-glow"
        >
          <p className="font-medium">Couldn't load lessons.</p>
          <p className="mt-1 text-danger-glow/80">{error}</p>
        </div>
      )}

      {!isLoading && !error && lessons.length === 0 && (
        <p className="rounded-lg border border-void-400 bg-void-800 p-3 text-xs text-slate-500">
          No lessons are available yet.
        </p>
      )}

      {catalogReady && <LessonDashboard onOpenLesson={onOpenLesson} />}
    </div>
  )
}

/** Everything that is derived from the lesson catalog + Learn progress. Split
 * out so the streak card above renders even while the catalog is loading or
 * failed — the streak doesn't depend on it. */
function LessonDashboard({ onOpenLesson }: { onOpenLesson: (lessonId: string) => void }) {
  const lessons = useLearnStore((s) => s.lessons)
  const lessonProgress = useLearnStore((s) => s.lessonProgress)
  const startedLessonIds = useLearnStore((s) => s.startedLessonIds)

  const overall = getOverallLearningProgress(lessons, lessonProgress, startedLessonIds)
  const mastery = getMasteryBreakdown(lessons, lessonProgress, startedLessonIds)
  const misconceptions = getMisconceptions(lessons, lessonProgress, startedLessonIds)
  const nextChallenge = getNextChallenge(lessons, lessonProgress, startedLessonIds)
  const completionPercent = percent(overall.lessonsCompleted, overall.totalLessons)

  const completedLessonIds = new Set(
    lessons.filter((lesson) => isLessonComplete(lesson, lessonProgress[lesson.id])).map((lesson) => lesson.id),
  )

  return (
    <>
      <div className="grid gap-5 md:grid-cols-2">
        <section aria-labelledby="overall-heading" className={CARD}>
          <h2 id="overall-heading" className={SECTION_HEADING}>
            Overall progress
          </h2>
          <p className="mt-3 font-mono-qasm text-3xl leading-none font-semibold text-slate-100">
            {completionPercent}%
            <span className="ml-2 text-sm font-normal text-slate-400">of lessons completed</span>
          </p>
          <div
            role="progressbar"
            aria-label="Overall lesson completion"
            aria-valuenow={completionPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${overall.lessonsCompleted} of ${overall.totalLessons} lessons completed`}
            className="mt-3 h-2 w-full overflow-hidden rounded-full bg-void-600"
          >
            <div className="h-full rounded-full bg-cyan-glow" style={{ width: `${completionPercent}%` }} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-slate-400">Lessons started</dt>
            <dd className="font-mono-qasm text-slate-200">
              {overall.lessonsStarted} of {overall.totalLessons}
            </dd>
            <dt className="text-slate-400">Lessons completed</dt>
            <dd className="font-mono-qasm text-slate-200">
              {overall.lessonsCompleted} of {overall.totalLessons}
            </dd>
          </dl>
          <p className="mt-3 text-[10px] leading-snug text-void-200">
            Lesson progress is tracked in this browser session only — it resets on reload.
          </p>
        </section>

        <section aria-labelledby="checks-heading" className={CARD}>
          <h2 id="checks-heading" className={SECTION_HEADING}>
            Concept-check performance
          </h2>
          {overall.overallAccuracy === null ? (
            <p className="mt-3 text-sm text-slate-300">No attempts yet</p>
          ) : (
            <p className="mt-3 font-mono-qasm text-3xl leading-none font-semibold text-slate-100">
              {Math.round(overall.overallAccuracy * 100)}%
              <span className="ml-2 text-sm font-normal text-slate-400">accuracy</span>
            </p>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-slate-400">Checks attempted</dt>
            <dd className="font-mono-qasm text-slate-200">
              {overall.conceptChecksAttempted} of {overall.conceptChecksTotal}
            </dd>
            <dt className="text-slate-400">Answered correctly</dt>
            <dd className="font-mono-qasm text-slate-200">{overall.conceptChecksCorrect}</dd>
          </dl>
          <p className="mt-3 text-[10px] leading-snug text-void-200">
            Accuracy uses your latest answer on each attempted check.
          </p>
        </section>

        <section aria-labelledby="mastery-heading" className={CARD}>
          <h2 id="mastery-heading" className={SECTION_HEADING}>
            Mastery
          </h2>
          <ul className="mt-3 grid grid-cols-3 gap-2">
            {(['mastered', 'developing', 'not_started'] as const).map((key) => (
              <li key={key} className={`rounded-lg border px-2.5 py-2 ${MASTERY_STYLE[key]}`}>
                <p className="font-mono-qasm text-xl leading-none font-semibold">{mastery[key]}</p>
                <p className="mt-1 text-[11px]">{MASTERY_LABEL[key]}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[10px] leading-snug text-void-200">
            Mastered = lesson completed with at least 80% of its concept checks correct.
          </p>
        </section>

        <section aria-labelledby="next-heading" className={CARD}>
          <h2 id="next-heading" className={SECTION_HEADING}>
            Next challenge
          </h2>
          <div className="mt-3 rounded-lg border border-violet-glow/30 bg-violet-dim/20 p-3">
            <p className="font-serif-prose text-[14px] leading-relaxed text-slate-200">{nextChallenge.reason}</p>
            {nextChallenge.lessonId && (
              <button
                type="button"
                onClick={() => onOpenLesson(nextChallenge.lessonId as string)}
                className="mt-2.5 rounded-md bg-violet-glow px-3 py-1.5 text-xs font-semibold text-void-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
              >
                Go to lesson
              </button>
            )}
          </div>
        </section>
      </div>

      <section aria-labelledby="attention-heading" className={CARD}>
        <h2 id="attention-heading" className={SECTION_HEADING}>
          Needs attention
        </h2>
        {misconceptions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No open signals right now.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5">
            {misconceptions.map((signal) => (
              <li key={`${signal.lessonId}-${signal.sectionId ?? 'lesson'}-${signal.severity}`}>
                <button
                  type="button"
                  onClick={() => onOpenLesson(signal.lessonId)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-amber-glow/30 bg-amber-dim/20 px-3 py-2 text-left text-sm text-amber-glow hover:border-amber-glow/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
                >
                  <span>{signal.reason}</span>
                  <span className="shrink-0 font-mono-qasm text-[10px] uppercase">{signal.severity}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lessons-heading" className={CARD}>
        <h2 id="lessons-heading" className={SECTION_HEADING}>
          Lessons
        </h2>
        <ul className="mt-3 flex flex-col gap-2">
          {lessons.map((lesson) => (
            <LessonProgressRow
              key={lesson.id}
              lesson={lesson}
              lessons={lessons}
              completedLessonIds={completedLessonIds}
              onOpenLesson={onOpenLesson}
            />
          ))}
        </ul>
      </section>
    </>
  )
}

function LessonProgressRow({
  lesson,
  lessons,
  completedLessonIds,
  onOpenLesson,
}: {
  lesson: Lesson
  lessons: Lesson[]
  completedLessonIds: ReadonlySet<string>
  onOpenLesson: (lessonId: string) => void
}) {
  const progress = useLearnStore((s) => s.lessonProgress[lesson.id])
  const started = useLearnStore((s) => s.startedLessonIds.has(lesson.id))

  const status = getLessonStatus(lesson, progress, started)
  const mastery = getLessonMastery(lesson, progress, started)
  const sections = getSectionProgress(lesson, progress)
  const locked = getLessonState(lesson, completedLessonIds) === 'locked'
  const missing = lesson.prerequisiteLessonIds
    .filter((id) => !completedLessonIds.has(id))
    .map((id) => lessons.find((l) => l.id === id)?.title ?? id)
  const sectionPercent = percent(sections.completed, sections.total)

  return (
    <li>
      <button
        type="button"
        disabled={locked}
        onClick={() => onOpenLesson(lesson.id)}
        aria-label={locked ? `${lesson.title} — locked, complete ${missing.join(', ')} first` : undefined}
        title={locked ? `Complete ${missing.join(', ')} first` : undefined}
        className={`flex w-full flex-col gap-2 rounded-lg border px-3.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow ${
          locked
            ? 'cursor-not-allowed border-void-500 bg-void-900 opacity-60'
            : 'border-void-500 bg-void-800 hover:border-void-300'
        }`}
      >
        <span className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-100">{lesson.title}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[status]}`}>
              {STATUS_LABEL[status]}
            </span>
            {status === 'completed' && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${MASTERY_STYLE[mastery]}`}
              >
                Mastery: {MASTERY_LABEL[mastery]}
              </span>
            )}
            {locked && (
              <span className="rounded-full border border-void-400 px-2 py-0.5 text-[10px] font-medium text-void-200">
                Locked
              </span>
            )}
          </span>
        </span>

        <span className="font-mono-qasm text-[11px] text-void-200">{lesson.concept}</span>

        <span className="flex w-full items-center gap-3">
          {/* Decorative: a button's children are presentational to assistive
              tech, so the meaning lives in the visible "N/M sections" text
              (part of the button's accessible name), not in this bar. */}
          <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-void-600">
            <span className="block h-full rounded-full bg-cyan-glow" style={{ width: `${sectionPercent}%` }} />
          </span>
          <span className="shrink-0 font-mono-qasm text-[11px] text-slate-300">
            {sections.completed}/{sections.total} sections
          </span>
        </span>
      </button>
    </li>
  )
}
