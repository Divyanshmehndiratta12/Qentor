/**
 * Qubi, the AI Tutor's companion: the button and its nameplate, the roaming schedule, the pause control, docking beside the panel,
 * keyboard access and reduced motion. Time is faked (only timers) and the random source is injected, so every position is exact.
 * jsdom has no layout, so Qubi's size and the top bar fall back to the hook's constants; the 1024 x 768 window is a desktop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BUBBLE_DELAY_MS, BUBBLE_VISIBLE_MS, GuideLauncher, resetGuideBubbleForTests } from './GuideLauncher'
import { EDGE_MARGIN } from './qubiMotion'

const launcher = () => screen.getByTestId('guide-launcher')
const pos = () => ({ x: Number(launcher().dataset.x), y: Number(launcher().dataset.y) })
const qubi = () => screen.getByRole('button', { name: /Qubi AI Tutor/ })
const pauseButton = () => screen.getByRole('button', { name: /Qubi’s movement/ })

// The hook's fallbacks when jsdom reports no layout: Qubi is 72 x 78 px and the top bar 52 px tall.
const SIZE = { w: 72, h: 78 }
const TOP = 52
const REGION = { minX: EDGE_MARGIN, maxX: 1024 - SIZE.w - EDGE_MARGIN, minY: TOP + EDGE_MARGIN, maxY: 768 - SIZE.h - EDGE_MARGIN }

/** A small deterministic generator (mulberry32). */
function seeded(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** Enough time for several full cycles of rest + glide. */
const A_WHILE = 60_000

/** A controllable `matchMedia` for the reduced-motion query. */
function installMatchMedia(reduce: boolean) {
  const listeners = new Set<() => void>()
  const state = { reduced: reduce }
  const mql = {
    get matches() {
      return state.reduced
    },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => mql) })
  return {
    setReduced(next: boolean) {
      state.reduced = next
      act(() => listeners.forEach((fn) => fn()))
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  resetGuideBubbleForTests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
})

describe('Qubi, the companion', () => {
  it('renders as a real <button> named "Open Qubi AI Tutor", wired to the tutor panel', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)

    const b = screen.getByRole('button', { name: 'Open Qubi AI Tutor' })
    expect(b.tagName).toBe('BUTTON')
    expect(b).toHaveAttribute('type', 'button')
    expect(b).toHaveAttribute('aria-expanded', 'false')
    expect(b).toHaveAttribute('aria-controls', 'qentor-guide-panel')
    expect(b).not.toHaveAttribute('tabindex', '-1')
  })

  it('shows its name and role on a small nameplate: "Qubi" and "AI Tutor"', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(qubi()).toHaveTextContent('Qubi')
    expect(qubi()).toHaveTextContent('AI Tutor')
    expect(screen.getByText('Qubi')).toBeVisible()
    expect(screen.getByText('AI Tutor')).toBeVisible()
  })

  it('draws an original inline SVG — decorative, with no image file or external URL', () => {
    const { container } = render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)

    const svg = screen.getByTestId('guide-character')
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true') // the button carries the name
    expect(container.querySelector('img, image, foreignObject')).toBeNull()
    expect(container.innerHTML).not.toMatch(/https?:\/\//i)
    expect(container.innerHTML).not.toMatch(/href=|xlink:href/i)
  })

  it('stays recognisable when small: the same shapes at 24px', () => {
    const { container } = render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    const svg = container.querySelector('svg[data-testid="guide-character"]')!
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64') // scales by viewBox, not by re-drawing
    expect(svg.querySelectorAll('circle').length).toBeGreaterThanOrEqual(6) // body, eyes, electron, spark
  })

  it('toggles: clicking calls onToggle, and the name/aria-expanded follow the open state', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<GuideLauncher open={false} onToggle={onToggle} rng={seeded(1)} />)

    fireEvent.click(qubi())
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(<GuideLauncher open onToggle={onToggle} rng={seeded(1)} />)
    expect(screen.getByRole('button', { name: 'Close Qubi AI Tutor' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('exposes its element to the caller for focus restoration', () => {
    const ref = { current: null as HTMLButtonElement | null }
    render(<GuideLauncher open={false} onToggle={vi.fn()} buttonRef={ref} rng={seeded(1)} />)
    expect(ref.current).toBe(qubi())
  })

  it('is fixed to the screen (so it can roam it) and never sits in the document flow', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(launcher().className).toContain('fixed')
    expect(launcher().className).toContain('z-30') // under the tutor panel (z-40), over the page
  })
})

