/**
 * Pure learner-insight derivation: overall progress, mastery, misconceptions,
 * and a next-challenge recommendation. Every function here takes only the
 * real lesson catalog (`Lesson[]`, from GET /api/lessons — never a second,
 * hardcoded copy) and session-local Learn progress (`lessonProgress`,
 * `startedLessonIds`, both from `useLearnStore`) and returns a plain value.
 * None of these read or write any store, and none of them invent a learner
 * fact that isn't already recorded in that progress data.
 *
 * "Mastery" reuses `lessonState.ts`'s `getLessonMastery` exactly — this
 * module does not define a second, competing mastery rule; it only
 * aggregates the same per-lesson result across the whole catalog.
 *
 * Misconception signals describe an observed *learning signal* only — a
 * concept and a plain count/observation (e.g. "Phase: 2 incorrect
 * attempts") — never a psychological or cognitive diagnosis of the learner.
 *
 * Nothing here is persisted, sent to a server, or shared across sessions;
 * see `useLearnStore`'s own docstring for where the underlying progress data
 * actually lives (session memory only).
 */
import type { Lesson } from '@/api'
import {
  getConceptCheckScore,
  getLessonMastery,
  getLessonReadiness,
  isFullConceptCheck,
  isLessonComplete,
  MASTERY_ACCURACY_THRESHOLD,
  type LessonProgress,
  type Mastery,
} from './lessonState'

export { getLessonMastery, MASTERY_ACCURACY_THRESHOLD }
export type { Mastery }

export interface OverallLearningProgress {
  totalLessons: number
  lessonsStarted: number
  lessonsCompleted: number
  conceptChecksAttempted: number
  conceptChecksCorrect: number
  conceptChecksTotal: number
  /** `null` when nothing has been attempted yet — never a misleading 0%. */
  overallAccuracy: number | null
}

/** Requirement 7's whole-catalog tally: lessons completed/started, concept
 * checks attempted/correct, and accuracy where meaningful. This is a session
 * snapshot, not a persistent or shared record. */
export function getOverallLearningProgress(
  lessons: Lesson[],
  lessonProgress: Record<string, LessonProgress>,
  startedLessonIds: ReadonlySet<string>,
): OverallLearningProgress {
  let lessonsCompleted = 0
  let conceptChecksAttempted = 0
  let conceptChecksCorrect = 0
  let conceptChecksTotal = 0

  for (const lesson of lessons) {
    const progress = lessonProgress[lesson.id]
    if (isLessonComplete(lesson, progress)) lessonsCompleted += 1

    const score = getConceptCheckScore(lesson, progress)
    conceptChecksAttempted += score.attempted
    conceptChecksCorrect += score.correct
    conceptChecksTotal += score.total
  }

  return {
    totalLessons: lessons.length,
    lessonsStarted: lessons.filter((lesson) => startedLessonIds.has(lesson.id)).length,
    lessonsCompleted,
    conceptChecksAttempted,
    conceptChecksCorrect,
    conceptChecksTotal,
    overallAccuracy: conceptChecksAttempted === 0 ? null : conceptChecksCorrect / conceptChecksAttempted,
  }
}

/** How many lessons currently fall into each mastery bucket — a thin
 * aggregation over `getLessonMastery`, not a second mastery algorithm. */
export function getMasteryBreakdown(
  lessons: Lesson[],
  lessonProgress: Record<string, LessonProgress>,
  startedLessonIds: ReadonlySet<string>,
): Record<Mastery, number> {
  const breakdown: Record<Mastery, number> = { not_started: 0, developing: 0, mastered: 0 }
  for (const lesson of lessons) {
    const mastery = getLessonMastery(lesson, lessonProgress[lesson.id], startedLessonIds.has(lesson.id))
    breakdown[mastery] += 1
  }
  return breakdown
}

export type LessonStatus = 'completed' | 'developing' | 'not_started'

/** One lesson's headline status for lists: `completed` when
 * `isLessonComplete`; otherwise `developing` if `getLessonMastery` says the
 * lesson has been started; otherwise `not_started`. A *completed* lesson can
 * still have `developing` mastery (low concept-check accuracy) — that is a
 * separate signal the caller shows alongside, from `getLessonMastery`. */
export function getLessonStatus(
  lesson: Lesson,
  progress: LessonProgress | undefined,
  started: boolean,
): LessonStatus {
  if (isLessonComplete(lesson, progress)) return 'completed'
  return getLessonMastery(lesson, progress, started) === 'not_started' ? 'not_started' : 'developing'
}

/** How many of this lesson's own sections the learner has explicitly
 * completed. Counts only ids that are real sections of `lesson`. */
export function getSectionProgress(
  lesson: Lesson,
  progress: LessonProgress | undefined,
): { completed: number; total: number } {
  const completed = lesson.sections.filter((section) => progress?.completedSectionIds.has(section.id)).length
  return { completed, total: lesson.sections.length }
}

export type MisconceptionSeverity = 'low' | 'medium' | 'high'

export interface MisconceptionSignal {
  conceptId: string
  lessonId: string
  /** The specific concept-check section this evidence came from, or `null`
   * for a lesson-wide signal (the low-accuracy-across-checks rule). */
  sectionId: string | null
  /** A plain description of the observed evidence — never a diagnosis. */
  reason: string
  severity: MisconceptionSeverity
}

