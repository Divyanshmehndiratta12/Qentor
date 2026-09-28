/**
 * Zod schemas mirroring `backend/qentor/api/schemas.py` and
 * `backend/qentor/provenance/models.py` exactly. Parsing an HTTP response
 * through `ExecuteResponseSchema` is the ONLY way anywhere in this app to turn
 * bytes off the wire into something a component is allowed to render — see
 * `QuantumValue.ts`.
 */
import { z } from 'zod'
import { CircuitSchema } from '@/circuit/types'

// backend/qentor/lessons/models.py::Difficulty
export const LessonDifficultySchema = z.enum(['beginner', 'intermediate', 'advanced'])
export type LessonDifficulty = z.infer<typeof LessonDifficultySchema>

// backend/qentor/lessons/models.py::LabCapability — the set of already-real
// backend endpoints an interactive_lab section may point at. Never a new
// capability invented client-side.
export const LabCapabilitySchema = z.enum(['execute', 'verify_bell_state', 'multi_input_test', 'optimize'])
export type LabCapability = z.infer<typeof LabCapabilitySchema>

// backend/qentor/lessons/models.py's four section models, discriminated on
// `type` exactly like the backend's own discriminated union.
export const ExplanationSectionSchema = z.object({
  type: z.literal('explanation'),
  id: z.string(),
  title: z.string(),
  body: z.string(),
})

// backend/qentor/lessons/models.py::ConceptCheckOption
export const ConceptCheckOptionSchema = z.object({
  id: z.string(),
  text: z.string(),
})

// backend/qentor/lessons/models.py::ConceptCheckSection — `question` et al.
// are `.nullable()`, not `.optional()`, because pydantic/FastAPI serialise a
// `None` field as JSON `null`, not an omitted key (same convention as every
// other optional field in this file, e.g. `OptimizeResponseSchema.reason`).
// The backend guarantees these four are present together or all null; this
// schema doesn't re-enforce that (the backend catalog is already validated).
export const ConceptCheckSectionSchema = z.object({
  type: z.literal('concept_check'),
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  question: z.string().nullable(),
  options: z.array(ConceptCheckOptionSchema).nullable(),
  correct_option_id: z.string().nullable(),
  explanation: z.string().nullable(),
  concept: z.string().nullable(),
})

export const InteractiveLabSectionSchema = z.object({
  type: z.literal('interactive_lab'),
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  capability: LabCapabilitySchema,
})

export const ReflectionSectionSchema = z.object({
  type: z.literal('reflection'),
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
})

export const LessonSectionSchema = z.discriminatedUnion('type', [
  ExplanationSectionSchema,
  ConceptCheckSectionSchema,
  InteractiveLabSectionSchema,
  ReflectionSectionSchema,
])
export type LessonSectionResponse = z.infer<typeof LessonSectionSchema>

// backend/qentor/lessons/models.py::Lesson — `linked_circuit` reuses
// `CircuitSchema` exactly, the same canonical shape every execute/verify/
// optimize/multi-input request already validates against.
export const LessonSchema = z.object({
  id: z.string(),
  title: z.string(),
  short_description: z.string(),
  concept: z.string(),
  difficulty: LessonDifficultySchema,
  estimated_minutes: z.number().int(),
  learning_objectives: z.array(z.string()),
  sections: z.array(LessonSectionSchema),
  linked_circuit: CircuitSchema.nullable(),
  prerequisite_lesson_ids: z.array(z.string()),
})
export type LessonResponse = z.infer<typeof LessonSchema>

// backend/qentor/api/schemas.py::LessonCatalogResponse
export const LessonCatalogResponseSchema = z.object({
  lessons: z.array(LessonSchema),
})
export type LessonCatalogResponse = z.infer<typeof LessonCatalogResponseSchema>

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

// backend/qentor/verification/optimizer.py::OptimizationStatus
export const OptimizationStatusSchema = z.enum([
  'VERIFIED_SHORTER',
  'NO_OPTIMIZATION_FOUND',
  'REJECTED',
  'UNVERIFIABLE',
])
export type OptimizationStatus = z.infer<typeof OptimizationStatusSchema>

