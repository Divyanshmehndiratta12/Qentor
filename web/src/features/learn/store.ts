/**
 * Zustand store for the Learn screen — a separate store from `useBuildStore`
 * (same library, same one-store-per-feature pattern already used there), not
 * a second state-management system. `lessons` is always exactly what
 * `ApiClient.listLessons()` (GET /api/lessons) returned — this store never
 * fabricates or hand-writes a lesson.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError } from '@/api'
import type { Lesson } from '@/api'

interface LearnState {
  lessons: Lesson[]
  isLoading: boolean
  error: string | null
  selectedLessonId: string | null

  /**
   * Local-only, session-only "completed" marks a learner can toggle. There is
   * no persistent learner-progress backend yet (docs/PRODUCT_CONTRACT.md) —
   * this is never sent to the server, never read from it, and is lost on
   * reload. It exists purely so the Learn screen can show a "completed"
   * lesson state (and derive "locked" from it, see `./lessonState.ts`)
   * without inventing authoritative backend progress.
   */
  completedLessonIds: Set<string>

  fetchLessons: () => Promise<void>
  selectLesson: (id: string | null) => void
  toggleLessonCompleted: (id: string) => void
}

export const useLearnStore = create<LearnState>((set, get) => ({
  lessons: [],
  isLoading: false,
  error: null,
  selectedLessonId: null,
  completedLessonIds: new Set(),

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

  selectLesson: (id) => set({ selectedLessonId: id }),

  toggleLessonCompleted: (id) => {
    const next = new Set(get().completedLessonIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    set({ completedLessonIds: next })
  },
}))
