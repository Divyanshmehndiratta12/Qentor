/**
 * Zod schemas mirroring `backend/qentor/api/schemas.py` and
 * `backend/qentor/provenance/models.py` exactly. Parsing an HTTP response
 * through `ExecuteResponseSchema` is the ONLY way anywhere in this app to turn
 * bytes off the wire into something a component is allowed to render — see
 * `QuantumValue.ts`.
 */
import { z } from 'zod'
import { CircuitSchema, GATE_NAMES, GateOpSchema } from '@/circuit/types'

// backend/qentor/lessons/models.py::Difficulty
export const LessonDifficultySchema = z.enum(['beginner', 'intermediate', 'advanced'])
export type LessonDifficulty = z.infer<typeof LessonDifficultySchema>

// backend/qentor/lessons/models.py::LabCapability — the set of already-real
// backend endpoints an interactive_lab section may point at. Never a new
// capability invented client-side.
export const LabCapabilitySchema = z.enum(['execute', 'verify_bell_state', 'multi_input_test', 'optimize', 'variational_sweep'])
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

// backend/qentor/lessons/models.py::PublicConceptCheckSection — the question and
// the options, and NOTHING that grades them: the answer key and the explanation
// are not in the catalog, they come back from the grading endpoint for a selection
// this client submits (`ConceptCheckGradeResponseSchema`). `question` and `options`
// are `.nullable()`, not `.optional()`, because pydantic/FastAPI serialise a `None`
// field as JSON `null`, not an omitted key (same convention as every other optional
// field in this file, e.g. `OptimizeResponseSchema.reason`); they are both null
// (a prompt-only check) or both present. This object is not `.passthrough()`, so a
// `correct_option_id` or `explanation` a server sent anyway is dropped at the
// boundary and can never reach a component.
export const ConceptCheckSectionSchema = z.object({
  type: z.literal('concept_check'),
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  question: z.string().nullable(),
  options: z.array(ConceptCheckOptionSchema).nullable(),
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

// backend/qentor/api/schemas.py::ConceptCheckGradeResponse — the SERVER's verdict on one selection, and the explanation.
// It names no answer key: a wrong answer is `correct: false` and the explanation, nothing more.
export const ConceptCheckGradeResponseSchema = z.object({
  lesson_id: z.string(),
  check_id: z.string(),
  selected_option_id: z.string(),
  correct: z.boolean(),
  explanation: z.string(),
  grader: z.string(),
})
export type ConceptCheckGradeResponse = z.infer<typeof ConceptCheckGradeResponseSchema>

// backend/qentor/lessons/grading.py::RegradeResult — one saved selection graded again. `GRADED` carries a verdict and the
// explanation; any other status means the selection can no longer be graded (the lesson, check or option no longer
// exists) and carries neither.
export const RegradeResultSchema = z.object({
  lesson_id: z.string(),
  check_id: z.string(),
  selected_option_id: z.string(),
  status: z.enum(['GRADED', 'UNKNOWN_LESSON', 'UNKNOWN_CHECK', 'NOT_GRADED', 'UNKNOWN_OPTION']),
  correct: z.boolean().nullable(),
  explanation: z.string().nullable(),
})
export const RegradeResponseSchema = z.object({ results: z.array(RegradeResultSchema) })
export type RegradeResponse = z.infer<typeof RegradeResponseSchema>

// `detail = {code, message}` of a grading refusal (404 / 422 from the grading endpoints).
export const GradeErrorDetailSchema = z.object({ code: z.string(), message: z.string() })

// backend/qentor/provenance/models.py::ProvenanceClass
export const ProvenanceClassSchema = z.enum([
  'SIMULATION',
  'REAL_HARDWARE',
  'RECORDED_HARDWARE',
])
export type ProvenanceClass = z.infer<typeof ProvenanceClassSchema>

// backend/qentor/provenance/models.py::ExecutionStatus — what is known about ONE execution, never about the
// circuit: STATE_CHECKED (the backend ran and returned a well-formed result), FAILED (it ran but the result
// failed that check), ERROR (the run failed), SUCCEEDED (an older row: ran, no state check recorded). The wire
// field is still called `verification_status`; the word "verified" is reserved for property verifiers.
export const ExecutionStatusSchema = z.enum(['STATE_CHECKED', 'FAILED', 'ERROR', 'SUCCEEDED'])
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>

// backend/qentor/api/schemas.py::ExecuteResponse
export const ExecuteResponseSchema = z.object({
  result_id: z.string(),
  circuit_hash: z.string(),
  backend: z.string(),
  backend_version: z.string(),
  execution_mode: z.string(),
  provenance_class: ProvenanceClassSchema,
  verification_status: ExecutionStatusSchema,
  created_at: z.string(),
  payload: z.record(z.string(), z.unknown()),
  // Each qubit's own reduced state in the final state of a statevector run, derived by the SERVER from that run's stored
  // statevector (backend/qentor/api/state_view.py). Additive: a backend that predates it sends none, which parses as "none
  // provided" (an empty list) and is shown as exactly that.
  qubit_states: z.array(z.lazy(() => QubitStateSchema)).default([]),
})
export type ExecuteResponse = z.infer<typeof ExecuteResponseSchema>

// backend/qentor/execution/adapter.py::ExecutionResult.to_payload() — the two
// shapes AerAdapter actually produces, one per execution_mode. Parsed lazily
// by callers that know which mode they asked for, never assumed.
export const StatevectorPayloadSchema = z.object({
  execution_id: z.string(),
  statevector: z.array(z.tuple([z.number(), z.number()])),
  // What an ideal measurement of THIS state would give, computed by the server from the amplitudes above. Absent on records
  // written before the server supplied it; the UI then simply shows no probability chart, never one it worked out itself.
  theoretical_probabilities: z.record(z.string(), z.number()).optional(),
})
export type StatevectorPayload = z.infer<typeof StatevectorPayloadSchema>

export const ShotsPayloadSchema = z.object({
  execution_id: z.string(),
  counts: z.record(z.string(), z.number().int()),
  // SAMPLED frequencies (count / shots) — not theoretical probabilities. The wire name is historical.
  probabilities: z.record(z.string(), z.number()),
  shots: z.number().int().positive().optional(),
})
export type ShotsPayload = z.infer<typeof ShotsPayloadSchema>

// backend/qentor/api/schemas.py::TraceProvenanceResponse — exactly the
// provenance fields `ExecuteResponse` carries (minus `payload`), one set per
// trace step. Every step is an ordinary persisted execution record, so this
// mirrors `ExecuteResponseSchema` field for field, reusing the same enums.
export const TraceProvenanceSchema = z.object({
  result_id: z.string(),
  circuit_hash: z.string(),
  backend: z.string(),
  backend_version: z.string(),
  execution_mode: z.string(),
  provenance_class: ProvenanceClassSchema,
  verification_status: ExecutionStatusSchema,
  created_at: z.string(),
})
export type TraceProvenanceResponse = z.infer<typeof TraceProvenanceSchema>

// backend/qentor/execution/bloch.py::BlochSource — exactly which backend
// state a Bloch vector was derived from (mirrors the step's own identity).
export const BlochSourceSchema = z.object({
  step_index: z.number().int().nonnegative(),
  result_id: z.string().nullable(),
  execution_id: z.string(),
  circuit_hash: z.string(),
  backend: z.string(),
  backend_version: z.string(),
})
export type BlochSourceResponse = z.infer<typeof BlochSourceSchema>

// backend/qentor/execution/bloch.py::BlochVector — (x, y, z) DERIVED BY THE
// BACKEND from the step's own statevector, plus where it came from. The
// frontend only ever renders these numbers; it never computes them. There is
// deliberately no range clamp or normalisation here: a value outside [-1, 1]
// is reported by the component as received, not "corrected" (see BlochSphere).
export const BlochVectorSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  method: z.string(),
  derived_from: BlochSourceSchema,
})
export type BlochVectorResponse = z.infer<typeof BlochVectorSchema>

