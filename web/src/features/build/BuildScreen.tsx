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

export function BuildScreen() {
  useAutoRun()

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-[3]">
        <CircuitCanvas />
        <GatePalette />
      </div>
      <div className="min-h-0 flex-[2] border-t border-void-500">
        <CodePane />
      </div>
    </div>
  )
}
