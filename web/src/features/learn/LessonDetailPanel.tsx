/**
 * The selected lesson's detail view: objectives, ordered sections and lab
 * availability. Every field rendered here is a plain string/number/list
 * already returned by GET /api/lessons — nothing here computes a quantum
 * value; `linkedCircuit` is shown only as shape (qubit/op counts), never
 * executed in place.
 */
import type { Circuit } from '@/circuit/types'
import type { Lesson, LessonDifficulty } from '@/api'
import { getLessonState } from './lessonState'
import { LessonSectionView } from './LessonSectionView'

const DIFFICULTY_LABEL: Record<LessonDifficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
}

export function LessonDetailPanel({
  lesson,
  lessons,
  completedLessonIds,
  onToggleCompleted,
  onOpenLab,
}: {
  lesson: Lesson
  lessons: Lesson[]
  completedLessonIds: ReadonlySet<string>
  onToggleCompleted: () => void
  onOpenLab: (circuit: Circuit) => void
}) {
  const state = getLessonState(lesson, completedLessonIds)
  const prerequisiteTitles = lesson.prerequisiteLessonIds.map(
    (id) => lessons.find((l) => l.id === id)?.title ?? id,
  )

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div>
        <div className="flex flex-wrap items-center gap-2 font-mono-qasm text-[11px] text-void-200">
          <span>{DIFFICULTY_LABEL[lesson.difficulty]}</span>
          <span>·</span>
          <span>{lesson.concept}</span>
          <span>·</span>
          <span>{lesson.estimatedMinutes} min</span>
        </div>
        <h2 className="mt-1.5 font-sans-ui text-2xl font-semibold text-slate-100">{lesson.title}</h2>
        <p className="mt-2 font-serif-prose text-[15px] leading-relaxed text-slate-300">{lesson.shortDescription}</p>

        <button
          type="button"
          onClick={onToggleCompleted}
          className={`mt-3 rounded-lg border px-3 py-1.5 text-xs font-medium ${
            state === 'completed'
              ? 'border-cyan-glow/50 bg-cyan-dim/40 text-cyan-glow'
              : 'border-void-400 text-slate-300 hover:border-void-300'
          }`}
        >
          {state === 'completed' ? '✓ Marked complete' : 'Mark as complete'}
        </button>
        <p className="mt-1.5 text-[11px] text-void-200">
          Completion is tracked locally in this session only — there is no learner-progress backend yet.
        </p>
      </div>

      {prerequisiteTitles.length > 0 && (
        <div className="rounded-lg border border-void-500 bg-void-900 p-3 text-xs text-slate-400">
          <span className="font-medium text-slate-300">Prerequisites: </span>
          {prerequisiteTitles.join(', ')}
        </div>
      )}

      <div>
        <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Objectives</h3>
        <ul className="mt-2 flex flex-col gap-1.5">
          {lesson.learningObjectives.map((objective) => (
            <li key={objective} className="flex gap-2 text-sm text-slate-300">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-cyan-glow" aria-hidden="true" />
              {objective}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-void-500 bg-void-900 p-3 text-xs text-slate-400">
        {lesson.linkedCircuit ? (
          <span>
            Includes a hands-on lab: a {lesson.linkedCircuit.num_qubits}-qubit circuit,{' '}
            {lesson.linkedCircuit.ops.length} operation{lesson.linkedCircuit.ops.length === 1 ? '' : 's'}.
          </span>
        ) : (
          <span>No hands-on lab for this lesson yet.</span>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Sections</h3>
        {lesson.sections.map((section) => (
          <LessonSectionView
            key={section.id}
            section={section}
            linkedCircuit={lesson.linkedCircuit}
            onOpenLab={onOpenLab}
          />
        ))}
      </div>
    </div>
  )
}
