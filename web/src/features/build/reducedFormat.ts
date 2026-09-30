/**
 * Display text for the backend's per-qubit states and amplitude view — and nothing but text.
 *
 * TRUST RULE: like `traceFormat.ts`, every function here takes a value the backend returned and produces a STRING. No
 * angle is converted, wrapped or reduced, no length or purity is worked out, and nothing is compared. The numbers
 * themselves are formatted by `formatComponent` (three decimals, a typographic minus, no "−0.000").
 */
import { formatComponent } from './traceFormat'

/** A backend-supplied angle in radians as text. `null` — the backend reports none for a zero amplitude — says so
 * instead of showing a number. */
export function formatAngle(angle: number | null): string {
  return angle === null ? 'no phase' : `${formatComponent(angle)} rad`
}

/** Wording for the server's entangled-with-the-rest flag; `null` (none supplied) says it is not available. */
export function describeEntanglement(entangledWithRest: boolean | null): string {
  if (entangledWithRest === null) return 'not available'
  return entangledWithRest ? 'entangled with the rest of the register' : 'not entangled with the rest of the register'
}

/** `q[2]` — the wire a per-qubit card is about. */
export function qubitLabel(qubit: number): string {
  return `q[${qubit}]`
}
