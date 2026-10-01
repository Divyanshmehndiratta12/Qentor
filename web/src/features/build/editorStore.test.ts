/**
 * The editing actions of `useBuildStore`: insert, delete, move, undo, redo. What is checked is what has to stay true however a
 * circuit changes: the canonical circuit is the only source (the QASM text is always its canonical emission and always parses back
 * to it), everything derived from the old circuit is dropped (a result, a trace, a tutor turn, an in-flight answer), a refused
 * edit changes nothing, and undo/redo walk exactly the circuits that existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import { toQasm3 } from '@/circuit/qasmEmitter'
import { parseQasm3 } from '@/circuit/qasmParser'
import { sameCircuit } from '@/circuit/edit'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import type { ExecutePayload, ExecutionTraceResult, OptimizationResult } from '@/api'

const client = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client.current }
})

import { HISTORY_LIMIT, useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const store = () => useBuildStore.getState()

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
const circuitOf = (n: number, ops: GateOp[]): Circuit => ({ ...emptyCircuit(n, n), ops })
const names = (c: Circuit) => c.ops.map((o) => o.gate + (o.controls.length ? `${o.controls.join('')}>` : '') + o.targets.join(''))

const PROV: Provenance = {
  resultId: 'res_1',
  circuitHash: 'h1',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
}
const RESULT = () => toQuantumValue({ execution_id: 'e', statevector: [[1, 0]], theoretical_probabilities: { '0': 1 } } as unknown as ExecutePayload, PROV)
const OPTIMIZATION = { status: 'NO_OPTIMIZATION_FOUND', candidateCircuit: null } as unknown as OptimizationResult
const TRACE = { steps: [{ operationIndex: null }, { operationIndex: 0 }] } as unknown as ExecutionTraceResult

/** Put every kind of derived state on screen, as if the learner had run, traced, asked and optimised. */
function seedDerivedState() {
  useBuildStore.setState({
    result: RESULT(),
    trace: TRACE,
    selectedTraceStep: 1,
    traceError: null,
    optimization: OPTIMIZATION,
    tutorTurns: [{ role: 'learner', text: 'what happened?' }],
    isAskingTutor: true,
    verificationError: 'stale',
  })
}
const expectNothingDerivedLeft = () => {
  const s = store()
  expect(s.result).toBeNull()
  expect(s.trace).toBeNull()
  expect(s.selectedTraceStep).toBe(0)
  expect(s.optimization).toBeNull()
  expect(s.tutorTurns).toEqual([])
  expect(s.isAskingTutor).toBe(false)
  expect(s.verification).toBeNull()
  expect(s.multiInputTest).toBeNull()
}

/** The invariant: the QASM text IS the canonical emission of the circuit, and parses back to the very same circuit. */
const expectViewsAgree = (options: { canonical?: boolean } = {}) => {
  const { circuit, qasmText } = store()
  // After a canvas edit, an undo or a redo the text is the canonical emission; after the learner TYPES, the store keeps their own
  // text (so the editor is never overwritten under their cursor), which must still read back as exactly this circuit.
  if (options.canonical !== false) expect(qasmText).toBe(toQasm3(circuit))
  expect(parseQasm3(qasmText)).toEqual(circuit)
}

beforeEach(() => {
  client.current = {}
  useBuildStore.setState(INITIAL, true)
  store().loadCircuit(circuitOf(3, [H(0), CX(0, 1), X(2)]))
  useBuildStore.setState({ past: [], future: [] }) // start each test from a clean history
})
afterEach(() => {
  vi.restoreAllMocks()
  useBuildStore.setState(INITIAL, true)
})

