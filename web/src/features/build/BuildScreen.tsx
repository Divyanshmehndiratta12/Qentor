/**
 * Composes the Build screen's center pane: circuit canvas (with the gate
 * palette as a floating dock over it, per the finalized design) and the QASM
 * editor, plus the 250ms debounced execute call per docs/ARCHITECTURE.md §3
 * ("circuit edits are debounced before an execute call"). Changing the backend,
 * the mode or the shot count re-runs the same way: each of those clears the
 * result (it belonged to the old choice), so the new one is asked for at once. `ResultsPanel`
 * lives in the right pane in `App.tsx` and reads the same `useBuildStore`.
 */
import { GatePalette } from './GatePalette'
import { CircuitCanvas } from './CircuitCanvas'
import { CodePane } from './CodePane'
import { useAutoRun } from './useAutoRun'
import { useBuildStore } from './store'

export function BuildScreen() {
  useAutoRun()
  // A register of four or more qubits (phase estimation, error correction) gets more of the column, so its wires are not all behind a scrollbar.
  const tall = useBuildStore((s) => s.circuit.num_qubits >= 4)

  return (
    <div className="flex h-full flex-col">
      {/* the palette is a strip under the canvas, not a dock over it: it never hides a wire or a gate */}
      <div className={`flex min-h-0 flex-col ${tall ? 'flex-[5]' : 'flex-[3]'}`} data-testid="canvas-region">
        <div className="relative min-h-0 flex-1">
          <CircuitCanvas />
        </div>
        <GatePalette />
      </div>
      <div className="min-h-0 flex-[2] border-t border-void-500">
        <CodePane />
      </div>
    </div>
  )
}
