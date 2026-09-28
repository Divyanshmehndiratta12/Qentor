/**
 * Click-to-place (and now drag-to-place) gate palette, restyled into the
 * finalized design's floating bottom dock. Still only lists the 11 gates
 * `backend/qentor/circuit/model.py` and the `AerAdapter` actually accept
 * today (see circuit/types.ts) — the design's own palette additionally shows
 * a `cz` button, which is deliberately NOT reproduced here: extending the
 * gate set means extending the backend first, not the other way round.
 *
 * Drag-and-drop is additive and isolated: dragging a gate onto a wire's
 * append cell (CircuitCanvas.tsx) just calls `selectGate` then `onWireClick`
 * in sequence — the exact same store actions a click already makes. No new
 * placement logic, no change to the circuit model or arity checking.
 */
import { useBuildStore, ROTATION_DEFAULT_ANGLE } from './store'
import type { GateName } from '@/circuit/types'

export const GATE_DND_MIME = 'application/x-qentor-gate'

const SINGLE_QUBIT: { gate: GateName; label: string; title: string }[] = [
  { gate: 'h', label: 'H', title: 'Hadamard' },
  { gate: 'x', label: 'X', title: 'Pauli-X' },
  { gate: 'y', label: 'Y', title: 'Pauli-Y' },
  { gate: 'z', label: 'Z', title: 'Pauli-Z' },
  { gate: 's', label: 'S', title: 'Phase S' },
  { gate: 't', label: 'T', title: 'T gate' },
]

const ROTATION: { gate: GateName; label: string; title: string }[] = [
  { gate: 'rx', label: 'RX', title: 'Rotation-X' },
  { gate: 'ry', label: 'RY', title: 'Rotation-Y' },
  { gate: 'rz', label: 'RZ', title: 'Rotation-Z' },
]

function DockButton({ gate, label, title }: { gate: GateName; label: string; title: string }) {
  const selectedGate = useBuildStore((s) => s.selectedGate)
  const selectGate = useBuildStore((s) => s.selectGate)
  const active = selectedGate === gate

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(GATE_DND_MIME, gate)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => selectGate(active ? null : gate)}
      title={title}
      className={`flex h-[38px] w-[38px] shrink-0 cursor-grab items-center justify-center rounded-lg font-mono-qasm text-[13px] font-semibold select-none active:cursor-grabbing ${
        active
          ? 'bg-cyan-glow text-void-950 shadow-[0_0_0_2px_var(--color-void-700),0_0_0_4px_var(--color-cyan-glow)]'
          : 'bg-void-500 text-slate-100 hover:bg-void-400'
      }`}
    >
      {label}
    </button>
  )
}

export function GatePalette() {
  const pendingAngle = useBuildStore((s) => s.pendingAngle)
  const setPendingAngle = useBuildStore((s) => s.setPendingAngle)
  const selectedGate = useBuildStore((s) => s.selectedGate)
  const pendingControl = useBuildStore((s) => s.pendingControl)
  const canvasError = useBuildStore((s) => s.canvasError)
  const isRotationSelected = selectedGate === 'rx' || selectedGate === 'ry' || selectedGate === 'rz'

  const statusText =
    canvasError ??
    (selectedGate === 'cx'
      ? pendingControl === null
        ? 'click a wire to set the control qubit'
        : `control = q${pendingControl} · click a wire to set the target`
      : null)

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-2 px-4">
      {(statusText || isRotationSelected) && (
        <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-void-400 bg-void-700/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
          {statusText && (
            <span className={canvasError ? 'text-danger-glow' : 'text-violet-glow/90'}>{statusText}</span>
          )}
          {isRotationSelected && (
            <label className="flex items-center gap-2 text-slate-400">
              angle (rad)
              <input
                type="number"
                step="0.01"
                value={pendingAngle}
                onChange={(e) => setPendingAngle(Number(e.target.value) || ROTATION_DEFAULT_ANGLE)}
                className="w-20 rounded border border-void-400 bg-void-950 px-2 py-1 font-mono-qasm text-slate-200 focus:border-cyan-glow focus:outline-none"
              />
            </label>
          )}
        </div>
      )}

      <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-void-400 bg-void-700/95 p-1.5 shadow-lg backdrop-blur">
        <span className="px-2 font-mono-qasm text-[11px] whitespace-nowrap text-void-200">drag or click</span>
        {SINGLE_QUBIT.map((g) => (
          <DockButton key={g.gate} {...g} />
        ))}
        <span className="mx-0.5 h-6 w-px shrink-0 bg-void-400" />
        {ROTATION.map((g) => (
          <DockButton key={g.gate} {...g} />
        ))}
        <span className="mx-0.5 h-6 w-px shrink-0 bg-void-400" />
        <DockButton gate="cx" label="CX" title="Controlled-X" />
        <span className="mx-0.5 h-6 w-px shrink-0 bg-void-400" />
        <DockButton gate="measure" label="M" title="Measure" />
      </div>
    </div>
  )
}
