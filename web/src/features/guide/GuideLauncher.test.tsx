/**
 * The Guide's launcher: the character as a button, its roaming schedule, the
 * one-time "Need help?" bubble, and reduced-motion behaviour. Time is faked
 * (only timers), so the roaming/bubble schedule is asserted exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BUBBLE_DELAY_MS, BUBBLE_VISIBLE_MS, GuideLauncher, resetGuideBubbleForTests } from './GuideLauncher'
import { REST_ANCHOR, ROAM_ANCHORS, ROAM_INTERVAL_MS } from './useRoaming'

const launcher = () => screen.getByTestId('guide-launcher')
const guideX = () => launcher().style.getPropertyValue('--guide-x')
const button = () => screen.getByRole('button', { name: /Qentor Guide/ })

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** A controllable `matchMedia` for the reduced-motion query. */
function installMatchMedia(reduce: boolean) {
  const listeners = new Set<() => void>()
  const state = { reduced: reduce }
  // One LIVE MediaQueryList (like a real browser's): `matches` is read on
  // demand, so a "change" event followed by a re-read sees the new value.
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

describe('the character', () => {
  it('renders as a real <button> with the accessible name "Open Qentor Guide"', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)

    const b = screen.getByRole('button', { name: 'Open Qentor Guide' })
    expect(b.tagName).toBe('BUTTON')
    expect(b).toHaveAttribute('type', 'button')
    expect(b).toHaveAttribute('aria-expanded', 'false')
    expect(b).toHaveAttribute('aria-controls', 'qentor-guide-panel')
    expect(b).not.toHaveAttribute('tabindex', '-1')
  })

  it('draws an original inline SVG — decorative, with no image file or external URL', () => {
    const { container } = render(<GuideLauncher open={false} onToggle={vi.fn()} />)

    const svg = screen.getByTestId('guide-character')
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true') // the button carries the name
    expect(container.querySelector('img, image, foreignObject')).toBeNull()
    expect(container.innerHTML).not.toMatch(/https?:\/\//i)
    expect(container.innerHTML).not.toMatch(/href=|xlink:href/i)
  })

  it('stays recognisable when small: the same shapes at 24px', () => {
    const { container } = render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64') // scales by viewBox, not by re-drawing
    expect(svg.querySelectorAll('circle').length).toBeGreaterThanOrEqual(6) // body, eyes, electron, spark
  })

  it('toggles: clicking calls onToggle, and the name/aria-expanded follow the open state', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<GuideLauncher open={false} onToggle={onToggle} />)

    fireEvent.click(button())
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(<GuideLauncher open onToggle={onToggle} />)
    expect(screen.getByRole('button', { name: 'Close Qentor Guide' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('is keyboard operable and takes focus (Enter/Space activate a native button)', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    act(() => button().focus())
    expect(button()).toHaveFocus()
    expect(button().className).toContain('focus-visible:outline-2') // visible focus ring
  })

  it('exposes its element to the caller for focus restoration', () => {
    const ref = { current: null as HTMLButtonElement | null }
    render(<GuideLauncher open={false} onToggle={vi.fn()} buttonRef={ref} />)
    expect(ref.current).toBe(button())
  })
})

describe('roaming', () => {
  it('starts at the first anchor, inside the strip', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    expect(guideX()).toBe(`${ROAM_ANCHORS[0]}%`)
  })

  it('moves on a fixed, slow schedule — one step per interval, through the anchor list in order', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)

    advance(ROAM_INTERVAL_MS - 1)
    expect(guideX()).toBe(`${ROAM_ANCHORS[0]}%`) // still resting: it pauses between moves
    advance(1)
    expect(guideX()).toBe(`${ROAM_ANCHORS[1]}%`)
    advance(ROAM_INTERVAL_MS)
    expect(guideX()).toBe(`${ROAM_ANCHORS[2]}%`)
  })

  it('wraps around and never leaves the strip (every position is a percentage inside 0–100)', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)

    for (let i = 0; i < ROAM_ANCHORS.length * 2 + 1; i++) {
      const percent = parseFloat(guideX())
      expect(percent).toBeGreaterThanOrEqual(0)
      expect(percent).toBeLessThanOrEqual(100)
      advance(ROAM_INTERVAL_MS)
    }
    expect(guideX()).toBe(`${ROAM_ANCHORS[(ROAM_ANCHORS.length * 2 + 1) % ROAM_ANCHORS.length]}%`)
  })

  it('is deterministic: no randomness — two runs visit the same positions', () => {
    const run = () => {
      const visited: string[] = []
      const view = render(<GuideLauncher open={false} onToggle={vi.fn()} />)
      for (let i = 0; i < 4; i++) {
        visited.push(guideX())
        advance(ROAM_INTERVAL_MS)
      }
      view.unmount()
      return visited
    }
    expect(run()).toEqual(run())
  })

  it('every anchor is a modest drift, never a jump across the whole strip', () => {
    const jumps = ROAM_ANCHORS.map((a, i) => Math.abs(a - ROAM_ANCHORS[(i + 1) % ROAM_ANCHORS.length]!))
    expect(Math.max(...jumps)).toBeLessThanOrEqual(56)
    expect(Math.min(...ROAM_ANCHORS)).toBeGreaterThanOrEqual(15)
    expect(Math.max(...ROAM_ANCHORS)).toBeLessThanOrEqual(85)
  })

  it('has the slow-slide class while roaming', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    expect(launcher()).toHaveClass('qentor-guide-roam')
    expect(launcher().querySelector('.qentor-guide-bob')).not.toBeNull()
  })

  it('stops while the learner hovers the character, and resumes when they leave', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)

    fireEvent.pointerEnter(button())
    advance(ROAM_INTERVAL_MS * 3)
    expect(guideX()).toBe(`${ROAM_ANCHORS[0]}%`) // never a moving target under the pointer

    fireEvent.pointerLeave(button())
    advance(ROAM_INTERVAL_MS)
    expect(guideX()).toBe(`${ROAM_ANCHORS[1]}%`)
  })

  it('stops while the character has keyboard focus, and resumes on blur', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)

    fireEvent.focus(button())
    advance(ROAM_INTERVAL_MS * 2)
    expect(guideX()).toBe(`${ROAM_ANCHORS[0]}%`)

    fireEvent.blur(button())
    advance(ROAM_INTERVAL_MS)
    expect(guideX()).toBe(`${ROAM_ANCHORS[1]}%`)
  })

  it('settles at the resting anchor and stays put while the panel is open', () => {
    const { rerender } = render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    advance(ROAM_INTERVAL_MS)

    rerender(<GuideLauncher open onToggle={vi.fn()} />)
    expect(guideX()).toBe(`${REST_ANCHOR}%`)
    advance(ROAM_INTERVAL_MS * 4)
    expect(guideX()).toBe(`${REST_ANCHOR}%`)
    expect(launcher().querySelector('.qentor-guide-bob')).toBeNull()
  })

  it('does not advance while the tab is hidden', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      advance(ROAM_INTERVAL_MS * 3)
      expect(guideX()).toBe(`${ROAM_ANCHORS[0]}%`)
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    }
    advance(ROAM_INTERVAL_MS)
    expect(guideX()).toBe(`${ROAM_ANCHORS[1]}%`)
  })

  it('clicking always works — at every roaming position, and mid-schedule', () => {
    const onToggle = vi.fn()
    render(<GuideLauncher open={false} onToggle={onToggle} />)

    for (let i = 0; i < ROAM_ANCHORS.length; i++) {
      fireEvent.click(button())
      advance(ROAM_INTERVAL_MS / 2) // a click landing in the middle of a slide
    }
    expect(onToggle).toHaveBeenCalledTimes(ROAM_ANCHORS.length)
  })

  it('never sits over the page: it is positioned inside its strip (absolute) with a fixed corner fallback on small screens only', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    const cls = launcher().className
    expect(cls).toContain('absolute')
    expect(cls).toContain('max-md:fixed') // <768px: parked bottom-right, no roaming space needed
    expect(cls).toContain('max-md:[transform:none]')
    expect(cls).toContain('max-md:bottom-4')
  })
})

