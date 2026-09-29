/**
 * Top-level Learn destination. Fetches the real lesson catalog from
 * GET /api/lessons (via `useLearnStore` -> `ApiClient.listLessons()` — never
 * a second, hardcoded copy of lesson content) and lets a learner browse
 * lesson metadata and open a lesson's detail view.
 *
 * There is no persistent learner-progress backend yet: completion is derived
 * here, each render, from session-local `lessonProgress` via
 * `isLessonComplete` (`./lessonState.ts`) — never invented server data, and
 * never stored as its own boolean (so it can't drift from the progress it's
 * computed from). "Locked" then follows from that plus each lesson's own
 * `prerequisiteLessonIds`. Selecting a lesson, completing a section or
 * submitting a concept check never touches `useBuildStore` (the circuit/Lab
 * state); the only bridge to Lab is `onOpenLab`, called explicitly from an
 * interactive_lab section.
 */
import { useEffect } from 'react'
import type { Circuit } from '@/circuit/types'
import { useLearnStore } from './store'
import { isLessonComplete } from './lessonState'
import { LessonCard } from './LessonCard'
import { LessonDetailPanel } from './LessonDetailPanel'
import { LearnerSummaryPanel } from './LearnerSummaryPanel'

export function LearnScreen({ onOpenLab }: { onOpenLab: (circuit: Circuit) => void }) {
  const lessons = useLearnStore((s) => s.lessons)
  const isLoading = useLearnStore((s) => s.isLoading)
  const error = useLearnStore((s) => s.error)
  const selectedLessonId = useLearnStore((s) => s.selectedLessonId)
  const lessonProgress = useLearnStore((s) => s.lessonProgress)
  const startedLessonIds = useLearnStore((s) => s.startedLessonIds)
  const fetchLessons = useLearnStore((s) => s.fetchLessons)
  const selectLesson = useLearnStore((s) => s.selectLesson)

  useEffect(() => {
    void fetchLessons()
  }, [fetchLessons])

  const selectedLesson = lessons.find((lesson) => lesson.id === selectedLessonId) ?? null

  const completedLessonIds = new Set(
    lessons.filter((lesson) => isLessonComplete(lesson, lessonProgress[lesson.id])).map((lesson) => lesson.id),
  )

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex w-[380px] shrink-0 flex-col border-r border-void-500 bg-void-900">
        <div className="border-b border-void-500 px-5 py-4">
          <h1 className="font-sans-ui text-lg font-semibold text-slate-100">Learn</h1>
          <p className="mt-1 text-[13px] leading-snug text-slate-400">
            Work through verified quantum circuits, one concept at a time — every number you see
            here comes from a real backend execution, never a guess.
          </p>
        </div>

        {!isLoading && !error && lessons.length > 0 && (
          <LearnerSummaryPanel
            lessons={lessons}
            lessonProgress={lessonProgress}
            startedLessonIds={startedLessonIds}
            onSelectLesson={selectLesson}
          />
        )}

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {isLoading && <p className="p-2 text-xs text-slate-500">Loading lessons…</p>}

          {!isLoading && error && (
            <div
              role="alert"
              className="m-1 rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3 text-xs text-danger-glow"
            >
              <p className="font-medium">Couldn't load lessons.</p>
              <p className="mt-1 text-danger-glow/80">{error}</p>
            </div>
          )}

          {!isLoading && !error && lessons.length === 0 && (
            <p className="m-1 rounded-lg border border-void-400 bg-void-800 p-3 text-xs text-slate-500">
              No lessons are available yet.
            </p>
          )}

          {!isLoading && !error && lessons.length > 0 && (
            <ul className="flex flex-col gap-2">
              {lessons.map((lesson) => (
                <li key={lesson.id}>
                  <LessonCard
                    lesson={lesson}
                    lessons={lessons}
                    completedLessonIds={completedLessonIds}
                    selected={lesson.id === selectedLessonId}
                    onSelect={() => selectLesson(lesson.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-auto bg-void-950">
        {selectedLesson ? (
          <LessonDetailPanel
            lesson={selectedLesson}
            lessons={lessons}
            progress={lessonProgress[selectedLesson.id]}
            started={startedLessonIds.has(selectedLesson.id)}
            onOpenLab={onOpenLab}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <p className="max-w-sm font-serif-prose text-[15px] text-slate-500">
              Select a lesson to see its objectives and walk through its sections.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
