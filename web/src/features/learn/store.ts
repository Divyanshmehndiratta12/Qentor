/**
 * Zustand store for the Learn screen — a separate store from `useBuildStore`
 * (same library, same one-store-per-feature pattern already used there), not
 * a second state-management system. `lessons` is always exactly what
 * `ApiClient.listLessons()` (GET /api/lessons) returned — this store never
 * fabricates or hand-writes a lesson.
 *
 * `startedLessonIds`/`lessonProgress` are the learner's progression state.
 * They are saved to THIS browser's localStorage (`progressStorage.ts`,
 * behind a small `ProgressStore` interface a backend could implement later)
 * and read back on load — never sent to or read from the server, and there
 * is no account: another browser or device starts empty. When the browser
 * will not let us save (`persistence === 'session-only'`) progress still
 * works for this page load and the UI says so. Stored data is untrusted: it
 * is shape-checked on load and reconciled against the real lesson catalog
 * once that has loaded (`reconcileProgress`), and completion, mastery and
 * misconception signals are always re-derived from it, never stored.
 * Because this is a module-level store (not React component state), it also
 * survives switching between the Lab and Learn screens and reselecting a
 * lesson within the same session: `App.tsx` unmounting/remounting
 * `LearnScreen` has no effect on this data, which is exactly what makes
 * `LessonPlayer`'s resume-in-place behavior work without any extra plumbing.
 *
 * Grading a concept-check answer happens on the SERVER: the lesson catalog this
 * store holds carries no answer key, so `submitConceptCheckAnswer` sends the
 * selection to the grading endpoint and records the verdict and explanation it
 * returns. If the server cannot be reached or refuses, nothing is recorded and
 * the failure is shown — a verdict is never guessed or substituted. After a reload,
 * `regradeSavedAnswers` sends the saved selections back to the server and replaces
 * every saved verdict with its answer, so mastery is reconstructed from the authority
 * and not from what was saved. Nothing here computes or invents a quantum value, and
 * nothing here ever touches `useBuildStore` (the circuit/Lab state) — see
 * `lessonState.ts` for the completion/mastery rules this progress data feeds.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError, GradeRejectedError } from '@/api'
import type { Lesson, SavedAnswer } from '@/api'
import { reportClassroomEvent } from '@/features/classroom/events'
import { isLessonComplete, type ConceptCheckAttempt, type LessonProgress } from './lessonState'
import { recordActivity, toLocalDateKey, type ActivityHistory } from './streak'
import { loadActivityHistory, saveActivityHistory } from './streakStorage'
import {
  localStorageProgressStore,
  reconcileProgress,
  serializeProgress,
  type LearnerProgress,
  type ProgressStore,
} from './progressStorage'

/** Where this device's progress lives. `device`: saved in this browser. `session-only`: this browser will not let us save. */
export type Persistence = 'device' | 'session-only'

let progressStore: ProgressStore = localStorageProgressStore()

/** Swap the persistence backend (a future server-backed store; or a fake in tests). Does not itself load or save anything. */
export function setProgressStore(store: ProgressStore): void {
  progressStore = store
}

function emptyProgress(): LessonProgress {
  return { activeSectionIndex: 0, completedSectionIds: new Set(), conceptCheckAttempts: {} }
}

/** Where a concept-check submission stands: `grading` while the server is being asked, `failed` (with why) when it could not
 * be graded. Absent when nothing is pending. Never persisted. */
export type GradingStatus = { state: 'grading' } | { state: 'failed'; message: string }

/**
 * Whether the saved verdicts have been re-checked with the server since the page loaded.
 * `idle`: nothing to check yet. `checking`: the request is out. `done`: every saved verdict is the server's.
 * `unverified`: the server could not be reached, so the verdicts shown are the ones last saved.
 */
export type RegradeStatus = 'idle' | 'checking' | 'done' | 'unverified'

export function gradingKey(lessonId: string, sectionId: string): string {
  return `${lessonId}/${sectionId}`
}

