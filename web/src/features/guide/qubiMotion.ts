/**
 * Qubi's movement rules, as pure functions (no DOM, no React, no timers): where Qubi may go, which spot it
 * picks next, and how long a move and a rest last. `useQubiRoaming` supplies the measurements and applies the
 * result; everything that decides *where* lives here so it can be tested exactly.
 *
 * Safe region. Qubi is `position: fixed`, so its box is kept inside the visible viewport with a margin on every
 * side and below the top bar (the bar holds Run and the navigation: Qubi never roams over it). The region
 * shrinks with the screen: the whole usable viewport on a desktop, an inset area on a tablet, and on a phone a
 * thin band along the bottom edge, so a small screen's content is never the stage.
 *
 * Choosing a spot. Qubi cannot know which control matters, so it measures: every visible interactive element
 * (buttons, links, inputs, tabs, summaries) and the code editor's text area is an obstacle, and elements marked
 * `data-qubi-avoid` (the tutor's input, the welcome actions) count many times more. Of a handful of random
 * candidate spots it takes the one that covers the least obstacle area, keeps clear of the pointer, and is a
 * real move away from where it is (broad, not fidgeting). In a screen with no free space it still picks the
 * least bad spot, never a random one.
 */

export interface Size {
  w: number
  h: number
}
export interface Point {
  x: number
  y: number
}
export interface Box extends Point, Size {}
export interface Obstacle {
  box: Box
  /** How much a covered pixel of this obstacle costs: 1 for a control, more for a primary one, less for text. */
  weight: number
}
export interface Region {
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** The largest horizontal step in one move (a phone's band is narrow, so its moves are short). */
  maxStepX: number
  tier: 'desktop' | 'tablet' | 'phone'
}

export const EDGE_MARGIN = 12
export const PHONE_MAX_WIDTH = 639
export const TABLET_MAX_WIDTH = 1023
/** The height of the band Qubi may use on a phone, above the bottom margin. */
export const PHONE_BAND_HEIGHT = 56
/** Candidate spots examined per move. */
export const CANDIDATES = 60
/** Keep this far from the pointer when picking a spot. */
export const POINTER_CLEARANCE = 120
/** Padding around an obstacle: a spot that merely touches a control still counts as covering it. */
export const OBSTACLE_PAD = 6

export function regionFor(viewport: Size, topInset: number, size: Size): Region {
  const { w: vw, h: vh } = viewport
  let minX = EDGE_MARGIN
  let maxX = vw - size.w - EDGE_MARGIN
  let minY = topInset + EDGE_MARGIN
  let maxY = vh - size.h - EDGE_MARGIN
  let tier: Region['tier'] = 'desktop'
  let maxStepX = Infinity

  if (vw <= PHONE_MAX_WIDTH) {
    tier = 'phone'
    minY = Math.max(minY, maxY - PHONE_BAND_HEIGHT)
    maxStepX = Math.round(vw * 0.45)
  } else if (vw <= TABLET_MAX_WIDTH) {
    tier = 'tablet'
    const insetX = Math.round(vw * 0.12)
    const insetY = Math.round(vh * 0.08)
    minX = Math.max(minX, insetX)
    maxX = Math.min(maxX, vw - size.w - insetX)
    minY = Math.max(minY, topInset + insetY)
    maxY = Math.min(maxY, vh - size.h - insetY)
  }
  // A viewport too small to fit Qubi still gets a valid (degenerate) region rather than an inverted one.
  if (maxX < minX) maxX = minX
  if (maxY < minY) maxY = minY
  return { minX, maxX, minY, maxY, maxStepX, tier }
}

export function clampToRegion(p: Point, region: Region): Point {
  return {
    x: Math.min(region.maxX, Math.max(region.minX, p.x)),
    y: Math.min(region.maxY, Math.max(region.minY, p.y)),
  }
}

function overlapArea(a: Box, b: Box, pad: number): number {
  const w = Math.min(a.x + a.w, b.x + b.w + pad) - Math.max(a.x, b.x - pad)
  const h = Math.min(a.y + a.h, b.y + b.h + pad) - Math.max(a.y, b.y - pad)
  return w > 0 && h > 0 ? w * h : 0
}

/** The cost of standing at `p`: the weighted obstacle area it would cover, plus a large charge for sitting on the pointer. */
export function coverCost(p: Point, size: Size, obstacles: readonly Obstacle[], pointer: Point | null): number {
  const me: Box = { ...p, ...size }
  let cost = 0
  for (const o of obstacles) cost += overlapArea(me, o.box, OBSTACLE_PAD) * o.weight
  if (pointer) {
    const dx = p.x + size.w / 2 - pointer.x
    const dy = p.y + size.h / 2 - pointer.y
    if (Math.hypot(dx, dy) < POINTER_CLEARANCE) cost += 5_000
  }
  return cost
}

export interface PlanInput {
  region: Region
  size: Size
  from: Point
  obstacles: readonly Obstacle[]
  pointer: Point | null
  rng: () => number
}

/** The next spot: the cheapest of `CANDIDATES` random spots in the region, each at least a real move from `from`. */
export function planTarget({ region, size, from, obstacles, pointer, rng }: PlanInput): Point {
  const spanX = region.maxX - region.minX
  const spanY = region.maxY - region.minY
  const minTravel = Math.max(spanX, spanY) * 0.25
  let best: { p: Point; score: number } | null = null
  for (let i = 0; i < CANDIDATES; i++) {
    let x = region.minX + rng() * spanX
    const y = region.minY + rng() * spanY
    if (Number.isFinite(region.maxStepX)) x = Math.min(from.x + region.maxStepX, Math.max(from.x - region.maxStepX, x))
    const p = clampToRegion({ x, y }, region)
    const travel = Math.hypot(p.x - from.x, p.y - from.y)
    // Covering a control always costs more than a short move: a 300 px shortfall is worth about one small button.
    const score = coverCost(p, size, obstacles, pointer) + Math.max(0, minTravel - travel) * 2 + rng()
    if (!best || score < best.score) best = { p, score }
  }
  return { x: Math.round(best!.p.x), y: Math.round(best!.p.y) }
}

/** A calm resting spot (used when motion is reduced, and as the first placement): the cheapest spot on a coarse grid of the region. */
export function planRest({ region, size, obstacles, pointer }: Omit<PlanInput, 'from' | 'rng'>): Point {
  const steps = 6
  let best: { p: Point; score: number } | null = null
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const p = { x: region.minX + ((region.maxX - region.minX) * i) / steps, y: region.minY + ((region.maxY - region.minY) * j) / steps }
      // Prefer the lower-left of the region among equally free spots: away from the results and the tutor's Ask button.
      const score = coverCost(p, size, obstacles, pointer) - (steps - i) * 0.01 - j * 0.001
      if (!best || score < best.score) best = { p, score }
    }
  }
  return { x: Math.round(best!.p.x), y: Math.round(best!.p.y) }
}

/**
 * Where to wait while the tutor panel is open: the given column (`x`, beside the panel), at the height that covers the least, nearest
 * to where Qubi is. A fixed column means only the height is free to choose.
 */
export function planDock({ region, size, x, fromY, obstacles }: { region: Region; size: Size; x: number; fromY: number; obstacles: readonly Obstacle[] }): Point {
  const steps = 10
  let best: { y: number; score: number } | null = null
  for (let j = 0; j <= steps; j++) {
    const y = region.minY + ((region.maxY - region.minY) * j) / steps
    const score = coverCost({ x, y }, size, obstacles, null) + Math.abs(y - fromY) * 0.001
    if (!best || score < best.score) best = { y, score }
  }
  return { x, y: Math.round(best!.y) }
}

/** How long a move takes: slow and steady (about 45 px a second), never snappy and never endless. */
export function travelMs(from: Point, to: Point): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  return Math.round(Math.min(12_000, Math.max(4_000, distance / 0.045)))
}

/** How long Qubi rests between moves. Usually a few seconds; now and then a long, natural pause. */
export function restMs(rng: () => number): number {
  const base = 2_800 + rng() * 3_200
  return Math.round(rng() < 0.25 ? base + 6_000 : base)
}
