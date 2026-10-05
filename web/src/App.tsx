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
 *  - Noise Lab: one circuit run ideally and under a named simulated noise model (Qiskit Aer), compared by the server. It edits the
 *    Lab's own circuit; it computes nothing in the browser (`features/noise`).
 *
 *  - Progress: the learner dashboard — overall progress, concept-check
 *    performance, mastery, needs-attention signals, next challenge and the
 *    local activity streak. Read-only over Learn state; it never touches Lab.
 *
 * Qubi (`features/guide`) is the AI Tutor's companion, offered on Lab and Learn:
 * a small character that roams the visible screen and opens a side panel that
 * embeds the existing tutor. It is an entry point only — no tutor logic here.
 *
 * An interactive_lab section's "Open in Lab" action is the only bridge
 * between Learn and Lab: it loads that lesson's canonical circuit into
 * `useBuildStore` (via `loadCircuit`) and switches back to Lab — it never
 * computes anything itself. Progress's only bridge is `openLesson`, which
 * selects a lesson in the Learn store and switches to Learn.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { labColumnRem } from '@/features/build/canvasHeight'
import type { Circuit } from '@/circuit/types'
import { BuildScreen } from '@/features/build/BuildScreen'
import { ResultsPanel } from '@/features/build/ResultsPanel'
import { useBuildStore } from '@/features/build/store'
import { LearnScreen } from '@/features/learn/LearnScreen'
import { useLearnStore } from '@/features/learn/store'
import { GuideLauncher } from '@/features/guide/GuideLauncher'
import { GuidePanel } from '@/features/guide/GuidePanel'
import { ChallengesScreen } from '@/features/challenges/ChallengesScreen'
import { NextStep } from '@/features/challenges/NextStep'
import { WelcomeCard, rememberWelcomeDismissed, welcomeDismissed } from '@/features/shell/WelcomeCard'
import { ProgressScreen } from '@/features/progress/ProgressScreen'
import { NoiseLabScreen } from '@/features/noise/NoiseLabScreen'
import { TutorPanel, type Mode as TutorMode } from '@/features/tutor/TutorPanel'
import { ClassroomScreen } from '@/features/classroom/ClassroomScreen'
import { useClassroomStore } from '@/features/classroom/store'
import { SharedExperimentScreen } from '@/features/share/SharedExperimentScreen'
import { TopBar, type Screen } from '@/features/shell/TopBar'
import { decodeShareFragment } from '@/features/share/shareLink'
import { challengeIdFromPath, pathForChallenge, pathForScreen, screenFromPath, sharedIdFromPath } from '@/features/shell/routes'

