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
 * An interactive_lab section's "Open in Lab" action is the only bridge
 * between them: it loads that lesson's canonical circuit into
 * `useBuildStore` (via `loadCircuit`) and switches back to Lab — it never
 * computes anything itself.
 */
import { useState } from 'react'
import type { Circuit } from '@/circuit/types'
import { BuildScreen } from '@/features/build/BuildScreen'
import { ResultsPanel } from '@/features/build/ResultsPanel'
import { useBuildStore } from '@/features/build/store'
import { LearnScreen } from '@/features/learn/LearnScreen'
import { TutorPanel } from '@/features/tutor/TutorPanel'
import { TopBar, type Screen } from '@/features/shell/TopBar'

function App() {
  const [screen, setScreen] = useState<Screen>('lab')
  const loadCircuit = useBuildStore((s) => s.loadCircuit)

  function openInLab(circuit: Circuit) {
    loadCircuit(circuit)
    setScreen('lab')
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
      ) : (
        <div className="min-h-0 flex-1">
          <LearnScreen onOpenLab={openInLab} />
        </div>
      )}
    </div>
  )
}

export default App
