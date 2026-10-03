/**
 * The Lab's state view for the latest run: one 3D Bloch sphere per qubit of the run's FINAL state, from the per-qubit states
 * the server derived from that run's own stored statevector (`ExecutePayload.qubitStates`). Nothing is computed here: this only
 * picks which backend values to hand to `QubitStateView` and which honest wording to show when there are none.
 *
 * A shots run has no state (it samples measurement outcomes), and says so; a statevector run on a server that sent no per-qubit
 * states says so too. A circuit with measurements has one collapsed post-measurement state, and says that.
 */
import { QubitStateView } from '@/features/bloch3d/QubitStateView'
import { useBuildStore } from './store'

export function ResultStateView() {
  const result = useBuildStore((s) => s.result)
  const numQubits = useBuildStore((s) => s.circuit.num_qubits)
  const hasMeasurement = useBuildStore((s) => s.circuit.ops.some((op) => op.gate === 'measure'))
  if (!result) return null

  const hasState = Boolean(result.value.statevector)
  const qubitStates = result.value.qubitStates ?? []

  return (
    <QubitStateView
      testId="result-state-view"
      headingLevel={3}
      qubitStates={qubitStates}
      numQubits={numQubits}
      context="Final state of this run"
      caution={
        hasState && hasMeasurement
          ? 'This circuit contains measurements, so this is one collapsed post-measurement state, not the ideal state — a different run can give a different one.'
          : undefined
      }
      unavailableReason={
        !hasState
          ? 'A shots run samples measurement outcomes and returns no state, so there is no Bloch vector to draw. Switch to statevector mode to see each qubit’s state.'
          : 'The server did not send a state for each qubit of this run, so no sphere is shown. Qentor does not work one out itself. A trace shows each qubit step by step.'
      }
    />
  )
}
