/**
 * How each gate is shown and placed — presentation and input flow only. Nothing here is a quantum
 * quantity: it names gates for a learner and says how many wires a click sequence must pick and in
 * which roles. The arity rules themselves live in `types.ts::gateArityError` (mirroring the server's
 * model); the server remains the authority.
 */
import type { GateName, GateOp } from './types'

/** The label a learner sees for each gate (S† and T† are the dagger gates, `sdg` and `tdg` on the wire). */
export const GATE_DISPLAY: Record<GateName, string> = {
  h: 'H',
  x: 'X',
  y: 'Y',
  z: 'Z',
  s: 'S',
  sdg: 'S†',
  t: 'T',
  tdg: 'T†',
  rx: 'RX',
  ry: 'RY',
  rz: 'RZ',
  cx: 'CX',
  cz: 'CZ',
  cp: 'CP',
  swap: 'SWAP',
  ccx: 'CCX',
  measure: 'M',
}

/** Gates that carry one angle in radians: the three rotations, and the phase of a controlled phase. */
export const ANGLE_GATES: readonly GateName[] = ['rx', 'ry', 'rz', 'cp']

export function gateTakesAngle(gate: GateName | null | undefined): boolean {
  return !!gate && ANGLE_GATES.includes(gate)
}

/** What a gate looks like on the qubit it acts ON (a controlled gate shows the operation, its controls show a dot). */
export const TARGET_SYMBOL: Partial<Record<GateName, string>> = {
  cx: 'X',
  cz: 'Z',
  cp: 'P',
  ccx: 'X',
  swap: '×',
}

export type OperandRole = 'control' | 'target'

/**
 * Gates that need more than one wire, as the roles of the wires a learner clicks, in order. Every other
 * gate is placed with a single click.
 */
export const MULTI_QUBIT_PLACEMENT: Partial<Record<GateName, readonly OperandRole[]>> = {
  cx: ['control', 'target'],
  cz: ['control', 'target'],
  cp: ['control', 'target'],
  ccx: ['control', 'control', 'target'],
  swap: ['target', 'target'],
}

export function isMultiQubitGate(gate: GateName): boolean {
  return gate in MULTI_QUBIT_PLACEMENT
}

/** Name of the wire being picked: "control", "second control", "target", "first qubit"… */
export function placementRoleLabel(gate: GateName, index: number): string {
  const roles = MULTI_QUBIT_PLACEMENT[gate] ?? []
  if (gate === 'swap') return index === 0 ? 'first qubit' : 'second qubit'
  const role = roles[index] ?? 'target'
  const sameRole = roles.filter((r) => r === role).length
  if (sameRole > 1) return `${index === roles.indexOf(role) ? 'first' : 'second'} ${role}`
  return role
}

/** The hint under the canvas while a multi-wire gate is half placed. */
export function placementPrompt(gate: GateName, picked: readonly number[]): string {
  const chosen = picked.map((q, i) => `${placementRoleLabel(gate, i)} = q${q}`).join(', ')
  const label = placementRoleLabel(gate, picked.length)
  const next = `click a wire to set the ${label.endsWith('qubit') ? label : `${label} qubit`}`
  return chosen ? `${chosen} · ${next}` : next
}

/**
 * The finished operation for a fully picked multi-wire gate. `angle` is the learner's chosen angle in
 * radians; it is kept only by a gate that takes one (cp), so every other gate stays parameter-free.
 */
export function buildMultiQubitOp(gate: GateName, picked: readonly number[], angle?: number): GateOp {
  const roles = MULTI_QUBIT_PLACEMENT[gate] ?? []
  return {
    gate,
    controls: picked.filter((_, i) => roles[i] === 'control'),
    targets: picked.filter((_, i) => roles[i] === 'target'),
    params: gateTakesAngle(gate) && angle !== undefined ? [angle] : [],
    clbits: [],
  }
}
