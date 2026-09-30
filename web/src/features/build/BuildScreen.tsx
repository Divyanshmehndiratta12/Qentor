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
import { useBuildStore } from './store'

const DEBOUNCE_MS = 250

export function BuildScreen() {
  const qasmText = useBuildStore((s) => s.qasmText)
  const runExecution = useBuildStore((s) => s.runExecution)
  const backend = useBuildStore((s) => s.backend)
  // The shot count only matters to a shots run, so it is `null` in statevector mode: typing in it there re-runs nothing, and
  // switching mode (which flips it between `null` and a number) re-runs.
  const shots = useBuildStore((s) => (s.mode === 'shots' ? s.shots : null))

  useEffect(() => {
    const timer = setTimeout(() => {
      void runExecution()
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `qasmText` changes iff the canonical circuit changes, so it's a stable
    // trigger for both canvas and editor edits.
  }, [qasmText, backend, shots, runExecution])

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
