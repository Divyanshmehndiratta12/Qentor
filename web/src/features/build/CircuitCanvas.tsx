/**
 * Click-to-place (and drag-to-place) circuit canvas. Gates append to the end
 * of the op sequence (column = the op's index) — there is no mid-sequence
 * insert yet (P1 per docs/ARCHITECTURE.md §3). Clicking an existing gate
 * removes it. This component only edits the canonical `Circuit` in
 * `useBuildStore`; it never computes or displays a quantum number itself.
 *
 * Dropping a gate dragged from GatePalette onto an append cell just calls
 * `selectGate` then `onWireClick` for that qubit — identical to selecting
 * the gate and clicking the wire. No separate placement path, no new
 * validation: `gateArityError` in the store is still the only gate on what
 * gets added to the circuit.
 */
import type { DragEvent } from 'react'
import { useBuildStore } from './store'
import { GATE_DND_MIME } from './GatePalette'
import type { GateName, GateOp } from '@/circuit/types'
import { GATE_DISPLAY, MULTI_QUBIT_PLACEMENT, TARGET_SYMBOL, gateTakesAngle } from '@/circuit/gateSpec'
import { describeOperation } from './traceFormat'

function GateBox({ op, onClick }: { op: GateOp; onClick: () => void }) {
  // On the wire it acts ON, a controlled gate shows the operation (X, Z); a swap shows × on both wires.
  const label = TARGET_SYMBOL[op.gate] ?? GATE_DISPLAY[op.gate]
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${describeOperation(op)} · click to remove`}
      aria-label={`Remove: ${describeOperation(op)}`}
      className="flex h-9 w-9 items-center justify-center rounded-md border border-cyan-glow/50 bg-cyan-dim font-mono-qasm text-xs font-semibold text-cyan-glow transition-transform hover:scale-105 hover:border-danger-glow hover:bg-danger-dim hover:text-danger-glow"
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

  const numQubits = circuit.num_qubits
  const columns = circuit.ops.length + 1 // +1 = the always-clickable "append here" column

  function dropGate(e: DragEvent<HTMLButtonElement>, q: number) {
    e.preventDefault()
    const gate = e.dataTransfer.getData(GATE_DND_MIME)
    if (!gate) return
    selectGate(gate as GateName)
    onWireClick(q)
  }

  return (
    <div className="flex h-full flex-col" role="group" aria-label="Circuit editor">
      <div className="flex items-center justify-between border-b border-void-500 px-4 py-2">
        <span className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
          Circuit · {numQubits} qubit{numQubits === 1 ? '' : 's'} · {circuit.ops.length} op
          {circuit.ops.length === 1 ? '' : 's'}
        </span>
        {!lockQubits && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setQubits(numQubits - 1)}
            aria-label="Remove a qubit"
            title="Remove a qubit"
            className="h-6 w-6 rounded border border-void-400 text-slate-300 hover:border-void-300"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setQubits(numQubits + 1)}
            aria-label="Add a qubit"
            title="Add a qubit"
            className="h-6 w-6 rounded border border-void-400 text-slate-300 hover:border-void-300"
          >
            +
          </button>
        </div>
        )}
      </div>

      <div className="circuit-grid-bg flex-1 overflow-auto p-6 pb-28">
        <div className="flex flex-col gap-6">
          {Array.from({ length: numQubits }, (_, q) => (
            <div key={q} role="group" aria-label={`Qubit ${q}`} className="flex items-center gap-3">
              <span className="w-8 shrink-0 font-mono-qasm text-xs text-slate-500">q[{q}]</span>
              <div
                className="relative grid flex-1 items-center gap-2"
                style={{ gridTemplateColumns: `repeat(${columns}, minmax(2.5rem, 3rem))` }}
              >
                <div className="pointer-events-none absolute top-1/2 right-0 left-0 h-px bg-void-200" />
                {Array.from({ length: columns }, (_, col) => {
                  if (col < circuit.ops.length) {
                    const op = circuit.ops[col]
                    const touchesTarget = op.targets.includes(q)
                    const touchesControl = op.controls.includes(q)
                    if (!touchesTarget && !touchesControl) {
                      return <div key={col} className="relative z-10 flex justify-center" />
                    }
                    if (touchesControl) {
                      return (
                        <div key={col} className="relative z-10 flex justify-center">
                          <button
                            type="button"
                            onClick={() => removeOpAt(col)}
                            title={`${describeOperation(op)} · click to remove`}
                            aria-label={`Remove: ${describeOperation(op)} (control on q[${q}])`}
                            className="h-3.5 w-3.5 rounded-full border-2 border-violet-glow bg-violet-glow"
                          />
                        </div>
                      )
                    }
                    return (
                      <div key={col} className="relative z-10 flex justify-center">
                        <GateBox op={op} onClick={() => removeOpAt(col)} />
                      </div>
                    )
                  }

                  // The single trailing "append" column.
                  const isPendingControlHere = !!selectedGate && selectedGate in MULTI_QUBIT_PLACEMENT && pendingQubits.includes(q)
                  return (
                    <div key={col} className="relative z-10 flex justify-center">
                      <button
                        type="button"
                        onClick={() => onWireClick(q)}
                        onDragOver={(e) => {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'copy'
                        }}
                        onDrop={(e) => dropGate(e, q)}
                        title={selectedGate ? `place ${selectedGate} on q[${q}]` : 'drag a gate here, or select one first'}
                        aria-label={
                          selectedGate
                            ? `Place ${selectedGate} on qubit ${q}${isPendingControlHere ? ' (already chosen)' : ''}`
                            : `Append on qubit ${q} — select a gate first`
                        }
                        aria-pressed={isPendingControlHere || undefined}
                        className={`flex h-9 w-9 items-center justify-center rounded-md border border-dashed transition-colors ${
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
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
