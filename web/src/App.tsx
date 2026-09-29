/**
 * App shell. Two first-class destinations, switched locally (no router
 * dependency exists in this project) — `screen` lives here and is handed
 * down to `TopBar` for its nav, rather than adding a second state-management
 * system or a store field that doesn't belong to either feature's own store:
 *
 *  - Lab: circuit canvas, verified results panel, AI tutor — building,
 *    running and verifying circuits (Milestone 2's Build screen).
 *  - Learn: the lesson catalog (`GET /api/lessons`) and per-lesson detail —
 *    progression, explanation and objectives, not circuit editing.
 *
 *  - Progress: the learner dashboard — overall progress, concept-check
 *    performance, mastery, needs-attention signals, next challenge and the
 *    local activity streak. Read-only over Learn state; it never touches Lab.
 *
 * An interactive_lab section's "Open in Lab" action is the only bridge
 * between Learn and Lab: it loads that lesson's canonical circuit into
 * `useBuildStore` (via `loadCircuit`) and switches back to Lab — it never
 * computes anything itself. Progress's only bridge is `openLesson`, which
 * selects a lesson in the Learn store and switches to Learn.
 */
import { useState } from 'react'
import type { Circuit } from '@/circuit/types'
import { BuildScreen } from '@/features/build/BuildScreen'
import { ResultsPanel } from '@/features/build/ResultsPanel'
import { useBuildStore } from '@/features/build/store'
import { LearnScreen } from '@/features/learn/LearnScreen'
import { useLearnStore } from '@/features/learn/store'
import { ProgressScreen } from '@/features/progress/ProgressScreen'
import { TutorPanel } from '@/features/tutor/TutorPanel'
import { TopBar, type Screen } from '@/features/shell/TopBar'

function App() {
  const [screen, setScreen] = useState<Screen>('lab')
  const loadCircuit = useBuildStore((s) => s.loadCircuit)
  const selectLesson = useLearnStore((s) => s.selectLesson)

  function openInLab(circuit: Circuit) {
    loadCircuit(circuit)
    setScreen('lab')
  }

  function openLesson(lessonId: string) {
    selectLesson(lessonId)
    setScreen('learn')
  }

  return (
    <div className="flex h-screen flex-col bg-void-950 text-slate-200">
      <TopBar screen={screen} onNavigate={setScreen} />

      {screen === 'lab' ? (
        <>
          <div className="flex min-h-0 flex-1">
            <main className="min-w-0 flex-1 border-r border-void-500 bg-void-950">
              <BuildScreen />
            </main>

            <aside className="w-96 shrink-0 bg-void-900">
              <ResultsPanel />
            </aside>
          </div>

          <footer className="h-64 shrink-0 border-t border-void-500 bg-void-900">
            <TutorPanel />
          </footer>
        </>
      ) : screen === 'learn' ? (
        <div className="min-h-0 flex-1">
          <LearnScreen onOpenLab={openInLab} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-void-950">
          <ProgressScreen onOpenLesson={openLesson} />
        </div>
      )}
    </div>
  )
}

export default App
