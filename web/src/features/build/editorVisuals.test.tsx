/**
 * How the circuit editor LOOKS and reads — the visual layer of the canvas and the palette, over the one canonical circuit (the
 * behaviour tests are `editorCanvas.test.tsx` and `gatePlacement.test.tsx`). jsdom does no layout, so these pin the structure that
 * makes the drawing right: which family colours a gate, that a controlled gate is a dot, a round target and ONE line through every
 * wire between them, where that line starts and stops on each wire, that the angle is written on a controlled phase, that the
 * insertion point is a dashed guide through every wire with the next gate previewed under the pointer, that a refused placement
 * says so in the cells themselves, that an empty circuit invites, and that a trace step marks its gate. The real layout (spacing,
 * alignment, long circuits, 390 px and 320 px) is checked in Chrome.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import { bellWithQubitStates } from '@/test/traceFixtures'
import { CircuitCanvas } from './CircuitCanvas'
import { GatePalette } from './GatePalette'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const store = () => useBuildStore.getState()
const op = (gate: GateOp['gate'], targets: number[], controls: number[] = [], params: number[] = [], clbits: number[] = []): GateOp => ({ gate, targets, controls, params, clbits })

function load(ops: GateOp[], qubits = 3) {
  act(() => {
    store().loadCircuit({ ...emptyCircuit(qubits, qubits), ops } as Circuit)
    useBuildStore.setState({ past: [], future: [] })
  })
}
const mount = () =>
  render(
    <>
      <GatePalette />
      <CircuitCanvas />
    </>,
  )
const row = (q: number) => within(screen.getByRole('group', { name: `Qubit ${q}` }))
const connectors = (q: number) => row(q).queryAllByTestId('gate-connector')
const tile = (label: RegExp | string) => screen.getByRole('button', { name: label })

beforeEach(() => useBuildStore.setState(INITIAL, true))
afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL, true)
})

describe('gate tiles', () => {
  it('every tile has the same size and a readable label, and its family is named on it', () => {
    load([op('h', [0]), op('x', [0]), op('s', [1]), op('rx', [1], [], [Math.PI / 2]), op('measure', [2], [], [], [0])])
    mount()
    const boxes = [...document.querySelectorAll<HTMLElement>('button[data-op-index]')]
    expect(boxes.map((b) => b.getAttribute('data-family'))).toEqual(['hadamard', 'pauli', 'phase', 'rotation', 'measure'])
    for (const b of boxes) {
      expect(b.className).toContain('h-9')
      expect(b.className).toContain('w-9')
    }
    expect(boxes.map((b) => b.firstChild?.textContent ?? b.textContent)).toEqual(['H', 'X', 'S', 'RX', 'M'])
  })

  it('the families differ in colour AND in what else the tile carries (colour is never the only signal)', () => {
    load([op('h', [0]), op('s', [1]), op('rx', [2], [], [Math.PI / 2])])
    mount()
    const cls = (family: string) => document.querySelector<HTMLElement>(`button[data-family="${family}"]`)!.className
    expect(cls('hadamard')).toContain('text-cyan-glow')
    expect(cls('phase')).toContain('text-violet-glow')
    expect(cls('rotation')).toContain('text-amber-glow')
    // a rotation also writes its angle on the tile
    expect(screen.getByTestId('gate-angle')).toHaveTextContent('π/2')
  })

  it('a rotation shows its angle the way a textbook writes it, and a plain decimal otherwise', () => {
    load([op('rz', [0], [], [0.5]), op('ry', [1], [], [-Math.PI / 4])])
    mount()
    expect(screen.getAllByTestId('gate-angle').map((n) => n.textContent)).toEqual(['0.50', '-π/4'])
  })

  it('a single-wire gate is a square tile, a controlled gate’s target is round, and the two are told apart by shape', () => {
    load([op('h', [0]), op('cx', [2], [1])])
    mount()
    expect(tile('H on q0, step 1 of 2').className).toContain('rounded-md')
    const target = tile(/^CX — control q1, target q2, step 2 of 2/)
    expect(target.className).toContain('rounded-full')
    expect(target.textContent).toBe('X')
  })

  it('the picked gate is clearly marked (pressed, white border, ring), not just recoloured', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    fireEvent.click(tile('H on q0, step 1 of 2'))
    const picked = tile('H on q0, step 1 of 2')
    expect(picked).toHaveAttribute('aria-pressed', 'true')
    expect(picked.className).toContain('border-white')
    expect(picked.className).toContain('ring-2')
    expect(tile('X on q1, step 2 of 2').className).not.toContain('ring-2')
  })
})

describe('controlled and multi-wire gates: dot, target, and the line between them', () => {
  it('CX on adjacent wires: a control dot, a round target, and one connecting line that meets in the gap between the wires', () => {
    load([op('cx', [1], [0])])
    mount()
    expect(row(0).getAllByTestId('control-dot')).toHaveLength(1)
    expect(row(1).queryAllByTestId('control-dot')).toHaveLength(0)
    // the control wire's line runs down from its centre, the target wire's runs up to its centre
    expect(connectors(0).map((c) => c.className)).toEqual([expect.stringContaining('top-1/2 -bottom-3')])
    expect(connectors(1).map((c) => c.className)).toEqual([expect.stringContaining('-top-3 bottom-1/2')])
    expect(connectors(2)).toHaveLength(0) // the third wire is not touched
    for (const c of [...connectors(0), ...connectors(1)]) expect(c).toHaveAttribute('aria-hidden', 'true') // drawing only: the gate's button carries the name
  })

  it('CX across a wire it does not touch: the line passes through that wire’s cell with nothing on it', () => {
    load([op('cx', [2], [0])])
    mount()
    expect(connectors(1).map((c) => c.className)).toEqual([expect.stringContaining('-top-3 -bottom-3')])
    expect(row(1).queryAllByRole('button').filter((b) => b.getAttribute('data-op-index') !== null)).toHaveLength(0) // no gate on wire 1
    expect(row(1).queryAllByTestId('control-dot')).toHaveLength(0)
    // the line is the same colour end to end
    const all = [0, 1, 2].flatMap((q) => connectors(q))
    expect(new Set(all.map((c) => c.className.match(/bg-\S+/)?.[0])).size).toBe(1)
  })

  it('Toffoli: two dots, one round target, and the line through all three wires', () => {
    load([op('ccx', [2], [0, 1])])
    mount()
    expect([0, 1].flatMap((q) => row(q).getAllByTestId('control-dot'))).toHaveLength(2)
    expect(connectors(0)[0]!.className).toContain('top-1/2 -bottom-3')
    expect(connectors(1)[0]!.className).toContain('-top-3 -bottom-3')
    expect(connectors(2)[0]!.className).toContain('-top-3 bottom-1/2')
    expect(row(2).getByRole('button', { name: /^CCX — controls q0, q1, target q2/ }).className).toContain('rounded-full')
  })

  it('CZ is a dot and a Z target joined by the line', () => {
    load([op('cz', [1], [0])])
    mount()
    expect(row(0).getAllByTestId('control-dot')).toHaveLength(1)
    expect(row(1).getByRole('button', { name: /^CZ/ }).textContent).toBe('Z')
    expect(connectors(0)).toHaveLength(1)
    expect(connectors(1)).toHaveLength(1)
  })

  it('a swap is two × marks joined by a line, with no control dot', () => {
    load([op('swap', [0, 2])])
    mount()
    const marks = screen.getAllByTitle(/^SWAP/)
    expect(marks.map((m) => m.textContent)).toEqual(['×', '×'])
    expect(document.querySelectorAll('[data-testid="control-dot"]')).toHaveLength(0)
    expect([0, 1, 2].map((q) => connectors(q).length)).toEqual([1, 1, 1])
    expect(connectors(0)[0]!.className).toContain('bg-cyan-glow') // a swap's own colour, not a control's
  })

  it('a single-wire gate has no line at all', () => {
    load([op('h', [0]), op('rx', [1], [], [1])])
    mount()
    expect(document.querySelectorAll('[data-testid="gate-connector"]')).toHaveLength(0)
  })

  it('a controlled phase writes its angle on the line, on the target tile too, and only once', () => {
    load([op('cp', [2], [0], [Math.PI / 2])])
    mount()
    const chip = screen.getByTestId('connector-angle')
    expect(chip).toHaveTextContent('φ π/2')
    expect(chip).toHaveAttribute('aria-hidden', 'true') // the gate's accessible name already carries the angle
    expect(screen.getAllByTestId('connector-angle')).toHaveLength(1)
    expect(screen.getByTestId('gate-angle')).toHaveTextContent('π/2') // on the target tile
    expect(row(0).getByTestId('connector-angle')).toBeInTheDocument() // beside the first wire, in the gap above the next
    expect(row(2).getByRole('button', { name: /^CP/ }).getAttribute('aria-label')).toContain('1.571')
  })

  it('the control dot is a button of its own that picks the whole gate', () => {
    load([op('cx', [1], [0])])
    mount()
    fireEvent.click(row(0).getByRole('button', { name: /control on q\[0\]/ }))
    expect(store().selectedOpIndex).toBe(0)
    expect(screen.getByTestId('selected-op')).toHaveTextContent('CX — control q0, target q1')
  })
})

describe('the picked gate: details, and its place in the trace', () => {
  it('names the gate’s family and what it is, beside the step number', () => {
    load([op('cx', [1], [0])])
    mount()
    fireEvent.click(row(1).getByRole('button', { name: /^CX — control q0, target q1/ }))
    const detail = screen.getByTestId('selected-op-detail')
    expect(detail).toHaveTextContent('Controlled')
    expect(detail).toHaveTextContent('Controlled-X (CNOT)')
    expect(screen.getByTestId('selected-op').textContent).toBe('CX — control q0, target q1 · step 1 of 1') // unchanged wording
  })

  it('says which trace step applied it once a trace exists, and nothing before', () => {
    load([op('h', [0]), op('cx', [1], [0])], 2)
    mount()
    fireEvent.click(tile('H on q0, step 1 of 2'))
    expect(screen.queryByTestId('selected-op-trace')).not.toBeInTheDocument()
    act(() => useBuildStore.setState({ trace: bellWithQubitStates(), selectedTraceStep: 0 }))
    expect(screen.getByTestId('selected-op-trace')).toHaveTextContent('trace step 2 of 3') // step 1 is the initial state
    act(() => store().selectOp(1))
    expect(screen.getByTestId('selected-op-trace')).toHaveTextContent('trace step 3 of 3')
  })

  it('marks the gate behind the selected trace step with an amber marker, and only that gate', () => {
    load([op('h', [0]), op('cx', [1], [0])], 2)
    mount()
    act(() => useBuildStore.setState({ trace: bellWithQubitStates(), selectedTraceStep: 1 }))
    const marked = screen.getAllByTestId('traced-marker')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.closest('button')).toHaveAttribute('aria-label', 'H on q0, step 1 of 2, shown in the trace')
    act(() => useBuildStore.setState({ selectedTraceStep: 2 }))
    expect(screen.getAllByTestId('traced-marker').map((m) => m.closest('button')!.getAttribute('aria-label'))).toEqual([
      'CX — control q0, target q1, step 2 of 2, shown in the trace',
    ])
    act(() => useBuildStore.setState({ selectedTraceStep: 0 })) // the initial state: no gate
    expect(screen.queryByTestId('traced-marker')).not.toBeInTheDocument()
  })
})

describe('insertion points', () => {
  it('the next gate’s column is a dashed guide through every wire, named "next", with a handle before each gate', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    expect(screen.getAllByTestId('insertion-guide')).toHaveLength(3) // one segment per wire
    expect(screen.getByText('▾ next')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Where the next gate goes' })).toHaveTextContent('The next gate goes here')
    expect(screen.getByRole('button', { name: 'Insert before step 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Insert before step 2' })).toBeInTheDocument()
    const [first, middle, last] = [0, 1, 2].map((q) => row(q).getByTestId('insertion-guide').className)
    expect(first).toContain('top-1/2 -bottom-3')
    expect(middle).toContain('-top-3 -bottom-3')
    expect(last).toContain('-top-3 bottom-1/2')
    expect([first, middle, last].every((c) => c.includes('border-dashed'))).toBe(true)
  })

  it('choosing a handle moves the column into the middle and offers a way back to the end', () => {
    load([op('h', [0]), op('x', [1])])
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Insert before step 2' }))
    expect(store().insertAt).toBe(1)
    expect(screen.getByRole('button', { name: 'Insert at the end' })).toBeInTheDocument()
    expect(screen.getAllByTestId('insertion-guide')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Insert at the end' }))
    expect(store().insertAt).toBeNull()
  })

  it('a single-qubit circuit has nothing to join, so no guide line, but still the "next" marker', () => {
    load([op('h', [0])], 1)
    mount()
    expect(screen.queryAllByTestId('insertion-guide')).toHaveLength(0)
    expect(screen.getByText('▾ next')).toBeInTheDocument()
  })
})

describe('hover preview: what the next click will place', () => {
  const cells = () => screen.getAllByTitle(/place .* on q\[\d\]|drag a gate here/)

  it('with nothing picked there is nothing to preview', () => {
    load([])
    mount()
    for (const c of cells()) expect(c).not.toHaveAttribute('data-ghost')
  })

  it('a single-wire gate previews its own letters under the pointer', () => {
    load([])
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'H' }))
    for (const c of cells()) expect(c).toHaveAttribute('data-ghost', 'H')
    expect(cells()[0]!.className).toContain('hover:after:content-[attr(data-ghost)]')
    // the preview is drawn by CSS from the attribute: it adds no text, so nothing reads it twice
    for (const c of cells()) expect(c.textContent).toBe('+')
  })

  it('a controlled gate previews a dot for the control wire, then its target symbol', () => {
    load([])
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'CX' }))
    expect(cells().map((c) => c.getAttribute('data-ghost'))).toEqual(['●', '●', '●'])
    act(() => store().onWireClick(0))
    expect(cells().map((c) => c.getAttribute('data-ghost'))).toEqual(['X', 'X', 'X'])
  })

  it('a Toffoli previews dot, dot, then target; a swap previews × for both wires; a rotation its letters', () => {
    load([])
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'CCX' }))
    const ghosts = () => cells().map((c) => c.getAttribute('data-ghost'))[0]
    expect(ghosts()).toBe('●')
    act(() => store().onWireClick(0))
    expect(ghosts()).toBe('●')
    act(() => store().onWireClick(1))
    expect(ghosts()).toBe('X')
    fireEvent.click(screen.getByRole('button', { name: 'SWAP' }))
    expect(ghosts()).toBe('×')
    fireEvent.click(screen.getByRole('button', { name: 'RY' }))
    expect(ghosts()).toBe('RY')
  })

  it('the cell already chosen as a control is marked as chosen', () => {
    load([])
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'CX' }))
    act(() => store().onWireClick(1))
    const chosen = screen.getByRole('button', { name: 'Place cx on qubit 1 (already chosen)' })
    expect(chosen).toHaveAttribute('aria-pressed', 'true')
    expect(chosen.className).toContain('border-violet-glow')
  })
})

describe('invalid placement', () => {
  it('a refused edit turns the insertion cells red, beside the reason in the palette, and a new pick clears it', () => {
    load([op('h', [0])], 2)
    mount()
    fireEvent.click(tile('H on q0, step 1 of 1'))
    act(() => store().shiftOp(0, -1)) // up from wire 0: off the register
    expect(store().canvasError).toBeTruthy()
    const cells = screen.getAllByTitle(/drag a gate here/)
    for (const c of cells) {
      expect(c).toHaveAttribute('data-invalid', 'true')
      expect(c.className).toContain('border-danger-glow')
    }
    expect(screen.getByRole('alert')).toHaveTextContent(String(store().canvasError)) // the reason, once, as an alert
    expect(store().circuit.ops).toHaveLength(1) // and the circuit is untouched
    fireEvent.click(screen.getByRole('button', { name: 'X' }))
    expect(store().canvasError).toBeNull()
    for (const c of screen.getAllByTitle(/place x on q\[\d\]/)) expect(c).not.toHaveAttribute('data-invalid')
  })
})

describe('an empty circuit invites', () => {
  it('says how to start, right beside the first insertion point, and goes away with the first gate', () => {
    load([])
    mount()
    const hint = screen.getByTestId('empty-circuit-hint')
    expect(hint).toHaveTextContent('Drag a gate onto a qubit wire')
    expect(hint).toHaveTextContent('pick one below, then click a wire')
    expect(screen.getAllByTitle(/drag a gate here/)).toHaveLength(3) // and every wire has its drop cell
    act(() => store().loadCircuit({ ...emptyCircuit(3, 3), ops: [op('h', [0])] }))
    expect(screen.queryByTestId('empty-circuit-hint')).not.toBeInTheDocument()
  })
})

describe('the palette: compact, grouped and consistent with the canvas', () => {
  it('keeps every gate in one scrolling strip (it never wraps into a tall block), groups them, and names the groups', () => {
    render(<GatePalette />)
    const strip = screen.getByRole('toolbar', { name: 'Gate palette' })
    expect(strip.className).toContain('overflow-x-auto')
    expect(strip.className).toContain('max-w-full')
    expect(strip.className).not.toContain('flex-wrap')
    for (const caption of ['1 qubit', 'Rotate', 'Several qubits']) expect(within(strip).getByText(caption)).toHaveAttribute('aria-hidden', 'true') // names, not controls
    expect(within(strip).getAllByRole('button')).toHaveLength(17)
  })

  it('every button is short (compact) and carries its family, the same family the canvas tile will have', () => {
    render(<GatePalette />)
    const family = (name: string) => screen.getByRole('button', { name }).getAttribute('data-family')
    expect([family('H'), family('X'), family('S†'), family('RX'), family('CX'), family('SWAP'), family('M')]).toEqual([
      'hadamard',
      'pauli',
      'phase',
      'rotation',
      'controlled',
      'swap',
      'measure',
    ])
    expect(screen.getByRole('button', { name: 'H' }).className).toContain('h-8')
  })

  it('shows a dot-and-ring glyph on exactly the gates that join wires', () => {
    render(<GatePalette />)
    const hasGlyph = (name: string) => within(screen.getByRole('button', { name })).queryByTestId('gate-glyph') !== null
    for (const name of ['CX', 'CZ', 'CP', 'CCX', 'SWAP']) expect(hasGlyph(name), name).toBe(true)
    for (const name of ['H', 'X', 'S', 'RX', 'M']) expect(hasGlyph(name), name).toBe(false)
    // the glyph is a picture: it adds no text to the button's name
    expect(screen.getByRole('button', { name: 'CX' }).textContent).toBe('CX')
  })

  it('the picked gate is the one filled button, and a gate a challenge disallows is shown but cannot be used', () => {
    render(<GatePalette allowedGates={['h', 'cx']} />)
    fireEvent.click(screen.getByRole('button', { name: 'H' }))
    expect(screen.getByRole('button', { name: 'H' }).className).toContain('bg-cyan-glow')
    expect(screen.getByRole('button', { name: 'X' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'X' }).title).toContain('not allowed in this challenge')
  })
})

describe('long circuits and narrow screens', () => {
  it('a long circuit scrolls inside its own box instead of widening the page, and its lines stay inside that box', () => {
    const ops: GateOp[] = []
    for (let i = 0; i < 40; i++) ops.push(i % 3 === 0 ? op('cx', [2], [0]) : i % 3 === 1 ? op('h', [i % 2]) : op('ccx', [2], [0, 1]))
    load(ops)
    const { container } = render(<CircuitCanvas />)
    const scroller = container.querySelector<HTMLElement>('.circuit-grid-bg')!
    expect(scroller.className).toContain('overflow-auto')
    expect(scroller.className).toContain('relative')
    const lines = [...scroller.querySelectorAll('[data-testid="gate-connector"], [data-testid="connector-angle"], [data-testid="insertion-guide"]')]
    expect(lines.length).toBeGreaterThan(40)
    for (const line of lines) {
      let anchored = false
      for (let p: Element | null = line.parentElement; p; p = p.parentElement) {
        if (['relative', 'absolute', 'fixed', 'sticky'].some((c) => p!.classList.contains(c))) anchored = true
        if (p === scroller) break
      }
      expect(anchored, `${line.getAttribute('data-testid')} is not anchored inside the scroller`).toBe(true)
    }
  })

  it('every wire keeps one row height and pitch (36 px cells, 24 px apart) so the lines of neighbouring wires meet', () => {
    load([op('cx', [2], [0])])
    const { container } = render(<CircuitCanvas />)
    const rows = container.querySelectorAll('[role="group"][aria-label^="Qubit "]')
    expect(rows).toHaveLength(3)
    const cellsOf = (r: Element) => [...r.querySelectorAll('.relative.z-10.flex')]
    for (const r of rows) for (const cell of cellsOf(r)) expect(cell.className, 'cell').toContain('h-9')
    const stack = container.querySelector('.flex.flex-col.gap-6')
    expect(stack).not.toBeNull() // 1.5 rem between wires: half of it (0.75 rem) is the `-top-3` / `-bottom-3` the connectors reach
  })

  it('the palette strip, the edit toolbar and the title row can all wrap or scroll on a phone', () => {
    load([op('h', [0])])
    const { container } = mount()
    expect(screen.getByRole('toolbar', { name: 'Gate palette' }).className).toContain('overflow-x-auto')
    expect(screen.getByRole('toolbar', { name: 'Edit the selected gate' }).className).toContain('flex-wrap')
    expect(screen.getByText(/^Circuit ·/).parentElement?.className).toContain('flex-wrap')
    expect(container).toBeTruthy()
  })
})
