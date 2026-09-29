/**
 * Screen projection for the Bloch sphere drawing — PRESENTATION ONLY.
 *
 * The backend gives us a Bloch vector (x, y, z). This file only answers "where
 * on a 240x240 SVG canvas does that point go?", by a FIXED LINEAR MAP from the
 * supplied coordinates to screen coordinates. It does not turn a quantum state
 * into a Bloch vector and does not derive, correct, clamp or normalise any
 * coordinate: `projectBloch(x, y, z)` is just
 *
 *     sx = CENTER + RADIUS * (AXIS_X.sx * x + AXIS_Y.sx * y + AXIS_Z.sx * z)
 *     sy = CENTER + RADIUS * (AXIS_X.sy * x + AXIS_Y.sy * y + AXIS_Z.sy * z)
 *
 * with constants written out as literals. Only multiplication and addition of
 * the supplied numbers happens here — no square roots, no trigonometry at run
 * time, no angles, no magnitudes. (`blochTrust.test.ts` scans this file's
 * source for the calculation primitives that would break that.)
 *
 * The constants are a standard orthographic camera looking at a z-up scene from
 * azimuth 30 degrees and elevation 18 degrees (their cos/sin are written as
 * plain numbers below):
 *
 *     sx =  -sin(30) * x + cos(30) * y               =  -0.500 x + 0.866 y
 *     sy = ( cos(30) * sin(18) * x + sin(30) * sin(18) * y - cos(18) * z )
 *                                                     =   0.268 x + 0.155 y - 0.951 z
 *
 * (SVG's y axis points DOWN, so +z moves up the screen, +y to the right and +x
 * toward the viewer, down and to the left.) `facing` is the third row of the
 * same camera — how far toward the viewer a point lies — used only to dash the
 * vector when it points into the far hemisphere, so depth isn't conveyed by
 * position alone.
 */

export const VIEWBOX = 240
export const CENTER = VIEWBOX / 2
export const RADIUS = 84

export interface ScreenAxis {
  sx: number
  sy: number
}

/** Screen displacement (as a fraction of RADIUS) of one unit along each axis. */
export const AXIS_X: ScreenAxis = { sx: -0.5, sy: 0.268 }
export const AXIS_Y: ScreenAxis = { sx: 0.866, sy: 0.155 }
export const AXIS_Z: ScreenAxis = { sx: 0, sy: -0.951 }

/** Depth toward the viewer per unit of each axis (same camera, third row). */
const FACING = { x: 0.824, y: 0.476, z: 0.309 }

export interface ScreenPoint {
  sx: number
  sy: number
}

/** Where (x, y, z) lands on the canvas. `scale` only stretches the LAYOUT
 * (e.g. 1.3 places an axis label beyond the sphere); it is never applied to a
 * quantum value. */
export function projectBloch(x: number, y: number, z: number, scale = 1): ScreenPoint {
  return {
    sx: CENTER + RADIUS * scale * (AXIS_X.sx * x + AXIS_Y.sx * y + AXIS_Z.sx * z),
    sy: CENTER + RADIUS * scale * (AXIS_X.sy * x + AXIS_Y.sy * y + AXIS_Z.sy * z),
  }
}

/** > 0 when the point is on the near side of the sphere, < 0 on the far side. */
export function facing(x: number, y: number, z: number): number {
  return FACING.x * x + FACING.y * y + FACING.z * z
}

/** SVG `transform` that maps the unit circle onto the great circle spanned by
 * two axes — an affine map, so no points are computed. */
export function greatCircleTransform(u: ScreenAxis, v: ScreenAxis): string {
  return `matrix(${RADIUS * u.sx} ${RADIUS * u.sy} ${RADIUS * v.sx} ${RADIUS * v.sy} ${CENTER} ${CENTER})`
}

/**
 * A valid Bloch coordinate lies in [-1, 1]; the backend derives it from a state
 * normalised to within 1e-9, so a hair over 1 is legitimate. Anything beyond
 * this slack is a malformed response. The component then shows the numbers as
 * received and refuses to DRAW them — it never clamps or "fixes" a value.
 * (A per-coordinate bound, not a vector length: nothing is computed.)
 */
export const OUT_OF_RANGE_TOLERANCE = 1e-6

export function isDrawable(x: number, y: number, z: number): boolean {
  const limit = 1 + OUT_OF_RANGE_TOLERANCE
  return [x, y, z].every((v) => Number.isFinite(v) && v <= limit && v >= -limit)
}
