/**
 * The selected lesson's detail view: objectives, lab availability, an
 * overall progress/mastery summary, and the step-by-step `LessonPlayer`
 * (sections completed, concept-check score, completion, mastery — all
 * derived by `lessonState.ts` from `progress`, never stored pre-computed).
 * Every field rendered here is either a plain value from GET /api/lessons or
 * a pure function of local session progress — nothing here computes a
 * quantum value; `linkedCircuit` is shown only as shape (qubit/op counts),
 * never executed in place.
 */
import type { Circuit } from '@/circuit/types'
import type { Lesson, LessonDifficulty } from '@/api'
import {
  getConceptCheckScore,
  getLessonMastery,
  isLessonComplete,
  type LessonProgress,
  type Mastery,
} from './lessonState'
import { LessonPlayer } from './LessonPlayer'
import { PersistenceNote } from './PersistenceNote'
import { LessonChallenges } from '@/features/challenges/LessonChallenges'

const DIFFICULTY_LABEL: Record<LessonDifficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
}

const MASTERY_LABEL: Record<Mastery, string> = {
  not_started: 'Not started',
  developing: 'Developing',
  mastered: 'Mastered',
}

const MASTERY_STYLE: Record<Mastery, string> = {
  not_started: 'border-void-400 text-void-200',
  developing: 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow',
  mastered: 'border-cyan-glow/40 bg-cyan-dim/30 text-cyan-glow',
}

export function LessonDetailPanel({
  lesson,
  lessons,
  progress,
  started,
  onOpenLab,
  onOpenNoiseLab,
  onOpenChallenge,
}: {
  lesson: Lesson
  lessons: Lesson[]
  progress: LessonProgress | undefined
  started: boolean
  onOpenLab: (circuit: Circuit) => void
  onOpenNoiseLab?: (circuit: Circuit) => void
  /** Where a lesson's challenges lead. Optional: without it the practice card is not shown. */
  onOpenChallenge?: (challengeId: string) => void
}) {
  const prerequisiteTitles = lesson.prerequisiteLessonIds.map(
    (id) => lessons.find((l) => l.id === id)?.title ?? id,
  )

  const completedCount = progress?.completedSectionIds.size ?? 0
  const complete = isLessonComplete(lesson, progress)
  const score = getConceptCheckScore(lesson, progress)
  const mastery = getLessonMastery(lesson, progress, started)

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
      </div>

      <div
        className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-void-500 bg-void-900 p-3.5 text-xs text-slate-300 sm:grid-cols-4"
        aria-label="Lesson progress"
      >
        <div>
          <p className="text-void-200">Sections</p>
          <p className="mt-0.5 font-mono-qasm text-slate-200">
            {completedCount}/{lesson.sections.length}
          </p>
        </div>
        <div>
          <p className="text-void-200">Concept checks</p>
          <p className="mt-0.5 font-mono-qasm text-slate-200">
            {score.correct}/{score.total} correct
          </p>
        </div>
        <div>
          <p className="text-void-200">Status</p>
          <p className="mt-0.5 font-mono-qasm text-slate-200">{complete ? 'Completed' : 'In progress'}</p>
        </div>
        <div>
          <p className="text-void-200">Mastery</p>
          <span
            className={`mt-0.5 inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${MASTERY_STYLE[mastery]}`}
          >
            {MASTERY_LABEL[mastery]}
          </span>
        </div>
      </div>
      <PersistenceNote className="-mt-4 text-[11px] text-void-200" />

      {prerequisiteTitles.length > 0 && (
        <div className="rounded-lg border border-void-500 bg-void-900 p-3 text-xs text-slate-400">
          <span className="font-medium text-slate-300">Builds on: </span>
          {prerequisiteTitles.join(', ')}
          <span className="text-void-200"> — recommended first, but you can start here any time.</span>
        </div>
      )}

      <div>
        <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Objectives</h3>
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

      <LessonPlayer lesson={lesson} onOpenLab={onOpenLab} onOpenNoiseLab={onOpenNoiseLab} />

      {onOpenChallenge && <LessonChallenges lessonId={lesson.id} lessonComplete={complete} onOpenChallenge={onOpenChallenge} />}
    </div>
  )
}
