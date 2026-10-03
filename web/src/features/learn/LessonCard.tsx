/**
 * One lesson in the Learn list. Every card is an enabled, real `<button>`: no lesson is locked. What a lesson builds on is
 * shown as a plain "Builds on: …" line (and the one lesson the recommended path points at as "Suggested next"), neither of
 * which stops a learner opening it.
 */
import type { Lesson, LessonDifficulty } from '@/api'
import { getLessonState, getUnmetPrerequisiteIds, lessonTitlesFor, type LessonState } from './lessonState'

export const DIFFICULTY_LABEL: Record<LessonDifficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
}

export const DIFFICULTY_STYLE: Record<LessonDifficulty, string> = {
  beginner: 'border-cyan-glow/40 bg-cyan-dim/30 text-cyan-glow',
  intermediate: 'border-violet-glow/40 bg-violet-dim/30 text-violet-glow',
  advanced: 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow',
}

export function LessonCard({
  lesson,
  lessons,
  completedLessonIds,
  selected,
  suggestedNext = false,
  onSelect,
}: {
  lesson: Lesson
  lessons: Lesson[]
  completedLessonIds: ReadonlySet<string>
  selected: boolean
  /** True for the single lesson the recommended path points at (from `getNextChallenge`, never decided here). */
  suggestedNext?: boolean
  onSelect: () => void
}) {
  const state = getLessonState(lesson, completedLessonIds)
  const buildsOn =
    state === 'completed' ? [] : lessonTitlesFor(getUnmetPrerequisiteIds(lesson, completedLessonIds), lessons)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${lesson.title}${state === 'completed' ? ' — completed' : ''}${suggestedNext ? ' — suggested next' : ''}${
        buildsOn.length > 0 ? ` — builds on ${buildsOn.join(', ')}` : ''
      }`}
      className={`flex w-full flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-cyan-glow/50 bg-cyan-dim/30'
          : suggestedNext
            ? 'border-cyan-glow/30 bg-void-800 hover:border-cyan-glow/60'
            : 'border-void-500 bg-void-800 hover:border-void-300'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className={`text-sm font-medium ${selected ? 'text-cyan-glow' : 'text-slate-200'}`}>{lesson.title}</span>
        <LessonStateBadge state={state} suggestedNext={suggestedNext} />
      </div>
      <p className="text-[12px] text-slate-400">{lesson.shortDescription}</p>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono-qasm text-[10px] text-void-200">
        <span className={`rounded-full border px-1.5 py-0.5 ${DIFFICULTY_STYLE[lesson.difficulty]}`}>
          {DIFFICULTY_LABEL[lesson.difficulty]}
        </span>
        <span>{lesson.concept}</span>
        <span>· {lesson.estimatedMinutes} min</span>
      </div>
      {buildsOn.length > 0 && (
        <p className="text-[11px] text-void-200">{`Builds on: ${buildsOn.join(', ')}`}</p>
      )}
    </button>
  )
}

function LessonStateBadge({ state, suggestedNext }: { state: LessonState; suggestedNext: boolean }) {
  if (state === 'completed') {
    return (
      <span className="shrink-0 rounded-full border border-cyan-glow/40 bg-cyan-dim/40 px-1.5 py-0.5 text-[10px] font-medium text-cyan-glow">
        done
      </span>
    )
  }
  if (suggestedNext) {
    return (
      <span className="shrink-0 rounded-full border border-cyan-glow/40 px-1.5 py-0.5 text-[10px] font-medium text-cyan-glow">
        Suggested next
      </span>
    )
  }
  return null
}
