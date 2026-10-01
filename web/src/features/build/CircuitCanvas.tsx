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
 * A refused edit (a wire that does not exist, a gate that would leave the register) leaves the circuit untouched and says why in the
 * palette's status line. The operation behind the selected trace step is outlined, so the trace and the circuit read together.
 */
import { useRef } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { useBuildStore } from './store'
import { GATE_DND_MIME } from './GatePalette'
import { shiftOpWires } from '@/circuit/edit'
import type { GateName, GateOp } from '@/circuit/types'
import { GATE_DISPLAY, MULTI_QUBIT_PLACEMENT, TARGET_SYMBOL, gateTakesAngle } from '@/circuit/gateSpec'
import { describeOperation } from './traceFormat'
import { useEditShortcuts } from './useEditShortcuts'

export const OP_DND_MIME = 'application/x-qentor-op'

type Column = { kind: 'op'; index: number } | { kind: 'slot' }

const ACTION_BUTTON =
  'rounded border border-void-400 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-void-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-35'

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
      aria-pressed={selected}
      aria-label={`${describeOperation(op)}, step ${index + 1} of ${total}${traced ? ', shown in the trace' : ''}`}
      title={`${describeOperation(op)} · click to pick, then move or delete`}
      className={`flex h-9 w-9 items-center justify-center rounded-md border font-mono-qasm text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow ${
        selected
          ? 'border-violet-glow bg-violet-dim text-violet-glow ring-2 ring-violet-glow/70'
          : 'border-cyan-glow/50 bg-cyan-dim text-cyan-glow hover:border-slate-300 hover:text-slate-100'
      } ${traced ? 'outline-2 outline-offset-2 outline-amber-glow' : ''}`}
    >
      {gateTakesAngle(op.gate) ? `${label}(${op.params[0].toFixed(2)})` : label}
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-void-500 px-4 py-2">
        <span className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
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
        className="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-void-500 bg-void-900/70 px-4 py-1.5 text-[11px]"
      >
        {selected && selectedOp !== null ? (
          <>
            <span className="mr-1 font-mono-qasm text-violet-glow" data-testid="selected-op">
              {describeOperation(selected)} · step {selectedOp + 1} of {total}
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

      <div className="circuit-grid-bg flex-1 overflow-auto p-6 pt-3 pb-28">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="w-8 shrink-0" aria-hidden="true" />
            <div
              role="group"
              aria-label="Where the next gate goes"
              className="grid flex-1 items-center gap-2"
              style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(2.5rem, 3rem))` }}
            >
              {columns.map((column, position) =>
                column.kind === 'slot' ? (
                  <span key={`slot-${position}`} className="flex justify-center text-[10px] font-semibold text-cyan-glow" aria-current="location" title="The next gate goes here">
                    <span aria-hidden="true">▾</span>
                    <span className="sr-only">The next gate goes here</span>
                  </span>
                ) : (
                  <button
                    key={`h-${column.index}`}
                    type="button"
                    onClick={() => setInsertAt(column.index)}
                    aria-label={`Insert before step ${column.index + 1}`}
                    title={`Insert before step ${column.index + 1}`}
                    className="flex justify-center text-[10px] text-void-300 hover:text-cyan-glow focus-visible:text-cyan-glow focus-visible:outline-2 focus-visible:outline-cyan-glow"
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
                  className="flex justify-center text-[10px] text-void-300 hover:text-cyan-glow focus-visible:text-cyan-glow focus-visible:outline-2 focus-visible:outline-cyan-glow"
                >
                  ▾
                </button>
              )}
            </div>
          </div>

          {Array.from({ length: numQubits }, (_, q) => (
            <div key={q} role="group" aria-label={`Qubit ${q}`} className="flex items-center gap-3">
              <span className="w-8 shrink-0 font-mono-qasm text-xs text-slate-500">q[{q}]</span>
              <div className="relative grid flex-1 items-center gap-2" style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(2.5rem, 3rem))` }}>
                <div className="pointer-events-none absolute top-1/2 right-0 left-0 h-px bg-void-200" />
                {columns.map((column, position) => {
                  if (column.kind === 'op') {
                    const op = circuit.ops[column.index]!
                    const isSelected = selectedOp === column.index
                    const isTraced = tracedOp === column.index
                    const touchesTarget = op.targets.includes(q)
                    const touchesControl = op.controls.includes(q)
                    if (!touchesTarget && !touchesControl) {
                      return (
                        <div key={position} className="relative z-10 flex h-9 justify-center" {...dropTarget(column, q)} />
                      )
                    }
                    if (touchesControl) {
                      return (
                        <div key={position} className="relative z-10 flex justify-center" {...dropTarget(column, q)}>
                          <button
                            type="button"
                            onClick={() => selectOp(isSelected ? null : column.index)}
                            aria-pressed={isSelected}
                            title={`${describeOperation(op)} · click to pick`}
                            aria-label={`${describeOperation(op)}, control on q[${q}], step ${column.index + 1} of ${total}`}
                            className={`h-3.5 w-3.5 rounded-full border-2 bg-violet-glow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow ${
                              isSelected ? 'border-white ring-2 ring-violet-glow/70' : 'border-violet-glow'
                            } ${isTraced ? 'outline-2 outline-offset-2 outline-amber-glow' : ''}`}
                          />
                        </div>
                      )
                    }
                    return (
                      <div key={position} className="relative z-10 flex justify-center" {...dropTarget(column, q)}>
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

                  // The dashed column: where the next gate goes (the end, unless a ▾ handle chose another place).
                  const isPendingControlHere = !!selectedGate && selectedGate in MULTI_QUBIT_PLACEMENT && pendingQubits.includes(q)
                  return (
                    <div key={position} className="relative z-10 flex justify-center">
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
                        className={`flex h-9 w-9 items-center justify-center rounded-md border border-dashed transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow ${
                          isPendingControlHere
                            ? 'border-violet-glow bg-violet-dim/60 text-violet-glow'
                            : selectedGate
                              ? 'border-void-300 text-slate-600 hover:border-cyan-glow hover:text-cyan-glow'
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
