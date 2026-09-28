/**
 * Pure lesson-state derivation — kept separate from any component so it's
 * trivially unit-testable and so no component has to re-derive this logic.
 *
 * There is no persistent learner-progress backend yet (docs/PRODUCT_CONTRACT.md),
 * so "locked"/"completed" are never read from the server: "completed" comes
 * only from local, session-only UI state (`useLearnStore`'s `completedLessonIds`
 * — never sent to or read from the backend), and "locked" is derived purely
 * from a lesson's own `prerequisiteLessonIds` (real registry structure from
 * GET /api/lessons) checked against that same local completion set.
 */
import type { Lesson } from '@/api'

export type LessonState = 'available' | 'locked' | 'completed'

export function getLessonState(lesson: Lesson, completedLessonIds: ReadonlySet<string>): LessonState {
  if (completedLessonIds.has(lesson.id)) return 'completed'

  const hasUnmetPrerequisite = lesson.prerequisiteLessonIds.some((id) => !completedLessonIds.has(id))
  return hasUnmetPrerequisite ? 'locked' : 'available'
}