describe('insert', () => {
  it('puts a gate in the middle, keeps the order, and updates the QASM from the circuit', () => {
    expect(store().insertOpAt(1, op('z', [0]))).toEqual({ ok: true })
    expect(names(store().circuit)).toEqual(['h0', 'z0', 'cx0>1', 'x2'])
    expectViewsAgree()
  })

  it('a gate chosen from the palette goes where the insertion point is, and the point moves on', () => {
    store().setInsertAt(1)
    store().selectGate('z')
    store().onWireClick(0)
    store().onWireClick(1) // the next one goes straight after the first
    expect(names(store().circuit)).toEqual(['h0', 'z0', 'z1', 'cx0>1', 'x2'])
    expect(store().insertAt).toBe(3)
    expectViewsAgree()
  })

  it('without an insertion point a gate is appended, as it always was', () => {
    store().selectGate('y')
    store().onWireClick(1)
    expect(names(store().circuit)).toEqual(['h0', 'cx0>1', 'x2', 'y1'])
    expect(store().insertAt).toBeNull()
  })

  it('a multi-qubit gate is inserted whole, with two or three clicks', () => {
    store().setInsertAt(0)
    store().selectGate('ccx')
    store().onWireClick(0)
    store().onWireClick(1)
    expect(names(store().circuit)).toEqual(['h0', 'cx0>1', 'x2']) // not placed yet: a third wire is needed
    store().onWireClick(2)
    expect(store().circuit.ops[0]).toMatchObject({ gate: 'ccx', controls: [0, 1], targets: [2] })
    expectViewsAgree()
  })

  it('the insertion point is clamped to the circuit and cleared by edits that make it meaningless', () => {
    store().setInsertAt(99)
    expect(store().insertAt).toBeNull() // past the end means "at the end"
    store().setInsertAt(2)
    expect(store().insertAt).toBe(2)
    store().removeOpAt(0)
    expect(store().insertAt).toBeNull()
  })
})

describe('invalid placement is refused and changes nothing', () => {
  it('a position that does not exist, a wire that does not exist, a malformed gate', () => {
    seedDerivedState()
    const before = store().circuit
    const pastBefore = store().past.length
    for (const attempt of [
      () => store().insertOpAt(9, H(0)),
      () => store().insertOpAt(0, H(7)),
      () => store().insertOpAt(0, op('cx', [1], [1])),
      () => store().insertOpAt(0, op('h', [0, 1])),
      () => store().moveOpTo(0, 9),
      () => store().moveOpTo(9, 0),
      () => store().shiftOp(0, -1), // h on q0 cannot go up
      () => store().shiftOp(2, 1), // x on q2 cannot go down
    ]) {
      const result = attempt()
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(store().circuit).toBe(before)
      expect(store().past.length).toBe(pastBefore)
      expect(store().canvasError).toBe(result.error)
      expect(store().result).not.toBeNull() // a refused edit does not invalidate anything: nothing changed
      expect(store().trace).not.toBeNull()
    }
    expect(store().canvasError).not.toBeNull()
  })

  it('the refusal says why', () => {
    expect(store().insertOpAt(0, H(7))).toEqual({ ok: false, error: expect.stringMatching(/q\[7\] does not exist: the circuit has 3 qubits/) })
    expect(store().shiftOp(0, -1)).toEqual({ ok: false, error: expect.stringMatching(/already on q\[0\]/) })
    expect(store().moveOpTo(0, 9)).toEqual({ ok: false, error: expect.stringMatching(/positions run from 0 to 2/) })
  })

  it('a good edit afterwards clears the message', () => {
    store().insertOpAt(0, H(7))
    expect(store().canvasError).not.toBeNull()
    store().insertOpAt(0, H(1))
    expect(store().canvasError).toBeNull()
  })

  it('a measurement into a classical bit the circuit does not have is refused', () => {
    store().loadCircuit(emptyCircuit(1, 0))
    store().selectGate('measure')
    store().onWireClick(0)
    expect(store().circuit.ops).toEqual([])
    expect(store().canvasError).toMatch(/no classical bits/)
  })
})

