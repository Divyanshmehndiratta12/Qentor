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
import { useState } from 'react'
import { useBuildStore } from './store'
import { parseAngle } from '@/circuit/angle'
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
          ? 'cursor-not-allowed bg-void-700 text-void-200 opacity-40'
          : active
          ? 'cursor-grab bg-cyan-glow text-void-950 shadow-[0_0_0_2px_var(--color-void-700),0_0_0_4px_var(--color-cyan-glow)] active:cursor-grabbing'
          : 'cursor-grab bg-void-500 text-slate-100 hover:bg-void-400 active:cursor-grabbing'
      }`}
    >
      {label}
    </button>
  )
}

const ANGLE_PRESETS = ['pi/2', 'pi/4', '-pi/2', '-pi/4', 'pi'] as const

/**
 * The angle of the next CP or rotation. A person writes an angle the way a textbook does (`pi/4`, `-pi/2`, `0.5`), not as sixteen
 * digits: the text is read by the same grammar as the server's QASM reader (`circuit/angle.ts`) and the store only ever receives the
 * number. Text that is not an angle leaves the store's angle as it was and says so; it is never guessed at.
 */
function AngleInput() {
  const pendingAngle = useBuildStore((s) => s.pendingAngle)
  const setPendingAngle = useBuildStore((s) => s.setPendingAngle)
  const [text, setText] = useState('pi/2')
  const parsed = parseAngle(text)
  const apply = (next: string) => {
    setText(next)
    const value = parseAngle(next)
    if (value !== null) setPendingAngle(value)
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-slate-400">
      <label className="flex items-center gap-2">
        angle (rad)
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => apply(e.target.value)}
          aria-invalid={parsed === null}
          aria-describedby="angle-hint"
          className={`w-24 rounded border bg-void-950 px-2 py-1 font-mono-qasm text-slate-200 focus:outline-none ${
            parsed === null ? 'border-danger-glow focus:border-danger-glow' : 'border-void-400 focus:border-cyan-glow'
          }`}
        />
      </label>
      <span id="angle-hint" role={parsed === null ? 'alert' : undefined} className={`font-mono-qasm text-[11px] ${parsed === null ? 'text-danger-glow' : 'text-void-200'}`}>
        {parsed === null ? 'not an angle: try pi/4, -pi/2 or 0.5' : `= ${pendingAngle} rad`}
      </span>
      <span role="group" aria-label="Common angles" className="flex gap-1">
        {ANGLE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => apply(preset)}
            aria-label={`Set the angle to ${preset}`}
            className="min-h-6 rounded border border-void-400 px-1.5 font-mono-qasm text-[11px] text-slate-200 hover:border-cyan-glow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
          >
            {preset.replace('pi', 'π')}
          </button>
        ))}
      </span>
    </div>
  )
}

/** `allowedGates`: when given, only those gates can be used (a challenge's constraint); the rest are shown disabled. `sticky`: stay at the bottom of a scrolling column (the challenge workspace, where a tall brief and canvas can push it out of view). */
export function GatePalette({ allowedGates, sticky = false }: { allowedGates?: readonly GateName[]; sticky?: boolean } = {}) {
  const isAllowed = (gate: GateName) => !allowedGates || allowedGates.includes(gate)
  const selectedGate = useBuildStore((s) => s.selectedGate)
  const pendingQubits = useBuildStore((s) => s.pendingQubits)
  const canvasError = useBuildStore((s) => s.canvasError)
  const isRotationSelected = gateTakesAngle(selectedGate)

  const statusText =
    canvasError ??
    (selectedGate && selectedGate in MULTI_QUBIT_PLACEMENT ? placementPrompt(selectedGate, pendingQubits) : null)

  return (
    <div className={`flex shrink-0 flex-col items-center gap-2 border-t border-void-500 bg-void-900 px-3 py-2 ${sticky ? 'sticky bottom-0 z-10' : ''}`}>
      {(statusText || isRotationSelected) && (
        <div className="flex items-center gap-3 rounded-xl border border-void-400 bg-void-700 px-3 py-2 text-xs">
          {statusText && (
            <span
              role={canvasError ? 'alert' : 'status'}
              className={canvasError ? 'text-danger-glow' : 'text-violet-glow/90'}
            >
              {statusText}
            </span>
          )}
          {isRotationSelected && <AngleInput />}
        </div>
      )}

      <div
        role="toolbar"
        aria-label="Gate palette"
        className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-void-400 bg-void-700 p-1.5"
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