describe('reduced motion', () => {
  it('disables roaming entirely: parked at the resting anchor however much time passes', () => {
    installMatchMedia(true)
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)

    expect(launcher()).toHaveAttribute('data-motion', 'reduced')
    expect(guideX()).toBe(`${REST_ANCHOR}%`)
    advance(ROAM_INTERVAL_MS * 10)
    expect(guideX()).toBe(`${REST_ANCHOR}%`)
  })

  it('drops the slide transition and the idle bob classes', () => {
    installMatchMedia(true)
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)

    expect(launcher()).not.toHaveClass('qentor-guide-roam')
    expect(launcher().querySelector('.qentor-guide-bob')).toBeNull()
  })

  it('the guide stays visible, focusable and clickable', () => {
    installMatchMedia(true)
    const onToggle = vi.fn()
    render(<GuideLauncher open={false} onToggle={onToggle} />)

    expect(button()).toBeVisible()
    act(() => button().focus())
    expect(button()).toHaveFocus()
    fireEvent.click(button())
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Open Qentor Guide' })).toBeInTheDocument()
  })

  it('reacts to the preference changing while the app is open', () => {
    const media = installMatchMedia(false)
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    expect(launcher()).toHaveAttribute('data-motion', 'allowed')
    advance(ROAM_INTERVAL_MS)
    expect(guideX()).toBe(`${ROAM_ANCHORS[1]}%`)

    media.setReduced(true)
    expect(launcher()).toHaveAttribute('data-motion', 'reduced')
    expect(guideX()).toBe(`${REST_ANCHOR}%`)

    media.setReduced(false)
    expect(launcher()).toHaveAttribute('data-motion', 'allowed')
  })

  it('treats a browser with no matchMedia as "motion allowed" (no crash)', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    expect(launcher()).toHaveAttribute('data-motion', 'allowed')
  })
})