describe('keyboard', () => {
  it('Qubi and the pause control are both in the tab order, Qubi first, and take focus', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    const all = [...launcher().querySelectorAll('button')]
    expect(all).toHaveLength(2)
    expect(all[0]).toBe(qubi()) // Qubi first, then its pause control
    for (const b of all) {
      expect(b).not.toHaveAttribute('tabindex', '-1')
      act(() => b.focus())
      expect(b).toHaveFocus()
    }
  })

  it('shows a visible focus state on both buttons', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(qubi().className).toContain('focus-visible:outline-2')
    expect(qubi().className).toContain('focus-visible:outline-cyan-glow')
    expect(pauseButton().className).toContain('focus-visible:outline-2')
  })

  it('has hover and focus feedback on the character', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    const orb = launcher().querySelector('.qubi-orb')!
    expect(orb.className).toContain('group-hover:scale-105')
    expect(orb.className).toContain('group-focus-visible:scale-105')
  })

  it('keyboard focus on Qubi holds it still, and leaving lets it go on', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(2)} />)
    advance(1_000) // placed and about to move
    fireEvent.focus(qubi())
    expect(launcher()).toHaveAttribute('data-state', 'held')
    const held = pos()
    advance(A_WHILE)
    expect(pos()).toEqual(held)

    fireEvent.blur(qubi())
    expect(launcher()).toHaveAttribute('data-state', 'roaming')
    advance(A_WHILE)
    expect(pos()).not.toEqual(held)
  })
})

describe('roaming', () => {
  it('is placed inside the viewport before it moves, and is shown', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(launcher()).toHaveAttribute('data-placed', 'true')
    expect(launcher()).toHaveAttribute('data-state', 'roaming')
    expect(launcher()).toHaveAttribute('data-motion', 'allowed')
    const { x, y } = pos()
    expect(x).toBeGreaterThanOrEqual(REGION.minX)
    expect(x).toBeLessThanOrEqual(REGION.maxX)
    expect(y).toBeGreaterThanOrEqual(REGION.minY)
    expect(y).toBeLessThanOrEqual(REGION.maxY)
  })

  it('moves: it rests, then glides to a new spot; each glide is a slow CSS transition on a transform', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    const start = pos()
    expect(launcher().style.transform).toContain('translate3d(')

    advance(A_WHILE)

    expect(pos()).not.toEqual(start)
    const ms = parseInt(launcher().style.transitionDuration, 10)
    expect(ms).toBeGreaterThanOrEqual(4_000) // slow...
    expect(ms).toBeLessThanOrEqual(12_000) // ...but not endless
  })

  it('never leaves the viewport: every position over a long time is inside the safe margins', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(42)} />)
    const seen = new Set<string>()
    for (let i = 0; i < 80; i++) {
      advance(3_000)
      const { x, y } = pos()
      seen.add(`${x},${y}`)
      expect(x).toBeGreaterThanOrEqual(REGION.minX)
      expect(x).toBeLessThanOrEqual(REGION.maxX)
      expect(y).toBeGreaterThanOrEqual(REGION.minY)
      expect(y).toBeLessThanOrEqual(REGION.maxY)
    }
    expect(seen.size).toBeGreaterThan(5) // it really did roam, broadly
  })

  it('never goes up into the top bar', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(8)} />)
    for (let i = 0; i < 60; i++) {
      advance(4_000)
      expect(pos().y).toBeGreaterThanOrEqual(TOP)
    }
  })

  it('pauses naturally: it spends most of its time resting between glides', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(5)} />)
    let moves = 0
    let last = pos()
    for (let i = 0; i < 300; i++) {
      advance(1_000)
      const now = pos()
      if (now.x !== last.x || now.y !== last.y) moves++
      last = now
    }
    expect(moves).toBeGreaterThan(2)
    expect(moves).toBeLessThan(40) // a move every several seconds, never a constant fidget
  })

  it('does not advance while the tab is hidden', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    const start = pos()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      advance(A_WHILE)
      expect(pos()).toEqual(start)
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    }
    advance(A_WHILE)
    expect(pos()).not.toEqual(start)
  })

  it('has the idle bob only while it is roaming', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(launcher().querySelector('.qentor-guide-bob')).not.toBeNull()
    fireEvent.click(pauseButton())
    expect(launcher().querySelector('.qentor-guide-bob')).toBeNull()
  })

  it('clicking always works — at every moment of the schedule', () => {
    const onToggle = vi.fn()
    render(<GuideLauncher open={false} onToggle={onToggle} rng={seeded(1)} />)

    for (let i = 0; i < 10; i++) {
      fireEvent.click(qubi())
      advance(2_500) // a click landing mid-glide
    }
    expect(onToggle).toHaveBeenCalledTimes(10)
  })

  it('does no React work per move: once the bubble is gone, a long roam commits nothing', () => {
    let commits = 0
    render(
      <Profiler id="qubi" onRender={() => commits++}>
        <GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />
      </Profiler>,
    )
    for (let t = 0; t < BUBBLE_DELAY_MS + BUBBLE_VISIBLE_MS + 2_000; t += 1_000) advance(1_000) // the one-time bubble has come and gone
    commits = 0
    advance(A_WHILE * 2)
    expect(commits).toBe(0)
  })
})

