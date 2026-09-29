/**
 * Zustand store for the Learn screen — a separate store from `useBuildStore`
 * (same library, same one-store-per-feature pattern already used there), not
 * a second state-management system. `lessons` is always exactly what
 * `ApiClient.listLessons()` (GET /api/lessons) returned — this store never
 * fabricates or hand-writes a lesson.
 *
 * `startedLessonIds`/`lessonProgress` are session-local learning-progression
 * state (docs/PRODUCT_CONTRACT.md: no persistent progress backend yet) —
 * never sent to or read from the server, and lost on reload. Because this is
 * a module-level store (not React component state), it survives switching
 * between the Lab and Learn screens and reselecting a lesson within the same
 * session: `App.tsx` unmounting/remounting `LearnScreen` has no effect on
 * this data, which is exactly what makes `LessonPlayer`'s resume-in-place
 * behavior work without any extra plumbing.
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

  fetchLessons: () => Promise<void>
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

export const useLearnStore = create<LearnState>((set, get) => ({
  lessons: [],
  isLoading: false,
  error: null,
  selectedLessonId: null,

  startedLessonIds: new Set(),
  lessonProgress: {},
  activityHistory: loadActivityHistory(),

  fetchLessons: async () => {
    set({ isLoading: true, error: null })
    try {
      const client = getApiClient()
      const lessons = await client.listLessons()
      set({ lessons, isLoading: false })
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
  },

  completeSection: (lessonId, sectionId) => {
    const existing = get().lessonProgress[lessonId] ?? emptyProgress()
    if (existing.completedSectionIds.has(sectionId)) return // no-op: completion is monotonic

    const completedSectionIds = new Set(existing.completedSectionIds)
    completedSectionIds.add(sectionId)
    const updated: LessonProgress = { ...existing, completedSectionIds }
    set({ lessonProgress: { ...get().lessonProgress, [lessonId]: updated } })

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

    // Activity rule: submitting a concept-check answer counts (right or
    // wrong, first try or retry — the same calendar day is still one day).
    recordActivityToday()
  },
}))

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
