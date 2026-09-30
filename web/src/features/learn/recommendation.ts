/**
 * The next thing to do, chosen by FIXED RULES over what this browser has saved: lesson progress, concept-check accuracy,
 * misconception signals, prerequisites and challenge outcomes. There is no model, no scoring and no personalisation beyond these
 * rules: the same saved data always gives the same recommendation, and each one carries the evidence it was based on, so the
 * learner can see exactly why.
 *
 * Priority (first rule that applies wins):
 *  1. `address_misconception` - the highest-severity unresolved misconception in a started lesson (`getNextChallenge`).
 *  2. `revisit_lesson` - a challenge with several failed attempts and every hint already shown: go back to its lesson first.
 *  3. `continue_challenge` - a challenge already attempted but not solved, whose lesson is completed.
 *  4. `try_challenge` - the first (catalog order) unsolved challenge whose lesson is completed.
 *  5. `next_lesson` - the first available (unlocked, not completed) lesson (`getNextChallenge`).
 *  6. `all_done` - every lesson is complete and every challenge solved (or there is nothing to recommend).
 */
import type { Challenge, Lesson } from '@/api'
import type { ChallengeRecord } from '@/features/challenges/challengeStorage'
import { getNextChallenge } from './learnerInsights'
import { getConceptCheckScore, isLessonComplete, type LessonProgress } from './lessonState'

export type RecommendationKind =
  | 'address_misconception'
  | 'revisit_lesson'
  | 'continue_challenge'
  | 'try_challenge'
  | 'next_lesson'
  | 'all_done'

export interface Recommendation {
  kind: RecommendationKind
  lessonId: string | null
  challengeId: string | null
  /** One plain sentence: what to do and why. */
  reason: string
  /** The saved facts the rule looked at, in plain words. */
  evidence: string[]
}

/** Failed attempts (with every hint shown) after which the recommendation is to revisit the lesson instead of trying again. */
export const STRUGGLE_ATTEMPTS = 3

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function getRecommendation(
  lessons: readonly Lesson[],
  challenges: readonly Challenge[],
  lessonProgress: Record<string, LessonProgress>,
  startedLessonIds: ReadonlySet<string>,
  records: Readonly<Record<string, ChallengeRecord>>,
): Recommendation {
  const lessonList = [...lessons]
  const lessonById = new Map(lessonList.map((l) => [l.id, l]))
  const title = (lessonId: string) => lessonById.get(lessonId)?.title ?? lessonId
  const completed = (lessonId: string) => {
    const lesson = lessonById.get(lessonId)
    return !!lesson && isLessonComplete(lesson, lessonProgress[lessonId])
  }

  const lessonRule = getNextChallenge(lessonList, lessonProgress, startedLessonIds)

  // 1. An unresolved misconception comes first: it is the strongest evidence of what to work on.
  if (lessonRule.challengeType === 'address_misconception' && lessonRule.lessonId) {
    return {
      kind: 'address_misconception',
      lessonId: lessonRule.lessonId,
      challengeId: null,
      reason: lessonRule.reason,
      evidence: [`Concept checks in "${title(lessonRule.lessonId)}" show an unresolved signal.`],
    }
  }

  const known = challenges.filter((c) => lessonById.has(c.lessonId))

  // 2. Struggling: several failed attempts and every hint already shown.
  for (const c of known) {
    const r = records[c.id]
    if (r && !r.solved && r.attempts >= STRUGGLE_ATTEMPTS && r.hintsRevealed >= c.hints.length) {
      return {
        kind: 'revisit_lesson',
        lessonId: c.lessonId,
        challengeId: c.id,
        reason: `You have tried "${c.title}" ${plural(r.attempts, 'time')} and seen every hint. Revisit "${title(c.lessonId)}" first, then come back to it.`,
        evidence: [`Challenge "${c.title}": ${plural(r.attempts, 'attempt')}, not solved, all ${c.hints.length} hints shown.`],
      }
    }
  }

  // 3./4. A challenge for a lesson the learner has completed.
  const open = known.filter((c) => completed(c.lessonId) && !records[c.id]?.solved)
  const attempted = open.find((c) => (records[c.id]?.attempts ?? 0) > 0)
  const chosen = attempted ?? open[0]
  if (chosen) {
    const r = records[chosen.id]
    const lesson = lessonById.get(chosen.lessonId)!
    const score = getConceptCheckScore(lesson, lessonProgress[lesson.id])
    const evidence = [`"${lesson.title}" is completed.`]
    if (score.total > 0) evidence.push(`Concept checks in "${lesson.title}": ${score.correct} of ${score.total} correct.`)
    if (attempted && r) {
      evidence.push(`Challenge "${chosen.title}": ${plural(r.attempts, 'attempt')} so far, not solved yet.`)
      return {
        kind: 'continue_challenge',
        lessonId: chosen.lessonId,
        challengeId: chosen.id,
        reason: `Keep going with "${chosen.title}": you have already tried it ${plural(r.attempts, 'time')}.`,
        evidence,
      }
    }
    return {
      kind: 'try_challenge',
      lessonId: chosen.lessonId,
      challengeId: chosen.id,
      reason: `You finished "${lesson.title}". Apply it with the challenge "${chosen.title}".`,
      evidence,
    }
  }

  // 5./6. Otherwise the lesson path.
  if (lessonRule.challengeType === 'next_lesson' && lessonRule.lessonId) {
    const lesson = lessonById.get(lessonRule.lessonId)
    const evidence: string[] = []
    const done = lessonList.filter((l) => completed(l.id)).length
    evidence.push(`${done} of ${lessonList.length} lessons completed.`)
    if (lesson && lesson.prerequisiteLessonIds.length > 0) {
      evidence.push(`Prerequisites for "${lesson.title}" are complete: ${lesson.prerequisiteLessonIds.map(title).join(', ')}.`)
    }
    return { kind: 'next_lesson', lessonId: lessonRule.lessonId, challengeId: null, reason: lessonRule.reason, evidence }
  }

  const unsolved = known.filter((c) => !records[c.id]?.solved)
  if (unsolved.length > 0) {
    // Every lesson is complete, so this only happens for a challenge whose lesson is not in the catalog's completed set; keep honest.
    return {
      kind: 'all_done',
      lessonId: null,
      challengeId: null,
      reason: 'Every lesson is complete.',
      evidence: [`${plural(unsolved.length, 'challenge')} still unsolved.`],
    }
  }
  return { kind: 'all_done', lessonId: null, challengeId: null, reason: lessonRule.reason, evidence: [] }
}
