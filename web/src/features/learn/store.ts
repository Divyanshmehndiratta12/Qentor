/**
 * Zustand store for the Learn screen — a separate store from `useBuildStore`
 * (same library, same one-store-per-feature pattern already used there), not
 * a second state-management system. `lessons` is always exactly what
 * `ApiClient.listLessons()` (GET /api/lessons) returned — this store never
 * fabricates or hand-writes a lesson.
 *
 * `startedLessonIds`/`lessonProgress` are session-local learning-progression
 * state (docs/PRODUCT_CONTRACT.md: no persistent progress backend yet) —
 * never sent to or read from the server, and lost on reload. Grading a
 * concept-check answer happens entirely here, client-side, against the
 * `correctOptionId` already present in the fetched lesson data; nothing here
 * computes or invents a quantum value, and nothing here ever touches
 * `useBuildStore` (the circuit/Lab state) — see `lessonState.ts` for the
 * completion/mastery rules this progress data feeds.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError } from '@/api'
import type { Lesson } from '@/api'
import type { ConceptCheckAttempt, LessonProgress } from './lessonState'

function emptyProgress(): LessonProgress {
  return { visitedSectionIds: new Set(), conceptCheckAttempts: {} }
}

interface LearnState {
  lessons: Lesson[]
  isLoading: boolean
  error: string | null
  selectedLessonId: string | null

  startedLessonIds: Set<string>
  lessonProgress: Record<string, LessonProgress>

  fetchLessons: () => Promise<void>
  selectLesson: (id: string | null) => void
  markSectionVisited: (lessonId: string, sectionId: string) => void
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

  markSectionVisited: (lessonId, sectionId) => {
    const existing = get().lessonProgress[lessonId] ?? emptyProgress()
    if (existing.visitedSectionIds.has(sectionId)) return // no-op: avoid churning a new Set every render

    const visitedSectionIds = new Set(existing.visitedSectionIds)
    visitedSectionIds.add(sectionId)
    set({
      lessonProgress: {
        ...get().lessonProgress,
        [lessonId]: { ...existing, visitedSectionIds },
      },
    })
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
  },
}))