describe('move and delete', () => {
  it('moves a gate earlier and later and keeps it selected at its new place', () => {
    store().moveOpTo(2, 0)
    expect(names(store().circuit)).toEqual(['x2', 'h0', 'cx0>1'])
    expect(store().selectedOpIndex).toBe(0)
    store().moveOpTo(0, 2)
    expect(names(store().circuit)).toEqual(['h0', 'cx0>1', 'x2'])
    expectViewsAgree()
  })

  it('moves a gate across wires; a CX moves as a whole', () => {
    store().shiftOp(0, 1)
    expect(names(store().circuit)).toEqual(['h1', 'cx0>1', 'x2'])
    store().shiftOp(1, 1)
    expect(store().circuit.ops[1]).toMatchObject({ controls: [1], targets: [2] })
    expectViewsAgree()
  })

  it('a drag is one edit: position and wire together, one undo step', () => {
    const pastBefore = store().past.length
    store().dropOp(0, 2, 1)
    expect(names(store().circuit)).toEqual(['cx0>1', 'x2', 'h1'])
    expect(store().past.length).toBe(pastBefore + 1)
    store().undo()
    expect(names(store().circuit)).toEqual(['h0', 'cx0>1', 'x2'])
  })

  it('deletes a gate, wherever it is', () => {
    store().removeOpAt(1)
    expect(names(store().circuit)).toEqual(['h0', 'x2'])
    expectViewsAgree()
    store().removeOpAt(5) // there is no such gate
    expect(names(store().circuit)).toEqual(['h0', 'x2'])
    expect(store().canvasError).toMatch(/no operation 5/)
  })

  it('selection follows the circuit: picking is bounded, and any change of the circuit lets go', () => {
    store().selectOp(1)
    expect(store().selectedOpIndex).toBe(1)
    store().selectOp(9)
    expect(store().selectedOpIndex).toBeNull()
    store().selectOp(0)
    store().insertOpAt(0, X(0))
    expect(store().selectedOpIndex).toBeNull()
  })

  it('picking a gate changes nothing about the circuit or what was derived from it', () => {
    seedDerivedState()
    const before = store().circuit
    store().selectOp(1)
    store().setInsertAt(1)
    expect(store().circuit).toBe(before)
    expect(store().result).not.toBeNull()
    expect(store().trace).not.toBeNull()
  })
})

describe('undo and redo', () => {
  it('walk back through exactly the circuits that existed, and forward again', () => {
    const c0 = store().circuit
    store().insertOpAt(1, op('z', [0]))
    const c1 = store().circuit
    store().removeOpAt(0)
    const c2 = store().circuit
    store().moveOpTo(0, 2)
    const c3 = store().circuit
    expect(store().past).toHaveLength(3)

    store().undo()
    expect(sameCircuit(store().circuit, c2)).toBe(true)
    store().undo()
    expect(sameCircuit(store().circuit, c1)).toBe(true)
    store().undo()
    expect(sameCircuit(store().circuit, c0)).toBe(true)
    expect(store().future).toHaveLength(3)
    store().undo() // nothing left
    expect(sameCircuit(store().circuit, c0)).toBe(true)

    store().redo()
    store().redo()
    store().redo()
    expect(sameCircuit(store().circuit, c3)).toBe(true)
    store().redo() // nothing left
    expect(sameCircuit(store().circuit, c3)).toBe(true)
    expect(store().future).toHaveLength(0)
  })

  it('the QASM text follows undo and redo and always agrees with the circuit', () => {
    store().insertOpAt(0, X(1))
    store().insertOpAt(1, X(2))
    for (const step of [store().undo, store().undo, store().redo, store().redo, store().undo]) {
      step()
      expectViewsAgree()
    }
  })

  it('a new edit after an undo drops the redo list', () => {
    store().insertOpAt(0, X(1))
    store().undo()
    expect(store().future).toHaveLength(1)
    store().insertOpAt(0, op('y', [1]))
    expect(store().future).toHaveLength(0)
    store().redo()
    expect(names(store().circuit)).toEqual(['y1', 'h0', 'cx0>1', 'x2'])
  })

  it('every undo and redo drops what was derived from the circuit it leaves', () => {
    store().insertOpAt(0, X(1))
    seedDerivedState()
    store().undo()
    expectNothingDerivedLeft()
    seedDerivedState()
    store().redo()
    expectNothingDerivedLeft()
  })

  it('undoing restores a circuit object the tutor and results are re-derived for, not a stale one', () => {
    store().insertOpAt(0, X(1))
    const edited = store().circuit
    store().undo()
    expect(store().circuit).not.toBe(edited)
    store().redo()
    expect(sameCircuit(store().circuit, edited)).toBe(true)
  })

  it('applying an optimised circuit and loading a lesson are undoable too', () => {
    const original = store().circuit
    useBuildStore.setState({ optimization: { status: 'VERIFIED_SHORTER', candidateCircuit: circuitOf(3, [H(0)]) } as unknown as OptimizationResult })
    store().applyOptimizedCircuit()
    expect(names(store().circuit)).toEqual(['h0'])
    store().undo()
    expect(sameCircuit(store().circuit, original)).toBe(true)

    store().loadCircuit(circuitOf(2, [X(0)]))
    expect(store().circuit.num_qubits).toBe(2)
    store().undo()
    expect(sameCircuit(store().circuit, original)).toBe(true)
  })

  it('changing the number of qubits is an undoable edit', () => {
    const original = store().circuit
    store().setNumQubits(5)
    expect(store().circuit.ops).toEqual([])
    store().undo()
    expect(sameCircuit(store().circuit, original)).toBe(true)
  })

  it('history is bounded', () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) store().insertOpAt(0, X(i % 3))
    expect(store().past).toHaveLength(HISTORY_LIMIT)
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) store().undo()
    expect(store().past).toHaveLength(0)
    expect(store().future).toHaveLength(HISTORY_LIMIT)
  })

  it('loading the same circuit again records no history step, but still resets what was derived', () => {
    const same = JSON.parse(JSON.stringify(store().circuit)) as Circuit
    seedDerivedState()
    store().loadCircuit(same)
    expect(store().past).toHaveLength(0)
    expectNothingDerivedLeft()
  })
})

