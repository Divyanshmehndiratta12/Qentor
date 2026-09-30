/**
 * Click-to-place (and drag-to-place) gate palette, in the finalized design's
 * floating bottom dock. It lists exactly the gates `backend/qentor/circuit/model.py`
 * accepts (see circuit/types.ts): extending the gate set means extending the
 * backend first, not the other way round. A gate on several wires (CX, CZ, CP, CCX,
 * SWAP) is placed with one click per wire; the hint above the dock says which.
 *
 * Drag-and-drop is additive and isolated: dragging a gate onto a wire's
 * append cell (CircuitCanvas.tsx) just calls `selectGate` then `onWireClick`
 * in sequence — the exact same store actions a click already makes. No new
 * placement logic, no change to the circuit model or arity checking.
 */
import { useBuildStore, ROTATION_DEFAULT_ANGLE } from './store'
import type { GateName } from '@/circuit/types'
import { GATE_DISPLAY, MULTI_QUBIT_PLACEMENT, gateTakesAngle, placementPrompt } from '@/circuit/gateSpec'

export const GATE_DND_MIME = 'application/x-qentor-gate'

const SINGLE_QUBIT: { gate: GateName; label: string; title: string }[] = [
  { gate: 'h', label: 'H', title: 'Hadamard' },
  { gate: 'x', label: 'X', title: 'Pauli-X' },
  { gate: 'y', label: 'Y', title: 'Pauli-Y' },
  { gate: 'z', label: 'Z', title: 'Pauli-Z' },
  { gate: 's', label: 'S', title: 'Phase S' },
  { gate: 'sdg', label: 'S†', title: 'S-dagger (undoes S)' },
  { gate: 't', label: 'T', title: 'T gate' },
  { gate: 'tdg', label: 'T†', title: 'T-dagger (undoes T)' },
]

const MULTI_QUBIT: { gate: GateName; label: string; title: string }[] = [
  { gate: 'cx', label: GATE_DISPLAY.cx, title: 'Controlled-X: click the control wire, then the target wire' },
  { gate: 'cz', label: GATE_DISPLAY.cz, title: 'Controlled-Z: click the control wire, then the target wire' },
  { gate: 'cp', label: GATE_DISPLAY.cp, title: 'Controlled-phase: click the control wire, then the target wire; the angle (rad) is set above' },
  { gate: 'ccx', label: GATE_DISPLAY.ccx, title: 'Toffoli: click the two control wires, then the target wire' },
  { gate: 'swap', label: GATE_DISPLAY.swap, title: 'Swap: click the two wires to exchange' },
]

const ROTATION: { gate: GateName; label: string; title: string }[] = [
  { gate: 'rx', label: 'RX', title: 'Rotation-X' },
  { gate: 'ry', label: 'RY', title: 'Rotation-Y' },
  { gate: 'rz', label: 'RZ', title: 'Rotation-Z' },
]

function DockButton({
  gate,
  label,
  title,
  allowed,
}: {
  gate: GateName
  label: string
  title: string
  /** False when the current challenge does not allow this gate: the button is shown but cannot be used. */
  allowed: boolean
}) {
  const selectedGate = useBuildStore((s) => s.selectedGate)
  const selectGate = useBuildStore((s) => s.selectGate)
  const active = selectedGate === gate

  return (
    <button
      type="button"
      draggable={allowed}
      disabled={!allowed}
      onDragStart={(e) => {
        e.dataTransfer.setData(GATE_DND_MIME, gate)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => selectGate(active ? null : gate)}
      title={allowed ? title : `${title} — not allowed in this challenge`}
      aria-pressed={active}
      className={`flex h-[38px] min-w-[38px] shrink-0 items-center justify-center rounded-lg px-1.5 font-mono-qasm text-[13px] font-semibold select-none ${
        !allowed
          ? 'cursor-not-allowed bg-void-700 text-void-300 opacity-40'
          : active
          ? 'cursor-grab bg-cyan-glow text-void-950 shadow-[0_0_0_2px_var(--color-void-700),0_0_0_4px_var(--color-cyan-glow)] active:cursor-grabbing'
          : 'cursor-grab bg-void-500 text-slate-100 hover:bg-void-400 active:cursor-grabbing'
      }`}
    >
      {label}
    </button>
  )
}

/** `allowedGates`: when given, only those gates can be used (a challenge's constraint); the rest are shown disabled. */
export function GatePalette({ allowedGates }: { allowedGates?: readonly GateName[] } = {}) {
  const isAllowed = (gate: GateName) => !allowedGates || allowedGates.includes(gate)
  const pendingAngle = useBuildStore((s) => s.pendingAngle)
  const setPendingAngle = useBuildStore((s) => s.setPendingAngle)
  const selectedGate = useBuildStore((s) => s.selectedGate)
  const pendingQubits = useBuildStore((s) => s.pendingQubits)
  const canvasError = useBuildStore((s) => s.canvasError)
  const isRotationSelected = gateTakesAngle(selectedGate)

  const statusText =
    canvasError ??
    (selectedGate && selectedGate in MULTI_QUBIT_PLACEMENT ? placementPrompt(selectedGate, pendingQubits) : null)

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-2 px-4">
      {(statusText || isRotationSelected) && (
        <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-void-400 bg-void-700/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
          {statusText && (
            <span
              role={canvasError ? 'alert' : 'status'}
              className={canvasError ? 'text-danger-glow' : 'text-violet-glow/90'}
            >
              {statusText}
            </span>
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

      <div
        role="toolbar"
        aria-label="Gate palette"
        className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-void-400 bg-void-700/95 p-1.5 shadow-lg backdrop-blur"
      >
        <span className="px-2 font-mono-qasm text-[11px] whitespace-nowrap text-void-200">drag or click</span>
        {SINGLE_QUBIT.map((g) => (
          <DockButton key={g.gate} {...g} allowed={isAllowed(g.gate)} />
        ))}
        <span className="mx-0.5 h-6 w-px shrink-0 bg-void-400" />
        {ROTATION.map((g) => (
          <DockButton key={g.gate} {...g} allowed={isAllowed(g.gate)} />
        ))}
        <span className="mx-0.5 h-6 w-px shrink-0 bg-void-400" />
        {MULTI_QUBIT.map((g) => (
          <DockButton key={g.gate} {...g} allowed={isAllowed(g.gate)} />
        ))}
        <span className="mx-0.5 h-6 w-px shrink-0 bg-void-400" />
        <DockButton gate="measure" label="M" title="Measure" allowed={isAllowed('measure')} />
      </div>
    </div>
  )
}
