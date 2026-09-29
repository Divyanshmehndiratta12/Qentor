/**
 * The identity of the trace step the learner has selected, in the shape the
 * tutor API takes (`TutorTraceStepContext`).
 *
 * IDENTITY ONLY. This copies indices, the operation the learner built, and the
 * ids/hashes/backend labels of the provenance record the backend wrote for the
 * step — every one of them already in the trace the backend returned. It reads
 * NO amplitude, probability or Bloch coordinate, calculates nothing, and infers
 * nothing from a gate's name. The server looks the step's record up itself and
 * verifies this identity against the circuit before using it, so a wrong or
 * forged identity is refused rather than explained.
 */
import type { ExecutionTraceResult, TutorTraceStepContext } from '@/api'

export function selectedTraceStepContext(state: {
  trace: ExecutionTraceResult | null
  selectedTraceStep: number
}): TutorTraceStepContext | null {
  const { trace, selectedTraceStep } = state
  if (!trace) return null
  const step = trace.steps[selectedTraceStep]
  if (!step) return null
  const previous = selectedTraceStep > 0 ? trace.steps[selectedTraceStep - 1] : undefined
  return {
    stepIndex: step.stepIndex,
    operationIndex: step.operationIndex,
    operation: step.operation,
    resultId: step.state.provenance.resultId,
    executionId: step.executionId,
    circuitHash: step.state.provenance.circuitHash,
    backend: step.state.provenance.backend,
    backendVersion: step.state.provenance.backendVersion,
    previousResultId: previous ? previous.state.provenance.resultId : null,
  }
}