describe('hover', () => {
  it('stops while the pointer is on Qubi (never a moving target under the pointer) and goes on when it leaves', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(2)} />)
    advance(1_000)

    fireEvent.pointerEnter(qubi())
    expect(launcher()).toHaveAttribute('data-state', 'held')
    const held = pos()
    advance(A_WHILE)
    expect(pos()).toEqual(held)

    fireEvent.pointerLeave(qubi())
    advance(A_WHILE)
    expect(pos()).not.toEqual(held)
  })
})

describe('pause and resume', () => {
  it('has a pause control that says what it does and what state it is in', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(pauseButton()).toHaveAccessibleName('Pause Qubi’s movement')
    expect(pauseButton()).toHaveAttribute('aria-pressed', 'false')
    expect(pauseButton()).toHaveAttribute('type', 'button')
  })

  it('pausing stops Qubi at its current position, however long it is left', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(3)} />)
    advance(7_000) // part-way through its schedule
    fireEvent.click(pauseButton())

    expect(launcher()).toHaveAttribute('data-state', 'paused')
    expect(pauseButton()).toHaveAccessibleName('Resume Qubi’s movement')
    expect(pauseButton()).toHaveAttribute('aria-pressed', 'true')
    const stopped = pos()
    advance(A_WHILE * 3)
    expect(pos()).toEqual(stopped)
    expect(launcher().style.transitionDuration).toBe('0ms') // frozen, not still gliding
  })

  it('resuming continues from where it stopped — it does not jump or reset — and then roams again', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(3)} />)
    advance(7_000)
    fireEvent.click(pauseButton())
    const stopped = pos()
    advance(10_000)

    fireEvent.click(pauseButton())
    expect(launcher()).toHaveAttribute('data-state', 'roaming')
    expect(pos()).toEqual(stopped) // not reset on resume
    advance(A_WHILE)
    expect(pos()).not.toEqual(stopped)
  })

  it('pause works while the tutor panel is closed, and stays paused after the panel closes', () => {
    const { rerender } = render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(3)} />)
    fireEvent.click(pauseButton())
    rerender(<GuideLauncher open onToggle={vi.fn()} rng={seeded(3)} />)
    rerender(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(3)} />)
    expect(launcher()).toHaveAttribute('data-state', 'paused')
  })
})