describe('everything derived from the circuit is dropped by every kind of change', () => {
  const changes: Record<string, () => unknown> = {
    'an insert': () => store().insertOpAt(0, X(1)),
    'a delete': () => store().removeOpAt(0),
    'a move in time': () => store().moveOpTo(0, 2),
    'a move across wires': () => store().shiftOp(0, 1),
    'a drag': () => store().dropOp(0, 2, 1),
    'a placed gate': () => {
      store().selectGate('h')
      store().onWireClick(2)
    },
    'a QASM edit': () => store().applyQasmEdit('OPENQASM 3.0;\nqubit[3] q;\nh q[1];\n'),
    'a lesson loaded': () => store().loadCircuit(circuitOf(1, [H(0)])),
  }
  for (const [name, change] of Object.entries(changes)) {
    it(name, () => {
      seedDerivedState()
      change()
      expectNothingDerivedLeft()
      expectViewsAgree({ canonical: name !== 'a QASM edit' })
    })
  }

  it('an answer that arrives after the circuit changed is discarded, not shown against the new circuit', async () => {
    let resolve!: (value: unknown) => void
    client.current = { executeCircuit: () => new Promise((r) => (resolve = r)) }
    const pending = store().runExecution()
    store().insertOpAt(0, X(1)) // the circuit changes while the backend is still thinking
    resolve(RESULT())
    await pending
    expect(store().result).toBeNull()
    expect(store().isExecuting).toBe(false)
  })

  it('same for an answer that arrives after an undo', async () => {
    store().insertOpAt(0, X(1))
    let resolve!: (value: unknown) => void
    client.current = { executeCircuit: () => new Promise((r) => (resolve = r)) }
    const pending = store().runExecution()
    store().undo()
    resolve(RESULT())
    await pending
    expect(store().result).toBeNull()
  })

  it('a trace requested before an edit is not resurrected after it', async () => {
    let resolve!: (value: unknown) => void
    client.current = { traceCircuit: () => new Promise((r) => (resolve = r)) }
    const pending = store().runTrace()
    store().removeOpAt(0)
    resolve(TRACE)
    await pending
    expect(store().trace).toBeNull()
  })
})