// backend/qentor/api/schemas.py::TraceStepResponse — `operation` is the
// canonical GateOp (the shared `GateOpSchema`, not a second gate format);
// both it and `operation_index` are null for the initial state (step 0).
// `statevector` is the adapter's own [[re, im], ...] list, passed through
// untouched. `bloch_vector` is null for a multi-qubit step (the backend never
// invents one for an entangled register); `.nullish()` also tolerates a
// backend that predates the field, which is treated the same as null.
// backend/qentor/execution/step_changes.py::StepChange — what one operation changed, computed by the server from the two
// backend statevectors. The summary is a fixed template over counts; the browser only displays it.
export const StepChangeSchema = z.object({
  kind: z.enum(['unchanged', 'phase_only', 'probabilities_changed']),
  support_before: z.number().int().nonnegative(),
  support_after: z.number().int().nonnegative(),
  amplitudes_changed: z.number().int().nonnegative(),
  probabilities_changed: z.number().int().nonnegative(),
  changed_basis_states: z.array(
    z.object({
      basis: z.string(),
      before: z.tuple([z.number(), z.number()]),
      after: z.tuple([z.number(), z.number()]),
      probability_before: z.number(),
      probability_after: z.number(),
    }),
  ),
  summary: z.string(),
})
export type StepChangeResponse = z.infer<typeof StepChangeSchema>

// backend/qentor/execution/reduced_state.py::QubitReducedState — ONE qubit's own state inside a register, computed by
// the server from that step's statevector. `OK` carries the Bloch vector, its length, the purity and the
// entangled-with-the-rest flag; `UNUSABLE` carries a reason and none of them. The refinement checks only that
// structure (which fields accompany which status); it never looks at, recomputes or bounds a value.
export const QubitStateSchema = z
  .object({
    qubit: z.number().int().nonnegative(),
    status: z.enum(['OK', 'UNUSABLE']),
    reason: z.string().nullish(),
    bloch: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullish(),
    bloch_length: z.number().nullish(),
    purity: z.number().nullish(),
    entangled_with_rest: z.boolean().nullish(),
    method: z.string(),
    derived_from: BlochSourceSchema,
  })
  .superRefine((state, ctx) => {
    const numbers = [state.bloch, state.bloch_length, state.purity, state.entangled_with_rest]
    if (state.status === 'OK' && numbers.some((v) => v === null || v === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'an OK qubit state must carry its Bloch vector, length, purity and entanglement flag' })
    }
    if (state.status === 'UNUSABLE') {
      if (numbers.some((v) => v !== null && v !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'an UNUSABLE qubit state must not carry a value' })
      }
      if (!state.reason) ctx.addIssue({ code: 'custom', message: 'an UNUSABLE qubit state must say why' })
    }
  })
export type QubitStateResponse = z.infer<typeof QubitStateSchema>

