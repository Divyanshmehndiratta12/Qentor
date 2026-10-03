/**
 * Drives Qubi's movement without re-rendering React.
 *
 * Qubi is a `position: fixed` element placed with a CSS `transform`. This hook writes that transform (and its
 * transition duration) straight onto the element, so a move is one style write and the browser animates it on
 * the compositor: no React state changes per move, no per-frame JS, no animation library. React state is touched
 * only when something the learner did changes (paused, hovered, panel opened).
 *
 * The schedule: rest a few seconds, pick a spot (`qubiMotion.planTarget`), glide there slowly, rest again; a
 * rest is sometimes much longer. Nothing advances while the tab is hidden.
 *
 *  - `roam: false` (reduced motion): Qubi is placed on a calm spot (chosen again once, just after load, when the
 *    page has finished laying out) and never glides after that. It is still re-fitted into the viewport if the window is
 *    resized, docked beside the panel while the panel is open, and placed anew (a jump, no animation) only if a later
 *    layout change leaves it on top of a control.
 *  - `suspended: true` (paused, or the learner's pointer/keyboard is on Qubi): Qubi stops exactly where it is on
 *    screen, mid-glide included. Un-suspending continues from that spot; nothing resets.
 *  - `docked: true` (the tutor panel is open): roaming is suspended and Qubi glides to the gutter beside the panel,
 *    so it stays visible and reachable (it is the panel's toggle).
 *
 * `data-x` / `data-y` on the element hold the spot Qubi is at or heading to (for tests and diagnostics).
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  EDGE_MARGIN,
  clampToRegion,
  coverCost,
  planDock,
  planRest,
  planTarget,
  regionFor,
  restMs,
  travelMs,
  type Obstacle,
  type Point,
  type Size,
} from './qubiMotion'

const FALLBACK_SIZE: Size = { w: 72, h: 78 }
const FALLBACK_TOP_INSET = 52
const RESUME_DELAY_MS = 800
const SETTLE_MS = 600
const RECHECK_MS = 700
const DOCK_MS = 700
const DOCK_GAP = 10
const PANEL_ID = 'qentor-guide-panel'

/** What Qubi should stay off: controls and the code text, with the page's primary actions counted many times over. */
const CONTROL_SELECTOR = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="switch"]'
const TEXT_SELECTOR = '.cm-editor'
const PRIMARY_SELECTOR = '[data-qubi-avoid]'

function collectObstacles(self: HTMLElement): Obstacle[] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const out: Obstacle[] = []
  const add = (selector: string, weight: number) => {
    document.querySelectorAll<HTMLElement>(selector).forEach((node) => {
      if (self.contains(node)) return
      const r = node.getBoundingClientRect()
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return
      // A disabled control cannot be used right now, so standing on it costs a quarter as much.
      const disabled = node.matches(':disabled, [aria-disabled="true"]')
      out.push({ box: { x: r.left, y: r.top, w: r.width, h: r.height }, weight: disabled ? weight * 0.25 : weight })
    })
  }
  add(CONTROL_SELECTOR, 1)
  add(PRIMARY_SELECTOR, 30)
  add(TEXT_SELECTOR, 0.4)
  const focused = document.activeElement
  if (focused instanceof HTMLElement && focused !== document.body && !self.contains(focused)) {
    const r = focused.getBoundingClientRect()
    if (r.width >= 2) out.push({ box: { x: r.left, y: r.top, w: r.width, h: r.height }, weight: 30 })
  }
  return out
}

export interface QubiRoamingOptions {
  /** False under reduced motion: place once, never move. */
  roam: boolean
  /** True while paused, or while the learner is on Qubi: stop where it is. */
  suspended: boolean
  /** True while the tutor panel is open: sit beside it. */
  docked: boolean
  rng?: () => number
}

