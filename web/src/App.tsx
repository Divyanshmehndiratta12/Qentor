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
import { useEffect, useRef, useState } from 'react'
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
import { pathForScreen, screenFromPath } from '@/features/shell/routes'

function App() {
  // The address bar decides the first screen (a direct visit to /learn opens Learn), and is kept in step afterwards.
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(window.location.pathname))
  // Whether the Qentor Guide's side panel is open. Pure UI state: it lives
  // here, not in any store, and opening/closing it touches nothing else — the
  // tutor conversation and language stay in `useBuildStore`.
  const [guideOpen, setGuideOpen] = useState(false)
  const guideButtonRef = useRef<HTMLButtonElement>(null)
  const isFirstScreen = useRef(true)
  const loadCircuit = useBuildStore((s) => s.loadCircuit)
  const selectLesson = useLearnStore((s) => s.selectLesson)

  // The Guide is offered where there is something to be guided through.
  const guideScreen = screen === 'lab' || screen === 'learn' ? screen : null

  // Back/Forward: the address changed under us, so follow it.
  useEffect(() => {
    const onPop = () => setScreen(screenFromPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function goTo(next: Screen) {
    const path = pathForScreen(next)
    if (window.location.pathname !== path) window.history.pushState(null, '', path)
    setScreen(next)
  }

  // Moving to another screen puts keyboard and screen-reader focus on that screen's content (not left on the nav button that
  // no longer describes where you are). Not on first load, where the page should start at its top.
  useEffect(() => {
    if (isFirstScreen.current) {
      isFirstScreen.current = false
      return
    }
    document.getElementById('main-content')?.focus()
  }, [screen])

  function closeGuide() {
    setGuideOpen(false)
    guideButtonRef.current?.focus() // hand focus back to the character
  }

  function openInLab(circuit: Circuit) {
    loadCircuit(circuit)
    goTo('lab')
  }

  function openLesson(lessonId: string) {
    selectLesson(lessonId)
    goTo('learn')
  }

  return (
    <div className="flex min-h-screen flex-col bg-void-950 text-slate-200 lg:h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-slate-100 focus:px-3 focus:py-1.5 focus:text-sm focus:font-semibold focus:text-void-950"
      >
        Skip to main content
      </a>
      <TopBar
        screen={screen}
        onNavigate={goTo}
        guideSlot={
          guideScreen ? (
            <GuideLauncher open={guideOpen} onToggle={() => setGuideOpen((open) => !open)} buttonRef={guideButtonRef} />
          ) : undefined
        }
      />

      {screen === 'lab' ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <main
              id="main-content"
              tabIndex={-1}
              className="h-[34rem] min-w-0 shrink-0 border-b border-void-500 bg-void-950 outline-none lg:h-auto lg:flex-1 lg:shrink lg:border-r lg:border-b-0"
            >
              <BuildScreen />
            </main>

            <aside aria-label="Results" className="h-[32rem] w-full shrink-0 bg-void-900 lg:h-auto lg:w-96">
              <ResultsPanel />
            </aside>
          </div>

          <footer aria-label="Tutor" className="h-72 shrink-0 border-t border-void-500 bg-void-900 lg:h-64">
            <TutorPanel />
          </footer>
        </>
      ) : screen === 'learn' ? (
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 outline-none">
          <LearnScreen onOpenLab={openInLab} />
        </main>
      ) : (
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-auto bg-void-950 outline-none">
          <ProgressScreen onOpenLesson={openLesson} />
        </main>
      )}

      {guideScreen && guideOpen && <GuidePanel screen={guideScreen} onClose={closeGuide} />}
    </div>
  )
}

export default App
