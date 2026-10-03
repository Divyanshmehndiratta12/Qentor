/**
 * A single-qubit backend Bloch vector (`TraceBlochVector`) in the same shape as a per-qubit state, so the 3D view has one thing
 * to draw. A pure re-labelling of fields: the coordinates are the backend's `QuantumValue` as it arrived, and the length,
 * purity and entanglement the backend did NOT give for this path stay `null` (shown as "not provided", never worked out).
 */
import type { TraceBlochVector, TraceQubitState } from '@/api'

export function blochVectorAsQubitState(vector: TraceBlochVector): TraceQubitState {
  return {
    qubit: 0,
    status: 'OK',
    reason: null,
    bloch: vector.coordinates,
    blochLength: null,
    purity: null,
    entangledWithRest: null,
    method: vector.method,
    derivedFrom: vector.derivedFrom,
  }
}
