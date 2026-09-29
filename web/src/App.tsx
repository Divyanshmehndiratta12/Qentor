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
 * The Qentor Guide (`features/guide`) is a companion offered on Lab and Learn:
 * its launcher sits in the top bar's spare space and opens a side panel that
 * embeds the existing tutor. It is an entry point only — no tutor logic here.
 *
 * An interactive_lab section's "Open in Lab" action is the only bridge
 * between Learn and Lab: it loads that lesson's canonical circuit into
 * `useBuildStore` (via `loadCircuit`) and switches back to Lab — it never
 * computes anything itself. Progress's only bridge is `openLesson`, which
 * selects a lesson in the Learn store and switches to Learn.
 */
import { useRef, useState } from 'react'
import type { Circuit } from '@/circuit/types'
import { BuildScreen } from '@/features/build/BuildScreen'
import { ResultsPanel } from '@/features/build/ResultsPanel'
import { useBuildStore } from '@/features/build/store'
import { LearnScreen } from '@/features/learn/LearnScreen'
import { useLearnStore } from '@/features/learn/store'
import { GuideLauncher } from '@/features/guide/GuideLauncher'
import { GuidePanel } from '@/features/guide/GuidePanel'
import { ProgressScreen } from '@/features/progress/ProgressScreen'
import { TutorPanel } from '@/features/tutor/TutorPanel'
import { TopBar, type Screen } from '@/features/shell/TopBar'

function App() {
  const [screen, setScreen] = useState<Screen>('lab')
  // Whether the Qentor Guide's side panel is open. Pure UI state: it lives
  // here, not in any store, and opening/closing it touches nothing else — the
  // tutor conversation and language stay in `useBuildStore`.
  const [guideOpen, setGuideOpen] = useState(false)
  const guideButtonRef = useRef<HTMLButtonElement>(null)
  const loadCircuit = useBuildStore((s) => s.loadCircuit)
  const selectLesson = useLearnStore((s) => s.selectLesson)

  // The Guide is offered where there is something to be guided through.
  const guideScreen = screen === 'lab' || screen === 'learn' ? screen : null

  function closeGuide() {
    setGuideOpen(false)
    guideButtonRef.current?.focus() // hand focus back to the character
  }

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
      <TopBar
        screen={screen}
        onNavigate={setScreen}
        guideSlot={
          guideScreen ? (
            <GuideLauncher open={guideOpen} onToggle={() => setGuideOpen((open) => !open)} buttonRef={guideButtonRef} />
          ) : undefined
        }
      />

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

      {guideScreen && guideOpen && <GuidePanel screen={guideScreen} onClose={closeGuide} />}
    </div>
  )
}

export default App
