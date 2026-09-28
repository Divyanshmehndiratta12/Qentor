/**
 * Zod schemas mirroring `backend/qentor/api/schemas.py` and
 * `backend/qentor/provenance/models.py` exactly. Parsing an HTTP response
 * through `ExecuteResponseSchema` is the ONLY way anywhere in this app to turn
 * bytes off the wire into something a component is allowed to render — see
 * `QuantumValue.ts`.
 */
import { z } from 'zod'

// backend/qentor/provenance/models.py::ProvenanceClass
export const ProvenanceClassSchema = z.enum([
  'SIMULATION',
  'REAL_HARDWARE',
  'RECORDED_HARDWARE',
])
export type ProvenanceClass = z.infer<typeof ProvenanceClassSchema>

// backend/qentor/provenance/models.py::VerificationStatus
export const VerificationStatusSchema = z.enum(['VERIFIED', 'FAILED', 'ERROR'])
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>

// backend/qentor/api/schemas.py::ExecuteResponse
export const ExecuteResponseSchema = z.object({
  result_id: z.string(),
  circuit_hash: z.string(),
  backend: z.string(),
  backend_version: z.string(),
  execution_mode: z.string(),
  provenance_class: ProvenanceClassSchema,
  verification_status: VerificationStatusSchema,
  created_at: z.string(),
  payload: z.record(z.string(), z.unknown()),
})
export type ExecuteResponse = z.infer<typeof ExecuteResponseSchema>

// backend/qentor/execution/adapter.py::ExecutionResult.to_payload() — the two
// shapes AerAdapter actually produces, one per execution_mode. Parsed lazily
// by callers that know which mode they asked for, never assumed.
export const StatevectorPayloadSchema = z.object({
  execution_id: z.string(),
  statevector: z.array(z.tuple([z.number(), z.number()])),
})
export type StatevectorPayload = z.infer<typeof StatevectorPayloadSchema>

export const ShotsPayloadSchema = z.object({
  execution_id: z.string(),
  counts: z.record(z.string(), z.number().int()),
  probabilities: z.record(z.string(), z.number()),
})
export type ShotsPayload = z.infer<typeof ShotsPayloadSchema>

// backend/qentor/verification/models.py::CheckStatus
export const VerificationCheckStatusSchema = z.enum(['PASS', 'FAIL'])
export type VerificationCheckStatus = z.infer<typeof VerificationCheckStatusSchema>

// backend/qentor/verification/models.py::VerificationStatus — a verifier's
// judgement (VERIFIED/FAILED/UNVERIFIABLE/ERROR), deliberately a distinct type
// from `VerificationStatusSchema` above, which is the *execution's* own status
// (VERIFIED/FAILED/ERROR, no UNVERIFIABLE) reported by /api/execute.
export const BellVerificationStatusSchema = z.enum(['VERIFIED', 'FAILED', 'UNVERIFIABLE', 'ERROR'])
export type BellVerificationStatus = z.infer<typeof BellVerificationStatusSchema>

// backend/qentor/api/schemas.py::VerificationCheckResponse
export const VerificationCheckSchema = z.object({
  name: z.string(),
  status: VerificationCheckStatusSchema,
  detail: z.string(),
})
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>

// backend/qentor/api/schemas.py::VerifyBellStateResponse
export const VerifyBellStateResponseSchema = z.object({
  result_id: z.string(),
  circuit_hash: z.string(),
  verifier: z.string(),
  verification_status: BellVerificationStatusSchema,
  checks: z.array(VerificationCheckSchema),
  expected_support: z.array(z.string()),
  observed_support: z.array(z.string()),
})
export type VerifyBellStateResponse = z.infer<typeof VerifyBellStateResponseSchema>

// backend/qentor/api/schemas.py::TutorFactResponse
export const TutorFactSchema = z.object({
  id: z.string(),
  kind: z.string(),
  description: z.string(),
  result_id: z.string(),
})
export type TutorFact = z.infer<typeof TutorFactSchema>

// backend/qentor/api/schemas.py::TutorResponse — `verification_status` here is
// the *execution's* own status (VERIFIED/FAILED/ERROR, see
// `VerificationStatusSchema` above), not a Bell-verifier verdict.
export const TutorResponseSchema = z.object({
  answer: z.string(),
  result_id: z.string(),
  circuit_hash: z.string(),
  provenance_class: z.string(),
  verification_status: z.string(),
  used_fallback_template: z.boolean(),
  facts: z.array(TutorFactSchema),
})
export type TutorResponse = z.infer<typeof TutorResponseSchema>
