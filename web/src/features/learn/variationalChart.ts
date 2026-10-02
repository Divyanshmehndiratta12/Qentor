/**
 * Layout for the variational cost-curve chart. POSITIONS ONLY.
 *
 * This module maps values the server returned (an angle and a cost) to screen coordinates, and writes the axis labels for the angle range
 * the learner asked for. It computes no quantum quantity: nothing here is shown as a number, nothing is a cost, a gradient or a probability,
 * and no value is repaired, clamped or reordered. The cost axis is the fixed range of the Z observable (-1 to +1), which is a property of the
 * observable, not of any run; a value outside it is drawn where it falls and reported by the table, never moved onto the axis.
 */

export const CHART = { width: 360, height: 210, left: 44, right: 14, top: 14, bottom: 34 } as const

const plotWidth = CHART.width - CHART.left - CHART.right
const plotHeight = CHART.height - CHART.top - CHART.bottom

/** The Z observable's range, the cost axis: layout, not a result. */
export const COST_AXIS = { min: -1, max: 1 } as const

export function xFor(theta: number, thetaMin: number, thetaMax: number): number {
  const span = thetaMax - thetaMin
  return CHART.left + (span === 0 ? 0 : ((theta - thetaMin) / span) * plotWidth)
}

export function yFor(cost: number): number {
  return CHART.top + ((COST_AXIS.max - cost) / (COST_AXIS.max - COST_AXIS.min)) * plotHeight
}

export const BASELINE_Y = CHART.top + plotHeight

/** `x,y` pairs for an SVG polyline. */
export function polyline(points: readonly { theta: number; cost: number }[], thetaMin: number, thetaMax: number): string {
  return points.map((p) => `${xFor(p.theta, thetaMin, thetaMax).toFixed(2)},${yFor(p.cost).toFixed(2)}`).join(' ')
}

/** A label for an angle that is a whole number of quarter turns (halves of pi): "0", "π/2", "π", "3π/2", "2π", "-π"… */
export function quarterTurnLabel(halves: number): string {
  if (halves === 0) return '0'
  const sign = halves < 0 ? '-' : ''
  const n = Math.abs(halves)
  if (n === 1) return `${sign}π/2`
  if (n % 2 === 0) return n === 2 ? `${sign}π` : `${sign}${n / 2}π`
  return `${sign}${n}π/2`
}

/** Axis ticks at every quarter turn inside the range the learner asked for (the range is the learner's input, so these are labels of it). */
export function angleTicks(thetaMin: number, thetaMax: number): { theta: number; label: string }[] {
  const ticks: { theta: number; label: string }[] = []
  const first = Math.ceil(thetaMin / (Math.PI / 2) - 1e-9)
  const last = Math.floor(thetaMax / (Math.PI / 2) + 1e-9)
  for (let halves = first; halves <= last; halves += 1) ticks.push({ theta: (halves * Math.PI) / 2, label: quarterTurnLabel(halves) })
  return ticks
}
