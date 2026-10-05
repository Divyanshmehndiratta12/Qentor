/**
 * Composes the Build screen's center pane: circuit canvas (with the gate
 * palette as a floating dock over it, per the finalized design) and the QASM
 * editor, plus the 250ms debounced execute call per docs/ARCHITECTURE.md §3
 * ("circuit edits are debounced before an execute call"). Changing the backend,
 * the mode or the shot count re-runs the same way: each of those clears the
 * result (it belonged to the old choice), so the new one is asked for at once. `ResultsPanel`
 * lives in the right pane in `App.tsx` and reads the same `useBuildStore`.
 */
import { useEffect } from 'react'
import { GatePalette } from './GatePalette'
import { CircuitCanvas } from './CircuitCanvas'
import { CodePane } from './CodePane'
import { useAutoRun } from './useAutoRun'
import { useBuildStore } from './store'

export function BuildScreen() {
  useAutoRun()
  // A register of four or more qubits (phase estimation, error correction) gets more of the column, so its wires are not all behind a scrollbar.
  const tall = useBuildStore((s) => s.circuit.num_qubits >= 4)
  // "Expand canvas": the canvas region (the canvas and the palette under it) becomes a fixed full-window overlay and the code pane is hidden. The
  // region stays the same element in the same place, so the circuit, the selection and the focus are untouched. App hides the rest of the page.
  const expanded = useBuildStore((s) => s.canvasExpanded)
  const setExpanded = useBuildStore((s) => s.setCanvasExpanded)
  useEffect(() => () => setExpanded(false), [setExpanded]) // leaving the Lab ends the full view

  return (
    <div className="flex h-full flex-col">
      {/* the palette is a strip under the canvas, not a dock over it: it never hides a wire or a gate */}
      <div
        className={expanded ? 'fixed inset-0 z-50 flex flex-col bg-void-950' : `flex min-h-0 flex-col ${tall ? 'flex-[5]' : 'flex-[3]'}`}
        data-testid="canvas-region"
        data-expanded={expanded}
        role={expanded ? 'region' : undefined}
        aria-label={expanded ? 'Circuit canvas, full view' : undefined}
      >
        <div className="relative min-h-0 flex-1">
          <CircuitCanvas expandable />
        </div>
        <GatePalette />
      </div>
      <div hidden={expanded} className="min-h-0 flex-[2] border-t border-void-500">
        <CodePane />
      </div>
    </div>
  )
}
