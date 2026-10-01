/**
 * The pure circuit edits (`edit.ts`): insert, delete, move in time, move across wires, with multi-qubit gates and every kind of
 * invalid placement. Plus the property that matters most for a canonical model: an edit that is undone (or made and reversed)
 * gives back a circuit with the SAME canonical QASM and the SAME hash, checked against the golden fixtures the server shares.
 */
import { describe, expect, it } from 'vitest'
import { deleteOp, insertOp, moveOp, moveOpToWire, relocateOp, sameCircuit, shiftOpWires, validateOp, wiresOf } from './edit'
import { toQasm3 } from './qasmEmitter'
import { parseQasm3 } from './qasmParser'
import { CircuitSchema, emptyCircuit, type Circuit, type GateOp } from './types'

const op = (gate: GateOp['gate'], targets: number[], controls: number[] = [], params: number[] = [], clbits: number[] = []): GateOp => ({
  gate,
  targets,
  controls,
  params,
  clbits,
})
const H = (q: number) => op('h', [q])
const X = (q: number) => op('x', [q])
const CX = (c: number, t: number) => op('cx', [t], [c])
const circuit = (n: number, ops: GateOp[], clbits = n): Circuit => ({ ...emptyCircuit(n, clbits), ops })
const gates = (c: Circuit) => c.ops.map((o) => o.gate + (o.controls.length ? `${o.controls.join('')}>` : '') + o.targets.join(''))
const ok = (r: ReturnType<typeof insertOp>) => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { ok: true; circuit: Circuit }).circuit
}
const refused = (r: ReturnType<typeof insertOp>) => {
  expect(r.ok).toBe(false)
  return (r as { ok: false; error: string }).error
}

describe('insertOp', () => {
  const base = circuit(2, [H(0), X(1)])

  it('puts the gate at the start, the middle and the end', () => {
    expect(gates(ok(insertOp(base, 0, CX(0, 1))))).toEqual(['cx01>', 'h0', 'x1'].map((s) => (s === 'cx01>' ? 'cx0>1' : s)))
    expect(gates(ok(insertOp(base, 1, op('z', [0]))))).toEqual(['h0', 'z0', 'x1'])
    expect(gates(ok(insertOp(base, 2, op('z', [0]))))).toEqual(['h0', 'x1', 'z0'])
  })

  it('never changes the circuit it was given', () => {
    const before = JSON.stringify(base)
    insertOp(base, 1, op('z', [0]))
    deleteOp(base, 0)
    moveOp(base, 0, 1)
    shiftOpWires(base, 0, 1)
    expect(JSON.stringify(base)).toBe(before)
  })

  it('refuses a position that does not exist, with the circuit untouched', () => {
    for (const index of [-1, 3, 1.5, Number.NaN]) {
      expect(refused(insertOp(base, index, H(0)))).toMatch(/no position/)
    }
  })

  it('refuses a gate the server would refuse: wrong arity, a wire or classical bit that does not exist', () => {
    expect(refused(insertOp(base, 0, op('h', [0, 1])))).toMatch(/exactly 1 target/)
    expect(refused(insertOp(base, 0, op('cx', [1], [1])))).toMatch(/must differ/)
    expect(refused(insertOp(base, 0, op('ccx', [2], [0, 1])))).toMatch(/q\[2\] does not exist/)
    expect(refused(insertOp(base, 0, H(2)))).toMatch(/q\[2\] does not exist: the circuit has 2 qubits/)
    expect(refused(insertOp(base, 0, H(-1)))).toMatch(/does not exist/)
    expect(refused(insertOp(base, 0, op('measure', [0], [], [], [5])))).toMatch(/c\[5\] does not exist/)
    expect(refused(insertOp(circuit(1, [], 0), 0, op('measure', [0], [], [], [0])))).toMatch(/0 classical bits/)
    expect(refused(insertOp(base, 0, op('rx', [0])))).toMatch(/exactly 1 parameter/)
    expect(refused(insertOp(base, 0, op('swap', [0, 0])))).toMatch(/two different qubits/)
  })

  it('inserts multi-qubit gates and keeps every wire', () => {
    const wide = circuit(3, [H(0)])
    const result = ok(insertOp(wide, 1, op('ccx', [2], [0, 1])))
    expect(result.ops[1]).toMatchObject({ gate: 'ccx', controls: [0, 1], targets: [2] })
    expect(ok(insertOp(wide, 0, op('swap', [0, 2]))).ops[0]!.targets).toEqual([0, 2])
    expect(ok(insertOp(wide, 1, op('cp', [1], [0], [0.5]))).ops[1]!.params).toEqual([0.5])
  })

  it('inserting into an empty circuit works', () => {
    expect(gates(ok(insertOp(emptyCircuit(1), 0, H(0))))).toEqual(['h0'])
  })
})