function App() {
  // The address bar decides the first screen (a direct visit to /learn opens Learn), and is kept in step afterwards.
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(window.location.pathname))
  // Whether the Qentor Guide's side panel is open. Pure UI state: it lives
  // here, not in any store, and opening/closing it touches nothing else — the
  // tutor conversation and language stay in `useBuildStore`.
  // The challenge the address bar names (/challenges/<id>). `n` counts address changes from Back/Forward so the Challenges screen
  // follows them even when the id is the same as before.
  const [challengeRoute, setChallengeRoute] = useState(() => ({ challengeId: challengeIdFromPath(window.location.pathname), n: 0 }))
  // The shared experiment the address bar names (/shared/<id>); `null` for an address that is not a well-formed share id.
  const [sharedId, setSharedId] = useState(() => sharedIdFromPath(window.location.pathname))
  const [guideOpen, setGuideOpen] = useState(false)
  // The Lab's tutor footer is short while it has nothing to show: no result to ask about, no conversation, and the Explain mode on. It grows
  // back as soon as there is a result, a turn, or another mode (Debug and Generate code need the room).
  const [tutorMode, setTutorMode] = useState<TutorMode>('explain')
  const tutorEmpty = useBuildStore((s) => s.result === null && s.tutorTurns.length === 0)
  const guideButtonRef = useRef<HTMLButtonElement>(null)
  const isFirstScreen = useRef(true)
  const loadCircuit = useBuildStore((s) => s.loadCircuit)
  const canvasExpanded = useBuildStore((s) => s.canvasExpanded)
  const labQubits = useBuildStore((s) => s.circuit.num_qubits) // on a phone the Lab's canvas column is as tall as its register needs
  // A share link (`/#c=…`) carries a circuit and nothing else. It is validated, loaded onto the canvas WITHOUT any result, and the
  // fragment is removed so a reload does not silently replace the learner's work again.
  // First-visit welcome on the Lab: until dismissed, or until the learner has started a lesson.
  const [welcomeShown, setWelcomeShown] = useState(() => !welcomeDismissed())
  const startedAny = useLearnStore((s) => s.startedLessonIds.size > 0)
  const [sharedNotice, setSharedNotice] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    const decoded = decodeShareFragment(window.location.hash)
    if (!decoded) return
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    if (decoded.ok) {
      loadCircuit(decoded.circuit)
      setSharedNotice({ ok: true, text: 'Loaded a circuit from a shared link. It came without results — run it to see what the backend computes.' })
    } else {
      setSharedNotice({ ok: false, text: `That share link could not be opened: ${decoded.reason} Nothing was loaded.` })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on first load
  }, [])
  const selectLesson = useLearnStore((s) => s.selectLesson)
  const confirmMembership = useClassroomStore((s) => s.confirmMembership)
  // Ask the server where this browser's learner token stands, so the class indicator shows the truth (a deleted class, for instance).
  useEffect(() => {
    void confirmMembership()
  }, [confirmMembership])

  // The Guide is offered where there is something to be guided through.
  const guideScreen = screen === 'lab' || screen === 'learn' ? screen : null
  // The Lab's "Expand canvas" full view: the canvas fills the window, so the banner, the top bar, the results, the tutor footer and Qubi are hidden.
  const labExpanded = screen === 'lab' && canvasExpanded

  // Back/Forward: the address changed under us, so follow it.
  useEffect(() => {
    const onPop = () => {
      setScreen(screenFromPath(window.location.pathname))
      setChallengeRoute((r) => ({ challengeId: challengeIdFromPath(window.location.pathname), n: r.n + 1 }))
      setSharedId(sharedIdFromPath(window.location.pathname))
    }
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

  // The Challenges screen keeps the address bar on the selected challenge (a shareable, reloadable link). Selecting one while
  // already on Challenges adds a history entry; the initial selection replaces the bare /challenges entry instead.
  function syncChallengePath(challengeId: string | null) {
    const path = pathForChallenge(challengeId)
    if (window.location.pathname === path) return
    const onBare = window.location.pathname.replace(/\/+$/, '') === pathForScreen('challenges')
    if (onBare) window.history.replaceState(null, '', path)
    else window.history.pushState(null, '', path)
  }

  // Open a specific challenge (from Progress or a "what next" suggestion): the Challenges screen selects it once its catalog is here.
  function openChallenge(challengeId: string) {
    setChallengeRoute((r) => ({ challengeId, n: r.n + 1 }))
    goTo('challenges')
  }

  // "Fork into my Lab" on a shared page: the visitor's own copy of the circuit goes onto the Lab canvas, WITHOUT any result, and nothing
  // is sent anywhere. The shared experiment is not touched.
  function forkShared(circuit: Circuit, title: string | null) {
    loadCircuit(circuit)
    setSharedNotice({
      ok: true,
      text: `Forked ${title ? `“${title}”` : 'the shared experiment'} into your Lab as your own copy. The shared page is unchanged. It came without results — run it to see what the backend computes.`,
    })
    goTo('lab')
  }

  // A lesson whose lab is the ideal-versus-noisy comparison: its circuit goes onto the Lab's canvas (the one circuit) and the Noise Lab opens.
  function openInNoiseLab(circuit: Circuit) {
    loadCircuit(circuit)
    goTo('noise')
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
      <TopBar screen={screen} onNavigate={goTo} hidden={labExpanded} />

      {screen === 'lab' && welcomeShown && !startedAny && !sharedNotice && !labExpanded && (
        <WelcomeCard
          onStartLearning={() => goTo('learn')}
          onOpenChallenges={() => goTo('challenges')}
          onDismiss={() => {
            rememberWelcomeDismissed()
            setWelcomeShown(false)
          }}
        />
      )}

      {sharedNotice && !labExpanded && (
        <div
          role={sharedNotice.ok ? 'status' : 'alert'}
          data-testid="shared-notice"
          className={`flex items-center justify-between gap-3 border-b px-4 py-1.5 text-[12px] ${
            sharedNotice.ok ? 'border-cyan-glow/30 bg-cyan-dim/20 text-cyan-glow' : 'border-danger-glow/40 bg-danger-dim/30 text-danger-glow'
          }`}
        >
          <span>{sharedNotice.text}</span>
          <button type="button" onClick={() => setSharedNotice(null)} className="underline underline-offset-2">
            Dismiss
          </button>
        </div>
      )}

      {screen === 'lab' ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <main
              id="main-content"
              tabIndex={-1}
              aria-labelledby="lab-heading"
              className="h-[var(--lab-h)] min-w-0 shrink-0 border-b border-void-500 bg-void-950 outline-none lg:h-auto lg:flex-1 lg:shrink lg:border-r lg:border-b-0"
              style={{ '--lab-h': `${labColumnRem(labQubits)}rem` } as CSSProperties}
            >
              <h1 id="lab-heading" className="sr-only">
                Lab: build, run and verify a circuit
              </h1>
              <BuildScreen />
            </main>

            <aside hidden={labExpanded} aria-label="Results" className="h-[32rem] w-full shrink-0 bg-void-900 lg:h-auto lg:w-96">
              <ResultsPanel />
            </aside>
          </div>

          <footer
            hidden={labExpanded}
            aria-label="Tutor"
            data-compact={tutorEmpty && tutorMode === 'explain'}
            className={`shrink-0 border-t border-void-500 bg-void-900 ${tutorEmpty && tutorMode === 'explain' ? 'h-48 lg:h-44' : 'h-72 lg:h-64'}`}
          >
            <TutorPanel onModeChange={setTutorMode} />
          </footer>
        </>
      ) : screen === 'learn' ? (
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 outline-none">
          <LearnScreen onOpenLab={openInLab} onOpenNoiseLab={openInNoiseLab} onOpenChallenge={openChallenge} />
        </main>
      ) : screen === 'noise' ? (
        <NoiseLabScreen />
      ) : screen === 'classroom' ? (
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-auto bg-void-950 outline-none">
          <ClassroomScreen />
        </main>
      ) : screen === 'shared' ? (
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-auto bg-void-950 outline-none">
          <SharedExperimentScreen experimentId={sharedId} onFork={forkShared} onOpenLab={() => goTo('lab')} />
        </main>
      ) : screen === 'challenges' ? (
        <ChallengesScreen
          route={challengeRoute}
          onSelectionChange={syncChallengePath}
          onOpenLesson={openLesson}
          onOpenLab={() => goTo('lab')}
          renderNextStep={() => (
            <NextStep onOpenChallenge={openChallenge} onOpenLesson={openLesson} onOpenProgress={() => goTo('progress')} />
          )}
        />
      ) : (
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-auto bg-void-950 outline-none">
          <ProgressScreen onOpenLesson={openLesson} onOpenChallenge={openChallenge} />
        </main>
      )}

      {guideScreen && guideOpen && !labExpanded && <GuidePanel screen={guideScreen} onClose={closeGuide} />}

      {/* Qubi roams the visible screen (fixed), so it lives at the root rather than in any one region. */}
      {guideScreen && !labExpanded && <GuideLauncher open={guideOpen} onToggle={() => setGuideOpen((open) => !open)} buttonRef={guideButtonRef} />}
    </div>
  )
}

export default App
