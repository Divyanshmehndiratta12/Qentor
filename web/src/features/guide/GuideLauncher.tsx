/**
 * Qubi, the AI Tutor's companion: the character as a real `<button>` with a small nameplate, a pause control,
 * and a slow roam over the visible screen.
 *
 * Qubi is the entry point to the EXISTING tutor and holds no tutor state: the button toggles the Guide panel
 * (`GuidePanel`, which embeds the one `TutorPanel`). Nothing here computes or says anything about a quantum
 * result.
 *
 * Where it lives. `position: fixed`, placed by `useQubiRoaming` (rules in `qubiMotion.ts`): inside the viewport
 * margins and below the top bar, never off screen, and steering away from controls, the code editor, the
 * tutor's input and the pointer. Desktop uses the whole usable viewport, a tablet a smaller inset area, a phone
 * a thin band along the bottom. Qubi stops moving (it does not jump back anywhere):
 *  - while the learner hovers or focuses the Qubi button: never a moving target under the pointer;
 *  - while paused with the pause control, until it is resumed (it continues from where it stopped);
 *  - while the tutor panel is open: it glides beside the panel instead, so it stays reachable.
 * Under `prefers-reduced-motion: reduce` it sits on a calm spot and never roams, bobs or transitions,
 * and the tutor is exactly as usable. The pause control is then not needed and is not shown.
 */
import { useEffect, useRef, useState, type Ref } from 'react'
import { GuideCharacter } from './GuideCharacter'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'
import { useQubiRoaming } from './useQubiRoaming'

export const BUBBLE_DELAY_MS = 5_000
export const BUBBLE_VISIBLE_MS = 6_000

// The bubble is shown at most once per page load, however many times the launcher mounts (e.g. switching between Lab and Learn).
let bubbleShownThisSession = false

/** Test hook: forget that the bubble was shown. Not used by the app. */
export function resetGuideBubbleForTests(): void {
  bubbleShownThisSession = false
}

export interface GuideLauncherProps {
  open: boolean
  onToggle: () => void
  buttonRef?: Ref<HTMLButtonElement>
  /** Random source for the roaming schedule; tests pass a fixed one. */
  rng?: () => number
}

export function GuideLauncher({ open, onToggle, buttonRef, rng }: GuideLauncherProps) {
  const reduced = usePrefersReducedMotion()
  const [paused, setPaused] = useState(false)
  const [held, setHeld] = useState(false) // pointer or keyboard focus is on the Qubi button
  const [bubble, setBubble] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const roam = !reduced
  const state = open ? 'docked' : reduced ? 'still' : paused ? 'paused' : held ? 'held' : 'roaming'
  useQubiRoaming(rootRef, { roam, suspended: paused || held, docked: open, rng })

  // "Need help?" — once, a few seconds after Qubi first appears, unless the panel is already open.
  useEffect(() => {
    if (bubbleShownThisSession || open) return
    const show = window.setTimeout(() => {
      bubbleShownThisSession = true
      setBubble(true)
    }, BUBBLE_DELAY_MS)
    return () => window.clearTimeout(show)
  }, [open])

  useEffect(() => {
    if (!bubble) return
    const hide = window.setTimeout(() => setBubble(false), BUBBLE_VISIBLE_MS)
    return () => window.clearTimeout(hide)
  }, [bubble])

  useEffect(() => {
    if (open) setBubble(false)
  }, [open])

  const moving = state === 'roaming'

  return (
    <div
      ref={rootRef}
      data-testid="guide-launcher"
      data-motion={reduced ? 'reduced' : 'allowed'}
      data-state={state}
      data-placed="false"
      className="qubi fixed top-0 left-0 z-30 flex flex-col items-center"
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
        aria-label={open ? 'Close Qubi AI Tutor' : 'Open Qubi AI Tutor'}
        aria-expanded={open}
        aria-controls="qentor-guide-panel"
        title="Qubi, your AI Tutor"
        className="group flex flex-col items-center gap-1 rounded-2xl p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
      >
        <span
          className={`qubi-orb grid h-11 w-11 place-items-center rounded-full bg-void-600 shadow-[0_6px_16px_rgba(0,0,0,0.45)] ring-1 transition-[box-shadow,transform] duration-150 group-hover:scale-105 group-focus-visible:scale-105 ${
            open ? 'ring-2 ring-cyan-glow' : 'ring-cyan-glow/45 group-hover:ring-cyan-glow/80 group-focus-visible:ring-cyan-glow/80'
          }`}
        >
          <span className={moving ? 'qentor-guide-bob' : ''}>
            <GuideCharacter size={38} />
          </span>
        </span>
        <span className="flex min-w-16 flex-col items-center rounded-lg border border-slate-500/50 bg-void-800/95 px-2 py-0.5 leading-tight shadow-[0_4px_10px_rgba(0,0,0,0.4)]">
          <span className="text-[13px] font-semibold text-slate-100">Qubi</span>
          <span className="text-[10px] text-slate-300">AI Tutor</span>
        </span>
      </button>

      {roam && (
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused}
          aria-label={paused ? 'Resume Qubi’s movement' : 'Pause Qubi’s movement'}
          title={paused ? 'Resume Qubi’s movement' : 'Pause Qubi’s movement'}
          className="absolute top-0 right-0 grid h-6 w-6 place-items-center rounded-full border border-slate-500/60 bg-void-800 text-slate-200 shadow hover:border-cyan-glow/70 hover:text-slate-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" fill="currentColor">
            {paused ? <path d="M2 1 L9 5 L2 9 Z" /> : <path d="M2 1h2v8H2zM6 1h2v8H6z" />}
          </svg>
        </button>
      )}

      {bubble && (
        <span
          data-testid="guide-bubble"
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded-lg border border-void-400 bg-void-800 px-2 py-1 text-[11px] whitespace-nowrap text-slate-200 shadow-lg max-md:hidden"
        >
          Need help?
        </span>
      )}
    </div>
  )
}