describe('with the tutor panel open', () => {
  it('suspends roaming and docks beside the panel, where it stays visible and reachable', () => {
    const { rerender } = render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    advance(5_000)

    rerender(<GuideLauncher open onToggle={vi.fn()} rng={seeded(1)} />)

    expect(launcher()).toHaveAttribute('data-state', 'docked')
    const dock = pos()
    // The panel is 380 px wide at the right edge; Qubi sits just left of it.
    expect(dock.x).toBe(1024 - 380 - SIZE.w - 10)
    advance(A_WHILE)
    expect(pos()).toEqual(dock)
    expect(launcher().querySelector('.qentor-guide-bob')).toBeNull()
  })

  it('roams again from the dock when the panel closes', () => {
    const { rerender } = render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    rerender(<GuideLauncher open onToggle={vi.fn()} rng={seeded(1)} />)
    const dock = pos()
    rerender(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(pos()).toEqual(dock) // no jump
    advance(A_WHILE)
    expect(pos()).not.toEqual(dock)
  })

  it('on a narrow screen it docks in the gutter the panel leaves (the panel is 5.5rem short of the full width)', () => {
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    try {
      const { rerender } = render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
      rerender(<GuideLauncher open onToggle={vi.fn()} rng={seeded(1)} />)
      // The panel is 302 px wide (390 - 88), so the gutter is the left 88 px: Qubi sits at 390 - 302 - 72 - 10 = 6.
      expect(pos().x).toBe(6)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original })
    }
  })
})

describe('resizing', () => {
  it('a smaller window pulls Qubi back inside it', async () => {
    vi.useRealTimers() // the refit waits for an animation frame
    const original = { w: window.innerWidth, h: window.innerHeight }
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
      window.dispatchEvent(new Event('resize'))
      await new Promise((r) => setTimeout(r, 80))
      const { x, y } = pos()
      expect(x + SIZE.w).toBeLessThanOrEqual(300)
      expect(y + SIZE.h).toBeLessThanOrEqual(400)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.w })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: original.h })
    }
  })
})

