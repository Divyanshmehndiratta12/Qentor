/**
 * Deterministic OpenQASM 3 emitter — must stay byte-identical to
 * `backend/qentor/circuit/qasm.py::to_qasm3`. This is the client half of the
 * "server emitter is authoritative, web emitter must match it" rule in
 * CLAUDE.md. It exists only so the code editor can render QASM instantly on
 * every canvas edit without a network round trip; the server's own emission
 * (via `/api/execute`'s circuit_hash) remains the source of truth.
 *
 * No `fixtures/circuits/` golden-fixture directory exists in this repo yet
 * (see docs/ARCHITECTURE.md §2). When it's added, a test here must load the
 * same fixtures the Python test suite uses and assert byte-for-byte equality.
 */
import type { Circuit, GateOp } from './types'

const SIMPLE_GATE_QASM: Record<string, string> = {
  h: 'h',
  x: 'x',
  y: 'y',
  z: 'z',
  s: 's',
  t: 't',
}

const ROTATION_GATE_QASM: Record<string, string> = {
  rx: 'rx',
  ry: 'ry',
  rz: 'rz',
}

/**
 * Mirrors CPython's `repr(float)`: the shortest decimal string that round-trips
 * back to the same IEEE-754 double. JS's `Number.prototype.toString()` already
 * produces the shortest round-tripping representation, so the two only differ
 * in integral floats, where Python prints a trailing `.0` and JS does not.
 */
function formatAngle(theta: number): string {
  if (Number.isInteger(theta) && Number.isFinite(theta)) {
    return `${theta}.0`
  }
  return String(theta)
}

function emitOp(op: GateOp): string {
  if (op.gate in SIMPLE_GATE_QASM) {
    return `${SIMPLE_GATE_QASM[op.gate]} q[${op.targets[0]}];`
  }
  if (op.gate in ROTATION_GATE_QASM) {
    return `${ROTATION_GATE_QASM[op.gate]}(${formatAngle(op.params[0])}) q[${op.targets[0]}];`
  }
  if (op.gate === 'cx') {
    return `cx q[${op.controls[0]}], q[${op.targets[0]}];`
  }
  if (op.gate === 'measure') {
    return `c[${op.clbits[0]}] = measure q[${op.targets[0]}];`
  }
  throw new Error(`unsupported gate for QASM emission: ${op.gate}`)
}

export function toQasm3(circuit: Circuit): string {
  const lines: string[] = [
    'OPENQASM 3.0;',
    'include "stdgates.inc";',
    `qubit[${circuit.num_qubits}] q;`,
  ]
  if (circuit.num_clbits > 0) {
    lines.push(`bit[${circuit.num_clbits}] c;`)
  }
  for (const op of circuit.ops) {
    lines.push(emitOp(op))
  }
  return lines.join('\n') + '\n'
}
