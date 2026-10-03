/**
 * The one place a server per-qubit state (`QubitStateResponse`) becomes the client's `TraceQubitState`. Used for a trace step
 * and for the final state of a run, so both are wrapped identically: every number is the backend's, passed through untouched
 * and wrapped with the provenance of the state it was derived from. Nothing is computed, rounded or bounded here.
 */
import type { Provenance } from '@/provenance/QuantumValue'
import { toQuantumValue } from '@/provenance/QuantumValue'
import type { QubitStateResponse } from '@/provenance/schema'
import type { TraceQubitState } from './client'

export function mapQubitState(q: QubitStateResponse, provenance: Provenance): TraceQubitState {
  return {
    qubit: q.qubit,
    status: q.status,
    reason: q.reason ?? null,
    bloch: q.bloch ? toQuantumValue({ x: q.bloch.x, y: q.bloch.y, z: q.bloch.z }, provenance) : null,
    blochLength: q.bloch_length === null || q.bloch_length === undefined ? null : toQuantumValue(q.bloch_length, provenance),
    purity: q.purity === null || q.purity === undefined ? null : toQuantumValue(q.purity, provenance),
    entangledWithRest: q.entangled_with_rest ?? null,
    method: q.method,
    derivedFrom: {
      stepIndex: q.derived_from.step_index,
      resultId: q.derived_from.result_id,
      executionId: q.derived_from.execution_id,
      circuitHash: q.derived_from.circuit_hash,
      backend: q.derived_from.backend,
      backendVersion: q.derived_from.backend_version,
    },
  }
}