describe('deleteOp', () => {
  const base = circuit(2, [H(0), CX(0, 1), X(1)])

  it('removes the gate at that position and only that one', () => {
    expect(gates(ok(deleteOp(base, 0)))).toEqual(['cx0>1', 'x1'])
    expect(gates(ok(deleteOp(base, 1)))).toEqual(['h0', 'x1'])
    expect(gates(ok(deleteOp(base, 2)))).toEqual(['h0', 'cx0>1'])
  })

  it('refuses a position that does not exist', () => {
    for (const index of [-1, 3, 0.5]) expect(refused(deleteOp(base, index))).toMatch(/no operation/)
    expect(refused(deleteOp(emptyCircuit(1), 0))).toMatch(/no operation 0/)
  })

  it('deleting the only gate leaves a valid empty circuit', () => {
    expect(ok(deleteOp(circuit(1, [H(0)]), 0)).ops).toEqual([])
  })
})

describe('moveOp (in time)', () => {
  const base = circuit(2, [H(0), CX(0, 1), X(1), op('z', [0])])

  it('moves a gate earlier and later; `to` is the gate\'s new position', () => {
    expect(gates(ok(moveOp(base, 3, 0)))).toEqual(['z0', 'h0', 'cx0>1', 'x1'])
    expect(gates(ok(moveOp(base, 0, 3)))).toEqual(['cx0>1', 'x1', 'z0', 'h0'])
    expect(gates(ok(moveOp(base, 1, 2)))).toEqual(['h0', 'x1', 'cx0>1', 'z0'])
    expect(gates(ok(moveOp(base, 2, 1)))).toEqual(['h0', 'x1', 'cx0>1', 'z0'])
  })

  it('moving a gate to where it is changes nothing (the same circuit object)', () => {
    expect(ok(moveOp(base, 2, 2))).toBe(base)
  })

  it('keeps the other gates in their order and the circuit the same size', () => {
    for (let from = 0; from < 4; from++) {
      for (let to = 0; to < 4; to++) {
        const result = ok(moveOp(base, from, to))
        expect(result.ops).toHaveLength(4)
        const rest = (c: Circuit) => c.ops.filter((_, i) => i !== (c === result ? to : from)).map((o) => JSON.stringify(o))
        expect(rest(result)).toEqual(rest(base))
      }
    }
  })

  it('refuses positions outside the circuit', () => {
    expect(refused(moveOp(base, 4, 0))).toMatch(/no operation 4/)
    expect(refused(moveOp(base, 0, 4))).toMatch(/positions run from 0 to 3/)
    expect(refused(moveOp(base, 0, -1))).toMatch(/positions run from 0 to 3/)
  })

  it('a multi-qubit gate moves as a whole and keeps its controls and targets', () => {
    const moved = ok(moveOp(circuit(3, [H(0), op('ccx', [2], [0, 1]), X(2)]), 1, 0))
    expect(moved.ops[0]).toMatchObject({ gate: 'ccx', controls: [0, 1], targets: [2] })
  })
})

describe('shiftOpWires (across wires)', () => {
  it('moves a single-qubit gate up and down', () => {
    const base = circuit(3, [H(1)])
    expect(ok(shiftOpWires(base, 0, 1)).ops[0]!.targets).toEqual([2])
    expect(ok(shiftOpWires(base, 0, -1)).ops[0]!.targets).toEqual([0])
    expect(ok(shiftOpWires(base, 0, 0))).toBe(base)
  })

  it('moves a CX as a whole, keeping the distance between control and target', () => {
    const base = circuit(4, [CX(0, 2)])
    expect(ok(shiftOpWires(base, 0, 1)).ops[0]).toMatchObject({ controls: [1], targets: [3] })
    expect(refused(shiftOpWires(base, 0, 2))).toMatch(/last qubit, q\[3\]/)
    expect(refused(shiftOpWires(base, 0, -1))).toMatch(/already on q\[0\]/)
  })

  it('moves a Toffoli, a swap and a controlled phase as wholes', () => {
    expect(ok(shiftOpWires(circuit(4, [op('ccx', [2], [0, 1])]), 0, 1)).ops[0]).toMatchObject({ controls: [1, 2], targets: [3] })
    expect(ok(shiftOpWires(circuit(3, [op('swap', [0, 1])]), 0, 1)).ops[0]!.targets).toEqual([1, 2])
    expect(ok(shiftOpWires(circuit(3, [op('cp', [1], [0], [0.25])]), 0, 1)).ops[0]).toMatchObject({ controls: [1], targets: [2], params: [0.25] })
  })

  it('a measurement moves to another qubit and keeps its classical bit', () => {
    const base = circuit(3, [op('measure', [0], [], [], [2])])
    expect(ok(shiftOpWires(base, 0, 1)).ops[0]).toMatchObject({ targets: [1], clbits: [2] })
  })

  it('refuses a move that would leave the register, and leaves the gate where it was', () => {
    const base = circuit(2, [H(0), H(1)])
    expect(refused(shiftOpWires(base, 0, -1))).toMatch(/already on q\[0\]/)
    expect(refused(shiftOpWires(base, 1, 1))).toMatch(/last qubit/)
    expect(refused(shiftOpWires(base, 5, 1))).toMatch(/no operation 5/)
  })

  it('moveOpToWire drops a single-wire gate on a row, and refuses a gate on several wires', () => {
    const base = circuit(3, [H(0), CX(0, 1)])
    expect(ok(moveOpToWire(base, 0, 2)).ops[0]!.targets).toEqual([2])
    expect(refused(moveOpToWire(base, 1, 2))).toMatch(/several wires/)
    expect(refused(moveOpToWire(base, 0, 3))).toMatch(/last qubit|does not exist/)
  })

  it('relocateOp is one edit: position and (for a single-wire gate) wire together', () => {
    const base = circuit(3, [H(0), X(1), op('z', [2])])
    const result = ok(relocateOp(base, 0, 2, 1))
    expect(gates(result)).toEqual(['x1', 'z2', 'h1'])
    expect(gates(ok(relocateOp(circuit(3, [CX(0, 1), H(2)]), 0, 1, 2)))).toEqual(['h2', 'cx0>1']) // a CX is only moved in time
    expect(relocateOp(base, 0, 9, 1).ok).toBe(false)
  })
})