// backend/qentor/execution/amplitude_view.py::BasisAmplitude — one basis state's amplitude in polar form. Its position in
// the list is the statevector index. `phase` is null where the amplitude is numerically zero (no angle to report).
export const AmplitudeViewEntrySchema = z.object({
  magnitude: z.number(),
  probability: z.number(),
  phase: z.number().nullable(),
})
export type AmplitudeViewEntryResponse = z.infer<typeof AmplitudeViewEntrySchema>

export const TraceStepSchema = z.object({
  step_index: z.number().int().nonnegative(),
  operation_index: z.number().int().nonnegative().nullable(),
  operation: GateOpSchema.nullable(),
  execution_id: z.string(),
  provenance: TraceProvenanceSchema,
  statevector: z.array(z.tuple([z.number(), z.number()])),
  bloch_vector: BlochVectorSchema.nullish(),
  // Additive: a backend that predates them sends neither, which parses as "none provided" (an empty list).
  qubit_states: z.array(QubitStateSchema).default([]),
  amplitude_view: z.array(AmplitudeViewEntrySchema).default([]),
  change: StepChangeSchema.nullish(),
})
export type TraceStepResponse = z.infer<typeof TraceStepSchema>

// backend/qentor/api/schemas.py::TraceTerminalMeasurementResponse — a stripped
// trailing `measure`: metadata only, deliberately no state and no provenance.
export const TraceTerminalMeasurementSchema = z.object({
  operation_index: z.number().int().nonnegative(),
  operation: GateOpSchema,
})
export type TraceTerminalMeasurementResponse = z.infer<typeof TraceTerminalMeasurementSchema>

// backend/qentor/api/schemas.py::TraceResponse. The refinement below checks
// only STRUCTURE the renderer relies on — that steps are in order starting at
// an initial (operation-less) step, and that each statevector has one entry
// per basis state (2**num_qubits: a dimension count, not a quantum value).
// It never inspects, normalises or recomputes an amplitude, and it is not
// eligibility validation: whether a circuit can be traced stays entirely the
// backend's decision.
export const TraceResponseSchema = z
  .object({
    circuit_hash: z.string(),
    traced_circuit_hash: z.string(),
    backend: z.string(),
    backend_version: z.string(),
    num_qubits: z.number().int().positive(),
    mode: z.string(),
    trace_method: z.string(),
    basis_ordering: z.string(),
    steps: z.array(TraceStepSchema).min(1),
    terminal_measurements: z.array(TraceTerminalMeasurementSchema),
    final_result_id: z.string(),
  })
  .superRefine((trace, ctx) => {
    const dimension = 2 ** trace.num_qubits
    trace.steps.forEach((step, position) => {
      if (step.step_index !== position) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', position, 'step_index'],
          message: `step_index ${step.step_index} is out of order (expected ${position})`,
        })
      }
      if ((position === 0) !== (step.operation === null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', position, 'operation'],
          message: 'only the initial step (step 0) may have no operation',
        })
      }
      if (step.statevector.length !== dimension) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', position, 'statevector'],
          message: `statevector has ${step.statevector.length} entries, expected ${dimension} for ${trace.num_qubits} qubits`,
        })
      }

      // A Bloch vector's `derived_from` must name THIS step. If it points
      // anywhere else the response is malformed: rendering it would attach a
      // vector to the wrong state's provenance, so it is rejected outright
      // rather than shown with a mislinked source. (Identity check only —
      // nothing here looks at, or recomputes, a coordinate.)
      const sourceMismatches = (source: z.infer<typeof BlochSourceSchema>) =>
        [
          source.step_index !== step.step_index && 'step_index',
          source.result_id !== step.provenance.result_id && 'result_id',
          source.execution_id !== step.execution_id && 'execution_id',
          source.circuit_hash !== step.provenance.circuit_hash && 'circuit_hash',
          (source.backend !== step.provenance.backend ||
            source.backend_version !== step.provenance.backend_version) &&
            'backend',
        ].filter(Boolean)
      const bloch = step.bloch_vector
      if (bloch) {
        const mismatches = sourceMismatches(bloch.derived_from)
        if (mismatches.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', position, 'bloch_vector', 'derived_from'],
            message: `bloch_vector.derived_from does not match its own step (${mismatches.join(', ')})`,
          })
        }
      }

      // Per-qubit states: either none (an older backend) or exactly one per qubit in order, each naming THIS step.
      // A qubit state pointing at another step would put one state's numbers under another state's provenance.
      if (step.qubit_states.length > 0) {
        if (step.qubit_states.length !== trace.num_qubits) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', position, 'qubit_states'],
            message: `${step.qubit_states.length} qubit states for ${trace.num_qubits} qubits`,
          })
        }
        step.qubit_states.forEach((qubitState, qubitPosition) => {
          if (qubitState.qubit !== qubitPosition) {
            ctx.addIssue({
              code: 'custom',
              path: ['steps', position, 'qubit_states', qubitPosition, 'qubit'],
              message: `qubit ${qubitState.qubit} is out of order (expected ${qubitPosition})`,
            })
          }
          const mismatches = sourceMismatches(qubitState.derived_from)
          if (mismatches.length > 0) {
            ctx.addIssue({
              code: 'custom',
              path: ['steps', position, 'qubit_states', qubitPosition, 'derived_from'],
              message: `qubit_states.derived_from does not match its own step (${mismatches.join(', ')})`,
            })
          }
        })
      }

      if (step.amplitude_view.length > 0 && step.amplitude_view.length !== dimension) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', position, 'amplitude_view'],
          message: `amplitude_view has ${step.amplitude_view.length} entries, expected ${dimension} for ${trace.num_qubits} qubits`,
        })
      }
    })
  })