describe('the QASM editor and the canvas stay one circuit', () => {
  it('an edit in the QASM text updates the circuit, and an undo puts the previous circuit back as canonical text', () => {
    const before = store().circuit
    expect(store().applyQasmEdit('OPENQASM 3.0;\nqubit[3] q;\nx q[0];\nx q[1];\n')).toEqual({ ok: true })
    expect(names(store().circuit)).toEqual(['x0', 'x1'])
    store().undo()
    expect(sameCircuit(store().circuit, before)).toBe(true)
    expectViewsAgree()
  })

  it('text that does not parse changes nothing: no new circuit, no history, no invalidation', () => {
    seedDerivedState()
    const before = store().circuit
    const pastBefore = store().past.length
    const outcome = store().applyQasmEdit('qubit[3] q;\nfrobnicate q[0];')
    expect(outcome).toMatchObject({ ok: false, line: 2 })
    expect(store().circuit).toBe(before)
    expect(store().past.length).toBe(pastBefore)
    expect(store().result).not.toBeNull()
  })

  it('typing in the editor is one undo step per burst, not one per keystroke', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    store().applyQasmEdit('OPENQASM 3.0;\nqubit[3] q;\nx q[0];\n')
    vi.spyOn(Date, 'now').mockReturnValue(1_000_300)
    store().applyQasmEdit('OPENQASM 3.0;\nqubit[3] q;\nx q[0];\nx q[1];\n')
    vi.spyOn(Date, 'now').mockReturnValue(1_000_600)
    store().applyQasmEdit('OPENQASM 3.0;\nqubit[3] q;\nx q[0];\nx q[1];\nx q[2];\n')
    expect(store().past).toHaveLength(1)
    vi.spyOn(Date, 'now').mockReturnValue(1_005_000) // a pause: the next change is a new step
    store().applyQasmEdit('OPENQASM 3.0;\nqubit[3] q;\nh q[0];\n')
    expect(store().past).toHaveLength(2)
    store().undo()
    expect(names(store().circuit)).toEqual(['x0', 'x1', 'x2'])
    store().undo()
    expect(names(store().circuit)).toEqual(['h0', 'cx0>1', 'x2'])
  })

  it('text equal to the current text is not an edit (a stale echo cannot erase a newer result)', () => {
    seedDerivedState()
    expect(store().applyQasmEdit(store().qasmText)).toEqual({ ok: true })
    expect(store().result).not.toBeNull()
  })

  it('the same circuit spelled differently adds no undo step', () => {
    store().applyQasmEdit('OPENQASM 3;\nqubit[3] q; // spaced\nh q[0]; cx q[0],q[1]; x q[2];')
    expect(store().past).toHaveLength(0)
    expect(names(store().circuit)).toEqual(['h0', 'cx0>1', 'x2'])
  })

  it('after any sequence of edits the two views still agree (a deterministic random walk)', () => {
    let seed = 12345
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let step = 0; step < 300; step++) {
      const n = store().circuit.ops.length
      switch (rand(7)) {
        case 0:
          store().insertOpAt(rand(n + 1), [H(rand(3)), X(rand(3)), CX(0, 1 + rand(2)), op('swap', [0, 1 + rand(2)])][rand(4)]!)
          break
        case 1:
          if (n) store().removeOpAt(rand(n))
          break
        case 2:
          if (n) store().moveOpTo(rand(n), rand(n))
          break
        case 3:
          if (n) store().shiftOp(rand(n), rand(2) ? 1 : -1)
          break
        case 4:
          store().undo()
          break
        case 5:
          store().redo()
          break
        default:
          if (n) store().dropOp(rand(n), rand(n), rand(3))
      }
      expectViewsAgree()
    }
  })

  it('undoing every step of a long session returns the first circuit; redoing them all returns the last', () => {
    const first = store().circuit
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 0) store().insertOpAt(i % (store().circuit.ops.length + 1), X(i % 3))
      else if (i % 3 === 1) store().moveOpTo(0, store().circuit.ops.length - 1)
      else store().removeOpAt(0)
    }
    const last = store().circuit
    while (store().past.length) store().undo()
    expect(sameCircuit(store().circuit, first)).toBe(true)
    while (store().future.length) store().redo()
    expect(sameCircuit(store().circuit, last)).toBe(true)
  })
})
