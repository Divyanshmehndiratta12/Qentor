/**
 * `QuantumValue<T>` per docs/VERIFICATION_ARCHITECTURE.md §5: "The only way to
 * obtain one is to parse an API response with its zod schema." This module is
 * that parse step. Nothing else in the app is allowed to construct one by hand
 * — there is deliberately no public constructor that takes a bare number.
 *
 * `MOCK_PROVENANCE_CLASS` extends the backend's three real classes with a
 * fourth, client-only tag for the mock adapter (see api/mockClient.ts). A real
 * `/api/execute` response can never carry it — `ExecuteResponseSchema` only
 * accepts the backend's literal `ProvenanceClass` enum — so this is not a
 * value the network can forge, only one the mock adapter self-declares.
 */
import type { ExecuteResponse, ProvenanceClass, TraceProvenanceResponse, VerificationStatus } from './schema'

export const FIXTURE = 'FIXTURE' as const

export interface Provenance {
  resultId: string
  circuitHash: string
  backend: string
  backendVersion: string
  executionMode: string
  provenanceClass: ProvenanceClass | typeof FIXTURE
  verificationStatus: VerificationStatus
  createdAt: string
}

export interface QuantumValue<T> {
  readonly value: T
  readonly provenance: Provenance
}

/** The one place an `ExecuteResponse` becomes provenance metadata. */
export function provenanceFromExecuteResponse(response: ExecuteResponse): Provenance {
  return {
    resultId: response.result_id,
    circuitHash: response.circuit_hash,
    backend: response.backend,
    backendVersion: response.backend_version,
    executionMode: response.execution_mode,
    provenanceClass: response.provenance_class,
    verificationStatus: response.verification_status,
    createdAt: response.created_at,
  }
}

/**
 * A trace step's provenance block -> the same `Provenance` an execute result
 * carries. Each trace step is an ordinary persisted execution record, so this
 * is the identical mapping as `provenanceFromExecuteResponse`, field for
 * field — not a second provenance model.
 */
export function provenanceFromTraceStep(response: TraceProvenanceResponse): Provenance {
  return {
    resultId: response.result_id,
    circuitHash: response.circuit_hash,
    backend: response.backend,
    backendVersion: response.backend_version,
    executionMode: response.execution_mode,
    provenanceClass: response.provenance_class,
    verificationStatus: response.verification_status,
    createdAt: response.created_at,
  }
}

/** Wraps an already-validated payload field with its response's provenance. */
export function toQuantumValue<T>(value: T, provenance: Provenance): QuantumValue<T> {
  return { value, provenance }
}