describe('reduced motion', () => {
  it('Qubi is stationary: placed once, in the viewport, and never moves however much time passes', () => {
    installMatchMedia(true)
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)

    expect(launcher()).toHaveAttribute('data-motion', 'reduced')
    expect(launcher()).toHaveAttribute('data-state', 'still')
    const spot = pos()
    expect(spot.x).toBeGreaterThanOrEqual(REGION.minX)
    expect(spot.x).toBeLessThanOrEqual(REGION.maxX)
    expect(spot.y).toBeGreaterThanOrEqual(REGION.minY)
    expect(spot.y).toBeLessThanOrEqual(REGION.maxY)
    advance(A_WHILE * 3)
    expect(pos()).toEqual(spot)
  })

  it('has no idle bob and no transition (no animation of any kind)', () => {
    installMatchMedia(true)
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(launcher().querySelector('.qentor-guide-bob')).toBeNull()
    expect(launcher().style.transitionDuration).toBe('0ms')
  })

  it('shows no pause control (there is nothing to pause)', () => {
    installMatchMedia(true)
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(screen.queryByRole('button', { name: /Qubi’s movement/ })).not.toBeInTheDocument()
  })

  const rectAt = (x: number, y: number, w: number, h: number) => () =>
    ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, toJSON: () => ({}) }) as DOMRect

  it('stays where it is when a later layout change puts nothing under it', async () => {
    installMatchMedia(true)
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    advance(1_000)
    const spot = pos()
    const away = document.createElement('button')
    away.getBoundingClientRect = rectAt(spot.x + 400, spot.y + 300, 80, 30) // a control well clear of Qubi
    await act(async () => {
      document.body.appendChild(away)
    })
    advance(5_000)
    expect(pos()).toEqual(spot)
    away.remove()
  })

  it('is placed anew, with no animation, only when a later layout change puts a control under it', async () => {
    installMatchMedia(true)
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    advance(1_000)
    const spot = pos()
    const under = document.createElement('button')
    under.getBoundingClientRect = rectAt(spot.x, spot.y, SIZE.w, SIZE.h) // exactly where Qubi stands
    await act(async () => {
      document.body.appendChild(under)
    })
    advance(5_000)
    expect(pos()).not.toEqual(spot)
    expect(launcher().style.transitionDuration).toBe('0ms')
    expect(launcher()).toHaveAttribute('data-state', 'still')
    under.remove()
  })

  it('the tutor is still fully usable: Qubi is visible, focusable and clickable', () => {
    installMatchMedia(true)
    const onToggle = vi.fn()
    const { rerender } = render(<GuideLauncher open={false} onToggle={onToggle} rng={seeded(1)} />)

    expect(qubi()).toBeVisible()
    act(() => qubi().focus())
    expect(qubi()).toHaveFocus()
    fireEvent.click(qubi())
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(screen.getByText('AI Tutor')).toBeVisible()

    rerender(<GuideLauncher open onToggle={onToggle} rng={seeded(1)} />)
    expect(screen.getByRole('button', { name: 'Close Qubi AI Tutor' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('reacts to the preference changing while the app is open', () => {
    const media = installMatchMedia(false)
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(launcher()).toHaveAttribute('data-motion', 'allowed')
    expect(pauseButton()).toBeInTheDocument()

    media.setReduced(true)
    expect(launcher()).toHaveAttribute('data-motion', 'reduced')
    expect(launcher()).toHaveAttribute('data-state', 'still')
    const spot = pos()
    advance(A_WHILE)
    expect(pos()).toEqual(spot)

    media.setReduced(false)
    expect(launcher()).toHaveAttribute('data-motion', 'allowed')
    expect(launcher()).toHaveAttribute('data-state', 'roaming')
  })

  it('treats a browser with no matchMedia as "motion allowed" (no crash)', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(launcher()).toHaveAttribute('data-motion', 'allowed')
  })
})

describe('the "Need help?" bubble', () => {
  it('appears once, after a delay — not at first paint', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()

    advance(BUBBLE_DELAY_MS - 1)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()
    advance(1)
    expect(screen.getByTestId('guide-bubble')).toHaveTextContent('Need help?')
  })

  it('disappears on its own after a few seconds — it never lingers', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    advance(BUBBLE_DELAY_MS)
    advance(BUBBLE_VISIBLE_MS)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()
  })

  it('never comes back this session — not after time, and not on a fresh mount', () => {
    const first = render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    advance(BUBBLE_DELAY_MS + BUBBLE_VISIBLE_MS)
    advance(A_WHILE)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()

    first.unmount()
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    advance(BUBBLE_DELAY_MS * 3)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()
  })

  it('is not shown if the panel is already open, and is hidden the moment it opens', () => {
    const { rerender } = render(<GuideLauncher open onToggle={vi.fn()} rng={seeded(1)} />)
    advance(BUBBLE_DELAY_MS * 2)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()

    resetGuideBubbleForTests()
    rerender(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    advance(BUBBLE_DELAY_MS)
    expect(screen.getByTestId('guide-bubble')).toBeInTheDocument()
    rerender(<GuideLauncher open onToggle={vi.fn()} rng={seeded(1)} />)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()
  })

  it('is decorative text: hidden from assistive tech, never a claim or a tutor answer, and it can never block a click', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} rng={seeded(1)} />)
    advance(BUBBLE_DELAY_MS)
    const bubble = screen.getByTestId('guide-bubble')
    expect(bubble).toHaveAttribute('aria-hidden', 'true')
    expect(bubble.textContent).toBe('Need help?') // fixed, deterministic UI copy
    expect(bubble).toHaveClass('pointer-events-none')
    expect(bubble.className).toContain('max-md:hidden') // not on a phone
  })
})
