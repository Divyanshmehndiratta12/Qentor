/**
 * Deterministic OpenQASM 3 emitter — must stay byte-identical to
 * `backend/qentor/circuit/qasm.py::to_qasm3`. This is the client half of the
 * "server emitter is authoritative, web emitter must match it" rule in
 * CLAUDE.md. It exists only so the code editor can render QASM instantly on
 * every canvas edit without a network round trip; the server's own emission
 * (via `/api/execute`'s circuit_hash) remains the source of truth.
 *
 * `fixtures/circuits/` holds the golden circuits, QASM text and hashes that
 * BOTH test suites check (`qasmEmitter.test.ts` here, `test_golden_fixtures.py`
 * on the server), so a drift between the two emitters fails a test.
 */
import type { Circuit, GateOp } from './types'

const SIMPLE_GATE_QASM: Record<string, string> = {
  h: 'h',
  x: 'x',
  y: 'y',
  z: 'z',
  s: 's',
  sdg: 'sdg',
  t: 't',
  tdg: 'tdg',
}

const ROTATION_GATE_QASM: Record<string, string> = {
  rx: 'rx',
  ry: 'ry',
  rz: 'rz',
}

/**
 * Mirrors CPython's `repr(float)` exactly: the shortest digit string that round-trips to the same
 * double, laid out the way Python lays it out. The digits agree with JS's, but the layout does not:
 *
 * - an integral value keeps a `.0` (`1.0`, not `1`);
 * - Python switches to an exponent below 1e-4 and from 1e16 (`1e-05`, `1e+16`), JavaScript at 1e-7 and
 *   1e21 (`0.00001`, `10000000000000000`), and pads the exponent to two digits (`1e-07`, `1e-7`);
 * - negative zero prints as `-0.0`.
 *
 * This text is hashed (the circuit hash is SHA-256 of the QASM), so a difference here is a different hash
 * for the same circuit. `fixtures/circuits/angle_formatting.json` pins the awkward cases.
 */
export function formatAngle(theta: number): string {
  if (!Number.isFinite(theta)) throw new Error(`cannot emit a non-finite angle: ${theta}`)
  if (theta === 0) return Object.is(theta, -0) ? '-0.0' : '0.0'
  const sign = theta < 0 ? '-' : ''
  // toExponential() with no argument yields exactly the shortest round-tripping digits.
  const [mantissa, exponentText] = Math.abs(theta).toExponential().split('e')
  const digits = mantissa.replace('.', '')
  const decpt = Number(exponentText) + 1 // value = 0.DIGITS x 10^decpt, as in CPython's dtoa
  if (decpt <= -4 || decpt > 16) {
    const exponent = decpt - 1
    const body = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    const magnitude = Math.abs(exponent)
    return `${sign}${body}e${exponent < 0 ? '-' : '+'}${magnitude < 10 ? '0' : ''}${magnitude}`
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`
}

function emitOp(op: GateOp): string {
  if (op.gate in SIMPLE_GATE_QASM) {
    return `${SIMPLE_GATE_QASM[op.gate]} q[${op.targets[0]}];`
  }
  if (op.gate in ROTATION_GATE_QASM) {
    return `${ROTATION_GATE_QASM[op.gate]}(${formatAngle(op.params[0])}) q[${op.targets[0]}];`
  }
  if (op.gate === 'cx' || op.gate === 'cz') {
    return `${op.gate} q[${op.controls[0]}], q[${op.targets[0]}];`
  }
  if (op.gate === 'cp') {
    return `cp(${formatAngle(op.params[0])}) q[${op.controls[0]}], q[${op.targets[0]}];`
  }
  if (op.gate === 'swap') {
    return `swap q[${op.targets[0]}], q[${op.targets[1]}];`
  }
  if (op.gate === 'ccx') {
    return `ccx q[${op.controls[0]}], q[${op.controls[1]}], q[${op.targets[0]}];`
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