// backend/qentor/verification/equivalence.py::EquivalenceStatus — the
// optimizer's supporting equivalence report always uses this vocabulary,
// distinct from OptimizationStatusSchema above (an optimizer status) and from
// BellVerificationStatusSchema (the Bell verifier's own status).
export const EquivalenceStatusSchema = z.enum(['EQUIVALENT', 'NOT_EQUIVALENT', 'UNVERIFIABLE'])
export type EquivalenceStatus = z.infer<typeof EquivalenceStatusSchema>

// backend/qentor/api/schemas.py::OptimizeEquivalenceCheckResponse
export const OptimizeEquivalenceCheckSchema = z.object({
  name: z.string(),
  status: VerificationCheckStatusSchema,
  detail: z.string(),
})
export type OptimizeEquivalenceCheck = z.infer<typeof OptimizeEquivalenceCheckSchema>

// backend/qentor/api/schemas.py::OptimizeEquivalenceResponse
export const OptimizeEquivalenceSchema = z.object({
  status: EquivalenceStatusSchema,
  method: z.string(),
  global_phase: z.number().nullable(),
  checks: z.array(OptimizeEquivalenceCheckSchema),
  reason: z.string().nullable(),
})
export type OptimizeEquivalence = z.infer<typeof OptimizeEquivalenceSchema>

// backend/qentor/api/schemas.py::OptimizeResponse — `candidate_circuit` is
// non-null only when `status === "VERIFIED_SHORTER"` (see the backend's own
// OptimizationReport docstring): an unverified candidate's definition is
// withheld by the server, not merely labelled, so nothing downstream can
// apply it by mistake.
export const OptimizeResponseSchema = z.object({
  original_circuit_hash: z.string(),
  candidate_circuit_hash: z.string(),
  original_op_count: z.number().int(),
  candidate_op_count: z.number().int(),
  rules_applied: z.array(z.string()),
  reduction_summary: z.string(),
  status: OptimizationStatusSchema,
  equivalence: OptimizeEquivalenceSchema.nullable(),
  verifier_name: z.string(),
  verifier_version: z.string(),
  reason: z.string().nullable(),
  candidate_circuit: CircuitSchema.nullable(),
  result_id: z.string().nullable(),
})
export type OptimizeResponse = z.infer<typeof OptimizeResponseSchema>

// backend/qentor/verification/multi_input_harness.py::CaseStatus
export const MultiInputCaseStatusSchema = z.enum(['PASS', 'FAIL', 'EXECUTION_ERROR'])
export type MultiInputCaseStatus = z.infer<typeof MultiInputCaseStatusSchema>

// backend/qentor/verification/multi_input_harness.py::OverallStatus
export const MultiInputOverallStatusSchema = z.enum(['ALL_PASSED', 'SOME_FAILED', 'INCOMPLETE'])
export type MultiInputOverallStatus = z.infer<typeof MultiInputOverallStatusSchema>

// backend/qentor/api/schemas.py::MultiInputCaseResponse
export const MultiInputCaseResponseSchema = z.object({
  input_bits: z.string(),
  expected_output: z.string(),
  status: MultiInputCaseStatusSchema,
  observed_distribution: z.record(z.string(), z.number()).nullable(),
  error: z.string().nullable(),
  result_id: z.string().nullable(),
  circuit_hash: z.string(),
})
export type MultiInputCaseResponse = z.infer<typeof MultiInputCaseResponseSchema>

// backend/qentor/api/schemas.py::MultiInputCounterexampleResponse
export const MultiInputCounterexampleResponseSchema = z.object({
  input_bits: z.string(),
  expected_output: z.string(),
  observed_distribution: z.record(z.string(), z.number()),
  circuit_hash: z.string(),
  result_id: z.string().nullable(),
})
export type MultiInputCounterexampleResponse = z.infer<typeof MultiInputCounterexampleResponseSchema>

// backend/qentor/api/schemas.py::MultiInputTestResponse
export const MultiInputTestResponseSchema = z.object({
  test_id: z.string(),
  circuit_hash: z.string(),
  backend: z.string(),
  backend_version: z.string().nullable(),
  input_qubits: z.array(z.number().int()),
  output_qubits: z.array(z.number().int()),
  cases: z.array(MultiInputCaseResponseSchema),
  counterexamples: z.array(MultiInputCounterexampleResponseSchema),
  overall_status: MultiInputOverallStatusSchema,
})
export type MultiInputTestResponse = z.infer<typeof MultiInputTestResponseSchema>
