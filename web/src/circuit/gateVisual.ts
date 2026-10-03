/**
 * How each gate LOOKS in the editor — presentation only, like `gateSpec.ts` beside it. Which family a gate belongs to, what it is
 * called in full, and the classes that colour its tile. Nothing here is a quantum quantity and nothing is computed from a circuit:
 * it maps a gate name (which the learner chose) to a style.
 *
 * Colour is never the only signal: every family also has its own shape or glyph (a round target and a control dot for a controlled
 * gate, a × pair for a swap, a meter mark for a measurement), and every tile carries its letters.
 */
import type { GateName } from './types'

export type GateFamily = 'hadamard' | 'pauli' | 'phase' | 'rotation' | 'controlled' | 'swap' | 'measure'

const FAMILY: Record<GateName, GateFamily> = {
  h: 'hadamard',
  x: 'pauli',
  y: 'pauli',
  z: 'pauli',
  s: 'phase',
  sdg: 'phase',
  t: 'phase',
  tdg: 'phase',
  rx: 'rotation',
  ry: 'rotation',
  rz: 'rotation',
  cx: 'controlled',
  cz: 'controlled',
  cp: 'controlled',
  ccx: 'controlled',
  swap: 'swap',
  measure: 'measure',
}

export function gateFamily(gate: GateName): GateFamily {
  return FAMILY[gate]
}

/** What a learner calls each gate, in full (the tooltip and the selected-gate details). */
export const GATE_NAME: Record<GateName, string> = {
  h: 'Hadamard',
  x: 'Pauli-X (bit flip)',
  y: 'Pauli-Y',
  z: 'Pauli-Z (phase flip)',
  s: 'S (quarter-turn phase)',
  sdg: 'S-dagger (undoes S)',
  t: 'T (eighth-turn phase)',
  tdg: 'T-dagger (undoes T)',
  rx: 'Rotation about X',
  ry: 'Rotation about Y',
  rz: 'Rotation about Z',
  cx: 'Controlled-X (CNOT)',
  cz: 'Controlled-Z',
  cp: 'Controlled-phase',
  ccx: 'Toffoli (CCX)',
  swap: 'Swap',
  measure: 'Measurement',
}

export const FAMILY_LABEL: Record<GateFamily, string> = {
  hadamard: 'Hadamard',
  pauli: 'Pauli',
  phase: 'Phase',
  rotation: 'Rotation',
  controlled: 'Controlled',
  swap: 'Swap',
  measure: 'Measurement',
}

/** Tile colours of a gate on the canvas, by family (idle state; a selected gate overrides these). */
export const FAMILY_TILE: Record<GateFamily, string> = {
  hadamard: 'border-cyan-glow/60 bg-cyan-dim text-cyan-glow hover:border-cyan-glow',
  pauli: 'border-slate-400/50 bg-void-500 text-slate-100 hover:border-slate-200',
  phase: 'border-violet-glow/50 bg-violet-dim text-violet-glow hover:border-violet-glow',
  rotation: 'border-amber-glow/50 bg-amber-dim text-amber-glow hover:border-amber-glow',
  controlled: 'border-violet-glow/60 bg-violet-dim text-violet-glow hover:border-violet-glow',
  swap: 'border-cyan-glow/60 bg-cyan-dim text-cyan-glow hover:border-cyan-glow',
  measure: 'border-void-300 bg-void-700 text-slate-200 hover:border-slate-300',
}

/** Letter colour of a palette button, by family (the button keeps one background so a selected gate stands out). */
export const FAMILY_PALETTE_TEXT: Record<GateFamily, string> = {
  hadamard: 'text-cyan-glow',
  pauli: 'text-slate-100',
  phase: 'text-violet-glow',
  rotation: 'text-amber-glow',
  controlled: 'text-violet-glow',
  swap: 'text-cyan-glow',
  measure: 'text-slate-200',
}

/** The colour of the line that joins the wires of a multi-wire gate. */
export const FAMILY_LINE: Record<GateFamily, string> = {
  hadamard: 'bg-cyan-glow/70',
  pauli: 'bg-slate-300/70',
  phase: 'bg-violet-glow/70',
  rotation: 'bg-amber-glow/70',
  controlled: 'bg-violet-glow/80',
  swap: 'bg-cyan-glow/80',
  measure: 'bg-void-200',
}

/** The glyph shown in the empty "next gate goes here" cell while a gate is picked, for the role the next click would give the wire. */
export function ghostLabel(pickedSoFar: number, roles: readonly string[] | undefined, display: string, target: string | undefined): string {
  if (!roles) return display // a gate placed with one click: its own letters
  const role = roles[pickedSoFar] ?? 'target'
  return role === 'control' ? '●' : (target ?? display)
}