/**
 * Explicit, evidence-backed rules over concept-check attempts — only for
 * lessons the learner has actually started (never for untouched lessons):
 *
 * 1. Repeated incorrect attempts: the latest attempt on a concept check is
 *    still wrong after 2+ submissions. Severity "high". Because the retry
 *    UI (`ConceptCheckQuiz`) only offers "Try again" after a wrong answer and
 *    removes it once correct, `attemptCount` when `isCorrect` is false is
 *    exactly the count of incorrect attempts so far.
 * 2. Latest answer incorrect on an otherwise-completed lesson: completion
 *    only requires an attempt, not a correct one, so this flags a lesson
 *    that's "done" but still has an unresolved wrong answer. Severity
 *    "medium".
 * 3. Low accuracy across a lesson's concept checks: once every check in a
 *    lesson with 2+ question-bearing checks has been attempted, if overall
 *    accuracy is below `MASTERY_ACCURACY_THRESHOLD`, that's flagged at the
 *    lesson level. Severity "low". (Gated to 2+ checks so it doesn't just
 *    duplicate rule 2 for a single-check lesson.)
 */
export function getMisconceptions(
  lessons: Lesson[],
  lessonProgress: Record<string, LessonProgress>,
  startedLessonIds: ReadonlySet<string>,
): MisconceptionSignal[] {
  const signals: MisconceptionSignal[] = []

  for (const lesson of lessons) {
    if (!startedLessonIds.has(lesson.id)) continue
    const progress = lessonProgress[lesson.id]
    const checks = lesson.sections.filter(isFullConceptCheck)

    for (const section of checks) {
      const attempt = progress?.conceptCheckAttempts[section.id]
      if (!attempt || attempt.isCorrect) continue
      const conceptId = section.concept ?? lesson.concept

      if (attempt.attemptCount >= 2) {
        signals.push({
          conceptId,
          lessonId: lesson.id,
          sectionId: section.id,
          reason: `${conceptId}: ${attempt.attemptCount} incorrect attempts`,
          severity: 'high',
        })
      }

      if (isLessonComplete(lesson, progress)) {
        signals.push({
          conceptId,
          lessonId: lesson.id,
          sectionId: section.id,
          reason: `${conceptId} concept check: latest answer incorrect`,
          severity: 'medium',
        })
      }
    }

    if (checks.length >= 2) {
      const score = getConceptCheckScore(lesson, progress)
      if (score.attempted === score.total) {
        const accuracy = score.correct / score.total
        if (accuracy < MASTERY_ACCURACY_THRESHOLD) {
          signals.push({
            conceptId: lesson.concept,
            lessonId: lesson.id,
            sectionId: null,
            reason: `${lesson.concept}: accuracy below mastery threshold (${score.correct}/${score.total})`,
            severity: 'low',
          })
        }
      }
    }
  }

  return signals
}

export type ChallengeType = 'address_misconception' | 'next_lesson' | 'catalog_complete'

export interface NextChallenge {
  /** `null` only for `challengeType: 'catalog_complete'` — there is nothing
   * to navigate to. */
  lessonId: string | null
  reason: string
  challengeType: ChallengeType
}

const SEVERITY_RANK: Record<MisconceptionSeverity, number> = { high: 0, medium: 1, low: 2 }

/**
 * Deterministic priority, no AI model involved:
 *
 * A. The highest-severity unresolved misconception in an already-started
 *    lesson (ties broken by catalog order, since `getMisconceptions` already
 *    walks lessons in that order and array sort is stable).
 * B. Otherwise, the first lesson (catalog order) that is ready (everything it
 *    builds on is completed) and not yet completed (`getLessonReadiness(...) === 'ready'`).
 *    Prerequisites steer this recommendation; they never stop a lesson opening.
 * C. Otherwise, every lesson in the catalog is complete (or the catalog is
 *    empty) — there is no further challenge to recommend.
 */
export function getNextChallenge(
  lessons: Lesson[],
  lessonProgress: Record<string, LessonProgress>,
  startedLessonIds: ReadonlySet<string>,
): NextChallenge {
  const misconceptions = getMisconceptions(lessons, lessonProgress, startedLessonIds)
  if (misconceptions.length > 0) {
    const top = [...misconceptions].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0]!
    return { lessonId: top.lessonId, reason: top.reason, challengeType: 'address_misconception' }
  }

  const completedLessonIds = new Set(
    lessons.filter((lesson) => isLessonComplete(lesson, lessonProgress[lesson.id])).map((lesson) => lesson.id),
  )
  for (const lesson of lessons) {
    if (getLessonReadiness(lesson, completedLessonIds) === 'ready') {
      const reason = startedLessonIds.has(lesson.id)
        ? `Pick up where you left off in "${lesson.title}".`
        : `"${lesson.title}" is next in your learning path.`
      return { lessonId: lesson.id, reason, challengeType: 'next_lesson' }
    }
  }

  if (lessons.length === 0) {
    return { lessonId: null, reason: 'No lessons are available yet.', challengeType: 'catalog_complete' }
  }
  return { lessonId: null, reason: 'Every lesson in the current catalog is complete.', challengeType: 'catalog_complete' }
}
