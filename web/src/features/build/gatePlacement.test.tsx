/**
 * Placing the multi-wire gates (CX, CZ, CCX, SWAP) and the dagger gates from the palette and canvas, with the real
 * store: one click per wire, the role of the next wire named in a hint, a second click on a picked wire cancels, and
 * the QASM in the editor is exactly what the emitter (checked against the server's fixtures) prints.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { emptyCircuit } from '@/circuit/types'
import { GATE_DISPLAY, MULTI_QUBIT_PLACEMENT, buildMultiQubitOp, placementPrompt, placementRoleLabel } from '@/circuit/gateSpec'
import { gateArityError, GATE_NAMES } from '@/circuit/types'
import { CircuitCanvas } from './CircuitCanvas'
import { GatePalette } from './GatePalette'
import { describeOperation, shortOperationLabel } from './traceFormat'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()

function seed(numQubits: number) {
  act(() => {
    useBuildStore.setState(INITIAL, true)
    useBuildStore.getState().loadCircuit(emptyCircuit(numQubits))
  })
}

const store = () => useBuildStore.getState()

function clickWires(gate: (typeof GATE_NAMES)[number], wires: number[]) {
  act(() => store().selectGate(gate))
  for (const wire of wires) act(() => store().onWireClick(wire))
}

beforeEach(() => seed(3))
afterEach(() => {
  cleanup()
  act(() => useBuildStore.setState(INITIAL, true))
})

describe('the placement spec', () => {
  it('names a display label for every gate the model lists', () => {
    expect(Object.keys(GATE_DISPLAY).sort()).toEqual([...GATE_NAMES].sort())
    expect(GATE_DISPLAY.sdg).toBe('S†')
    expect(GATE_DISPLAY.tdg).toBe('T†')
  })

  it('a finished multi-wire placement always satisfies the gate’s arity', () => {
    for (const [gate, roles] of Object.entries(MULTI_QUBIT_PLACEMENT)) {
      const picked = roles!.map((_, i) => i)
      const op = buildMultiQubitOp(gate as never, picked)
      expect(gateArityError(op), gate).toBeNull()
      expect(op.controls.length + op.targets.length).toBe(roles!.length)
    }
  })

  it('assigns the picked wires to roles in click order', () => {
    expect(buildMultiQubitOp('cx', [2, 0])).toMatchObject({ controls: [2], targets: [0] })
    expect(buildMultiQubitOp('ccx', [1, 2, 0])).toMatchObject({ controls: [1, 2], targets: [0] })
    expect(buildMultiQubitOp('swap', [2, 1])).toMatchObject({ controls: [], targets: [2, 1] })
  })

  it('says which wire comes next', () => {
    expect(placementPrompt('cx', [])).toBe('click a wire to set the control qubit')
    expect(placementPrompt('cx', [1])).toBe('control = q1 · click a wire to set the target qubit')
    expect(placementPrompt('ccx', [])).toBe('click a wire to set the first control qubit')
    expect(placementPrompt('ccx', [0])).toBe('first control = q0 · click a wire to set the second control qubit')
    expect(placementPrompt('ccx', [0, 2])).toBe('first control = q0, second control = q2 · click a wire to set the target qubit')
    expect(placementPrompt('swap', [])).toBe('click a wire to set the first qubit')
    expect(placementPrompt('swap', [1])).toBe('first qubit = q1 · click a wire to set the second qubit')
    expect(placementRoleLabel('cz', 1)).toBe('target')
  })
})

describe('clicking wires in the store', () => {
  it.each([
    ['cx', [2, 0], { controls: [2], targets: [0] }],
    ['cz', [0, 1], { controls: [0], targets: [1] }],
    ['ccx', [2, 0, 1], { controls: [2, 0], targets: [1] }],
    ['swap', [2, 0], { controls: [], targets: [2, 0] }],
  ] as const)('%s takes one click per wire and adds one operation', (gate, wires, expected) => {
    clickWires(gate, [...wires])
    expect(store().circuit.ops).toHaveLength(1)
    expect(store().circuit.ops[0]).toMatchObject({ gate, ...expected })
    expect(store().pendingQubits).toEqual([])
    expect(store().canvasError).toBeNull()
  })

  it('a half-placed gate adds nothing and remembers its wires', () => {
    clickWires('ccx', [0, 1])
    expect(store().circuit.ops).toHaveLength(0)
    expect(store().pendingQubits).toEqual([0, 1])
  })

  it('clicking a wire that is already picked cancels the half-placed gate', () => {
    clickWires('ccx', [0, 1])
    act(() => store().onWireClick(1))
    expect(store().pendingQubits).toEqual([])
    expect(store().circuit.ops).toHaveLength(0)
    expect(store().canvasError).toBeNull() // a cancel, not a rejected placement
  })

  it('re-clicking the first wire of a swap cancels it quietly instead of trying swap(q1, q1)', () => {
    clickWires('swap', [1])
    act(() => store().onWireClick(1))
    expect(store().pendingQubits).toEqual([])
    expect(store().canvasError).toBeNull()
    expect(store().circuit.ops).toHaveLength(0)
  })

  it('choosing another gate or clearing the circuit drops a half-placed gate', () => {
    clickWires('swap', [1])
    act(() => store().selectGate('h'))
    expect(store().pendingQubits).toEqual([])
    clickWires('cx', [0])
    act(() => store().loadCircuit(emptyCircuit(2)))
    expect(store().pendingQubits).toEqual([])
  })

  it('single-wire gates, including the dagger gates, are still one click', () => {
    clickWires('sdg', [1])
    clickWires('tdg', [2])
    expect(store().circuit.ops.map((op) => [op.gate, op.targets])).toEqual([
      ['sdg', [1]],
      ['tdg', [2]],
    ])
  })

  it('the emitted text is what the fixtures pin (server-identical)', () => {
    clickWires('ccx', [2, 0, 1])
    clickWires('swap', [2, 0])
    clickWires('cz', [1, 2])
    clickWires('sdg', [0])
    expect(store().qasmText).toBe(
      'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[3] q;\nbit[3] c;\nccx q[2], q[0], q[1];\nswap q[2], q[0];\ncz q[1], q[2];\nsdg q[0];\n',
    )
  })

  it('the QASM editor path accepts the new gates and refuses a malformed one without changing the circuit', () => {
    expect(store().applyQasmEdit('OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[3] q;\nccx q[0], q[1], q[2];\nswap q[0], q[2];\n')).toEqual({ ok: true })
    expect(store().circuit.ops.map((op) => op.gate)).toEqual(['ccx', 'swap'])
    const before = store().circuit
    const result = store().applyQasmEdit('OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[3] q;\nccx q[0], q[1];\n')
    expect(result.ok).toBe(false)
    expect(store().circuit).toBe(before)
  })
})

describe('the palette', () => {
  it('lists every gate in the model, with the multi-wire gates and the dagger gates', () => {
    render(<GatePalette />)
    for (const label of ['H', 'X', 'Y', 'Z', 'S', 'S†', 'T', 'T†', 'RX', 'RY', 'RZ', 'CX', 'CZ', 'CCX', 'SWAP', 'M']) {
      expect(screen.getByRole('button', { name: label }), label).toBeInTheDocument()
    }
  })

  it('says which wire to click next, and updates as wires are picked', () => {
    render(<GatePalette />)
    fireEvent.click(screen.getByRole('button', { name: 'CCX' }))
    expect(screen.getByText('click a wire to set the first control qubit')).toBeInTheDocument()
    act(() => store().onWireClick(0))
    expect(screen.getByText('first control = q0 · click a wire to set the second control qubit')).toBeInTheDocument()
    act(() => store().onWireClick(2))
    expect(screen.getByText(/click a wire to set the target qubit/)).toBeInTheDocument()
    act(() => store().onWireClick(1))
    // the gate stays selected for the next placement, so the hint starts over
    expect(screen.getByText('click a wire to set the first control qubit')).toBeInTheDocument()
    expect(store().circuit.ops[0]).toMatchObject({ gate: 'ccx', controls: [0, 2], targets: [1] })
  })

  it('gives each multi-wire gate a title that says how it is placed', () => {
    render(<GatePalette />)
    expect(screen.getByRole('button', { name: 'CCX' }).title).toContain('two control wires')
    expect(screen.getByRole('button', { name: 'SWAP' }).title).toContain('two wires')
  })
})

describe('the canvas', () => {
  function appendCell(qubit: number) {
    const row = screen.getByText(`q[${qubit}]`).parentElement as HTMLElement
    return within(row).getByTitle(/place .* on q\[\d\]|drag a gate here/)
  }

  it('shows a Toffoli as a dot on each control wire and the target symbol on the target wire', () => {
    render(
      <>
        <GatePalette />
        <CircuitCanvas />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'CCX' }))
    fireEvent.click(appendCell(0))
    fireEvent.click(appendCell(1))
    fireEvent.click(appendCell(2))
    expect(store().circuit.ops[0]).toMatchObject({ gate: 'ccx', controls: [0, 1], targets: [2] })
    const removeButtons = screen.getAllByTitle(/CCX — controls q0, q1, target q2 · click to remove/)
    expect(removeButtons).toHaveLength(3) // two control dots and the target box
    expect(removeButtons.filter((b) => b.textContent === 'X')).toHaveLength(1)
  })

  it('shows a swap as × on both wires and removes it with one click', () => {
    render(
      <>
        <GatePalette />
        <CircuitCanvas />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'SWAP' }))
    fireEvent.click(appendCell(0))
    fireEvent.click(appendCell(2))
    const boxes = screen.getAllByTitle(/SWAP — q0 and q2 · click to remove/)
    expect(boxes.map((b) => b.textContent)).toEqual(['×', '×'])
    fireEvent.click(boxes[0])
    expect(store().circuit.ops).toHaveLength(0)
  })

  it('a controlled-Z shows a Z on its target', () => {
    render(
      <>
        <GatePalette />
        <CircuitCanvas />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'CZ' }))
    fireEvent.click(appendCell(1))
    fireEvent.click(appendCell(0))
    expect(screen.getAllByTitle(/CZ — control q1, target q0/).map((b) => b.textContent).sort()).toEqual(['', 'Z'])
  })

  it('a dagger gate shows its dagger', () => {
    render(
      <>
        <GatePalette />
        <CircuitCanvas />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'S†' }))
    fireEvent.click(appendCell(0))
    expect(screen.getByTitle(/S† on q0 · click to remove/).textContent).toBe('S†')
  })

  it('the wire where a half-placed gate started is highlighted', () => {
    render(
      <>
        <GatePalette />
        <CircuitCanvas />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'CCX' }))
    fireEvent.click(appendCell(1))
    expect(appendCell(1).className).toContain('border-violet-glow')
    expect(appendCell(0).className).not.toContain('border-violet-glow')
  })
})

describe('trace labels for the new gates', () => {
  const op = (gate: string, fields: object) => ({ gate, targets: [], controls: [], params: [], clbits: [], ...fields }) as never
  it('short labels', () => {
    expect(shortOperationLabel(op('ccx', { controls: [0, 1], targets: [2] }))).toBe('CCX q0,q1→q2')
    expect(shortOperationLabel(op('swap', { targets: [0, 2] }))).toBe('SWAP q0↔q2')
    expect(shortOperationLabel(op('cz', { controls: [1], targets: [0] }))).toBe('CZ q1→q0')
    expect(shortOperationLabel(op('sdg', { targets: [1] }))).toBe('S† q1')
    expect(shortOperationLabel(op('cx', { controls: [0], targets: [1] }))).toBe('CX q0→q1')
    expect(shortOperationLabel(op('h', { targets: [0] }))).toBe('H q0')
  })

  it('full descriptions', () => {
    expect(describeOperation(op('ccx', { controls: [2, 0], targets: [1] }))).toBe('CCX — controls q2, q0, target q1')
    expect(describeOperation(op('swap', { targets: [0, 2] }))).toBe('SWAP — q0 and q2')
    expect(describeOperation(op('tdg', { targets: [0] }))).toBe('T† on q0')
    expect(describeOperation(op('cx', { controls: [0], targets: [1] }))).toBe('CX — control q0, target q1')
  })
})
