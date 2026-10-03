/**
 * Which line of the canonical OpenQASM 3 text holds a given operation — so the code editor can mark the line of the gate picked on the
 * canvas (or shown in the trace). The emitter writes a fixed header and then exactly one statement per operation, in order; the
 * header's length is read from the emitter itself (an empty circuit of the same shape), not assumed, and the answer is `null` unless the
 * full text really has one line per operation after it. Presentation only: nothing here changes the circuit or its text.
 */
import { toQasm3 } from './qasmEmitter'
import type { Circuit } from './types'

const lineCount = (text: string): number => text.replace(/\n+$/, '').split('\n').length

/** The 1-based line of operation `opIndex` in `toQasm3(circuit)`, or `null` when it cannot be said for certain. */
export function qasmLineOfOp(circuit: Circuit, opIndex: number): number | null {
  if (!Number.isInteger(opIndex) || opIndex < 0 || opIndex >= circuit.ops.length) return null
  const header = lineCount(toQasm3({ ...circuit, ops: [] }))
  if (lineCount(toQasm3(circuit)) !== header + circuit.ops.length) return null
  return header + opIndex + 1
}
