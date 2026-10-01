/**
 * Count what this browser already did when it joins a class. Identifiers only: which concept-check option was picked for which check
 * (the server grades each one itself), which lessons were started, which were finished (the server accepts a finish only when its own
 * record of the learner's graded checks agrees). Challenges solved earlier are not claimed: only the server's verdict counts, so they
 * count when submitted again.
 *
 * Nothing is deleted or changed locally, and the learner chooses whether to do this when joining.
 */
import { getApiClient, type ClassSyncResult, type SavedAnswer } from '@/api'
import { useLearnStore } from '@/features/learn/store'
import { isLessonComplete } from '@/features/learn/lessonState'
import { reportClassroomEvent } from './events'
import { useClassroomStore } from './store'

export interface SyncSummary {
  answers: ClassSyncResult | null
  lessonsStarted: number
  lessonsFinished: number
}

export async function syncLocalProgress(): Promise<SyncSummary> {
  const { learnerToken, membership } = useClassroomStore.getState()
  if (!learnerToken || !membership) return { answers: null, lessonsStarted: 0, lessonsFinished: 0 }
  const { lessons, lessonProgress, startedLessonIds } = useLearnStore.getState()

  const saved: SavedAnswer[] = []
  for (const [lessonId, progress] of Object.entries(lessonProgress)) {
    for (const [checkId, attempt] of Object.entries(progress.conceptCheckAttempts)) {
      saved.push({ lessonId, checkId, selectedOptionId: attempt.selectedOptionId })
    }
  }

  let answers: ClassSyncResult | null = null
  if (saved.length > 0) {
    try {
      answers = await getApiClient().syncClassProgress(learnerToken, saved.slice(0, 200))
    } catch {
      answers = null // not delivered; the learner is told below that it was not counted
    }
  }

  let started = 0
  let finished = 0
  for (const lessonId of startedLessonIds) {
    reportClassroomEvent('lesson_started', lessonId)
    started += 1
  }
  for (const lesson of lessons) {
    const progress = lessonProgress[lesson.id]
    if (progress && isLessonComplete(lesson, progress)) {
      reportClassroomEvent('lesson_completed', lesson.id)
      finished += 1
    }
  }
  return { answers, lessonsStarted: started, lessonsFinished: finished }
}
