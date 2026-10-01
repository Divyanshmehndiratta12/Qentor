/**
 * The canvas as a learner uses it: pick a gate, move it, delete it, insert in the middle, undo and redo, with the mouse, with
 * drag and drop, and with the keyboard alone. Every action here is the store's own editing action; these tests check that each
 * control exists, is named, is reachable by keyboard, and does what it says to the ONE canonical circuit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import type { ExecutionTraceResult } from '@/api'
import { CircuitCanvas, OP_DND_MIME } from './CircuitCanvas'
import { GATE_DND_MIME, GatePalette } from './GatePalette'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const store = () => useBuildStore.getState()
const op = (gate: GateOp['gate'], targets: number[], controls: number[] = []): GateOp => ({ gate, targets, controls, params: [], clbits: [] })
const names = (c: Circuit = store().circuit) => c.ops.map((o) => o.gate + (o.controls.length ? `${o.controls.join('')}>` : '') + o.targets.join(''))

function load(ops: GateOp[], qubits = 3) {
  act(() => {
    store().loadCircuit({ ...emptyCircuit(qubits, qubits), ops })
    useBuildStore.setState({ past: [], future: [] })
  })
}
const mount = (lockQubits = false) =>
  render(
    <>
      <GatePalette />
      <CircuitCanvas lockQubits={lockQubits} />
    </>,
  )
const gate = (label: string) => screen.getByRole('button', { name: label })
const toolbar = () => within(screen.getByRole('toolbar', { name: 'Edit the selected gate' }))

beforeEach(() => useBuildStore.setState(INITIAL, true))
afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL, true)
})

describe('picking a gate', () => {
  it('a click picks the gate, shows what it is, and does not change the circuit; a second click lets go', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    expect(screen.getByText(/Click a gate to pick it/)).toBeTruthy()
    fireEvent.click(gate('H on q0, step 1 of 2'))
    expect(gate('H on q0, step 1 of 2').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('selected-op').textContent).toBe('H on q0 · step 1 of 2')
    expect(names()).toEqual(['h0', 'x1'])
    fireEvent.click(gate('H on q0, step 1 of 2'))
    expect(gate('H on q0, step 1 of 2').getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('selected-op')).toBeNull()
  })

  it('picking another gate moves the selection', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    fireEvent.click(gate('H on q0, step 1 of 2'))
    fireEvent.click(gate('X on q1, step 2 of 2'))
    expect(gate('H on q0, step 1 of 2').getAttribute('aria-pressed')).toBe('false')
    expect(gate('X on q1, step 2 of 2').getAttribute('aria-pressed')).toBe('true')
  })

  it('a control dot picks the whole controlled gate', () => {
    load([op('h', [0]), op('cx', [1], [0])])
    mount()
    fireEvent.click(gate('CX — control q0, target q1, control on q[0], step 2 of 2'))
    expect(store().selectedOpIndex).toBe(1)
    expect(screen.getByTestId('selected-op').textContent).toContain('CX — control q0, target q1')
    expect(gate('CX — control q0, target q1, step 2 of 2').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the toolbar', () => {
  it('moves the picked gate earlier and later, and it stays picked', () => {
    load([op('h', [0]), op('x', [1]), op('z', [2])])
    mount()
    fireEvent.click(gate('Z on q2, step 3 of 3'))
    fireEvent.click(toolbar().getByRole('button', { name: 'Move earlier' }))
    expect(names()).toEqual(['h0', 'z2', 'x1'])
    expect(screen.getByTestId('selected-op').textContent).toBe('Z on q2 · step 2 of 3')
    fireEvent.click(toolbar().getByRole('button', { name: 'Move earlier' }))
    expect(names()).toEqual(['z2', 'h0', 'x1'])
    fireEvent.click(toolbar().getByRole('button', { name: 'Move later' }))
    expect(names()).toEqual(['h0', 'z2', 'x1'])
  })

  it('the buttons are disabled where the move is impossible, so a refused move cannot even be asked for', () => {
    load([op('h', [0]), op('x', [2])])
    mount()
    fireEvent.click(gate('H on q0, step 1 of 2'))
    expect((toolbar().getByRole('button', { name: 'Move earlier' }) as HTMLButtonElement).disabled).toBe(true)
    expect((toolbar().getByRole('button', { name: 'Move up a wire' }) as HTMLButtonElement).disabled).toBe(true)
    expect((toolbar().getByRole('button', { name: 'Move down a wire' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(gate('X on q2, step 2 of 2'))
    expect((toolbar().getByRole('button', { name: 'Move later' }) as HTMLButtonElement).disabled).toBe(true)
    expect((toolbar().getByRole('button', { name: 'Move down a wire' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('moves a gate across wires, and a controlled gate as a whole', () => {
    load([op('cx', [1], [0])])
    mount()
    fireEvent.click(gate('CX — control q0, target q1, step 1 of 1'))
    fireEvent.click(toolbar().getByRole('button', { name: 'Move down a wire' }))
    expect(store().circuit.ops[0]).toMatchObject({ controls: [1], targets: [2] })
    expect((toolbar().getByRole('button', { name: 'Move down a wire' }) as HTMLButtonElement).disabled).toBe(true) // already on the last wire
    fireEvent.click(toolbar().getByRole('button', { name: 'Move up a wire' }))
    expect(store().circuit.ops[0]).toMatchObject({ controls: [0], targets: [1] })
  })

  it('deletes the picked gate; Done lets go without changing anything', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    fireEvent.click(gate('H on q0, step 1 of 2'))
    fireEvent.click(toolbar().getByRole('button', { name: 'Let go of the selected gate' }))
    expect(names()).toEqual(['h0', 'x1'])
    expect(store().selectedOpIndex).toBeNull()
    fireEvent.click(gate('H on q0, step 1 of 2'))
    fireEvent.click(toolbar().getByRole('button', { name: 'Delete the selected gate' }))
    expect(names()).toEqual(['x1'])
    expect(store().selectedOpIndex).toBeNull()
  })

  it('has real, named buttons that keyboard users can reach', () => {
    load([op('h', [0])])
    mount()
    fireEvent.click(gate('H on q0, step 1 of 1'))
    for (const button of toolbar().getAllByRole('button')) {
      expect((button.getAttribute('aria-label') ?? button.textContent ?? '').trim().length).toBeGreaterThan(0)
      expect(button.getAttribute('tabindex')).not.toBe('-1')
    }
    expect(screen.getByRole('toolbar', { name: 'Edit the selected gate' })).toBeTruthy()
  })
})

describe('the keyboard does everything the mouse does', () => {
  it('Alt+Right and Alt+Left move the picked gate in time, and focus follows it', async () => {
    load([op('h', [0]), op('x', [1]), op('z', [2])])
    mount()
    const h = gate('H on q0, step 1 of 3')
    h.focus()
    fireEvent.click(h)
    fireEvent.keyDown(h, { key: 'ArrowRight', altKey: true })
    expect(names()).toEqual(['x1', 'h0', 'z2'])
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute('data-op-index')).toBe('1'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft', altKey: true })
    expect(names()).toEqual(['h0', 'x1', 'z2'])
  })

  it('Alt+Down and Alt+Up move it across wires', () => {
    load([op('h', [0])])
    mount()
    const h = gate('H on q0, step 1 of 1')
    fireEvent.click(h)
    fireEvent.keyDown(h, { key: 'ArrowDown', altKey: true })
    expect(store().circuit.ops[0]!.targets).toEqual([1])
    fireEvent.keyDown(document.querySelector('[data-op-index="0"]')!, { key: 'ArrowUp', altKey: true })
    expect(store().circuit.ops[0]!.targets).toEqual([0])
  })

  it('a refused keyboard move says why and changes nothing', () => {
    load([op('h', [0])])
    mount()
    const h = gate('H on q0, step 1 of 1')
    fireEvent.click(h)
    fireEvent.keyDown(h, { key: 'ArrowUp', altKey: true })
    expect(store().circuit.ops[0]!.targets).toEqual([0])
    expect(store().canvasError).toMatch(/already on q\[0\]/)
  })

  it('Delete and Backspace remove the picked gate; Escape lets go', () => {
    load([op('h', [0]), op('x', [1]), op('z', [2])])
    mount()
    fireEvent.click(gate('X on q1, step 2 of 3'))
    fireEvent.keyDown(gate('X on q1, step 2 of 3'), { key: 'Delete' })
    expect(names()).toEqual(['h0', 'z2'])
    fireEvent.click(gate('Z on q2, step 2 of 2'))
    fireEvent.keyDown(gate('Z on q2, step 2 of 2'), { key: 'Backspace' })
    expect(names()).toEqual(['h0'])
    fireEvent.click(gate('H on q0, step 1 of 1'))
    fireEvent.keyDown(gate('H on q0, step 1 of 1'), { key: 'Escape' })
    expect(store().selectedOpIndex).toBeNull()
    expect(names()).toEqual(['h0'])
  })

  it('keys typed into a field inside the editor are never taken for edits', () => {
    load([op('h', [0])])
    const { container } = mount()
    fireEvent.click(gate('H on q0, step 1 of 1'))
    const input = document.createElement('input')
    container.querySelector('[role="group"][aria-label="Circuit editor"]')!.appendChild(input)
    fireEvent.keyDown(input, { key: 'Delete' })
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(names()).toEqual(['h0'])
  })

  it('without a picked gate the arrow and delete keys do nothing', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    fireEvent.keyDown(gate('H on q0, step 1 of 2'), { key: 'Delete' })
    fireEvent.keyDown(gate('H on q0, step 1 of 2'), { key: 'ArrowRight', altKey: true })
    expect(names()).toEqual(['h0', 'x1'])
  })

  it('Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y undo and redo', () => {
    load([op('h', [0])])
    mount()
    act(() => void store().insertOpAt(1, op('x', [1])))
    expect(names()).toEqual(['h0', 'x1'])
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(names()).toEqual(['h0'])
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(names()).toEqual(['h0', 'x1'])
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(names()).toEqual(['h0'])
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    expect(names()).toEqual(['h0', 'x1'])
  })

  it('the undo shortcuts leave the code editor and form fields alone (they have their own undo for text)', () => {
    load([op('h', [0])])
    mount()
    act(() => void store().insertOpAt(1, op('x', [1])))
    const cm = document.createElement('div')
    cm.className = 'cm-editor'
    const line = document.createElement('div')
    cm.appendChild(line)
    document.body.appendChild(cm)
    const field = document.createElement('input')
    document.body.appendChild(field)
    fireEvent.keyDown(line, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true })
    expect(names()).toEqual(['h0', 'x1'])
    cm.remove()
    field.remove()
  })

  it('Alt+Z is not an undo (it is a different shortcut)', () => {
    load([op('h', [0])])
    mount()
    act(() => void store().insertOpAt(1, op('x', [1])))
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, altKey: true })
    expect(names()).toEqual(['h0', 'x1'])
  })
})

describe('undo and redo buttons', () => {
  it('are disabled until there is something to undo or redo, and say what they are', () => {
    load([op('h', [0])])
    mount()
    const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement
    const redo = screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement
    expect([undo.disabled, redo.disabled]).toEqual([true, true])
    act(() => void store().insertOpAt(1, op('x', [1])))
    expect([undo.disabled, redo.disabled]).toEqual([false, true])
    fireEvent.click(undo)
    expect(names()).toEqual(['h0'])
    expect([undo.disabled, redo.disabled]).toEqual([true, false])
    fireEvent.click(redo)
    expect(names()).toEqual(['h0', 'x1'])
    expect(undo.getAttribute('title')).toMatch(/Ctrl\+Z/)
  })

  it('undo reverses a placement made with the palette, a move and a delete', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    fireEvent.click(gate('H'))
    fireEvent.click(screen.getByRole('button', { name: 'Place h on qubit 2' }))
    expect(names()).toEqual(['h0', 'x1', 'h2'])
    fireEvent.click(gate('X on q1, step 2 of 3'))
    fireEvent.click(toolbar().getByRole('button', { name: 'Move earlier' }))
    fireEvent.click(toolbar().getByRole('button', { name: 'Delete the selected gate' }))
    expect(names()).toEqual(['h0', 'h2'])
    for (const expected of [['x1', 'h0', 'h2'], ['h0', 'x1', 'h2'], ['h0', 'x1']]) {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(names()).toEqual(expected)
    }
  })

  it('a challenge locks the number of qubits but keeps undo and redo', () => {
    load([op('h', [0])])
    mount(true)
    expect(screen.queryByRole('button', { name: 'Add a qubit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
})

describe('inserting in the middle', () => {
  it('a handle chooses where the next gate goes, and a run of gates goes in order', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Insert before step 2' }))
    expect(store().insertAt).toBe(1)
    fireEvent.click(gate('Z'))
    fireEvent.click(screen.getByRole('button', { name: 'Place z on qubit 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Place z on qubit 0' }))
    expect(names()).toEqual(['h0', 'z2', 'z0', 'x1'])
    expect(store().insertAt).toBe(3)
  })

  it('the dashed column sits where the next gate will go, and "Insert at the end" puts it back', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    // the dashed column is the one holding the "place a gate" buttons: find its position among the q0 row's cells
    const slotColumn = () => cellsOf(0).findIndex((cell) => cell.querySelector('[aria-label^="Append on qubit 0"], [aria-label^="Place"]'))
    expect(slotColumn()).toBe(2) // at the end: after both gates
    fireEvent.click(screen.getByRole('button', { name: 'Insert before step 2' }))
    expect(slotColumn()).toBe(1) // before step 2
    fireEvent.click(screen.getByRole('button', { name: 'Insert before step 1' }))
    expect(slotColumn()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Insert at the end' }))
    expect(store().insertAt).toBeNull()
    expect(slotColumn()).toBe(2)
    expect(screen.queryByRole('button', { name: 'Insert at the end' })).toBeNull()
  })

  it('a multi-qubit gate can be inserted in the middle too', () => {
    load([op('h', [0]), op('x', [2])])
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Insert before step 2' }))
    fireEvent.click(gate('CX'))
    fireEvent.click(screen.getByRole('button', { name: 'Place cx on qubit 0' }))
    fireEvent.click(screen.getByRole('button', { name: 'Place cx on qubit 1' }))
    expect(names()).toEqual(['h0', 'cx0>1', 'x2'])
  })

  it('every insertion handle is a named button', () => {
    load([op('h', [0]), op('x', [1]), op('z', [2])])
    mount()
    for (const n of [1, 2, 3]) expect(screen.getByRole('button', { name: `Insert before step ${n}` })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------------- drag and drop

class FakeTransfer {
  private data = new Map<string, string>()
  effectAllowed = 'all'
  dropEffect = 'none'
  setData(type: string, value: string) {
    this.data.set(type, value)
  }
  getData(type: string) {
    return this.data.get(type) ?? ''
  }
}
const cellsOf = (qubit: number) => Array.from(document.querySelector(`[role="group"][aria-label="Qubit ${qubit}"] .grid`)!.children).slice(1) as HTMLElement[]

describe('drag and drop (each one has a button or key equivalent above)', () => {
  it('dragging a placed gate onto another column and row moves it in one step', () => {
    load([op('h', [0]), op('x', [1]), op('z', [2])])
    mount()
    const transfer = new FakeTransfer()
    fireEvent.dragStart(gate('H on q0, step 1 of 3'), { dataTransfer: transfer })
    expect(transfer.getData(OP_DND_MIME)).toBe('0')
    const target = cellsOf(2)[1]! // the column of step 2, on the q2 row
    fireEvent.dragOver(target, { dataTransfer: transfer })
    fireEvent.drop(target, { dataTransfer: transfer })
    expect(names()).toEqual(['x1', 'h2', 'z2'])
    act(() => store().undo())
    expect(names()).toEqual(['h0', 'x1', 'z2'])
  })

  it('dropping a controlled gate on a row only moves it in time (it cannot be put on one wire)', () => {
    load([op('cx', [1], [0]), op('x', [0])])
    mount()
    const transfer = new FakeTransfer()
    fireEvent.dragStart(gate('CX — control q0, target q1, step 1 of 2'), { dataTransfer: transfer })
    fireEvent.drop(cellsOf(2)[1]!, { dataTransfer: transfer }) // an empty cell of step 2, on the q2 row
    expect(names()).toEqual(['x0', 'cx0>1'])
  })

  it('a gate can also be dropped on a cell that already holds a gate: it takes that gate\'s place in time', () => {
    load([op('h', [0]), op('x', [1]), op('z', [2])])
    mount()
    const transfer = new FakeTransfer()
    fireEvent.dragStart(gate('H on q0, step 1 of 3'), { dataTransfer: transfer })
    fireEvent.drop(cellsOf(2)[2]!, { dataTransfer: transfer }) // the cell of the Z gate
    expect(names()).toEqual(['x1', 'z2', 'h2'])
  })

  it('dragging a gate from the palette onto a column in the middle inserts it there', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    const transfer = new FakeTransfer()
    transfer.setData(GATE_DND_MIME, 'z')
    fireEvent.drop(cellsOf(2)[1]!, { dataTransfer: transfer }) // the column of step 2, row q2
    expect(names()).toEqual(['h0', 'z2', 'x1'])
  })

  it('dragging a gate from the palette onto the dashed column still appends, as it always did', () => {
    load([op('h', [0])])
    mount()
    const transfer = new FakeTransfer()
    transfer.setData(GATE_DND_MIME, 'x')
    fireEvent.drop(screen.getByRole('button', { name: 'Append on qubit 1 — select a gate first' }), { dataTransfer: transfer })
    expect(names()).toEqual(['h0', 'x1'])
  })

  it('a drop that carries nothing we recognise does nothing', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    fireEvent.drop(cellsOf(2)[1]!, { dataTransfer: new FakeTransfer() })
    expect(names()).toEqual(['h0', 'x1'])
  })
})

describe('the circuit and the trace read together', () => {
  const traceOf = (_operationIndex: number | null) =>
    ({ steps: [{ operationIndex: null }, { operationIndex: 0 }, { operationIndex: 1 }].map((s, i) => ({ ...s, stepIndex: i })), terminalMeasurements: [] }) as unknown as ExecutionTraceResult

  it('the operation behind the selected trace step is marked, and only that one', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    act(() => useBuildStore.setState({ trace: traceOf(1), selectedTraceStep: 2 }))
    expect(screen.getByRole('button', { name: 'X on q1, step 2 of 2, shown in the trace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'H on q0, step 1 of 2' })).toBeTruthy()
    act(() => useBuildStore.setState({ selectedTraceStep: 1 }))
    expect(screen.getByRole('button', { name: 'H on q0, step 1 of 2, shown in the trace' })).toBeTruthy()
    act(() => useBuildStore.setState({ selectedTraceStep: 0 })) // the initial state has no operation
    expect(screen.queryByRole('button', { name: /shown in the trace/ })).toBeNull()
  })

  it('without a trace nothing is marked', () => {
    load([op('h', [0])])
    mount()
    expect(screen.queryByRole('button', { name: /shown in the trace/ })).toBeNull()
  })
})

describe('the canvas never holds circuit state of its own', () => {
  it('everything it shows is read from the store: changing the store changes the canvas, nothing else does', () => {
    load([op('h', [0])])
    mount()
    expect(screen.getAllByRole('button', { name: /step \d+ of \d+/ })).toHaveLength(1)
    act(() => void store().insertOpAt(1, op('x', [1])))
    expect(screen.getAllByRole('button', { name: /step \d+ of \d+/ })).toHaveLength(2)
    act(() => store().applyQasmEdit('qubit[3] q;\ny q[0];\ny q[1];\ny q[2];'))
    expect(screen.getAllByRole('button', { name: /step \d+ of \d+/ })).toHaveLength(3)
    expect(names()).toEqual(['y0', 'y1', 'y2'])
  })

  it('creates the events with the real DOM API (a sanity check of the drag helpers used above)', () => {
    const event = createEvent.drop(document.body, { dataTransfer: new FakeTransfer() })
    expect((event as unknown as { dataTransfer: FakeTransfer }).dataTransfer.getData('x')).toBe('')
  })
})
