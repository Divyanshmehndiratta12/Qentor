/**
 * Display formatting for the trace viewer — and nothing but formatting.
 *
 * TRUST RULE: the browser never calculates a quantum value. Every function
 * here takes a number the backend returned (or a canonical gate the learner
 * built) and produces a STRING. There is deliberately no magnitude,
 * probability, phase, normalisation or any other arithmetic on an amplitude
 * in this file: the sign of a component is read from its formatted text, not
 * from `Math.abs`, and a basis label is the amplitude's INDEX written in
 * binary, not anything derived from its value. `TraceViewer.test.tsx` scans
 * this file's source for the calculation primitives that would break this.
 */
import type { GateOp } from '@/circuit/types'
import { GATE_DISPLAY } from '@/circuit/gateSpec'

/** The one statevector-index convention the backend states (and this file
 * knows how to label): index k is the bitstring q[n-1]...q[0] read as binary.
 * If a response's `basisOrdering` doesn't say so, the viewer falls back to
 * raw indices rather than guess a labelling. */
export const KNOWN_BASIS_ORDERING_MARKER = 'q[n-1]...q[0]'

export function isKnownBasisOrdering(basisOrdering: string): boolean {
  return basisOrdering.includes(KNOWN_BASIS_ORDERING_MARKER)
}

/**
 * Learner-facing numbering. The trace's own indices (`stepIndex`,
 * `operationIndex`) are ZERO-based — they are positions in arrays the backend
 * returned, and everything internal keeps using them — but a person reads
 * "Step 1 of 4", not "Step 0 of 3". These two functions are the only place the
 * conversion happens, so a label can never disagree with another one. They return STRINGS (a label,
 * like every other formatter here), never a number to compute with.
 */
export function displayStepNumber(stepIndex: number): string {
  return String(stepIndex + 1)
}

/** As `displayStepNumber`, for a position in the learner's own circuit. */
export function displayOperationNumber(operationIndex: number): string {
  return String(operationIndex + 1)
}

/** `|01⟩` for index 1 of a 2-qubit register — the index in binary, padded to
 * the register width. Formatting an index, not deriving a quantum number. */
export function basisLabel(index: number, numQubits: number): string {
  return `|${index.toString(2).padStart(numQubits, '0')}⟩`
}

const DECIMALS = 3

/** One component to 3 decimals, with a typographic minus, and no "−0.000":
 * a value that rounds to zero displays as plain 0.000. */
export function formatComponent(value: number): string {
  const text = value.toFixed(DECIMALS)
  if (/^-0\.0+$/.test(text)) return text.slice(1)
  return text.startsWith('-') ? `−${text.slice(1)}` : text
}

/** `0.707 + 0.000i` / `−0.707 − 0.500i`, from the backend's [re, im]. */
export function formatAmplitude(amplitude: readonly [number, number]): string {
  const re = formatComponent(amplitude[0])
  const im = formatComponent(amplitude[1])
  const imNegative = im.startsWith('−')
  return `${re} ${imNegative ? '−' : '+'} ${imNegative ? im.slice(1) : im}i`
}

/** True when both components DISPLAY as zero — used only to dim such rows.
 * A comparison of display strings, not a statement about the state. */
export function displaysAsZero(amplitude: readonly [number, number]): boolean {
  return /^0\.0+$/.test(formatComponent(amplitude[0])) && /^0\.0+$/.test(formatComponent(amplitude[1]))
}

/** Compact label for a timeline chip: `H q0`, `CX q0→q1`, `CCX q0,q1→q2`, `SWAP q0↔q1`, `S† q0`. */
export function shortOperationLabel(op: GateOp): string {
  const gate = GATE_DISPLAY[op.gate]
  if (op.gate === 'cx' || op.gate === 'cz') return `${gate} q${op.controls[0]}→q${op.targets[0]}`
  if (op.gate === 'ccx') return `${gate} q${op.controls[0]},q${op.controls[1]}→q${op.targets[0]}`
  if (op.gate === 'swap') return `${gate} q${op.targets[0]}↔q${op.targets[1]}`
  return `${gate} q${op.targets[0]}`
}

/** Full sentence for the selected step. The rotation angle is the learner's
 * own circuit parameter (not a quantum result), shown to 3 decimals. */
export function describeOperation(op: GateOp): string {
  const gate = GATE_DISPLAY[op.gate]
  switch (op.gate) {
    case 'cx':
    case 'cz':
      return `${gate} — control q${op.controls[0]}, target q${op.targets[0]}`
    case 'ccx':
      return `${gate} — controls q${op.controls[0]}, q${op.controls[1]}, target q${op.targets[0]}`
    case 'swap':
      return `${gate} — q${op.targets[0]} and q${op.targets[1]}`
    case 'measure':
      return `Measure q${op.targets[0]} → c${op.clbits[0]}`
    case 'rx':
    case 'ry':
    case 'rz':
      return `${gate}(${(op.params[0] ?? 0).toFixed(DECIMALS)} rad) on q${op.targets[0]}`
    default:
      return `${gate} on q${op.targets[0]}`
  }
}