export type TraceResponse = z.infer<typeof TraceResponseSchema>

// backend/qentor/api/app.py::execute_trace's structured refusals:
// `detail = {"code": ..., "message": ...}` (a dict, unlike every other
// endpoint's string `detail`), with no quantum data alongside.
export const TraceErrorDetailSchema = z.object({
  code: z.string(),
  message: z.string(),
})
export type TraceErrorDetail = z.infer<typeof TraceErrorDetailSchema>

// backend/qentor/verification/models.py::CheckStatus
export const VerificationCheckStatusSchema = z.enum(['PASS', 'FAIL'])
export type VerificationCheckStatus = z.infer<typeof VerificationCheckStatusSchema>

// backend/qentor/verification/models.py::VerificationStatus — a verifier's
// judgement (VERIFIED/FAILED/UNVERIFIABLE/ERROR), deliberately a distinct type
// from `ExecutionStatusSchema` above, which is the *execution's* own status
// (STATE_CHECKED/FAILED/ERROR/SUCCEEDED, no UNVERIFIABLE) reported by /api/execute.
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
  // null for a lesson fact (course material, not an execution result)
  result_id: z.string().nullable(),
})
export type TutorFact = z.infer<typeof TutorFactSchema>

// backend/qentor/api/schemas.py::TutorResponse — `verification_status` here is
// the *execution's* own status (STATE_CHECKED/FAILED/ERROR/SUCCEEDED, see
// `VerificationStatusSchema` above), not a Bell-verifier verdict.
// result_id/circuit_hash/provenance_class/verification_status are null for a
// lesson-only answer: lesson material is not a quantum result. lesson_id and
// section_id echo the lesson context the server resolved; an older server
// that predates them omits both, hence `.nullish()`.
export const TutorResponseSchema = z.object({
  answer: z.string(),
  result_id: z.string().nullable(),
  circuit_hash: z.string().nullable(),
  provenance_class: z.string().nullable(),
  verification_status: z.string().nullable(),
  used_fallback_template: z.boolean(),
  facts: z.array(TutorFactSchema),
  lesson_id: z.string().nullish(),
  section_id: z.string().nullish(),
  trace_step: z
    .object({
      step_index: z.number().int(),
      step_number: z.number().int(),
      total_steps: z.number().int(),
      operation_index: z.number().int().nullable(),
      result_id: z.string(),
      circuit_hash: z.string(),
      provenance_class: z.string(),
      verification_status: z.string(),
    })
    .nullish(),
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
// backend/qentor/api/schemas.py::OpChangeResponse / RuleNoteResponse: what the SERVER computed about the difference between the
// original circuit and a verified candidate (qentor.verification.optimizer.diff_ops / explain_rule). The browser only draws it.
export const OpChangeSchema = z.object({
  kind: z.enum(['kept', 'removed', 'added']),
  original_index: z.number().int().nullable(),
  candidate_index: z.number().int().nullable(),
  description: z.string(),
})
export const RuleNoteSchema = z.object({ rule: z.string(), explanation: z.string().nullable() })

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
  operations_removed: z.number().int().nonnegative(),
  changes: z.array(OpChangeSchema),
  rule_notes: z.array(RuleNoteSchema),
  candidate_provenance: TraceProvenanceSchema.nullable(),
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

// backend/qentor/api/schemas.py::CodeResponse — read-only source text for the circuit in three SDKs, written by the
// server from the canonical model. It is displayed, never executed.
export const CodeResponseSchema = z.object({
  circuit_hash: z.string(),
  generator: z.string(),
  code: z.object({ qiskit: z.string(), cirq: z.string(), pennylane: z.string() }),
})
export type CodeResponse = z.infer<typeof CodeResponseSchema>

// backend/qentor/api/schemas.py::EquivalenceResponse
export const EquivalenceResponseSchema = z.object({
  status: EquivalenceStatusSchema,
  method: z.string(),
  checker_version: z.string(),
  circuit_hash_a: z.string(),
  circuit_hash_b: z.string(),
  global_phase: z.number().nullable(),
  checks: z.array(VerificationCheckSchema),
  reason: z.string().nullable(),
})
export type EquivalenceResponse = z.infer<typeof EquivalenceResponseSchema>

// backend/qentor/api/schemas.py::AgreementResponse — the server's comparison of several backends' statevectors.
export const AgreementBackendSchema = z.object({
  backend: z.string(),
  status: z.enum(['RAN', 'REFUSED', 'UNAVAILABLE', 'FAILED']),
  message: z.string().nullable(),
  provenance: TraceProvenanceSchema.nullable(),
})
export const AgreementPairSchema = z.object({
  backend_a: z.string(),
  backend_b: z.string(),
  max_amplitude_difference: z.number(),
  max_probability_difference: z.number(),
  fidelity: z.number(),
  agrees: z.boolean(),
})
export const AgreementResponseSchema = z.object({
  method: z.string(),
  threshold: z.number(),
  status: z.enum(['AGREE', 'DISAGREE', 'INCOMPLETE']),
  circuit_hash: z.string(),
  terminal_measurements_stripped: z.number().int().nonnegative(),
  backends: z.array(AgreementBackendSchema),
  pairs: z.array(AgreementPairSchema),
  provenance: TraceProvenanceSchema,
})
export type AgreementResponse = z.infer<typeof AgreementResponseSchema>


// ---------------------------------------------------------------------------
// Challenges — backend/qentor/api/schemas.py::ChallengeCatalogResponse / ChallengeSubmitResponse
// ---------------------------------------------------------------------------

// backend/qentor/challenges/models.py::Constraints
export const ChallengeConstraintsSchema = z.object({
  num_qubits: z.number().int().positive(),
  num_clbits: z.number().int().nonnegative(),
  allowed_gates: z.array(z.enum(GATE_NAMES)),
  max_ops: z.number().int().positive(),
  min_gate_counts: z.record(z.string(), z.number().int().positive()),
  anchor: z.array(GateOpSchema),
  must_measure: z.array(z.number().int().nonnegative()),
  gate_qubits: z.record(z.string(), z.array(z.number().int().nonnegative())),
  anchor_name: z.string(),
})

// backend/qentor/challenges/models.py::PublicChallenge — deliberately has no reference solution and no target circuit.
export const PublicChallengeSchema = z.object({
  id: z.string(),
  lesson_id: z.string(),
  title: z.string(),
  goal: z.string(),
  difficulty: LessonDifficultySchema,
  success_condition: z.string(),
  fixed_oracle: z.boolean(),
  constraints: ChallengeConstraintsSchema,
  starter_circuit: CircuitSchema,
  checks: z.array(z.object({ id: z.string(), label: z.string() })),
  hints: z.array(z.string()),
})
export type PublicChallengeResponse = z.infer<typeof PublicChallengeSchema>

export const ChallengeCatalogResponseSchema = z.object({ challenges: z.array(PublicChallengeSchema) })

// backend/qentor/challenges/evaluate.py::CheckOutcome
export const ChallengeCheckOutcomeSchema = z.object({
  id: z.string(),
  label: z.string(),
  passed: z.boolean(),
  evaluated: z.boolean(),
  detail: z.string(),
  hint_index: z.number().int().nonnegative(),
  evidence: z.array(z.object({ name: z.string(), value: z.number() })),
  result_id: z.string().nullable(),
})

export const ChallengeSubmitResponseSchema = z.object({
  attempt_id: z.string(),
  challenge_id: z.string(),
  circuit_hash: z.string(),
  passed: z.boolean(),
  verifier: z.string(),
  checks: z.array(ChallengeCheckOutcomeSchema),
  backend: z.string().nullable(),
  backend_version: z.string().nullable(),
  final_result_id: z.string().nullable(),
  provenance: z.record(z.string(), TraceProvenanceSchema),
  next_hint_index: z.number().int().nonnegative().nullable(),
  next_hint: z.string().nullable(),
  success_message: z.string().nullable(),
  created_at: z.string(),
})
export type ChallengeSubmitResponse = z.infer<typeof ChallengeSubmitResponseSchema>


// ---------------------------------------------------------------------------
// Circuit debugger — backend/qentor/api/schemas.py::DebugResponse
// ---------------------------------------------------------------------------

export const DebugSectionSchema = z.object({ text: z.string(), fact_ids: z.array(z.string()) })

export const DebugResponseSchema = z.object({
  observed: DebugSectionSchema,
  evidence: z.array(DebugSectionSchema),
  mismatch: DebugSectionSchema,
  next_experiment: DebugSectionSchema,
  hint: DebugSectionSchema.nullable(),
  // What the reasoning engine found about the run (R# facts, quoted); empty when it had nothing for this run.
  engine_evidence: z.array(DebugSectionSchema).default([]),
  facts: z.array(TutorFactSchema),
  used_fallback_template: z.boolean(),
  grounded_in: z.enum(['challenge', 'result', 'failed_run']),
  result_id: z.string().nullable(),
  circuit_hash: z.string(),
  provenance_class: z.string().nullable(),
  verification_status: z.string().nullable(),
  attempt_id: z.string().nullable(),
  analysis_id: z.string().nullish(),
})
export type DebugResponse = z.infer<typeof DebugResponseSchema>


// ---------------------------------------------------------------------------
// Experiment comparison - backend/qentor/api/schemas.py::ExperimentCompareResponse
// ---------------------------------------------------------------------------

const ValueKindSchema = z.enum(['sampled_frequency', 'theoretical_probability'])
const RunSchema = z.object({
  provenance: TraceProvenanceSchema,
  execution_id: z.string().nullable(),
  shots: z.number().nullable(),
  num_qubits: z.number(),
})

export const ComparisonCircuitSchema = z.object({
  same_circuit: z.boolean(),
  num_qubits_a: z.number(),
  num_qubits_b: z.number(),
  num_ops_a: z.number(),
  num_ops_b: z.number(),
  changes: z.array(
    z.object({
      tag: z.enum(['equal', 'replace', 'delete', 'insert']),
      a_start: z.number(),
      a_ops: z.array(z.string()),
      b_start: z.number(),
      b_ops: z.array(z.string()),
    }),
  ),
  equivalence_status: EquivalenceStatusSchema,
  equivalence_reason: z.string().nullable(),
})

export const ComparisonMeasurementSchema = z.object({
  comparable: z.boolean(),
  reason: z.string().nullable(),
  kind_a: ValueKindSchema.nullable(),
  kind_b: ValueKindSchema.nullable(),
  rows: z.array(z.object({ outcome: z.string(), a: z.number().nullable(), b: z.number().nullable(), difference: z.number().nullable() })),
  total_variation_distance: z.number().nullable(),
  max_difference: z.number().nullable(),
  note: z.string().nullable(),
})

export const ComparisonStateSchema = z.object({
  comparable: z.boolean(),
  reason: z.string().nullable(),
  fidelity: z.number().nullable(),
  max_probability_difference: z.number().nullable(),
  max_amplitude_difference: z.number().nullable(),
  note: z.string().nullable(),
})

export type ComparisonBodyResponse = {
  circuit: z.infer<typeof ComparisonCircuitSchema>
  measurement: z.infer<typeof ComparisonMeasurementSchema>
  state: z.infer<typeof ComparisonStateSchema>
}

export const ExperimentCompareResponseSchema = z.object({
  comparison_id: z.string(),
  method: z.string(),
  a: RunSchema,
  b: RunSchema,
  circuit: ComparisonCircuitSchema,
  measurement: ComparisonMeasurementSchema,
  state: ComparisonStateSchema,
  provenance: TraceProvenanceSchema,
})
export type ExperimentCompareResponse = z.infer<typeof ExperimentCompareResponseSchema>


// backend/qentor/api/schemas.py::ExportResponse - a portable description of a circuit; provenance METADATA only, no results.
export const ExportResponseSchema = z.object({
  format: z.string(),
  circuit_hash: z.string(),
  circuit: CircuitSchema,
  qasm: z.string(),
  generator: z.string(),
  code: z.object({ qiskit: z.string(), cirq: z.string(), pennylane: z.string() }),
  execution: TraceProvenanceSchema.nullable(),
  note: z.string(),
})
export type ExportResponse = z.infer<typeof ExportResponseSchema>

// backend/qentor/api/schemas.py::GenerationStatusResponse — whether this server can generate circuits at all.
export const GenerationStatusSchema = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  reason: z.string().nullable(),
})

