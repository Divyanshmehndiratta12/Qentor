/**
 * Left lesson sidebar. `backend/qentor/verification/` and the `learning`
 * module from docs/ARCHITECTURE.md §1 don't exist yet — there is no
 * `/api/lessons` route. This component calls `ApiClient.listLessons()`
 * exactly like every other screen; against the real backend that throws
 * `EndpointNotImplementedError`, which is shown honestly rather than papered
 * over with an invented lesson list. Set `VITE_USE_MOCK_API=true` to see the
 * shell filled with FIXTURE-labelled lessons during UI development.
 */
import { useEffect, useState } from 'react'
import { getApiClient, EndpointNotImplementedError } from '@/api'
import type { LessonSummary } from '@/api'

type LoadState =
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; lessons: LessonSummary[] }

export function LessonSidebar() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getApiClient()
      .listLessons()
      .then((lessons) => {
        if (!cancelled) setState({ status: 'ready', lessons })
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof EndpointNotImplementedError) {
          setState({ status: 'unavailable', message: err.message })
        } else {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-void-500 px-4 py-3">
        <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Lessons</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {state.status === 'loading' && <p className="p-2 text-xs text-slate-500">Loading…</p>}

        {state.status === 'unavailable' && (
          <div className="m-2 rounded border border-void-400 bg-void-800 p-3 text-xs text-slate-500">
            <p className="font-medium text-slate-400">Lessons aren't connected yet.</p>
            <p className="mt-1 text-slate-500">
              No lesson content endpoint exists on the backend yet (
              <code className="font-mono-qasm">GET /api/lessons</code>). Nothing is faked here — this
              panel stays empty until that lands.
            </p>
          </div>
        )}

        {state.status === 'error' && (
          <p className="m-2 rounded border border-danger-glow/40 bg-danger-dim/30 p-3 text-xs text-danger-glow">
            {state.message}
          </p>
        )}

        {state.status === 'ready' &&
          state.lessons.map((lesson) => (
            <button
              key={lesson.id}
              type="button"
              onClick={() => setSelected(lesson.id)}
              className={`mb-1 flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors ${
                selected === lesson.id
                  ? 'bg-cyan-dim/40 text-cyan-glow'
                  : 'text-slate-300 hover:bg-void-600'
              }`}
            >
              <span className="text-sm font-medium">{lesson.title}</span>
              <span className="text-[11px] text-slate-500">{lesson.concept}</span>
              {lesson.masteryFraction !== null && (
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-void-600">
                  <div
                    className="h-full rounded-full bg-cyan-glow/70"
                    style={{ width: `${Math.round(lesson.masteryFraction * 100)}%` }}
                  />
                </div>
              )}
            </button>
          ))}
      </div>
    </div>
  )
}