describe('the "Need help?" bubble', () => {
  it('appears once, after a delay — not at first paint', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()

    advance(BUBBLE_DELAY_MS - 1)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()
    advance(1)
    expect(screen.getByTestId('guide-bubble')).toHaveTextContent('Need help?')
  })

  it('disappears on its own after a few seconds — it never lingers', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    advance(BUBBLE_DELAY_MS)
    advance(BUBBLE_VISIBLE_MS)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()
  })

  it('never comes back this session — not after time, and not on a fresh mount', () => {
    const first = render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    advance(BUBBLE_DELAY_MS + BUBBLE_VISIBLE_MS)
    advance(ROAM_INTERVAL_MS * 20)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()

    first.unmount()
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    advance(BUBBLE_DELAY_MS * 3)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()
  })

  it('is not shown if the panel is already open, and is hidden the moment it opens', () => {
    const { rerender } = render(<GuideLauncher open onToggle={vi.fn()} />)
    advance(BUBBLE_DELAY_MS * 2)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()

    resetGuideBubbleForTests()
    rerender(<GuideLauncher open={false} onToggle={vi.fn()} />)
    advance(BUBBLE_DELAY_MS)
    expect(screen.getByTestId('guide-bubble')).toBeInTheDocument()
    rerender(<GuideLauncher open onToggle={vi.fn()} />)
    expect(screen.queryByTestId('guide-bubble')).not.toBeInTheDocument()
  })

  it('is decorative text: hidden from assistive tech, never a claim or a tutor answer', () => {
    render(<GuideLauncher open={false} onToggle={vi.fn()} />)
    advance(BUBBLE_DELAY_MS)
    const bubble = screen.getByTestId('guide-bubble')
    expect(bubble).toHaveAttribute('aria-hidden', 'true')
    expect(bubble.textContent).toBe('Need help?') // fixed, deterministic UI copy
    expect(bubble).toHaveClass('pointer-events-none') // can never block a click
  })
})