function gradingFailureMessage(err: unknown): string {
  if (err instanceof GradeRejectedError) return `The server would not grade this answer (${err.code}): ${err.message}`
  if (err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError) {
    return `Your answer could not be checked: ${err.message}. Nothing was recorded — try again.`
  }
  return `Your answer could not be checked: ${err instanceof Error ? err.message : String(err)}. Nothing was recorded — try again.`
}

interface LearnState {
  lessons: Lesson[]
  isLoading: boolean
  error: string | null
  selectedLessonId: string | null

  startedLessonIds: Set<string>
  lessonProgress: Record<string, LessonProgress>

  /** The days (browser-local calendar dates) on which the learner did
   * something meaningful — the only input to the streak. Unlike
   * `lessonProgress`, this is persisted to this browser's `localStorage`
   * (see `streakStorage.ts`) so it survives a page reload. Streak numbers
   * are always derived from it via `streak.ts`, never stored. */
  activityHistory: ActivityHistory

  /** Whether progress is being saved on this device or exists for this page load only. */
  persistence: Persistence
  /** True when saved progress was found but could not be read and was set aside; cleared by the next successful save. */
  progressRecovered: boolean

  /** Submissions the server is grading or could not grade, keyed `lessonId/sectionId` (see `gradingKey`). */
  gradingStatus: Record<string, GradingStatus>
  /** Whether saved verdicts have been re-checked with the server since load (see `RegradeStatus`). */
  regradeStatus: RegradeStatus

  fetchLessons: () => Promise<void>
  /** Re-read saved progress and streak from storage (what a page reload does), reconciled with the loaded catalog. */
  rehydrate: () => void
  selectLesson: (id: string | null) => void
  /** Navigation only — which step `LessonPlayer` is currently showing. Never
   * marks anything completed and never affects `isLessonComplete`. */
  setActiveSectionIndex: (lessonId: string, index: number) => void
  /** Progress — records that the learner explicitly finished this section
   * (clicked Continue/Finish on it in `LessonPlayer`). Idempotent. */
  completeSection: (lessonId: string, sectionId: string) => void
  /**
   * Ask the server to grade this selection and, if it answers, record its verdict and explanation as the latest attempt.
   * Resolves `true` when an attempt was recorded and `false` when it was not (the server could not be reached or refused,
   * or this check is already being graded) — in which case `gradingStatus` says why and progress is unchanged.
   */
  submitConceptCheckAnswer: (lessonId: string, sectionId: string, selectedOptionId: string) => Promise<boolean>
  /** Have the server grade every saved selection again and adopt its verdicts (see `RegradeStatus`). */
  regradeSavedAnswers: () => Promise<void>
}

const boot = progressStore.load()

