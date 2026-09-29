/**
 * The Guide's launcher: the character, as a real `<button>`.
 *
 * Where it lives: an empty spacer in the top bar (see `TopBar`'s `guideSlot`),
 * between the navigation and the Lab toolbar. That is the point of the
 * placement — nothing else is in that strip, so the character can never cover
 * a control, the circuit canvas or a lesson button, however it moves. It
 * drifts slowly along that strip (`useRoaming`: a fixed anchor list, one move
 * per 10 s, each a ~4 s slide), bobs a few pixels while idle, and shows a
 * "Need help?" bubble once, several seconds in, for a few seconds — never
 * again this session and never while the panel is open. Below the `md`
 * breakpoint the top bar is too tight, so it parks in the bottom-right corner
 * (no roaming there) and stays clickable.
 *
 * It stops moving while the learner hovers or focuses it (so it is never a
 * moving target under the pointer), while the panel is open, and while the tab
 * is hidden. Under `prefers-reduced-motion: reduce` there is no roaming, no
 * bobbing and no transition — it just sits, visible and clickable. It is
 * purely an entry point: it holds no tutor state and computes nothing.
 */
import { useEffect, useState, type CSSProperties, type Ref } from 'react'
import { GuideCharacter } from './GuideCharacter'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'
import { useRoaming } from './useRoaming'

export const BUBBLE_DELAY_MS = 5_000
export const BUBBLE_VISIBLE_MS = 6_000

// The bubble is shown at most once per page load, however many times the
// launcher mounts (e.g. switching between Lab and Learn).
let bubbleShownThisSession = false

/** Test hook: forget that the bubble was shown. Not used by the app. */
export function resetGuideBubbleForTests(): void {
  bubbleShownThisSession = false
}

export interface GuideLauncherProps {
  open: boolean
  onToggle: () => void
  buttonRef?: Ref<HTMLButtonElement>
}

export function GuideLauncher({ open, onToggle, buttonRef }: GuideLauncherProps) {
  const reduced = usePrefersReducedMotion()
  const [paused, setPaused] = useState(false)
  const [bubble, setBubble] = useState(false)

  const percent = useRoaming({ roam: !reduced && !open, paused })

  // "Need help?" — once, a few seconds after the launcher first appears, unless
  // the panel is already open.
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

  return (
    <div
      data-testid="guide-launcher"
      data-motion={reduced ? 'reduced' : 'allowed'}
      style={{ '--guide-x': `${percent}%` } as CSSProperties}
      className={`absolute top-1/2 z-30 -mt-5 left-[var(--guide-x)] [transform:translateX(calc(var(--guide-x)*-1))] max-md:fixed max-md:top-auto max-md:right-4 max-md:bottom-4 max-md:left-auto max-md:mt-0 max-md:[transform:none] ${
        reduced ? '' : 'qentor-guide-roam'
      }`}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
        aria-label={open ? 'Close Qentor Guide' : 'Open Qentor Guide'}
        aria-expanded={open}
        aria-controls="qentor-guide-panel"
        title="Qentor Guide"
        className={`grid h-10 w-10 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow ${
          open ? 'ring-2 ring-cyan-glow/70' : 'hover:bg-void-700'
        }`}
      >
        <span className={reduced || open ? '' : 'qentor-guide-bob'}>
          <GuideCharacter size={38} />
        </span>
      </button>

      {bubble && (
        <span
          data-testid="guide-bubble"
          aria-hidden="true"
          className="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-lg border border-void-400 bg-void-800 px-2 py-1 text-[11px] whitespace-nowrap text-slate-200 shadow-lg max-md:top-auto max-md:bottom-full max-md:mt-0 max-md:mb-1"
        >
          Need help?
        </span>
      )}
    </div>
  )
}
