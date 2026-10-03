/**
 * Shared types of the 3D Bloch view. Every quantum number in here is the backend's, passed through untouched; nothing is
 * computed from it.
 */
import type { ReactNode } from 'react'

/** The backend's Bloch vector for one qubit, as drawn. `headScale` is the backend's own Bloch length (or 1 when none was given). */
export interface SphereVector {
  x: number
  y: number
  z: number
}

/** How a parent drives one sphere from outside the 3D scene: toolbar buttons and keyboard shortcuts. */
export interface SphereController {
  /** Back to the starting camera. */
  reset: () => void
  /** One keyboard step round the sphere: `dx` turns it about the vertical axis, `dy` tilts it. Signs only; the size is fixed. */
  rotate: (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => void
  /** `-1` zooms in one step, `1` zooms out one step. */
  zoom: (direction: -1 | 1) => void
}

/** One drawn sphere (a qubit whose backend state was usable). */
export interface SphereTile {
  /** Stable key, e.g. `q0`. */
  id: string
  vector: SphereVector
  /** The backend's Bloch length for this qubit, used only to size the arrowhead; `null` when the backend gave none. */
  headScale: number | null
  /** False when the backend returned a vector outside the unit sphere: shown as numbers, not drawn. */
  drawable: boolean
  /** The text alternative the 3D view carries (the same numbers are listed beside it). */
  label: string
  /** The card wrapped around the sphere (readouts, provenance); the sphere itself is passed in. */
  renderCard: (sphere: ReactNode) => ReactNode
}

export interface SphereGridProps {
  tiles: SphereTile[]
  /** The id of the page text that explains the mouse, touch and keyboard controls (each sphere points at it). */
  helpId: string
  autoRotate: boolean
  reducedMotion: boolean
  /** Filled by the grid with one controller per tile id (the parent calls `reset`, `rotate`, `zoom`). */
  controllers: { current: Map<string, SphereController> }
  /** Called once the first frame has been drawn. */
  onReady?: () => void
}