export const useLearnStore = create<LearnState>((set, get) => ({
  lessons: [],
  isLoading: false,
  error: null,
  selectedLessonId: null,

  startedLessonIds: boot.progress.startedLessonIds,
  lessonProgress: boot.progress.lessonProgress,
  activityHistory: loadActivityHistory(),
  persistence: progressStore.probe() ? 'device' : 'session-only',
  progressRecovered: boot.status === 'recovered',
  gradingStatus: {},
  regradeStatus: 'idle',

  rehydrate: () => {
    const loaded = progressStore.load()
    set({
      startedLessonIds: loaded.progress.startedLessonIds,
      lessonProgress: loaded.progress.lessonProgress,
      activityHistory: loadActivityHistory(),
      persistence: progressStore.probe() ? 'device' : 'session-only',
      progressRecovered: loaded.status === 'recovered',
      regradeStatus: 'idle',
    })
    reconcileWithCatalog()
    void get().regradeSavedAnswers()
  },

  fetchLessons: async () => {
    set({ isLoading: true, error: null })
    try {
      const client = getApiClient()
      const lessons = await client.listLessons()
      set({ lessons, isLoading: false })
      reconcileWithCatalog()
      void get().regradeSavedAnswers()
    } catch (err) {
      const message =
        err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      set({ error: message, lessons: [], isLoading: false })
    }
  },

  selectLesson: (id) => {
    set({ selectedLessonId: id })
    if (id !== null && !get().startedLessonIds.has(id)) {
      const next = new Set(get().startedLessonIds)
      next.add(id)
      set({ startedLessonIds: next })
      persistProgress()
      reportClassroomEvent('lesson_started', id) // a no-op unless this browser is in a class
    }
  },

  setActiveSectionIndex: (lessonId, index) => {
    const existing = get().lessonProgress[lessonId] ?? emptyProgress()
    if (existing.activeSectionIndex === index) return // no-op: avoid churning a new object every render
    set({
      lessonProgress: {
        ...get().lessonProgress,
        [lessonId]: { ...existing, activeSectionIndex: index },
      },
    })
    persistProgress()
  },

  completeSection: (lessonId, sectionId) => {
    const existing = get().lessonProgress[lessonId] ?? emptyProgress()
    if (existing.completedSectionIds.has(sectionId)) return // no-op: completion is monotonic

    const completedSectionIds = new Set(existing.completedSectionIds)
    completedSectionIds.add(sectionId)
    const updated: LessonProgress = { ...existing, completedSectionIds }
    set({ lessonProgress: { ...get().lessonProgress, [lessonId]: updated } })
    persistProgress()

    // Activity rule: completing a *lesson* counts. Completing one section
    // does not — only the completion that flips the lesson to complete.
    const lesson = get().lessons.find((l) => l.id === lessonId)
    if (lesson && !isLessonComplete(lesson, existing) && isLessonComplete(lesson, updated)) {
      recordActivityToday()
      reportClassroomEvent('lesson_completed', lessonId) // the server accepts it only if its own record of graded checks agrees
    }
  },

  submitConceptCheckAnswer: async (lessonId, sectionId, selectedOptionId) => {
    const key = gradingKey(lessonId, sectionId)
    if (get().gradingStatus[key]?.state === 'grading') return false // one question to the server at a time per check
    set({ gradingStatus: { ...get().gradingStatus, [key]: { state: 'grading' } } })

    const clearStatus = (next?: GradingStatus) => {
      const rest = { ...get().gradingStatus }
      delete rest[key]
      set({ gradingStatus: next ? { ...rest, [key]: next } : rest })
    }

    let grade
    try {
      grade = await getApiClient().gradeConceptCheck(lessonId, sectionId, selectedOptionId)
    } catch (err) {
      clearStatus({ state: 'failed', message: gradingFailureMessage(err) })
      return false
    }
    // The verdict must be about exactly what was asked. One for anything else is refused, never recorded.
    if (grade.lessonId !== lessonId || grade.checkId !== sectionId || grade.selectedOptionId !== selectedOptionId) {
      clearStatus({ state: 'failed', message: 'The server answered about a different question, so the answer was not recorded — try again.' })
      return false
    }

    const existing = get().lessonProgress[lessonId] ?? emptyProgress()
    const previous = existing.conceptCheckAttempts[sectionId]
    const attempt: ConceptCheckAttempt = {
      selectedOptionId,
      isCorrect: grade.correct,
      attemptCount: (previous?.attemptCount ?? 0) + 1,
      explanation: grade.explanation,
    }
    clearStatus()
    set({
      lessonProgress: {
        ...get().lessonProgress,
        [lessonId]: {
          ...existing,
          conceptCheckAttempts: { ...existing.conceptCheckAttempts, [sectionId]: attempt },
        },
      },
    })
    persistProgress()

    // Activity rule: an answer the server graded counts (right or wrong, first try or retry — the same calendar day is
    // still one day). An answer that could not be graded was never recorded and does not count.
    recordActivityToday()
    return true
  },

  regradeSavedAnswers: async () => {
    const { lessons, lessonProgress, regradeStatus } = get()
    if (lessons.length === 0 || regradeStatus === 'checking') return // nothing to attach verdicts to yet, or already asking

    const asked: SavedAnswer[] = []
    for (const [lessonId, progress] of Object.entries(lessonProgress)) {
      for (const [checkId, attempt] of Object.entries(progress.conceptCheckAttempts)) {
        asked.push({ lessonId, checkId, selectedOptionId: attempt.selectedOptionId })
      }
    }
    if (asked.length === 0) {
      set({ regradeStatus: 'done' })
      return
    }

    set({ regradeStatus: 'checking' })
    let answers
    try {
      answers = await getApiClient().regradeConceptChecks(asked)
    } catch {
      set({ regradeStatus: 'unverified' }) // the saved verdicts stay as last saved; the UI says they were not re-checked
      return
    }

    // Apply each answer to the attempt it was about, unless the learner has answered that check again meanwhile.
    const progress: Record<string, LessonProgress> = { ...get().lessonProgress }
    for (const answer of answers) {
      const lesson = progress[answer.lessonId]
      const attempt = lesson?.conceptCheckAttempts[answer.checkId]
      if (!lesson || !attempt || attempt.selectedOptionId !== answer.selectedOptionId) continue
      const attempts = { ...lesson.conceptCheckAttempts }
      if (answer.status === 'GRADED' && answer.correct !== null) {
        attempts[answer.checkId] = {
          ...attempt,
          isCorrect: answer.correct,
          ...(answer.explanation !== null ? { explanation: answer.explanation } : {}),
        }
      } else {
        delete attempts[answer.checkId] // the server can no longer grade this selection: stale, so it is dropped
      }
      progress[answer.lessonId] = { ...lesson, conceptCheckAttempts: attempts }
    }

    // Every saved selection must have been answered for the verdicts to count as re-checked.
    const answered = new Set(answers.map((a) => gradingKey(a.lessonId, a.checkId)))
    const complete = asked.every((a) => answered.has(gradingKey(a.lessonId, a.checkId)))

    const before = serializeProgress({ startedLessonIds: get().startedLessonIds, lessonProgress: get().lessonProgress })
    set({ lessonProgress: progress, regradeStatus: complete ? 'done' : 'unverified' })
    const after = serializeProgress({ startedLessonIds: get().startedLessonIds, lessonProgress: progress })
    if (before !== after) persistProgress()
  },
}))