// backend/qentor/api/schemas.py::GenerateCircuitResponse — the server's reading of one model draft. There is deliberately no
// field for a probability, a count, a result id or a verdict: "PROPOSED" only means the text parsed and fits the limits.
export const GenerateCircuitResponseSchema = z.object({
  status: z.enum(['PROPOSED', 'REJECTED']),
  label: z.string(),
  verification_status: z.string(),
  generator: z.string(),
  model: z.string().nullable(),
  raw_qasm: z.string(),
  circuit: CircuitSchema.nullable(),
  canonical_qasm: z.string().nullable(),
  circuit_hash: z.string().nullable(),
  summary: z.string().nullable(),
  explanation: z.string().nullable(),
  explanation_source: z.enum(['AI', 'TEMPLATE']).nullable(),
  explanation_note: z.string().nullable(),
  problems: z.array(z.object({ code: z.string(), message: z.string(), line: z.number().int().nullable() })),
  constraint_notes: z.array(z.string()),
})
export type GenerateCircuitResponse = z.infer<typeof GenerateCircuitResponseSchema>

// ---------------------------------------------------------------------------------------------------------------------------
// Classroom (backend/qentor/api/classroom.py, backend/qentor/classroom/dashboard.py). Anonymous: a learner is a random token held
// by this browser; the instructor sees counts and aliases only. Every dashboard figure is a count the server made.

