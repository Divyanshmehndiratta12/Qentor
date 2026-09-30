/**
 * The Lab's debounced auto-run (docs/ARCHITECTURE.md §3: "circuit edits are debounced before an execute call"), shared by every
 * screen that shows the Lab's results for the circuit on screen. Changing the circuit, the backend, the mode or the shot count
 * re-runs after `DEBOUNCE_MS`: each of those clears the result (it belonged to the old choice), so the new one is asked for at once.
 */
import { useEffect } from 'react'
import { useBuildStore } from './store'

export const DEBOUNCE_MS = 250

export function useAutoRun(): void {
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
    // `qasmText` changes iff the canonical circuit changes, so it's a stable trigger for both canvas and editor edits.
  }, [qasmText, backend, shots, runExecution])
}
