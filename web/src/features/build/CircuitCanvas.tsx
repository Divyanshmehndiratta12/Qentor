/**
 * The circuit canvas: place gates (click or drag from the palette), insert them in the middle, pick a gate to move or delete it,
 * undo and redo. It only ever edits the canonical `Circuit` in `useBuildStore`, through the store's editing actions
 * (`qentor/circuit/edit.ts`): there is no canvas-only circuit state, and it never computes or shows a quantum number.
 *
 * How each interaction works, with its keyboard equivalent (nothing here is drag-only):
 *
 *  - Place: pick a gate in the palette, then click a wire in the dashed column (or drag the gate onto it).
 *  - Insert in the middle: the ▾ handles above the columns choose where the dashed column goes; the next gate is placed there and
 *    the column moves on, so a run of gates goes in order. The handles are buttons.
 *  - Pick a gate: click it (or Tab to it and press Enter). The toolbar then offers Move earlier / later / up / down and Delete;
 *    Alt+←/→ move it in time, Alt+↑/↓ across wires, Delete removes it, Escape lets go.
 *  - Drag a placed gate onto another column or row to move it (the same edit as the buttons).
 *  - Undo / Redo: the buttons, or Ctrl+Z and Ctrl+Shift+Z (Ctrl+Y) outside the code editor.
 *
 * How it reads (all presentation; the circuit is unchanged by any of it):
 *
 *  - A gate on one wire is a square tile coloured by its family (Hadamard, Pauli, phase, rotation, measurement). A gate on several
 *    wires is drawn the way circuit diagrams draw it: a dot on each control, a ROUND tile on the target, and one vertical line
 *    through every wire between them; a controlled phase also writes its angle on that line, a swap joins its two × marks.
 *  - The dashed column is the insertion point: a dashed guide runs through every wire, the next gate is previewed in the cell under
 *    the pointer, and a placement the editor refuses turns the cells red beside the reason.
 *  - The operation behind the selected trace step has an amber marker, so the trace and the circuit read together; the selected gate's
 *    details say which trace step it is.
 *
 * A refused edit (a wire that does not exist, a gate that would leave the register) leaves the circuit untouched and says why in the
 * palette's status line.
 */
import { useRef } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { useBuildStore } from './store'
import { GATE_DND_MIME } from './GatePalette'
import { shiftOpWires } from '@/circuit/edit'
import type { GateName, GateOp } from '@/circuit/types'
import { GATE_DISPLAY, MULTI_QUBIT_PLACEMENT, TARGET_SYMBOL, gateTakesAngle } from '@/circuit/gateSpec'
import { FAMILY_LABEL, FAMILY_LINE, FAMILY_TILE, GATE_NAME, gateFamily, ghostLabel } from '@/circuit/gateVisual'
import { describeOperation, displayStepNumber } from './traceFormat'
import { useEditShortcuts } from './useEditShortcuts'
import { describeAngle } from '@/circuit/angle'

export const OP_DND_MIME = 'application/x-qentor-op'

type Column = { kind: 'op'; index: number } | { kind: 'slot' }

const ACTION_BUTTON =
  'rounded border border-void-400 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-void-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-35'

/** Where a wire sits along a multi-wire gate's vertical line: its first wire, its last, or one in between. */
type Span = 'start' | 'middle' | 'end'

/**
 * The vertical line of a multi-wire gate (or of the insertion guide) through one wire's cell. Rows are 2.25rem tall and 1.5rem apart, so
 * 0.75rem past the cell on a side reaches half way to the next wire: lines from neighbouring cells meet without a gap.
 */
