/**
 * The keyboard controls of a focused sphere: which key does what. A pure table, so it can be tested without a browser; `SphereGrid`
 * calls the matching `SphereController` method. Arrow keys turn the sphere (one fixed step each), + and − zoom, 0 or Home reset.
 */
import type { SphereController } from './types'

export type SphereKeyAction =
  | { kind: 'rotate'; dx: -1 | 0 | 1; dy: -1 | 0 | 1 }
  | { kind: 'zoom'; direction: -1 | 1 }
  | { kind: 'reset' }

const KEYS: Record<string, SphereKeyAction> = {
  ArrowLeft: { kind: 'rotate', dx: -1, dy: 0 },
  ArrowRight: { kind: 'rotate', dx: 1, dy: 0 },
  ArrowUp: { kind: 'rotate', dx: 0, dy: -1 },
  ArrowDown: { kind: 'rotate', dx: 0, dy: 1 },
  '+': { kind: 'zoom', direction: -1 },
  '=': { kind: 'zoom', direction: -1 }, // + without Shift on most keyboards
  '-': { kind: 'zoom', direction: 1 },
  '0': { kind: 'reset' },
  Home: { kind: 'reset' },
}

/** What a key press does to a focused sphere, or `null` for a key this view does not use (it is then left alone). */
export function sphereKeyAction(key: string): SphereKeyAction | null {
  return KEYS[key] ?? null
}

export function applySphereKey(controller: SphereController, action: SphereKeyAction): void {
  if (action.kind === 'rotate') controller.rotate(action.dx, action.dy)
  else if (action.kind === 'zoom') controller.zoom(action.direction)
  else controller.reset()
}
