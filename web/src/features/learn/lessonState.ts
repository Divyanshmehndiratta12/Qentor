/**
 * Pure lesson-progress/state derivation — kept separate from any component
 * so it's trivially unit-testable and so no component has to re-derive this
 * logic. Every function here takes plain data (a `Lesson` and/or a session's
 * `LessonProgress`) and returns a plain value; none of them read or write
 * any store.
 *
 * There is no persistent learner-progress backend yet (docs/PRODUCT_CONTRACT.md):
 * `LessonProgress` lives only in `useLearnStore`'s session memory, is never
 * sent to or read from the server, and is lost on reload. "Locked" is
 * derived purely from a lesson's own `prerequisiteLessonIds` (real registry
 * structure from GET /api/lessons) checked against completion computed from
 * that same local progress.
 */
import type { ConceptCheckOption, Lesson, LessonConceptCheckSection, LessonSection } from '@/api'

export type LessonState = 'available' | 'locked' | 'completed'

export interface ConceptCheckAttempt {
  selectedOptionId: string
  isCorrect: boolean
  attemptCount: number
}

/**
 * One lesson's session-local progress, split into two clearly distinct
 * kinds of state (never conflated, never redundant with each other):
 *
 * - Navigation state — `activeSectionIndex`: which step the player is
 *   currently showing. Changes on every Back/Continue click; carries no
 *   information about what's actually been learned.
 * - Progress state — `completedSectionIds`/`conceptCheckAttempts`: what the
 *   learner has actually, explicitly done. Both are additive/monotonic — a
 *   section, once completed, and a concept check, once attempted, stay that
 *   way for the rest of the session (a retry updates `conceptCheckAttempts`'
 *   latest answer, it never "un-attempts" it, and revisiting a completed
 *   section via Back never un-completes it).
 *
 * A section lands in `completedSectionIds` only when the learner explicitly
 * clicks Continue/Finish on it in `LessonPlayer` — never merely from being
 * rendered.
 */
export interface LessonProgress {
  activeSectionIndex: number
  completedSectionIds: Set<string>
  conceptCheckAttempts: Record<string, ConceptCheckAttempt>
}

/** A concept_check section with every question field present — the shape
 * `ConceptCheckQuiz` actually renders. The backend guarantees these four
 * fields are present together or all null (`ConceptCheckSection`'s own
 * validator), so a plain `question !== null` check is enough to narrow. */
export interface FullConceptCheckSection extends LessonConceptCheckSection {
  question: string
  options: ConceptCheckOption[]
  correctOptionId: string
  explanation: string
}

export function isFullConceptCheck(section: LessonSection): section is FullConceptCheckSection {
  return section.type === 'concept_check' && section.question !== null
}

function attemptableSections(lesson: Lesson): FullConceptCheckSection[] {
  return lesson.sections.filter(isFullConceptCheck)
}

/**
 * Completion rule (unchanged since the previous milestone — only *how*
 * `completedSectionIds` gets populated changed, from "section rendered" to
 * "learner explicitly completed it" via `LessonPlayer`): a lesson is
 * complete once every one of its sections has been explicitly completed AND
 * every concept_check section that carries a real question has been
 * attempted at least once (correctness is not required — see
 * `getLessonMastery` for the signal that does care about correctness).
 * Deterministic, timer-free: it depends only on what the learner has
 * actually completed/attempted this session.
 */
export function isLessonComplete(lesson: Lesson, progress: LessonProgress | undefined): boolean {
  if (!progress) return false

  const allSectionsCompleted = lesson.sections.every((section) => progress.completedSectionIds.has(section.id))
  const allChecksAttempted = attemptableSections(lesson).every(
    (section) => section.id in progress.conceptCheckAttempts,
  )
  return allSectionsCompleted && allChecksAttempted
}

/**
 * Whether `LessonPlayer`'s Continue/Finish button should be enabled for this
 * section right now — pure navigation-gating logic, not itself a completion
 * record. A fully-specified concept check requires at least one submitted
 * attempt (selecting an option alone is not enough); every other section
 * type (explanation, reflection, interactive_lab, and a prompt-only concept
 * check) can be continued immediately.
 */
export function canContinueFromSection(section: LessonSection, progress: LessonProgress | undefined): boolean {
  if (isFullConceptCheck(section)) {
    return Boolean(progress?.conceptCheckAttempts[section.id])
  }
  return true
}

export interface ConceptCheckScore {
  attempted: number
  correct: number
  total: number
}

/** The learner's current concept-check score for a lesson, from their latest
 * attempt on each question-bearing section — meaningful before completion
 * too (e.g. "1/2 correct so far"), not just as a final tally. */
export function getConceptCheckScore(lesson: Lesson, progress: LessonProgress | undefined): ConceptCheckScore {
  const sections = attemptableSections(lesson)
  if (!progress) return { attempted: 0, correct: 0, total: sections.length }

  let attempted = 0
  let correct = 0
  for (const section of sections) {
    const attempt = progress.conceptCheckAttempts[section.id]
    if (attempt) {
      attempted += 1
      if (attempt.isCorrect) correct += 1
    }
  }
  return { attempted, correct, total: sections.length }
}

export type Mastery = 'not_started' | 'developing' | 'mastered'

/** A lesson is "mastered" once complete with at least 80% of its concept
 * checks answered correctly (a lesson with no question-bearing checks is
 * vacuously full marks — there is nothing to test, so completion alone is
 * the full signal). Below that, or before completion, it's "developing"; a
 * lesson with no recorded progress at all is "not_started". This is a
 * learning signal derived only from session data, not an AI judgment. */
export const MASTERY_ACCURACY_THRESHOLD = 0.8

export function getLessonMastery(
  lesson: Lesson,
  progress: LessonProgress | undefined,
  started: boolean,
): Mastery {
  if (!started) return 'not_started'
  if (!isLessonComplete(lesson, progress)) return 'developing'

  const { correct, total } = getConceptCheckScore(lesson, progress)
  const accuracy = total === 0 ? 1 : correct / total
  return accuracy >= MASTERY_ACCURACY_THRESHOLD ? 'mastered' : 'developing'
}

/**
 * The list/card state. Takes a plain `completedLessonIds` set (derived by
 * the caller from `isLessonComplete` over every lesson's own progress, see
 * `LearnScreen.tsx`) rather than progress data directly, so this function —
 * and `LessonCard`, which calls it — doesn't need to know how completion
 * itself is computed, only the lock/unlock graph over it.
 */
export function getLessonState(lesson: Lesson, completedLessonIds: ReadonlySet<string>): LessonState {
  if (completedLessonIds.has(lesson.id)) return 'completed'

  const hasUnmetPrerequisite = lesson.prerequisiteLessonIds.some((id) => !completedLessonIds.has(id))
  return hasUnmetPrerequisite ? 'locked' : 'available'
}
