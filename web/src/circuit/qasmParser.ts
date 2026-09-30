/**
 * Parser for the fixed OpenQASM 3 subset this app's own emitter produces
 * (see qasmEmitter.ts). This is what makes the code editor two-way: an edit
 * to the QASM text is parsed back into the canonical model to update the
 * canvas.
 *
 * This is NOT a general OpenQASM 3 parser. It only recognises the exact
 * statement shapes `to_qasm3` emits. Per docs/ARCHITECTURE.md §4 ("Code
 * input safety"), the server independently re-parses QASM with Qiskit's own
 * `qasm3` importer before anything is trusted — this client parser is purely
 * a UX convenience for instant sync and is never the source of truth. On any
 * line it doesn't recognise, it throws `QasmParseError` with the offending
 * line rather than guessing at the learner's intent.
 */
import type { Circuit, GateName, GateOp } from './types'
import { CircuitSchema, gateArityError } from './types'

export class QasmParseError extends Error {
  readonly line: number
  readonly text: string

  constructor(message: string, line: number, text: string) {
    super(`line ${line}: ${message}: "${text}"`)
    this.name = 'QasmParseError'
    this.line = line
    this.text = text
  }
}

const SIMPLE_GATES = new Set<GateName>(['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg'])
const ROTATION_GATES = new Set<GateName>(['rx', 'ry', 'rz'])

const RE_SIMPLE = /^([a-z]+)\s+q\[(\d+)\];$/
const RE_ROTATION = /^([a-z]+)\(([^)]+)\)\s+q\[(\d+)\];$/
// cx / cz / swap / ccx: the gate name, then its qubit operands in order
const RE_MULTI = /^(cx|cz|swap|ccx)\s+(q\[\d+\](?:\s*,\s*q\[\d+\])*);$/
const OPERAND_COUNT: Record<string, number> = { cx: 2, cz: 2, swap: 2, ccx: 3 }
const RE_MEASURE = /^c\[(\d+)\]\s*=\s*measure\s+q\[(\d+)\];$/
const RE_QUBIT_DECL = /^qubit\[(\d+)\]\s+q;$/
const RE_BIT_DECL = /^bit\[(\d+)\]\s+c;$/

export function parseQasm3(text: string): Circuit {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  let numQubits: number | null = null
  let numClbits = 0
  const ops: GateOp[] = []

  lines.forEach((line, i) => {
    const lineNo = i + 1

    if (line === 'OPENQASM 3.0;' || line === 'include "stdgates.inc";') {
      return
    }

    const qubitMatch = RE_QUBIT_DECL.exec(line)
    if (qubitMatch) {
      numQubits = Number(qubitMatch[1])
      return
    }

    const bitMatch = RE_BIT_DECL.exec(line)
    if (bitMatch) {
      numClbits = Number(bitMatch[1])
      return
    }

    const multiMatch = RE_MULTI.exec(line)
    if (multiMatch) {
      const gate = multiMatch[1] as GateName
      const operands = Array.from(multiMatch[2].matchAll(/q\[(\d+)\]/g), (m) => Number(m[1]))
      if (operands.length !== OPERAND_COUNT[gate]) {
        throw new QasmParseError(`${gate} takes ${OPERAND_COUNT[gate]} qubit operands, got ${operands.length}`, lineNo, line)
      }
      const op: GateOp =
        gate === 'swap'
          ? { gate, targets: [operands[0], operands[1]], controls: [], params: [], clbits: [] }
          : gate === 'ccx'
            ? { gate, controls: [operands[0], operands[1]], targets: [operands[2]], params: [], clbits: [] }
            : { gate, controls: [operands[0]], targets: [operands[1]], params: [], clbits: [] }
      const problem = gateArityError(op)
      if (problem) throw new QasmParseError(problem, lineNo, line)
      ops.push(op)
      return
    }

    const measureMatch = RE_MEASURE.exec(line)
    if (measureMatch) {
      ops.push({
        gate: 'measure',
        targets: [Number(measureMatch[2])],
        clbits: [Number(measureMatch[1])],
        controls: [],
        params: [],
      })
      return
    }

    const rotationMatch = RE_ROTATION.exec(line)
    if (rotationMatch) {
      const gate = rotationMatch[1]
      if (!ROTATION_GATES.has(gate as GateName)) {
        throw new QasmParseError(`unknown rotation gate "${gate}"`, lineNo, line)
      }
      const angle = Number(rotationMatch[2])
      if (Number.isNaN(angle)) {
        throw new QasmParseError(`unparsable angle "${rotationMatch[2]}"`, lineNo, line)
      }
      ops.push({
        gate: gate as GateName,
        targets: [Number(rotationMatch[3])],
        params: [angle],
        controls: [],
        clbits: [],
      })
      return
    }

    const simpleMatch = RE_SIMPLE.exec(line)
    if (simpleMatch) {
      const gate = simpleMatch[1]
      if (!SIMPLE_GATES.has(gate as GateName)) {
        throw new QasmParseError(`unknown or unsupported gate "${gate}"`, lineNo, line)
      }
      ops.push({
        gate: gate as GateName,
        targets: [Number(simpleMatch[2])],
        controls: [],
        params: [],
        clbits: [],
      })
      return
    }

    throw new QasmParseError('unrecognised statement', lineNo, line)
  })

  if (numQubits === null) {
    throw new QasmParseError('missing qubit declaration (expected "qubit[N] q;")', 1, text.split('\n')[0] ?? '')
  }

  return CircuitSchema.parse({
    schema: 'qentor.circuit/1',
    num_qubits: numQubits,
    num_clbits: numClbits,
    ops,
  })
}
