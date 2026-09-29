/**
 * Regression: the QASM editor's "echo" used to erase newer results.
 *
 * What happened: any change to the store's `qasmText` (a canvas edit, "Open in
 * Lab", ...) was mirrored into CodeMirror, which reports that exactly like
 * typing; 400ms later the editor "applied" the text it had just been given,
 * replacing the circuit and clearing the result/trace/verification. The Lab's
 * auto-run answers at ~250ms + latency — i.e. just BEFORE the echo — so the fresh
 * result was wiped, and a trace requested in that window vanished too.
 *
 * Three fixes, each pinned here without any real sleeping (fake timers, and
 * deferred promises that the test resolves in the order it chooses):
 *   1. the editor's own store-driven sync is not a user edit;
 *   2. `applyQasmEdit` of text identical to the circuit's is a no-op;
 *   3. `runExecution` discards a response that is no longer the current answer.
 * And what must NOT change: a genuine user edit still invalidates, and a stale
 * pending user edit never overwrites a newer canvas circuit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { EditorView } from 'codemirror'
import type { ExecutePayload } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQasm3 } from '@/circuit/qasmEmitter'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { hzh } from '@/test/traceFixtures'

const executeCircuit = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit,
      verifyBellState: vi.fn(),
      askTutor: vi.fn(),
      optimizeCircuit: vi.fn(),
      runMultiInputTest: vi.fn(),
      listLessons: vi.fn(),
      traceCircuit: vi.fn(),
    }),
  }
})

import { QASMEditor } from './QASMEditor'
import { useBuildStore } from './store'

const op = (gate: 'h' | 'x' | 'z') => ({ gate, targets: [0], controls: [], params: [], clbits: [] })
const circuitOf = (...gates: Array<'h' | 'x' | 'z'>): Circuit => ({ ...emptyCircuit(1, 0), ops: gates.map(op) })
const H = circuitOf('h')
const X = circuitOf('x')
const HZ = circuitOf('h', 'z')

const provenance = (id: string): Provenance => ({
  resultId: id,
  circuitHash: `hash_${id}`,
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'VERIFIED',
  createdAt: '2026-01-01T00:00:00Z',
})
const resultFor = (id: string) =>
  toQuantumValue<ExecutePayload>({ executionId: `exec_${id}`, statevector: [[1, 0], [0, 0]] }, provenance(id))

const INITIAL = useBuildStore.getState()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  executeCircuit.mockReset()
  useBuildStore.setState(INITIAL, true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useBuildStore.setState(INITIAL, true)
})

// ---------------------------------------------------------------------------
// The editor component
// ---------------------------------------------------------------------------

describe('the QASM editor never echoes the store back as an edit', () => {
  const spyOnApply = () => {
    const spy = vi.fn(useBuildStore.getState().applyQasmEdit)
    useBuildStore.setState({ applyQasmEdit: spy })
    return spy
  }
  const viewOf = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!

  it('a canvas-driven change is mirrored into the editor but never submitted as an edit', () => {
    vi.useFakeTimers()
    const apply = spyOnApply()
    const { container } = render(<QASMEditor />)

    act(() => useBuildStore.getState().loadCircuit(HZ)) // the store changes; the editor mirrors it
    act(() => void vi.advanceTimersByTime(5000))

    expect(viewOf(container).state.doc.toString()).toBe(toQasm3(HZ)) // it DID mirror it…
    expect(apply).not.toHaveBeenCalled() // …without treating that as typing
  })

  it('THE BUG: a result that arrives after a canvas change survives the echo window', () => {
    vi.useFakeTimers()
    render(<QASMEditor />)

    act(() => useBuildStore.getState().loadCircuit(HZ)) // t = 0: circuit changes
    act(() => void vi.advanceTimersByTime(350)) // the auto-run (250ms) has answered by now
    const result = resultFor('after_edit')
    const trace = hzh()
    act(() => useBuildStore.setState({ result, trace })) // ...its result and a requested trace arrive
    act(() => void vi.advanceTimersByTime(100)) // t = 450ms: past the old 400ms echo

    expect(useBuildStore.getState().result).toBe(result) // used to be null
    expect(useBuildStore.getState().trace).toBe(trace) // used to be null
    expect(useBuildStore.getState().circuit.ops).toHaveLength(2)
  })

  it('a burst of canvas edits never produces an edit from the editor, whatever the timing', () => {
    vi.useFakeTimers()
    const apply = spyOnApply()
    render(<QASMEditor />)

    for (const circuit of [H, X, HZ, H]) {
      act(() => useBuildStore.getState().loadCircuit(circuit))
      act(() => void vi.advanceTimersByTime(137))
    }
    act(() => void vi.advanceTimersByTime(2000))

    expect(apply).not.toHaveBeenCalled()
  })

  it('a genuine user edit still parses, still replaces the circuit, and still invalidates derived state', () => {
    vi.useFakeTimers()
    const { container } = render(<QASMEditor />)
    act(() => useBuildStore.getState().loadCircuit(H))
    act(() => void vi.advanceTimersByTime(1000))
    act(() => useBuildStore.setState({ result: resultFor('before_edit'), trace: hzh() }))

    // the learner types: an unannotated change, exactly what typing produces
    const view = viewOf(container)
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: toQasm3(X) } }))
    act(() => void vi.advanceTimersByTime(400))

    const state = useBuildStore.getState()
    expect(state.circuit.ops.map((o) => o.gate)).toEqual(['x']) // the edit was applied
    expect(state.result).toBeNull() // and it invalidated what belonged to the old circuit
    expect(state.trace).toBeNull()
    expect(state.qasmText).toBe(toQasm3(X))
  })

  it('a user edit still waits for its debounce (it is not applied early)', () => {
    vi.useFakeTimers()
    const { container } = render(<QASMEditor />)
    act(() => useBuildStore.getState().loadCircuit(H))
    act(() => void vi.advanceTimersByTime(1000))

    const view = viewOf(container)
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: toQasm3(X) } }))
    act(() => void vi.advanceTimersByTime(399))
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['h'])
    act(() => void vi.advanceTimersByTime(1))
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['x'])
  })

  it('a STALE pending user edit never overwrites a newer canvas circuit', () => {
    vi.useFakeTimers()
    const { container } = render(<QASMEditor />)
    act(() => useBuildStore.getState().loadCircuit(H))
    act(() => void vi.advanceTimersByTime(1000))

    const view = viewOf(container)
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: toQasm3(X) } })) // typed, pending
    act(() => void vi.advanceTimersByTime(200))
    act(() => useBuildStore.getState().loadCircuit(HZ)) // the canvas moves on before the debounce fires
    act(() => void vi.advanceTimersByTime(2000))

    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['h', 'z']) // the newer circuit won
    expect(viewOf(container).state.doc.toString()).toBe(toQasm3(HZ))
  })

  it('a user edit with a parse error is still reported, and changes nothing else', () => {
    vi.useFakeTimers()
    const { container } = render(<QASMEditor />)
    act(() => useBuildStore.getState().loadCircuit(H))
    act(() => void vi.advanceTimersByTime(1000))
    const result = resultFor('kept')
    act(() => useBuildStore.setState({ result }))

    const view = viewOf(container)
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'this is not qasm' } }))
    act(() => void vi.advanceTimersByTime(400))

    expect(screen.getByText('parse error')).toBeInTheDocument()
    expect(useBuildStore.getState().result).toBe(result) // an invalid edit never touched the circuit or result
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['h'])
  })
})

// ---------------------------------------------------------------------------
// applyQasmEdit
// ---------------------------------------------------------------------------

describe('applyQasmEdit: identical text is not an edit; different text is', () => {
  it('leaves the circuit, result, trace, verification, optimizer and tutor alone for identical text', () => {
    const state = useBuildStore.getState()
    state.loadCircuit(HZ)
    const result = resultFor('kept')
    const trace = hzh()
    useBuildStore.setState({
      result,
      trace,
      tutorTurns: [{ role: 'learner', text: 'hello' }],
    })
    const before = useBuildStore.getState()

    const outcome = useBuildStore.getState().applyQasmEdit(before.qasmText)

    expect(outcome).toEqual({ ok: true })
    const after = useBuildStore.getState()
    expect(after.circuit).toBe(before.circuit) // not even re-parsed into a new object
    expect(after.result).toBe(result)
    expect(after.trace).toBe(trace)
    expect(after.tutorTurns).toBe(before.tutorTurns)
    expect(after).toBe(before) // nothing at all was written
  })

  it('different text still applies and invalidates (a user edit may invalidate)', () => {
    useBuildStore.getState().loadCircuit(H)
    useBuildStore.setState({ result: resultFor('old'), trace: hzh() })

    const outcome = useBuildStore.getState().applyQasmEdit(toQasm3(X))

    expect(outcome).toEqual({ ok: true })
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['x'])
    expect(useBuildStore.getState().result).toBeNull()
    expect(useBuildStore.getState().trace).toBeNull()
  })

  it('text that differs only in whitespace is still a user edit (documented: only IDENTICAL text is a no-op)', () => {
    useBuildStore.getState().loadCircuit(H)
    useBuildStore.setState({ result: resultFor('old') })

    useBuildStore.getState().applyQasmEdit(toQasm3(H) + '\n')

    expect(useBuildStore.getState().result).toBeNull()
  })

  it('a parse error still reports its line and changes nothing', () => {
    useBuildStore.getState().loadCircuit(H)
    const result = resultFor('kept')
    useBuildStore.setState({ result })

    const outcome = useBuildStore.getState().applyQasmEdit('qubit[1] q;\nnot_a_gate q[0];')

    expect(outcome.ok).toBe(false)
    expect(useBuildStore.getState().result).toBe(result)
  })
})

// ---------------------------------------------------------------------------
// runExecution: no race-created result
// ---------------------------------------------------------------------------

describe('runExecution only shows the answer to the CURRENT question', () => {
  it('normal path: the result of the current circuit is shown and the flag clears', async () => {
    useBuildStore.getState().loadCircuit(H)
    executeCircuit.mockResolvedValueOnce(resultFor('r1'))

    await useBuildStore.getState().runExecution()

    expect(useBuildStore.getState().result?.provenance.resultId).toBe('r1')
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })

  it('a response for a circuit that has since changed is discarded, never shown', async () => {
    useBuildStore.getState().loadCircuit(H)
    const slow = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(slow.promise)
    const run = useBuildStore.getState().runExecution()
    expect(useBuildStore.getState().isExecuting).toBe(true)

    useBuildStore.getState().loadCircuit(X) // the learner edits while the run is in flight
    slow.resolve(resultFor('for_H'))
    await run

    expect(useBuildStore.getState().result).toBeNull() // NOT the result of H shown next to circuit X
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })

  it('...and the run for the new circuit then shows its own result', async () => {
    useBuildStore.getState().loadCircuit(H)
    const slow = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(slow.promise)
    const first = useBuildStore.getState().runExecution()

    useBuildStore.getState().loadCircuit(X)
    executeCircuit.mockResolvedValueOnce(resultFor('for_X'))
    const second = useBuildStore.getState().runExecution()
    slow.resolve(resultFor('for_H')) // the OLD answer arrives after the new run started
    await Promise.all([first, second])

    expect(useBuildStore.getState().result?.provenance.resultId).toBe('for_X')
  })

  it('out-of-order responses: the newest run wins even if an older one resolves last', async () => {
    useBuildStore.getState().loadCircuit(H)
    const older = deferred<ReturnType<typeof resultFor>>()
    const newer = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)

    const first = useBuildStore.getState().runExecution()
    const second = useBuildStore.getState().runExecution() // same circuit (e.g. auto-run, then the Run button)
    newer.resolve(resultFor('newer'))
    await second
    older.resolve(resultFor('older'))
    await first

    expect(useBuildStore.getState().result?.provenance.resultId).toBe('newer')
  })

  it('a superseded run cannot flip the flag under a newer run that is still going', async () => {
    useBuildStore.getState().loadCircuit(H)
    const older = deferred<ReturnType<typeof resultFor>>()
    const newer = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const first = useBuildStore.getState().runExecution()
    const second = useBuildStore.getState().runExecution()

    older.resolve(resultFor('older'))
    await first
    expect(useBuildStore.getState().isExecuting).toBe(true) // the newer run is still in flight
    expect(useBuildStore.getState().result).toBeNull()

    newer.resolve(resultFor('newer'))
    await second
    expect(useBuildStore.getState().isExecuting).toBe(false)
    expect(useBuildStore.getState().result?.provenance.resultId).toBe('newer')
  })

  it('a stale FAILURE is discarded too — no error is shown for a question nobody is asking any more', async () => {
    useBuildStore.getState().loadCircuit(H)
    const slow = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(slow.promise)
    const run = useBuildStore.getState().runExecution()

    useBuildStore.getState().loadCircuit(X)
    slow.reject(new Error('backend exploded'))
    await run

    expect(useBuildStore.getState().executionError).toBeNull()
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })

  it('a current failure is still reported exactly as before', async () => {
    useBuildStore.getState().loadCircuit(H)
    executeCircuit.mockRejectedValueOnce(new Error('backend exploded'))

    await useBuildStore.getState().runExecution()

    expect(useBuildStore.getState().executionError).toBe('backend exploded')
    expect(useBuildStore.getState().result).toBeNull()
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })

  it('changing the mode while a run is in flight discards that run’s answer', async () => {
    useBuildStore.getState().loadCircuit(H)
    const slow = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(slow.promise)
    const run = useBuildStore.getState().runExecution()

    useBuildStore.getState().setMode('shots')
    slow.resolve(resultFor('statevector_run'))
    await run

    expect(useBuildStore.getState().result).toBeNull()
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })

  it('changing the shot count in shots mode discards the old run, but not in statevector mode', async () => {
    useBuildStore.getState().loadCircuit(H)
    useBuildStore.getState().setMode('shots')
    const slow = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(slow.promise)
    const run = useBuildStore.getState().runExecution()
    useBuildStore.getState().setShots(50)
    slow.resolve(resultFor('shots_run'))
    await run
    expect(useBuildStore.getState().result).toBeNull()

    useBuildStore.getState().setMode('statevector')
    const slow2 = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(slow2.promise)
    const run2 = useBuildStore.getState().runExecution()
    useBuildStore.getState().setShots(75) // irrelevant to a statevector run
    slow2.resolve(resultFor('sv_run'))
    await run2
    expect(useBuildStore.getState().result?.provenance.resultId).toBe('sv_run')
  })

  it('emptying the circuit while a run is in flight leaves no result and does not strand the flag', async () => {
    useBuildStore.getState().loadCircuit(H)
    const slow = deferred<ReturnType<typeof resultFor>>()
    executeCircuit.mockReturnValueOnce(slow.promise)
    const run = useBuildStore.getState().runExecution()

    useBuildStore.getState().loadCircuit(emptyCircuit(1, 0))
    await useBuildStore.getState().runExecution() // the auto-run for an empty circuit
    slow.resolve(resultFor('for_H'))
    await run

    expect(useBuildStore.getState().result).toBeNull()
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })

  it('the exact production ordering, deterministically: edit, run answers, a stale echo arrives — the result stays', async () => {
    useBuildStore.getState().loadCircuit(HZ) // 1. the circuit changes
    executeCircuit.mockResolvedValueOnce(resultFor('auto_run'))
    await useBuildStore.getState().runExecution() // 2. the debounced auto-run answers
    const result = useBuildStore.getState().result
    const circuit = useBuildStore.getState().circuit

    useBuildStore.getState().applyQasmEdit(useBuildStore.getState().qasmText) // 3. the editor's echo (identical text)

    expect(useBuildStore.getState().result).toBe(result)
    expect(useBuildStore.getState().circuit).toBe(circuit)
  })
})
