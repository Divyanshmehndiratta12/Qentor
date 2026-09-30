/**
 * One lesson in the Learn list. A locked card is a real, semantic `<button>`
 * with `disabled` set (not just styled to look inert) so it's unreachable by
 * keyboard/click alike, and its `title`/`aria-label` say which prerequisite
 * is missing rather than leaving the lock unexplained.
 */
import type { Lesson, LessonDifficulty } from '@/api'
import { getLessonState, type LessonState } from './lessonState'

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
  onSelect,
}: {
  lesson: Lesson
  lessons: Lesson[]
  completedLessonIds: ReadonlySet<string>
  selected: boolean
  onSelect: () => void
}) {
  const state = getLessonState(lesson, completedLessonIds)
  const locked = state === 'locked'
  const missingPrerequisiteTitles = lesson.prerequisiteLessonIds
    .filter((id) => !completedLessonIds.has(id))
    .map((id) => lessons.find((l) => l.id === id)?.title ?? id)

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={locked}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${lesson.title}${locked ? ` — locked, complete ${missingPrerequisiteTitles.join(', ')} first` : ''}${
        state === 'completed' ? ' — completed' : ''
      }`}
      title={locked ? `Complete ${missingPrerequisiteTitles.join(', ')} first` : undefined}
      className={`flex w-full flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-cyan-glow/50 bg-cyan-dim/30'
          : locked
            ? 'cursor-not-allowed border-void-500 bg-void-900 opacity-50'
            : 'border-void-500 bg-void-800 hover:border-void-300'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className={`text-sm font-medium ${selected ? 'text-cyan-glow' : 'text-slate-200'}`}>{lesson.title}</span>
        <LessonStateBadge state={state} />
      </div>
      <p className="text-[12px] text-slate-400">{lesson.shortDescription}</p>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono-qasm text-[10px] text-void-200">
        <span className={`rounded-full border px-1.5 py-0.5 ${DIFFICULTY_STYLE[lesson.difficulty]}`}>
          {DIFFICULTY_LABEL[lesson.difficulty]}
        </span>
        <span>{lesson.concept}</span>
        <span>· {lesson.estimatedMinutes} min</span>
      </div>
    </button>
  )
}

function LessonStateBadge({ state }: { state: LessonState }) {
  if (state === 'completed') {
    return (
      <span className="shrink-0 rounded-full border border-cyan-glow/40 bg-cyan-dim/40 px-1.5 py-0.5 text-[10px] font-medium text-cyan-glow">
        done
      </span>
    )
  }
  if (state === 'locked') {
    return (
      <span className="shrink-0 rounded-full border border-void-400 px-1.5 py-0.5 text-[10px] font-medium text-void-200">
        locked
      </span>
    )
  }
  return null
}