export function useQubiRoaming(elRef: RefObject<HTMLElement | null>, { roam, suspended, docked, rng = Math.random }: QubiRoamingOptions) {
  const pos = useRef<Point>({ x: EDGE_MARGIN, y: 0 })
  const pointer = useRef<Point | null>(null)
  const rngRef = useRef(rng)
  rngRef.current = rng

  const measure = () => {
    const el = elRef.current!
    const size: Size = { w: el.offsetWidth || FALLBACK_SIZE.w, h: el.offsetHeight || FALLBACK_SIZE.h }
    const top = document.querySelector('header')?.getBoundingClientRect().bottom || FALLBACK_TOP_INSET
    const region = regionFor({ w: window.innerWidth, h: window.innerHeight }, top, size)
    return { el, size, region }
  }

  const apply = (p: Point, ms: number) => {
    const el = elRef.current
    if (!el) return
    pos.current = p
    el.style.transitionDuration = `${ms}ms`
    el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`
    el.dataset.x = String(Math.round(p.x))
    el.dataset.y = String(Math.round(p.y))
  }

  // First placement, before paint: a calm spot, no transition, then revealed.
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const { size, region } = measure()
    apply(planRest({ region, size, obstacles: collectObstacles(el), pointer: null }), 0)
    el.dataset.placed = 'true'
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, [])

  // Keep Qubi inside the viewport (and beside the panel, when docked) as the window is resized.
  useEffect(() => {
    let frame = 0
    const refit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!elRef.current) return
        const { size, region } = measure()
        const target = docked ? dockPoint(size, region) : clampToRegion(pos.current, region)
        if (target.x !== pos.current.x || target.y !== pos.current.y) apply(target, 0)
      })
    }
    window.addEventListener('resize', refit)
    return () => {
      window.removeEventListener('resize', refit)
      cancelAnimationFrame(frame)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measure/apply read refs only
  }, [docked])

  // Remember where the pointer is so a move never lands on it. A passive listener that only stores two numbers.
  useEffect(() => {
    if (!roam) return
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [roam])

  function dockPoint(size: Size, region: ReturnType<typeof regionFor>): Point {
    const panel = document.getElementById(PANEL_ID)
    const panelWidth = panel?.offsetWidth || Math.min(380, window.innerWidth - 88)
    const x = Math.max(4, window.innerWidth - panelWidth - size.w - DOCK_GAP)
    const fromY = clampToRegion(pos.current, region).y
    return planDock({ region, size, x, fromY, obstacles: collectObstacles(elRef.current!) })
  }

  useEffect(() => {
    const el = elRef.current
    if (!el) return

    if (docked) {
      const { size, region } = measure()
      apply(dockPoint(size, region), DOCK_MS)
      return
    }
    if (!roam) {
      // Reduced motion: the first placement happened before the page had finished laying out (the code editor mounts after it), so choose
      // the calm spot again once it has settled. This is the only time a stationary Qubi is placed after load.
      const settle = window.setTimeout(() => {
        const { size, region } = measure()
        apply(planRest({ region, size, obstacles: collectObstacles(el), pointer: pointer.current }), 0)
      }, SETTLE_MS)
      // Later layout changes (the welcome card dismissed, a result arriving) can leave the calm spot on top of a control. Look again after
      // the page has changed, and place Qubi anew only if that has happened: a placement, not an animation (there is no transition here).
      let watch = 0
      const recheck = () => {
        window.clearTimeout(watch)
        watch = window.setTimeout(() => {
          const { size, region } = measure()
          const obstacles = collectObstacles(el)
          if (coverCost(clampToRegion(pos.current, region), size, obstacles, null) > 0) apply(planRest({ region, size, obstacles, pointer: null }), 0)
        }, RECHECK_MS)
      }
      const observer = new MutationObserver(recheck)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        window.clearTimeout(settle)
        window.clearTimeout(watch)
        observer.disconnect()
      }
    }

    if (suspended) {
      // Stop exactly where Qubi is on screen, even part-way through a glide.
      const r = el.getBoundingClientRect()
      apply(r.width > 0 ? { x: r.left, y: r.top } : pos.current, 0)
      return
    }

    let timer = 0
    const step = () => {
      if (document.hidden) {
        timer = window.setTimeout(step, restMs(rngRef.current))
        return
      }
      const { size, region } = measure()
      const from = clampToRegion(pos.current, region)
      const to = planTarget({ region, size, from, obstacles: collectObstacles(el), pointer: pointer.current, rng: rngRef.current })
      const ms = travelMs(from, to)
      apply(to, ms)
      timer = window.setTimeout(step, ms + restMs(rngRef.current))
    }
    timer = window.setTimeout(step, RESUME_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measure/apply/dockPoint read refs only
  }, [roam, suspended, docked])
}