function Connector({ span, className, dashed = false }: { span: Span; className: string; dashed?: boolean }) {
  const place = span === 'start' ? 'top-1/2 -bottom-3' : span === 'end' ? '-top-3 bottom-1/2' : '-top-3 -bottom-3'
  return (
    <span
      aria-hidden="true"
      data-testid={dashed ? 'insertion-guide' : 'gate-connector'}
      className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${place} ${
        dashed ? 'w-0 border-l-2 border-dashed border-cyan-glow/35' : `w-0.5 ${className}`
      }`}
    />
  )
}

function GateBox({
  op,
  index,
  total,
  selected,
  traced,
  onSelect,
}: {
  op: GateOp
  index: number
  total: number
  selected: boolean
  traced: boolean
  onSelect: () => void
}) {
  // On the wire it acts ON, a controlled gate shows the operation (X, Z); a swap shows × on both wires.
  const label = TARGET_SYMBOL[op.gate] ?? GATE_DISPLAY[op.gate]
  const family = gateFamily(op.gate)
  // The target of a controlled gate is round (the diagram's ⊕), so it reads differently from a gate on a single wire.
  const shape = op.controls.length > 0 ? 'rounded-full' : 'rounded-md'
  return (
    <button
      type="button"
      onClick={onSelect}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(OP_DND_MIME, String(index))
        e.dataTransfer.effectAllowed = 'move'
      }}
      data-op-index={index}
      data-family={family}
      aria-pressed={selected}
      aria-label={`${describeOperation(op)}, step ${index + 1} of ${total}${traced ? ', shown in the trace' : ''}`}
      title={`${describeOperation(op)} · click to pick, then move or delete`}
      className={`relative flex h-9 w-9 cursor-grab flex-col items-center justify-center ${shape} border font-mono-qasm text-xs font-semibold shadow-sm transition-[transform,box-shadow,border-color] hover:-translate-y-px hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow active:cursor-grabbing ${
        selected ? 'border-white bg-violet-dim text-white ring-2 ring-violet-glow/80' : FAMILY_TILE[family]
      } ${traced ? 'outline-2 outline-offset-2 outline-amber-glow' : ''}`}
    >
      {gateTakesAngle(op.gate) ? (
        <>
          <span className="leading-none">{label}</span>
          <span className="mt-0.5 text-[9px] leading-none font-medium" data-testid="gate-angle">
            {describeAngle(op.params[0])}
          </span>
        </>
      ) : (
        label
      )}
      {traced && <span aria-hidden="true" data-testid="traced-marker" className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border border-void-950 bg-amber-glow" />}
    </button>
  )
}

/** `lockQubits`: a challenge fixes the number of qubits, so the add/remove controls are not offered. */
export function CircuitCanvas({ lockQubits = false }: { lockQubits?: boolean } = {}) {
  const circuit = useBuildStore((s) => s.circuit)
  const onWireClick = useBuildStore((s) => s.onWireClick)
  const removeOpAt = useBuildStore((s) => s.removeOpAt)
  const selectedGate = useBuildStore((s) => s.selectedGate)
  const selectGate = useBuildStore((s) => s.selectGate)
  const pendingQubits = useBuildStore((s) => s.pendingQubits)
  const canvasError = useBuildStore((s) => s.canvasError)
  const setQubits = useBuildStore((s) => s.setNumQubits)
  const selectedOp = useBuildStore((s) => s.selectedOpIndex)
  const selectOp = useBuildStore((s) => s.selectOp)
  const insertAt = useBuildStore((s) => s.insertAt)
  const setInsertAt = useBuildStore((s) => s.setInsertAt)
  const moveOpTo = useBuildStore((s) => s.moveOpTo)
  const shiftOp = useBuildStore((s) => s.shiftOp)
  const dropOp = useBuildStore((s) => s.dropOp)
  const undo = useBuildStore((s) => s.undo)
  const redo = useBuildStore((s) => s.redo)
  const canUndo = useBuildStore((s) => s.past.length > 0)
  const canRedo = useBuildStore((s) => s.future.length > 0)
  const tracedOp = useBuildStore((s) => s.trace?.steps[s.selectedTraceStep]?.operationIndex ?? null)
  // Which trace step applied the selected gate (-1: none, or no trace yet), and how many steps the trace has.
  const selectedGateStep = useBuildStore((s) => (s.selectedOpIndex === null || !s.trace ? -1 : s.trace.steps.findIndex((st) => st.operationIndex === s.selectedOpIndex)))
  const traceLength = useBuildStore((s) => s.trace?.steps.length ?? 0)
  const root = useRef<HTMLDivElement>(null)
  useEditShortcuts()

  const numQubits = circuit.num_qubits
  const total = circuit.ops.length
  const slotAt = insertAt === null ? total : Math.min(insertAt, total)
  const columns: Column[] = []
  for (let i = 0; i <= total; i++) {
    if (i === slotAt) columns.push({ kind: 'slot' })
    if (i < total) columns.push({ kind: 'op', index: i })
  }
  const trailingHandle = slotAt !== total // the slot is in the middle: a handle is needed to put it back at the end
  const gridColumns = columns.length + (trailingHandle ? 1 : 0)
  const selected = selectedOp !== null ? circuit.ops[selectedOp] : undefined

  // What the dashed cell under the pointer previews: the role the next click gives that wire (a control dot, a target, or the gate itself).
  const ghost = selectedGate
    ? ghostLabel(pendingQubits.length, MULTI_QUBIT_PLACEMENT[selectedGate], GATE_DISPLAY[selectedGate], TARGET_SYMBOL[selectedGate])
    : undefined

  const focusOp = (index: number) =>
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-op-index="${index}"]`)?.focus())

  function dropOnCell(e: DragEvent<HTMLElement>, column: Column, q: number) {
    e.preventDefault()
    const movedOp = e.dataTransfer.getData(OP_DND_MIME)
    if (movedOp !== '') {
      const from = Number(movedOp)
      // On a gate's column the dragged gate takes that gate's place; on the dashed column it goes where the slot is.
      const to = column.kind === 'op' ? column.index : from < slotAt ? slotAt - 1 : slotAt
      const clamped = Math.min(Math.max(to, 0), total - 1)
      dropOp(from, clamped, q)
      focusOp(clamped)
      return
    }
    const gate = e.dataTransfer.getData(GATE_DND_MIME)
    if (!gate) return
    setInsertAt(column.kind === 'op' ? column.index : slotAt >= total ? null : slotAt)
    selectGate(gate as GateName)
    onWireClick(q)
  }

  /** The handlers that make a cell a drop target (for a dragged gate or a gate dragged from the palette). */
  const dropTarget = (column: Column, q: number) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e: DragEvent<HTMLElement>) => dropOnCell(e, column, q),
  })

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (selectedOp === null) return
    if (e.key === 'Escape') {
      selectOp(null)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      removeOpAt(selectedOp)
      return
    }
    if (!e.altKey) return
    const step: Record<string, () => void> = {
      ArrowLeft: () => selectedOp > 0 && (moveOpTo(selectedOp, selectedOp - 1), focusOp(selectedOp - 1)),
      ArrowRight: () => selectedOp < total - 1 && (moveOpTo(selectedOp, selectedOp + 1), focusOp(selectedOp + 1)),
      ArrowUp: () => (shiftOp(selectedOp, -1), focusOp(selectedOp)),
      ArrowDown: () => (shiftOp(selectedOp, 1), focusOp(selectedOp)),
    }
    const action = step[e.key]
    if (action) {
      e.preventDefault()
      action()
    }
  }

  return (
    <div ref={root} className="flex h-full flex-col" role="group" aria-label="Circuit editor" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-1.5 pb-0.5">
        <span className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
          Circuit · {numQubits} qubit{numQubits === 1 ? '' : 's'} · {total} op{total === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" className={ACTION_BUTTON}>
            ↶ Undo
          </button>
          <button type="button" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo" className={ACTION_BUTTON}>
            Redo ↷
          </button>
          {!lockQubits && (
            <>
              <button
                type="button"
                onClick={() => setQubits(numQubits - 1)}
                aria-label="Remove a qubit"
                title="Remove a qubit"
                className="h-6 w-6 rounded border border-void-400 text-slate-300 hover:border-void-300 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => setQubits(numQubits + 1)}
                aria-label="Add a qubit"
                title="Add a qubit"
                className="h-6 w-6 rounded border border-void-400 text-slate-300 hover:border-void-300 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
              >
                +
              </button>
            </>
          )}
        </div>
      </div>

      <div
        role="toolbar"
        aria-label="Edit the selected gate"
        data-testid="edit-toolbar"
        className="flex min-h-7 flex-wrap items-center gap-1.5 border-b border-void-500 px-4 pb-1.5 text-[11px]"
      >
        {selected && selectedOp !== null ? (
          <>
            <span className="mr-1 font-mono-qasm text-violet-glow" data-testid="selected-op">
              {describeOperation(selected)} · step {selectedOp + 1} of {total}
            </span>
            {/* What the picked gate is, and which trace step shows its effect (when a trace has been run). */}
            <span className="mr-1 flex flex-wrap items-center gap-1 text-void-200" data-testid="selected-op-detail">
              <span className="rounded-full border border-void-400 px-1.5 py-px text-[10px] text-slate-300">{FAMILY_LABEL[gateFamily(selected.gate)]}</span>
              <span>{GATE_NAME[selected.gate]}</span>
              {selectedGateStep >= 0 && (
                <span className="rounded-full border border-amber-glow/60 bg-amber-dim/30 px-1.5 py-px text-[10px] text-amber-glow" data-testid="selected-op-trace">
                  trace step {displayStepNumber(selectedGateStep)} of {traceLength}
                </span>
              )}
            </span>
            <button type="button" className={ACTION_BUTTON} disabled={selectedOp === 0} aria-label="Move earlier" onClick={() => (moveOpTo(selectedOp, selectedOp - 1), focusOp(selectedOp - 1))}>
              ← Earlier
            </button>
            <button type="button" className={ACTION_BUTTON} disabled={selectedOp >= total - 1} aria-label="Move later" onClick={() => (moveOpTo(selectedOp, selectedOp + 1), focusOp(selectedOp + 1))}>
              Later →
            </button>
            <button type="button" className={ACTION_BUTTON} disabled={!shiftOpWires(circuit, selectedOp, -1).ok} aria-label="Move up a wire" onClick={() => shiftOp(selectedOp, -1)}>
              ↑ Up
            </button>
            <button type="button" className={ACTION_BUTTON} disabled={!shiftOpWires(circuit, selectedOp, 1).ok} aria-label="Move down a wire" onClick={() => shiftOp(selectedOp, 1)}>
              ↓ Down
            </button>
            <button
              type="button"
              className={`${ACTION_BUTTON} hover:!border-danger-glow hover:!text-danger-glow`}
              aria-label="Delete the selected gate"
              onClick={() => removeOpAt(selectedOp)}
            >
              Delete
            </button>
            <button type="button" className={ACTION_BUTTON} aria-label="Let go of the selected gate" onClick={() => selectOp(null)}>
              Done
            </button>
          </>
        ) : (
          <span className="text-void-200">
            Click a gate to pick it, then move or delete it · Alt+arrows move · Delete removes · Ctrl+Z undoes
          </span>
        )}
      </div>

      {/* `relative` makes the scroller the containing block of every absolutely positioned descendant (the screen-reader-only text in the
          insertion markers is one). Without it such an element keeps its static position far to the right in a long circuit, escapes the clip
          and widens the whole page (a 29-operation circuit made the page 1481 px wide on any screen). */}
      <div className="circuit-grid-bg relative flex-1 overflow-auto px-6 pt-2 pb-3">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="w-8 shrink-0" aria-hidden="true" />
            <div
              role="group"
              aria-label="Where the next gate goes"
              className={`grid items-center gap-2 ${total === 0 ? 'flex-none' : 'flex-1'}`}
              style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(2.5rem, 3rem))` }}
            >
              {columns.map((column, position) =>
                column.kind === 'slot' ? (
                  <span key={`slot-${position}`} className="flex justify-center" aria-current="location" title="The next gate goes here">
                    <span aria-hidden="true" className="rounded-full border border-cyan-glow/50 bg-cyan-dim/40 px-1.5 text-[9px] leading-4 font-semibold tracking-wide whitespace-nowrap text-cyan-glow uppercase">
                      ▾ next
                    </span>
                    <span className="sr-only">The next gate goes here</span>
                  </span>
                ) : (
                  <button
                    key={`h-${column.index}`}
                    type="button"
                    onClick={() => setInsertAt(column.index)}
                    aria-label={`Insert before step ${column.index + 1}`}
                    title={`Insert before step ${column.index + 1}`}
                    className="flex min-h-6 items-center justify-center rounded text-[10px] text-void-200 hover:bg-cyan-dim/30 hover:text-cyan-glow focus-visible:text-cyan-glow focus-visible:outline-2 focus-visible:outline-cyan-glow"
                  >
                    ▾
                  </button>
                ),
              )}
              {trailingHandle && (
                <button
                  type="button"
                  onClick={() => setInsertAt(null)}
                  aria-label="Insert at the end"
                  title="Insert at the end"
                  className="flex min-h-6 items-center justify-center rounded text-[10px] text-void-200 hover:bg-cyan-dim/30 hover:text-cyan-glow focus-visible:text-cyan-glow focus-visible:outline-2 focus-visible:outline-cyan-glow"
                >
                  ▾
                </button>
              )}
            </div>
            {/* An empty circuit is an invitation, not a blank grid: the way in is said right beside the first insertion point. */}
            {total === 0 && (
              <p
                data-testid="empty-circuit-hint"
                className="min-w-0 flex-1 rounded-lg border border-dashed border-void-300 bg-void-900/70 px-3 py-1 text-xs leading-snug text-slate-300"
              >
                <span aria-hidden="true" className="mr-1.5 text-cyan-glow">
                  ←
                </span>
                Drag a gate onto a qubit wire — or pick one below, then click a wire
              </p>
            )}
          </div>

          {Array.from({ length: numQubits }, (_, q) => (
            <div key={q} role="group" aria-label={`Qubit ${q}`} className="flex items-center gap-3">
              <span className="w-8 shrink-0 rounded border border-void-500 bg-void-900/80 py-0.5 text-center font-mono-qasm text-xs text-slate-300">q[{q}]</span>
              <div className="relative grid flex-1 items-center gap-2" style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(2.5rem, 3rem))` }}>
                <div className="pointer-events-none absolute top-1/2 right-0 left-0 h-px bg-void-200" />
                {columns.map((column, position) => {
                  if (column.kind === 'op') {
                    const op = circuit.ops[column.index]!
                    const isSelected = selectedOp === column.index
                    const isTraced = tracedOp === column.index
                    const touchesTarget = op.targets.includes(q)
                    const touchesControl = op.controls.includes(q)
                    // A gate on several wires: one vertical line through every wire from its first to its last, in its family's colour.
                    const wires = [...op.controls, ...op.targets]
                    const first = Math.min(...wires)
                    const last = Math.max(...wires)
                    const span: Span | null = wires.length > 1 && q >= first && q <= last ? (q === first ? 'start' : q === last ? 'end' : 'middle') : null
                    const line = FAMILY_LINE[gateFamily(op.gate)]
                    const angleChip =
                      op.gate === 'cp' && span === 'start' ? (
                        <span
                          aria-hidden="true"
                          data-testid="connector-angle"
                          className="pointer-events-none absolute top-full left-1/2 z-20 mt-[3px] -translate-x-1/2 rounded border border-violet-glow/50 bg-void-900 px-1 font-mono-qasm text-[9px] leading-[14px] whitespace-nowrap text-violet-glow"
                        >
                          φ {describeAngle(op.params[0])}
                        </span>
                      ) : null

                    if (!touchesTarget && !touchesControl) {
                      return (
                        <div key={position} className="relative z-10 flex h-9 items-center justify-center" {...dropTarget(column, q)}>
                          {span && <Connector span={span} className={line} />}
                        </div>
                      )
                    }
                    if (touchesControl) {
                      return (
                        <div key={position} className="relative z-10 flex h-9 items-center justify-center" {...dropTarget(column, q)}>
                          {span && <Connector span={span} className={line} />}
                          {angleChip}
                          <button
                            type="button"
                            onClick={() => selectOp(isSelected ? null : column.index)}
                            aria-pressed={isSelected}
                            title={`${describeOperation(op)} · click to pick`}
                            aria-label={`${describeOperation(op)}, control on q[${q}], step ${column.index + 1} of ${total}`}
                            className={`relative flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow ${
                              isTraced ? 'outline-2 outline-offset-2 outline-amber-glow' : ''
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              data-testid="control-dot"
                              className={`h-3.5 w-3.5 rounded-full border-2 bg-violet-glow transition-transform hover:scale-125 ${
                                isSelected ? 'border-white ring-2 ring-violet-glow/70' : 'border-violet-glow'
                              }`}
                            />
                          </button>
                        </div>
                      )
                    }
                    return (
                      <div key={position} className="relative z-10 flex h-9 items-center justify-center" {...dropTarget(column, q)}>
                        {span && <Connector span={span} className={line} />}
                        {angleChip}
                        <GateBox
                          op={op}
                          index={column.index}
                          total={total}
                          selected={isSelected}
                          traced={isTraced}
                          onSelect={() => selectOp(isSelected ? null : column.index)}
                        />
                      </div>
                    )
                  }

                  // The dashed column: where the next gate goes (the end, unless a ▾ handle chose another place). A dashed guide runs through
                  // every wire so the column reads as one insertion point, and the cell under the pointer previews the gate (or its role).
                  const isPendingControlHere = !!selectedGate && selectedGate in MULTI_QUBIT_PLACEMENT && pendingQubits.includes(q)
                  const guide: Span | null = numQubits > 1 ? (q === 0 ? 'start' : q === numQubits - 1 ? 'end' : 'middle') : null
                  return (
                    <div key={position} className="relative z-10 flex h-9 items-center justify-center">
                      {guide && <Connector span={guide} className="" dashed />}
                      <button
                        type="button"
                        onClick={() => onWireClick(q)}
                        onDragOver={(e) => {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'copy'
                        }}
                        onDrop={(e) => dropOnCell(e, column, q)}
                        title={selectedGate ? `place ${selectedGate} on q[${q}]` : 'drag a gate here, or select one first'}
                        aria-label={
                          selectedGate
                            ? `Place ${selectedGate} on qubit ${q}${isPendingControlHere ? ' (already chosen)' : ''}`
                            : `Append on qubit ${q} — select a gate first`
                        }
                        aria-pressed={isPendingControlHere || undefined}
                        data-ghost={ghost}
                        data-invalid={canvasError ? 'true' : undefined}
                        className={`relative flex h-9 w-9 items-center justify-center rounded-md border border-dashed bg-void-900/60 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow ${
                          selectedGate ? 'hover:text-transparent hover:after:absolute hover:after:inset-0 hover:after:flex hover:after:items-center hover:after:justify-center hover:after:font-mono-qasm hover:after:text-xs hover:after:font-semibold hover:after:text-cyan-glow hover:after:content-[attr(data-ghost)]' : ''
                        } ${
                          isPendingControlHere
                            ? 'border-violet-glow bg-violet-dim/60 text-violet-glow'
                            : canvasError
                              ? 'border-danger-glow/70 text-danger-glow hover:border-danger-glow'
                              : selectedGate
                                ? 'border-void-300 text-slate-500 hover:border-cyan-glow hover:bg-cyan-dim/30 hover:text-cyan-glow'
                                : 'border-void-500 text-void-200 hover:border-void-300 hover:text-slate-400'
                        }`}
                      >
                        +
                      </button>
                    </div>
                  )
                })}
                {trailingHandle && <div aria-hidden="true" />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