export const CreateClassResponseSchema = z.object({
  class_code: z.string(),
  instructor_key: z.string(),
  title: z.string(),
  created_at: z.string(),
  notice: z.string(),
})

export const JoinClassResponseSchema = z.object({
  learner_token: z.string(),
  alias: z.string(),
  class_code: z.string(),
  class_title: z.string(),
  rejoined: z.boolean(),
  new_identity: z.boolean(),
})

export const MyClassResponseSchema = z.object({
  in_class: z.boolean(),
  token_known: z.boolean(),
  class_code: z.string().nullable().optional(),
  class_title: z.string().nullable().optional(),
  alias: z.string().nullable().optional(),
  joined_at: z.string().nullable().optional(),
})

export const LeaveClassResponseSchema = z.object({ left: z.boolean() })
export const SyncProgressResponseSchema = z.object({ recorded: z.number().int(), duplicates: z.number().int(), unknown: z.number().int() })
export const LearnerEventResponseSchema = z.object({ status: z.enum(['RECORDED', 'DUPLICATE']) })
export const DeleteClassResponseSchema = z.object({ deleted: z.boolean(), events_deleted: z.number().int() })

export const DashboardCheckRowSchema = z.object({ check_id: z.string(), concept: z.string(), answered: z.number().int(), correct: z.number().int() })
export const DashboardLessonRowSchema = z.object({
  lesson_id: z.string(),
  title: z.string(),
  started: z.number().int(),
  completed: z.number().int(),
  developing: z.number().int(),
  assessment_answered: z.number().int(),
  assessment_correct: z.number().int(),
  checks: z.array(DashboardCheckRowSchema),
})
export const DashboardFailurePatternSchema = z.object({ check_id: z.string(), label: z.string(), count: z.number().int(), learners: z.number().int() })
export const DashboardChallengeRowSchema = z.object({
  challenge_id: z.string(),
  title: z.string(),
  lesson_id: z.string(),
  started: z.number().int(),
  attempting_learners: z.number().int(),
  attempts: z.number().int(),
  solved_learners: z.number().int(),
  failed_attempts: z.number().int(),
  failure_patterns: z.array(DashboardFailurePatternSchema),
})
export const DashboardMisconceptionSchema = z.object({
  kind: z.string(),
  category: z.string(),
  lesson_id: z.string(),
  challenge_id: z.string().nullable(),
  learners_affected: z.number().int(),
  still_incorrect: z.number().int().nullable(),
  sample_size: z.number().int(),
  explanation: z.string().nullable(),
})
export const DashboardRecentSchema = z.object({
  alias: z.string(),
  kind: z.string(),
  subject_id: z.string(),
  subject_label: z.string(),
  outcome: z.string().nullable(),
  created_at: z.string(),
})
export const ClassDashboardResponseSchema = z.object({
  class_info: z.object({ class_code: z.string(), title: z.string(), created_at: z.string() }),
  sample: z.object({
    learners_in_class: z.number().int(),
    learners_left: z.number().int(),
    active_learners: z.number().int(),
    active_window_days: z.number().int(),
    events_total: z.number().int(),
  }),
  empty: z.boolean(),
  data_note: z.string(),
  lessons: z.array(DashboardLessonRowSchema),
  challenges: z.array(DashboardChallengeRowSchema),
  misconceptions: z.array(DashboardMisconceptionSchema),
  recent: z.array(DashboardRecentSchema),
})
export type ClassDashboardResponse = z.infer<typeof ClassDashboardResponseSchema>

