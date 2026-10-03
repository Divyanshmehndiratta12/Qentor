/**
 * Qubi's movement rules, exactly: the safe region at each screen size, the choice of a next spot (inside the region, off
 * controls, off the pointer, a real move), and the move/rest timings. Pure functions, a seeded random source.
 */
import { describe, expect, it } from 'vitest'
import {
  CANDIDATES,
  EDGE_MARGIN,
  PHONE_BAND_HEIGHT,
  POINTER_CLEARANCE,
  clampToRegion,
  coverCost,
  planDock,
  planRest,
  planTarget,
  regionFor,
  restMs,
  travelMs,
  type Obstacle,
} from './qubiMotion'

const SIZE = { w: 72, h: 90 }
const TOP = 52

/** A small deterministic generator (mulberry32), so every run picks the same spots. */
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

const box = (x: number, y: number, w: number, h: number, weight = 1): Obstacle => ({ box: { x, y, w, h }, weight })

describe('the safe region', () => {
  it('desktop: the whole usable viewport, inside the margins and below the top bar', () => {
    const r = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    expect(r.tier).toBe('desktop')
    expect(r.minX).toBe(EDGE_MARGIN)
    expect(r.maxX).toBe(1440 - SIZE.w - EDGE_MARGIN)
    expect(r.minY).toBe(TOP + EDGE_MARGIN)
    expect(r.maxY).toBe(900 - SIZE.h - EDGE_MARGIN)
  })

  it('tablet: a smaller inset area than the desktop would give', () => {
    const tablet = regionFor({ w: 900, h: 1000 }, TOP, SIZE)
    const wide = regionFor({ w: 1100, h: 1000 }, TOP, SIZE)
    expect(tablet.tier).toBe('tablet')
    expect(tablet.minX).toBeGreaterThan(EDGE_MARGIN)
    expect(tablet.maxX).toBeLessThan(900 - SIZE.w - EDGE_MARGIN)
    expect(tablet.minY).toBeGreaterThan(TOP + EDGE_MARGIN)
    expect(tablet.maxY).toBeLessThan(1000 - SIZE.h - EDGE_MARGIN)
    expect(wide.tier).toBe('desktop')
  })

  it('phone: a thin band along the bottom edge, with short horizontal steps', () => {
    const r = regionFor({ w: 390, h: 844 }, TOP, SIZE)
    expect(r.tier).toBe('phone')
    expect(r.maxY - r.minY).toBeLessThanOrEqual(PHONE_BAND_HEIGHT)
    expect(r.maxY).toBe(844 - SIZE.h - EDGE_MARGIN)
    expect(r.maxStepX).toBeLessThan(390)
  })

  it('tier boundaries: 639 is a phone, 640 a tablet, 1023 a tablet, 1024 a desktop', () => {
    expect(regionFor({ w: 639, h: 800 }, TOP, SIZE).tier).toBe('phone')
    expect(regionFor({ w: 640, h: 800 }, TOP, SIZE).tier).toBe('tablet')
    expect(regionFor({ w: 1023, h: 800 }, TOP, SIZE).tier).toBe('tablet')
    expect(regionFor({ w: 1024, h: 800 }, TOP, SIZE).tier).toBe('desktop')
  })

  it('a viewport too small for Qubi still gives a valid, non-inverted region', () => {
    const r = regionFor({ w: 60, h: 100 }, TOP, SIZE)
    expect(r.maxX).toBeGreaterThanOrEqual(r.minX)
    expect(r.maxY).toBeGreaterThanOrEqual(r.minY)
  })

  it('clamping puts any point inside the region', () => {
    const r = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    for (const p of [{ x: -50, y: -50 }, { x: 9999, y: 9999 }, { x: 300, y: 9999 }]) {
      const c = clampToRegion(p, r)
      expect(c.x).toBeGreaterThanOrEqual(r.minX)
      expect(c.x).toBeLessThanOrEqual(r.maxX)
      expect(c.y).toBeGreaterThanOrEqual(r.minY)
      expect(c.y).toBeLessThanOrEqual(r.maxY)
    }
  })
})

