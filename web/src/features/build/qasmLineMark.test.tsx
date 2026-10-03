/**
 * The code editor marks the line of the gate picked on the canvas (violet), or of the gate behind the selected trace step (amber)
 * when none is picked: the QASM <-> canvas relationship made visible. It is a mark, not a claim: it is dropped (never guessed) when the
 * editor's text is not the canvas's own canonical text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { EditorView } from 'codemirror'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import { toQasm3 } from '@/circuit/qasmEmitter'
import { bellWithQubitStates } from '@/test/traceFixtures'
import { QASMEditor } from './QASMEditor'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const op = (gate: GateOp['gate'], targets: number[], controls: number[] = []): GateOp => ({ gate, targets, controls, params: [], clbits: [] })
const BELL_PLUS_X: Circuit = { ...emptyCircuit(2, 0), ops: [op('h', [0]), op('cx', [1], [0]), op('x', [1])] }

beforeEach(() => useBuildStore.setState(INITIAL, true))
afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL, true)
})

const viewOf = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
const marked = (container: HTMLElement, kind: 'selected' | 'traced') => [...container.querySelectorAll(`.cm-line.cm-op-line-${kind}`)].map((l) => l.textContent)

describe('the QASM editor marks the line of the picked gate', () => {
  it('marks the picked gate’s statement, moves with the selection, and clears when nothing is picked', () => {
    act(() => useBuildStore.getState().loadCircuit(BELL_PLUS_X))
    const { container } = render(<QASMEditor />)
    expect(marked(container, 'selected')).toEqual([])

    act(() => useBuildStore.getState().selectOp(1))
    expect(marked(container, 'selected')).toEqual(['cx q[0], q[1];'])
    act(() => useBuildStore.getState().selectOp(2))
    expect(marked(container, 'selected')).toEqual(['x q[1];'])
    act(() => useBuildStore.getState().selectOp(null))
    expect(marked(container, 'selected')).toEqual([])
  })

  it('follows a canvas edit: after a gate is inserted ahead of it, the mark is on the same gate on its new line', () => {
    act(() => useBuildStore.getState().loadCircuit(BELL_PLUS_X))
    const { container } = render(<QASMEditor />)
    act(() => useBuildStore.getState().selectOp(2))
    expect(marked(container, 'selected')).toEqual(['x q[1];'])
    act(() => useBuildStore.getState().insertOpAt(0, op('z', [0])))
    act(() => useBuildStore.getState().selectOp(3))
    expect(marked(container, 'selected')).toEqual(['x q[1];'])
    expect(viewOf(container).state.doc.toString()).toBe(toQasm3(useBuildStore.getState().circuit))
  })

  it('with nothing picked, the gate behind the selected trace step is marked (amber), and a picked gate takes precedence', () => {
    act(() => useBuildStore.getState().loadCircuit({ ...emptyCircuit(2, 0), ops: [op('h', [0]), op('cx', [1], [0])] }))
    const { container } = render(<QASMEditor />)
    act(() => useBuildStore.setState({ trace: bellWithQubitStates(), selectedTraceStep: 2 }))
    expect(marked(container, 'traced')).toEqual(['cx q[0], q[1];'])
    expect(marked(container, 'selected')).toEqual([])
    act(() => useBuildStore.getState().selectOp(0))
    expect(marked(container, 'selected')).toEqual(['h q[0];'])
    expect(marked(container, 'traced')).toEqual([]) // one mark at a time
    act(() => useBuildStore.getState().selectOp(null))
    act(() => useBuildStore.setState({ selectedTraceStep: 0 })) // the initial state has no gate
    expect(marked(container, 'traced')).toEqual([])
  })

  it('marks nothing while the editor text is not the canvas’s own text (a mark must mean an operation)', () => {
    act(() => useBuildStore.getState().loadCircuit(BELL_PLUS_X))
    const { container } = render(<QASMEditor />)
    const view = viewOf(container)
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '// my note\n' } }) // a person types in the editor
    })
    act(() => useBuildStore.getState().selectOp(1))
    expect(marked(container, 'selected')).toEqual([])
  })
})