// backend/qentor/api/sharing.py — a read-only snapshot. The result, when there is one, is the stored provenance record.
export const CreateExperimentResponseSchema = z.object({ experiment_id: z.string(), path: z.string(), created_at: z.string() })
export const SharedExperimentResponseSchema = z.object({
  experiment_id: z.string(),
  created_at: z.string(),
  title: z.string().nullable(),
  read_only: z.literal(true),
  note: z.string(),
  circuit_hash: z.string(),
  circuit: CircuitSchema,
  qasm: z.string(),
  generator: z.string(),
  code: z.object({ qiskit: z.string(), cirq: z.string(), pennylane: z.string() }),
  backend: z.string(),
  mode: z.string(),
  shots: z.number().int().nullable(),
  lesson: z.object({ id: z.string(), title: z.string() }).nullable(),
  challenge: z.object({ id: z.string(), title: z.string() }).nullable(),
  result: ExecuteResponseSchema.nullable(),
  result_note: z.string(),
})
export type SharedExperimentResponse = z.infer<typeof SharedExperimentResponseSchema>

// backend/qentor/api/code_input.py — pasted code read into the canonical circuit. No result, ever.
export const ParseCodeResponseSchema = z.object({
  status: z.literal('PARSED'),
  dialect: z.string(),
  label: z.string(),
  circuit: CircuitSchema,
  circuit_hash: z.string(),
  canonical_qasm: z.string(),
  notes: z.array(z.string()),
})
export const ParseCodeRefusalSchema = z.object({
  code: z.literal('CODE_NOT_SUPPORTED'),
  message: z.string(),
  problems: z.array(z.object({ line: z.number().int().nullable(), column: z.number().int().nullable(), message: z.string() })),
  supported: z.array(z.string()),
  label: z.string(),
})

// A structured refusal from a classroom, sharing or code endpoint: `{detail: {code, message}}`.
export const ClassroomErrorDetailSchema = z.object({ code: z.string(), message: z.string() }).passthrough()

// ---------------------------------------------------------------------------
// Quantum reasoning engine - backend/qentor/api/reasoning.py::AnalysisResponse and WhatIfPreview.
// Every number in a reasoning answer is the backend's: the browser parses it here and wraps it with the ANALYSIS record's own
// provenance (see realClient.ts), so no component can render one without it.
// ---------------------------------------------------------------------------

export const ReasoningSourceSchema = z.object({
  role: z.string(),
  result_id: z.string(),
  execution_id: z.string().nullable(),
  circuit_hash: z.string(),
  backend: z.string(),
  backend_version: z.string(),
  execution_mode: z.string(),
  provenance_class: z.string(),
  verification_status: z.string(),
})
export type ReasoningSourceResponse = z.infer<typeof ReasoningSourceSchema>

const ProbabilityItemSchema = z.object({
  label: z.string(),
  outcome: z.string().nullable(),
  qubit: z.number().int().nullable(),
  value: z.number().int().nullable(),
  theoretical_probability: z.number().nullable(),
  sampled_frequency: z.number().nullable(),
  sampled_count: z.number().int().nullable(),
  shots: z.number().int().nullable(),
  difference: z.number().nullable(),
})

const ProbabilityDataSchema = z.object({
  num_qubits: z.number().int(),
  bit_order: z.string(),
  items: z.array(ProbabilityItemSchema),
  notes: z.array(z.string()),
})

const OptimizationDataSchema = z.object({
  optimization_status: OptimizationStatusSchema,
  original_circuit_hash: z.string(),
  original_qasm: z.string(),
  original_op_count: z.number().int(),
  candidate_circuit: CircuitSchema.nullable(),
  candidate_qasm: z.string().nullable(),
  candidate_circuit_hash: z.string().nullable(),
  candidate_op_count: z.number().int().nullable(),
  operations_removed: z.number().int().nonnegative(),
  rules_applied: z.array(z.string()),
  rewrites: z.array(RuleNoteSchema),
  changes: z.array(OpChangeSchema),
  equivalence: z
    .object({ status: EquivalenceStatusSchema, method: z.string(), global_phase: z.number().nullable(), reason: z.string().nullable() })
    .nullable(),
  verifier: z.string(),
  candidate_result_id: z.string().nullable(),
})