describe('choosing the next spot', () => {
  it('is always inside the safe region, at every screen size, for many seeds', () => {
    for (const viewport of [{ w: 1440, h: 900 }, { w: 900, h: 1000 }, { w: 390, h: 844 }, { w: 320, h: 568 }]) {
      const region = regionFor(viewport, TOP, SIZE)
      let from = { x: region.minX, y: region.minY }
      const rng = seeded(7)
      for (let i = 0; i < 200; i++) {
        const p = planTarget({ region, size: SIZE, from, obstacles: [], pointer: null, rng })
        expect(p.x).toBeGreaterThanOrEqual(region.minX)
        expect(p.x).toBeLessThanOrEqual(region.maxX)
        expect(p.y).toBeGreaterThanOrEqual(region.minY)
        expect(p.y).toBeLessThanOrEqual(region.maxY)
        from = p
      }
    }
  })

  it('is a real move: with free space it travels at least a quarter of the region, not a fidget', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    const minTravel = Math.max(region.maxX - region.minX, region.maxY - region.minY) * 0.25
    const rng = seeded(3)
    let from = { x: 600, y: 400 }
    for (let i = 0; i < 100; i++) {
      const p = planTarget({ region, size: SIZE, from, obstacles: [], pointer: null, rng })
      expect(Math.hypot(p.x - from.x, p.y - from.y)).toBeGreaterThanOrEqual(minTravel * 0.999)
      from = p
    }
  })

  it('covers no control when there is free space: it picks around a wall of buttons', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    // Everything but a clear half on the right is full of controls.
    const obstacles = [box(0, TOP, 700, 900 - TOP)]
    const rng = seeded(11)
    let from = { x: 1300, y: 300 }
    for (let i = 0; i < 100; i++) {
      const p = planTarget({ region, size: SIZE, from, obstacles, pointer: null, rng })
      expect(coverCost(p, SIZE, obstacles, null)).toBe(0)
      from = p
    }
  })

  it('steers well clear of a primary action: it is counted many times over', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    const primary = box(100, 700, 300, 60, 30)
    const filler = box(0, TOP, 1440, 40) // an ordinary, cheap obstacle everywhere along the top
    const rng = seeded(5)
    for (let i = 0; i < 100; i++) {
      const p = planTarget({ region, size: SIZE, from: { x: 700, y: 400 }, obstacles: [primary, filler], pointer: null, rng })
      expect(coverCost(p, SIZE, [primary], null)).toBe(0)
    }
  })

  it('keeps away from the pointer', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    const pointer = { x: 700, y: 400 }
    const rng = seeded(9)
    for (let i = 0; i < 100; i++) {
      const p = planTarget({ region, size: SIZE, from: { x: 200, y: 200 }, obstacles: [], pointer, rng })
      expect(Math.hypot(p.x + SIZE.w / 2 - pointer.x, p.y + SIZE.h / 2 - pointer.y)).toBeGreaterThanOrEqual(POINTER_CLEARANCE)
    }
  })

  it('a phone move is a short step along the band, never across the whole width', () => {
    const region = regionFor({ w: 390, h: 844 }, TOP, SIZE)
    const rng = seeded(2)
    let from = { x: region.minX, y: region.maxY }
    for (let i = 0; i < 100; i++) {
      const p = planTarget({ region, size: SIZE, from, obstacles: [], pointer: null, rng })
      expect(Math.abs(p.x - from.x)).toBeLessThanOrEqual(region.maxStepX + 1)
      from = p
    }
  })

  it('in a screen with no free space it still picks the least bad spot, not a random one', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    // Cheap everywhere except a primary action on the left half: the least bad spots are on the right.
    const obstacles = [box(0, TOP, 1440, 900 - TOP, 1), box(0, TOP, 700, 900 - TOP, 30)]
    const rng = seeded(4)
    for (let i = 0; i < 50; i++) {
      const p = planTarget({ region, size: SIZE, from: { x: 100, y: 300 }, obstacles, pointer: null, rng })
      expect(p.x).toBeGreaterThan(700 - SIZE.w - 12)
    }
  })

  it('examines a fixed number of candidates (cheap enough to run on every move)', () => {
    let calls = 0
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    planTarget({ region, size: SIZE, from: { x: 0, y: 0 }, obstacles: [], pointer: null, rng: () => (calls++, 0.5) })
    expect(calls).toBe(CANDIDATES * 3) // x, y and the tie-break per candidate
  })
})

describe('a calm resting spot', () => {
  it('is inside the region and off the controls when it can be', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    const obstacles = [box(0, TOP, 700, 900 - TOP)]
    const p = planRest({ region, size: SIZE, obstacles, pointer: null })
    expect(p.x).toBeGreaterThanOrEqual(region.minX)
    expect(p.x).toBeLessThanOrEqual(region.maxX)
    expect(coverCost(p, SIZE, obstacles, null)).toBe(0)
  })

  it('prefers the lower-left among equally free spots (away from the results and the Ask button)', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    const p = planRest({ region, size: SIZE, obstacles: [], pointer: null })
    expect(p).toEqual({ x: region.minX, y: region.maxY })
  })
})

describe('timing', () => {
  it('a move is slow and steady: about 45 px a second, never under 4 s and never over 12 s', () => {
    expect(travelMs({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4_000)
    expect(travelMs({ x: 0, y: 0 }, { x: 450, y: 0 })).toBe(10_000)
    expect(travelMs({ x: 0, y: 0 }, { x: 5_000, y: 0 })).toBe(12_000)
  })

  it('rests a few seconds, and now and then much longer', () => {
    const rng = seeded(1)
    const rests = Array.from({ length: 400 }, () => restMs(rng))
    expect(Math.min(...rests)).toBeGreaterThanOrEqual(2_800)
    expect(Math.max(...rests)).toBeLessThanOrEqual(12_000)
    const long = rests.filter((r) => r > 6_000).length
    expect(long).toBeGreaterThan(40) // about a quarter pause for a long while
    expect(long).toBeLessThan(160)
  })
})

describe('docking beside the tutor panel', () => {
  it('waits in the given column, at the height that covers the least', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    // A primary action sits at the top of the dock column, ordinary controls elsewhere.
    const obstacles = [box(500, 60, 300, 50, 30), box(500, 400, 300, 40)]
    const p = planDock({ region, size: SIZE, x: 540, fromY: 70, obstacles })
    expect(p.x).toBe(540)
    expect(coverCost(p, SIZE, obstacles, null)).toBe(0)
  })

  it('stays near where Qubi was among equally free heights, and inside the region', () => {
    const region = regionFor({ w: 1440, h: 900 }, TOP, SIZE)
    const p = planDock({ region, size: SIZE, x: 600, fromY: 500, obstacles: [] })
    expect(p.y).toBeGreaterThanOrEqual(region.minY)
    expect(p.y).toBeLessThanOrEqual(region.maxY)
    expect(Math.abs(p.y - 500)).toBeLessThanOrEqual((region.maxY - region.minY) / 10)
  })
})
