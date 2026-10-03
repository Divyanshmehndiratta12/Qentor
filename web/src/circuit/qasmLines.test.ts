import { describe, expect, it } from 'vitest'
import { qasmLineOfOp } from './qasmLines'
import { toQasm3 } from './qasmEmitter'
import { emptyCircuit, type Circuit, type GateOp } from './types'

const op = (gate: GateOp['gate'], targets: number[], controls: number[] = [], params: number[] = [], clbits: number[] = []): GateOp => ({ gate, targets, controls, params, clbits })
const lineText = (circuit: Circuit, line: number) => toQasm3(circuit).split('\n')[line - 1]

describe('the line of an operation in the canonical OpenQASM text', () => {
  it('is the line that holds that operation, for every kind of gate, with and without classical bits', () => {
    for (const bits of [0, 3]) {
      const circuit: Circuit = {
        ...emptyCircuit(3, bits),
        ops: [op('h', [0]), op('cx', [1], [0]), op('rx', [2], [], [1.25]), op('cp', [2], [0], [0.5]), op('swap', [0, 1]), op('ccx', [2], [0, 1]), ...(bits ? [op('measure', [0], [], [], [0])] : [])],
      }
      const expected = bits
        ? ['h q[0];', 'cx q[0], q[1];', 'rx(1.25) q[2];', 'cp(0.5) q[0], q[2];', 'swap q[0], q[1];', 'ccx q[0], q[1], q[2];', 'c[0] = measure q[0];']
        : ['h q[0];', 'cx q[0], q[1];', 'rx(1.25) q[2];', 'cp(0.5) q[0], q[2];', 'swap q[0], q[1];', 'ccx q[0], q[1], q[2];']
      circuit.ops.forEach((_, i) => {
        const line = qasmLineOfOp(circuit, i)
        expect(line, `op ${i}, ${bits} clbits`).not.toBeNull()
        expect(lineText(circuit, line!), `op ${i}`).toBe(expected[i])
      })
    }
  })

  it('reads the header length from the emitter, so it follows the circuit (a classical register adds a line)', () => {
    const none = qasmLineOfOp({ ...emptyCircuit(2, 0), ops: [op('h', [0])] }, 0)!
    const some = qasmLineOfOp({ ...emptyCircuit(2, 2), ops: [op('h', [0])] }, 0)!
    expect(some).toBe(none + 1)
  })

  it('says nothing (null) for an operation that does not exist, rather than guessing a line', () => {
    const circuit: Circuit = { ...emptyCircuit(1, 0), ops: [op('h', [0])] }
    expect(qasmLineOfOp(circuit, -1)).toBeNull()
    expect(qasmLineOfOp(circuit, 1)).toBeNull()
    expect(qasmLineOfOp(circuit, 0.5)).toBeNull()
    expect(qasmLineOfOp(emptyCircuit(1, 0), 0)).toBeNull()
  })
})
