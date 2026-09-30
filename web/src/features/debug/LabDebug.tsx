/**
 * The debugger for the Lab's own run: the circuit on screen, the result the server issued for it, and the trace step the learner
 * has selected (identity only - the server verifies it). With no result there is nothing real to debug, so the button waits.
 */
import { useBuildStore } from '@/features/build/store'
import { selectedTraceStepContext } from '@/features/build/traceStepContext'
import { DebugPanel } from './DebugPanel'

export function LabDebug() {
  const circuit = useBuildStore((s) => s.circuit)
  const result = useBuildStore((s) => s.result)
  const trace = useBuildStore((s) => s.trace)
  const selectedTraceStep = useBuildStore((s) => s.selectedTraceStep)
  const language = useBuildStore((s) => s.tutorLanguage)

  const input = result
    ? {
        circuit,
        resultId: result.provenance.resultId,
        traceStep: selectedTraceStepContext({ trace, selectedTraceStep }),
        language,
      }
    : null

  return <DebugPanel scope="lab" input={input} askForGoal disabledReason="Run the circuit first: the debugger works from a real result." />
}
