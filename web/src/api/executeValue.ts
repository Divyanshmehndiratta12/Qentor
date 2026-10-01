/**
 * The one place a parsed `/api/execute`-shaped response becomes a `QuantumValue<ExecutePayload>`: used for a fresh run and for the
 * stored run inside a shared experiment, so both are wrapped identically with the record's own provenance.
 */
import { provenanceFromExecuteResponse, toQuantumValue, type QuantumValue } from '@/provenance/QuantumValue'
import { ShotsPayloadSchema, StatevectorPayloadSchema, type ExecuteResponse } from '@/provenance/schema'
import type { ExecutePayload } from './client'

export function quantumValueFromExecuteResponse(response: ExecuteResponse): QuantumValue<ExecutePayload> {
  const provenance = provenanceFromExecuteResponse(response)
  let payload: ExecutePayload
  if (response.execution_mode === 'statevector') {
    const sv = StatevectorPayloadSchema.parse(response.payload)
    payload = {
      executionId: sv.execution_id,
      statevector: sv.statevector,
      ...(sv.theoretical_probabilities ? { theoreticalProbabilities: sv.theoretical_probabilities } : {}),
    }
  } else {
    const shots = ShotsPayloadSchema.parse(response.payload)
    payload = {
      executionId: shots.execution_id,
      counts: shots.counts,
      probabilities: shots.probabilities,
      ...(shots.shots !== undefined ? { shots: shots.shots } : {}),
    }
  }
  return toQuantumValue(payload, provenance)
}
