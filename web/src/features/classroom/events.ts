/**
 * The few learning events a browser may report to its class: started a lesson, finished a lesson, started a challenge. Everything else
 * the server derives itself (a graded answer, a challenge verdict, a share), so this module has no way to send a score, an outcome or
 * another learner's id.
 *
 * Reporting is best effort and silent: only a learner who is in a class reports at all; each (kind, subject) is sent once per page
 * load (the server also ignores repeats); and a failure never reaches the learner, because classroom reporting must not get in the way
 * of learning. The server alone decides whether an event is recorded (a lesson counts as finished only if its own record agrees).
 */
import { getApiClient, type LearnerEventKind } from '@/api'
import { useClassroomStore } from './store'

const sent = new Set<string>()

export function reportClassroomEvent(kind: LearnerEventKind, subjectId: string): void {
  const { learnerToken, membership } = useClassroomStore.getState()
  if (!learnerToken || !membership) return
  const key = `${membership.classCode}|${kind}|${subjectId}`
  if (sent.has(key)) return
  sent.add(key)
  getApiClient()
    .reportLearnerEvent(learnerToken, kind, subjectId)
    .catch(() => {
      sent.delete(key) // not delivered: allow a later attempt
    })
}

/** Test helper. */
export function resetClassroomEventsForTests(): void {
  sent.clear()
}
