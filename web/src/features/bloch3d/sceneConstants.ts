/**
 * Fixed constants and the one coordinate mapping of the 3D Bloch scene — PRESENTATION ONLY.
 *
 * Nothing here turns a quantum state into a Bloch vector. The backend supplies (x, y, z); this file only says where in the
 * 3D scene that point is drawn, by a fixed axis permutation (no arithmetic on the values), and where the camera starts.
 * Every number below is a written-out literal: no trigonometry, no square roots and no `Math` call, and
 * `bloch3dTrust.test.ts` scans the 3D sources for the primitives that would break that.
 *
 * Axes. The Bloch sphere is right-handed with z up. three.js is right-handed with y up, so
 *     Bloch (x, y, z)  ->  scene (X, Y, Z) = (x, z, -y)
 * a proper rotation: Bloch z is the scene's up axis, and Bloch +y points away from a viewer who sees +x to the right.
 *
 * Camera. The start view looks at the sphere from Bloch azimuth 30 degrees and about 20 degrees of elevation, the same view the
 * flat projection (`features/build/blochProjection.ts`) uses, so the two drawings agree: +x toward the viewer and to the left,
 * +y to the right, +z up. The position is written out below as a literal (scene coordinates, distance about 4.1).
 */

export type Triple = readonly [number, number, number]

/** Bloch -> scene axis permutation (see the module comment). The values pass through unchanged, only reordered and one negated. */
export function toScene(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y]
}

export const CAMERA_START: Triple = [3.75, 1.47, -2.15]
export const CAMERA_FOV = 36
export const MIN_DISTANCE = 3
export const MAX_DISTANCE = 9

/** Radians, as literals (a quarter turn, and one keyboard step of rotation). */
export const QUARTER_TURN = 1.5707963267948966
export const KEY_ROTATE_STEP = 0.35
export const KEY_ZOOM_IN = 0.85
export const KEY_ZOOM_OUT = 1.18

/** Where the axis tips and their labels sit, as multiples of the sphere's radius (1). */
export const AXIS_LENGTH = 1.18
export const LABEL_RADIUS = 1.3

/** Latitude guide circles at +/-30 and +/-60 degrees: their heights and radii, as literals (sin and cos of the angle). */
export const LATITUDES: ReadonlyArray<{ height: number; radius: number }> = [
  { height: 0.5, radius: 0.866 },
  { height: -0.5, radius: 0.866 },
  { height: 0.866, radius: 0.5 },
  { height: -0.866, radius: 0.5 },
]

/** Hexadecimal stand-ins for the app's design tokens (`index.css`), because three.js cannot read `oklch()`. */
export const COLORS = {
  vector: '#4cd1ee', // --color-cyan-glow: the backend's state, as everywhere else in the app
  tip: '#f0ba59', // --color-amber-glow: the state point
  shell: '#8590a0', // --color-void-200
  guide: '#3d4450', // --color-void-300
  body: '#14171c', // --color-void-800
  axis: '#8590a0',
  label: '#e2e8f0',
  labelMuted: '#94a3b8',
  halo: '#0e1014', // --color-void-950
  mixed: '#ad99fb', // --color-violet-glow: the dot shown where the backend's vector has no direction
} as const
