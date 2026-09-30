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
 * Grading a concept-check answer happens entirely here, client-side, against
 * the `correctOptionId` already present in the fetched lesson data; nothing
 * here computes or invents a quantum value, and nothing here ever touches
 * `useBuildStore` (the circuit/Lab state) — see `lessonState.ts` for the
 * completion/mastery rules this progress data feeds.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError } from '@/api'
import type { Lesson } from '@/api'
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
  submitConceptCheckAnswer: (
    lessonId: string,
    sectionId: string,
    selectedOptionId: string,
    correctOptionId: string,
  ) => void
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

  rehydrate: () => {
    const loaded = progressStore.load()
    set({
      startedLessonIds: loaded.progress.startedLessonIds,
      lessonProgress: loaded.progress.lessonProgress,
      activityHistory: loadActivityHistory(),
      persistence: progressStore.probe() ? 'device' : 'session-only',
      progressRecovered: loaded.status === 'recovered',
    })
    reconcileWithCatalog()
  },

  fetchLessons: async () => {
    set({ isLoading: true, error: null })
    try {
      const client = getApiClient()
      const lessons = await client.listLessons()
      set({ lessons, isLoading: false })
      reconcileWithCatalog()
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
    }
  },

  submitConceptCheckAnswer: (lessonId, sectionId, selectedOptionId, correctOptionId) => {
    const existing = get().lessonProgress[lessonId] ?? emptyProgress()
    const previous = existing.conceptCheckAttempts[sectionId]
    const attempt: ConceptCheckAttempt = {
      selectedOptionId,
      isCorrect: selectedOptionId === correctOptionId,
      attemptCount: (previous?.attemptCount ?? 0) + 1,
    }
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

    // Activity rule: submitting a concept-check answer counts (right or
    // wrong, first try or retry — the same calendar day is still one day).
    recordActivityToday()
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