/** Save the current progress. A failed save flips the label to session-only; the next successful one flips it back. */
function persistProgress(): void {
  const { startedLessonIds, lessonProgress, persistence, progressRecovered } = useLearnStore.getState()
  const saved = progressStore.save({ startedLessonIds, lessonProgress })
  const next: Persistence = saved ? 'device' : 'session-only'
  if (next !== persistence || (saved && progressRecovered)) {
    useLearnStore.setState({ persistence: next, progressRecovered: saved ? false : progressRecovered })
  }
}

/**
 * Once the real catalog is here, check progress against it (see `reconcileProgress`). Writes back only when reconciliation
 * actually changed something, so simply opening Learn never rewrites storage. Does nothing before the catalog has loaded:
 * an empty catalog is "not loaded yet", not "every lesson was deleted".
 */
function reconcileWithCatalog(): void {
  const { lessons, startedLessonIds, lessonProgress } = useLearnStore.getState()
  if (lessons.length === 0) return
  const current: LearnerProgress = { startedLessonIds, lessonProgress }
  const reconciled = reconcileProgress(lessons, current)
  if (serializeProgress(reconciled) === serializeProgress(current)) return
  useLearnStore.setState({ startedLessonIds: reconciled.startedLessonIds, lessonProgress: reconciled.lessonProgress })
  persistProgress()
}

/** Counts a solved challenge as activity for today (same rule as finishing a lesson). Called only by the challenge store, only when
 * the server said an attempt passed. */
export function recordChallengeActivity(): void {
  recordActivityToday()
}

/** Records today's (browser-local) date as an activity day and persists it.
 * Deliberately module-private and only called from the two actions above —
 * rendering, selecting a lesson, Back/Continue on an incomplete lesson and
 * opening the Lab never reach it. A no-op when today is already recorded. */
function recordActivityToday(): void {
  const current = useLearnStore.getState().activityHistory
  const next = recordActivity(current, toLocalDateKey(new Date()))
  if (next === current) return
  useLearnStore.setState({ activityHistory: next })
  saveActivityHistory(next)
}