const WhatIfDataSchema = z.object({
  description: z.string(),
  original_circuit_hash: z.string(),
  counterfactual_circuit_hash: z.string(),
  counterfactual_qasm: z.string(),
  original_op_count: z.number().int(),
  counterfactual_op_count: z.number().int(),
  changes: z.array(OpChangeSchema),
  comparison: z.object({ circuit: ComparisonCircuitSchema, measurement: ComparisonMeasurementSchema, state: ComparisonStateSchema }),
  compared_values: z.string(),
})

const ReasoningQubitSchema = z.object({
  qubit: z.number().int(),
  status: z.enum(['OK', 'UNUSABLE']),
  reason: z.string().nullable(),
  bloch: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable(),
  bloch_length: z.number().nullable(),
  purity: z.number().nullable(),
  entangled_with_rest: z.boolean().nullable(),
})

const TraceChangeDataSchema = z.object({
  step_index: z.number().int(),
  step_number: z.number().int(),
  total_steps: z.number().int(),
  num_qubits: z.number().int(),
  bit_order: z.string(),
  operation: z.object({ index: z.number().int(), gate: z.string(), description: z.string() }).nullable(),
  after_probabilities: z.record(z.string(), z.number()),
  after_qubits: z.array(ReasoningQubitSchema),
  before_probabilities: z.record(z.string(), z.number()).optional(),
  before_qubits: z.array(ReasoningQubitSchema).optional(),
  change_kind: z.enum(['unchanged', 'phase_only', 'probabilities_changed']).optional(),
  change_summary: z.string().optional(),
  probability_changes: z.array(z.object({ outcome: z.string(), before: z.number(), after: z.number(), difference: z.number() })).optional(),
})

const reasoningBase = {
  analysis_id: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  method: z.string(),
  circuit_hash: z.string(),
  sources: z.array(ReasoningSourceSchema),
  provenance: TraceProvenanceSchema,
  facts: z.array(TutorFactSchema),
  answer: z.string(),
  used_fallback_template: z.boolean(),
}

export const ReasoningResponseSchema = z.discriminatedUnion('intent', [
  z.object({ ...reasoningBase, intent: z.literal('PROBABILITY'), data: ProbabilityDataSchema }),
  z.object({ ...reasoningBase, intent: z.literal('OPTIMIZE'), data: OptimizationDataSchema }),
  z.object({ ...reasoningBase, intent: z.literal('WHAT_IF'), data: WhatIfDataSchema }),
  z.object({ ...reasoningBase, intent: z.literal('TRACE_CHANGE'), data: TraceChangeDataSchema }),
  z.object({ ...reasoningBase, intent: z.literal('COMPARE'), data: z.record(z.string(), z.unknown()) }),
  z.object({ ...reasoningBase, intent: z.literal('DEBUG'), data: z.record(z.string(), z.unknown()) }),
])
export type ReasoningResponse = z.infer<typeof ReasoningResponseSchema>

export const WhatIfPreviewResponseSchema = z.object({
  description: z.string(),
  original_circuit_hash: z.string(),
  counterfactual_circuit: CircuitSchema,
  counterfactual_circuit_hash: z.string(),
  counterfactual_qasm: z.string(),
  original_op_count: z.number().int(),
  counterfactual_op_count: z.number().int(),
  changes: z.array(OpChangeSchema),
})
export type WhatIfPreviewResponse = z.infer<typeof WhatIfPreviewResponseSchema>

// ---------------------------------------------------------------------------
// Variational (VQE-style) demonstration - backend/qentor/api/variational.py
// Every <Z>, Bloch vector and probability is read by the server from a backend statevector; each point names the run (provenance) it
// came from. The browser parses it and draws it.
// ---------------------------------------------------------------------------

const VariationalPointSchema = z.object({
  theta: z.number(),
  expectation_z: z.number(),
  bloch: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  probabilities: z.object({ '0': z.number(), '1': z.number() }),
  result_id: z.string(),
  execution_id: z.string(),
  circuit_hash: z.string(),
  provenance: TraceProvenanceSchema,
})

const variationalCommon = {
  method: z.string(),
  expectation_method: z.string(),
  ansatz: z.string(),
  observable: z.string(),
  label: z.string(),
  backend: z.string(),
  backend_version: z.string(),
  provenance: TraceProvenanceSchema,
}

export const VariationalSweepResponseSchema = z.object({
  ...variationalCommon,
  points: z.array(VariationalPointSchema).min(1),
  minimum_index: z.number().int().nonnegative(),
  maximum_index: z.number().int().nonnegative(),
})
export type VariationalSweepResponse = z.infer<typeof VariationalSweepResponseSchema>

export const VariationalOptimizeResponseSchema = z.object({
  ...variationalCommon,
  steps: z
    .array(z.object({ step: z.number().int().nonnegative(), point: VariationalPointSchema, gradient: z.number(), plus: VariationalPointSchema, minus: VariationalPointSchema }))
    .min(1),
  lowest_index: z.number().int().nonnegative(),
  converged: z.boolean(),
  learning_rate: z.number(),
  shift: z.number(),
  notes: z.array(z.string()),
})
export type VariationalOptimizeResponse = z.infer<typeof VariationalOptimizeResponseSchema>