describe('validateOp and wiresOf', () => {
  it('names the wires an operation touches, controls first, with no repeats', () => {
    expect(wiresOf(op('ccx', [3], [0, 1]))).toEqual([0, 1, 3])
    expect(wiresOf(op('swap', [2, 1]))).toEqual([2, 1])
    expect(wiresOf(H(0))).toEqual([0])
  })

  it('accepts what the server accepts', () => {
    expect(validateOp({ num_qubits: 3, num_clbits: 3 }, op('measure', [2], [], [], [0]))).toBeNull()
    expect(validateOp({ num_qubits: 3, num_clbits: 0 }, op('ccx', [2], [0, 1]))).toBeNull()
  })
})

describe('sameCircuit', () => {
  it('compares canonical content, not object identity', () => {
    const a = circuit(2, [H(0), CX(0, 1)])
    expect(sameCircuit(a, JSON.parse(JSON.stringify(a)))).toBe(true)
    expect(sameCircuit(a, circuit(2, [H(0), CX(1, 0)]))).toBe(false)
    expect(sameCircuit(a, circuit(3, [H(0), CX(0, 1)]))).toBe(false)
    expect(sameCircuit(a, circuit(2, [H(0)]))).toBe(false)
    expect(sameCircuit(circuit(1, [op('rx', [0], [], [0.5])]), circuit(1, [op('rx', [0], [], [0.50001])]))).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------- golden fixtures

const RAW = import.meta.glob('../../../fixtures/circuits/*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
interface Fixture {
  name: string
  circuit: Circuit
  qasm: string
  hash: string
}
const FIXTURES: Fixture[] = Object.entries(RAW)
  .filter(([path]) => !/\/_/.test(path))
  .map(([, text]) => JSON.parse(text) as Fixture)

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('editing and undoing gives back the canonical text and hash the server shares (golden fixtures)', () => {
  it('has the fixtures', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15)
  })

  it('delete each gate then insert it back where it was: same QASM, same hash', async () => {
    for (const fixture of FIXTURES) {
      const original = CircuitSchema.parse(fixture.circuit)
      for (let i = 0; i < original.ops.length; i++) {
        const removed = ok(deleteOp(original, i))
        expect(removed.ops.length).toBe(original.ops.length - 1)
        const restored = ok(insertOp(removed, i, original.ops[i]!))
        expect(toQasm3(restored), `${fixture.name} op ${i}`).toBe(fixture.qasm)
        expect(await sha256(toQasm3(restored))).toBe(fixture.hash)
      }
    }
  })

  it('move each gate away and back: same QASM, same hash', async () => {
    for (const fixture of FIXTURES) {
      const original = CircuitSchema.parse(fixture.circuit)
      const last = original.ops.length - 1
      for (let from = 0; from <= last; from++) {
        const away = ok(moveOp(original, from, last))
        const back = ok(moveOp(away, last, from))
        expect(toQasm3(back), `${fixture.name} op ${from}`).toBe(fixture.qasm)
        expect(await sha256(toQasm3(back))).toBe(fixture.hash)
      }
    }
  })

  it('shift a single-wire gate down and back up: same QASM, same hash', async () => {
    for (const fixture of FIXTURES) {
      const original = CircuitSchema.parse(fixture.circuit)
      original.ops.forEach((_, i) => {
        const down = shiftOpWires(original, i, 1)
        if (!down.ok) return // already on the last wire: refused, which is itself tested above
        expect(toQasm3(ok(shiftOpWires(down.circuit, i, -1))), `${fixture.name} op ${i}`).toBe(fixture.qasm)
      })
      expect(await sha256(fixture.qasm)).toBe(fixture.hash)
    }
  })

  it('every edited circuit is still a circuit the QASM parser reads back exactly (the two views cannot drift)', () => {
    for (const fixture of FIXTURES) {
      const original = CircuitSchema.parse(fixture.circuit)
      const edited = original.ops.length > 1 ? ok(moveOp(original, 0, original.ops.length - 1)) : original
      expect(parseQasm3(toQasm3(edited))).toEqual(edited)
    }
  })
})
