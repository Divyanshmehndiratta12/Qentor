/**
 * The real implementation of `ApiClient`. Every response is parsed through a
 * zod schema before it leaves this file, and the only thing handed back to a
 * caller is a `QuantumValue` built from that parsed data — never a raw
 * `fetch` JSON object a component could render without a provenance badge.
 */
import type { z } from 'zod'
import { CircuitSchema, type Circuit } from '@/circuit/types'
import {
  provenanceFromExecuteResponse,
  provenanceFromTraceStep,
  toQuantumValue,
  type QuantumValue,
} from '@/provenance/QuantumValue'
import {
  AgreementResponseSchema,
  CodeResponseSchema,
  EquivalenceResponseSchema,
  ExecuteResponseSchema,
  LessonCatalogResponseSchema,
  MultiInputTestResponseSchema,
  OptimizeResponseSchema,
  ShotsPayloadSchema,
  StatevectorPayloadSchema,
  TraceErrorDetailSchema,
  TraceResponseSchema,
  TutorResponseSchema,
  VerifyBellStateResponseSchema,
  type LessonSectionResponse,
  type TraceResponse,
} from '@/provenance/schema'
import {
  BackendUnavailableError,
  TraceRejectedError,
  type ApiClient,
  type AgreementResult,
  type Backend,
  type CodeViewsResult,
  type EquivalenceResult,
  type ExecutePayload,
  type ExecutionMode,
  type ExecutionTraceResult,
  type Lesson,
  type LessonSection,
  type MultiInputTestCase,
  type MultiInputTestResult,
  type OptimizationResult,
  type TutorAnswerResult,
  type TutorLanguage,
  type TutorLessonContext,
  type TutorTraceStepContext,
  type VerifyBellStateResult,
} from './client'

/** The only section field that needs snake_case -> camelCase conversion
 * (`correct_option_id`) — every other section field is already a
 * single-word name shared verbatim between the wire shape and the domain
 * type, so this is the one place that mapping actually has to happen. */
function mapLessonSection(section: LessonSectionResponse): LessonSection {
  if (section.type !== 'concept_check') return section
  return {
    type: 'concept_check',
    id: section.id,
    title: section.title,
    prompt: section.prompt,
    question: section.question,
    options: section.options,
    correctOptionId: section.correct_option_id,
    explanation: section.explanation,
    concept: section.concept,
  }
}

export class RealApiClient implements ApiClient {
  private readonly baseUrl: string

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl
  }

  async executeCircuit(
    circuit: Circuit,
    mode: ExecutionMode,
    shots?: number,
    backend?: Backend,
  ): Promise<QuantumValue<ExecutePayload>> {
    // Validate the outgoing circuit locally too, so a malformed request never
    // even reaches the network — the server's own `extra="forbid"` model is
    // still the authority, this just fails faster.
    const validCircuit = CircuitSchema.parse(circuit)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuit: validCircuit, mode, shots: shots ?? null, ...(backend ? { backend } : {}) }),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res)
      throw new BackendUnavailableError(detail, res.status)
    }

    const response = ExecuteResponseSchema.parse(await res.json())
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

  async traceCircuit(circuit: Circuit, backend?: Backend): Promise<ExecutionTraceResult> {
    // Same discipline as every other write path: the request body has exactly
    // circuit + mode (+ backend if chosen). `mode` is always "statevector" —
    // the only mode a trace exists for — and there is no way to reach this
    // method with an amplitude, probability, count or verdict attached.
    const validCircuit = CircuitSchema.parse(circuit)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/execute/trace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuit: validCircuit, mode: 'statevector', ...(backend ? { backend } : {}) }),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) throw await traceErrorFromResponse(res)

    const response = TraceResponseSchema.parse(await res.json())

    return traceResultFromResponse(response)
  }

  async verifyBellState(resultId: string, circuit: Circuit): Promise<VerifyBellStateResult> {
    // Same discipline as executeCircuit: validate the circuit locally, and the
    // request body below has exactly two fields — result_id and circuit. There
    // is no way to reach this method with a probability, count, amplitude or
    // verification_status field attached; nothing here reads or forwards any
    // such value.
    const validCircuit = CircuitSchema.parse(circuit)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/verify/bell-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result_id: resultId, circuit: validCircuit }),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res)
      throw new BackendUnavailableError(detail, res.status)
    }

    const response = VerifyBellStateResponseSchema.parse(await res.json())

    return {
      resultId: response.result_id,
      circuitHash: response.circuit_hash,
      verifier: response.verifier,
      verificationStatus: response.verification_status,
      checks: response.checks,
      expectedSupport: response.expected_support,
      observedSupport: response.observed_support,
    }
  }

  /**
   * POST a JSON body, parse the answer with `schema`. Used by the read-only Lab endpoints below: each sends the
   * canonical circuit(s) and nothing else, so no probability, statevector, verdict or piece of code can be attached.
   */
  private async postParsed<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.infer<S>> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      const detail = await safeErrorDetail(res)
      throw new BackendUnavailableError(detail, res.status)
    }
    return schema.parse(await res.json())
  }

  async generateCode(circuit: Circuit): Promise<CodeViewsResult> {
    const response = await this.postParsed('/api/circuit/code', { circuit: CircuitSchema.parse(circuit) }, CodeResponseSchema)
    return { circuitHash: response.circuit_hash, generator: response.generator, code: response.code }
  }

  async checkEquivalence(circuitA: Circuit, circuitB: Circuit): Promise<EquivalenceResult> {
    const response = await this.postParsed(
      '/api/verify/equivalence',
      { circuit_a: CircuitSchema.parse(circuitA), circuit_b: CircuitSchema.parse(circuitB) },
      EquivalenceResponseSchema,
    )
    return {
      status: response.status,
      method: response.method,
      checkerVersion: response.checker_version,
      circuitHashA: response.circuit_hash_a,
      circuitHashB: response.circuit_hash_b,
      globalPhase: response.global_phase,
      checks: response.checks,
      reason: response.reason,
    }
  }

  async compareBackends(circuit: Circuit, backends?: Backend[]): Promise<AgreementResult> {
    const response = await this.postParsed(
      '/api/compare/backends',
      { circuit: CircuitSchema.parse(circuit), ...(backends ? { backends } : {}) },
      AgreementResponseSchema,
    )
    return {
      method: response.method,
      threshold: response.threshold,
      status: response.status,
      circuitHash: response.circuit_hash,
      terminalMeasurementsStripped: response.terminal_measurements_stripped,
      backends: response.backends.map((b) => ({
        backend: b.backend,
        status: b.status,
        message: b.message,
        provenance: b.provenance ? provenanceFromTraceStep(b.provenance) : null,
      })),
      pairs: response.pairs.map((p) => ({
        backendA: p.backend_a,
        backendB: p.backend_b,
        maxAmplitudeDifference: p.max_amplitude_difference,
        maxProbabilityDifference: p.max_probability_difference,
        fidelity: p.fidelity,
        agrees: p.agrees,
      })),
      provenance: provenanceFromTraceStep(response.provenance),
    }
  }

  async listLessons(): Promise<Lesson[]> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/lessons`)
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res)
      throw new BackendUnavailableError(detail, res.status)
    }

    const response = LessonCatalogResponseSchema.parse(await res.json())

    return response.lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      shortDescription: lesson.short_description,
      concept: lesson.concept,
      difficulty: lesson.difficulty,
      estimatedMinutes: lesson.estimated_minutes,
      learningObjectives: lesson.learning_objectives,
      sections: lesson.sections.map(mapLessonSection),
      linkedCircuit: lesson.linked_circuit,
      prerequisiteLessonIds: lesson.prerequisite_lesson_ids,
    }))
  }

  async askTutor(
    resultId: string | null,
    circuit: Circuit | null,
    question: string,
    language: TutorLanguage = 'en',
    lesson?: TutorLessonContext,
    traceStep?: TutorTraceStepContext,
  ): Promise<TutorAnswerResult> {
    // Same discipline as verifyBellState: the request body is result_id,
    // circuit, question and language — plus lesson_id/section_id when a lesson
    // is given. Those are IDENTIFIERS the server resolves against its own
    // lesson registry; lesson text is never sent from here. There is no way to
    // reach this method with a probability, count, amplitude or verdict
    // attached. `language` only ever selects the answer's wrapper language.
    // Without `lesson` the body is exactly the original four fields.
    if (traceStep) {
      // A trace step is verified server-side against the circuit it was traced from.
      if (circuit === null) throw new Error('askTutor: a trace step needs the circuit it was traced from')
    } else if ((resultId === null) !== (circuit === null)) {
      throw new Error('askTutor: resultId and circuit must be provided together')
    }
    if (resultId === null && !lesson && !traceStep) {
      throw new Error('askTutor: a question needs a result (resultId + circuit), a lesson or a trace step')
    }

    const body: Record<string, unknown> = { question, language }
    if (circuit !== null) body.circuit = CircuitSchema.parse(circuit)
    if (resultId !== null) body.result_id = resultId
    if (traceStep) {
      // IDENTITY only — indices, the operation and the record's ids/hashes. There
      // is no amplitude/probability/Bloch field to send, and none is sent.
      body.trace_step = {
        step_index: traceStep.stepIndex,
        operation_index: traceStep.operationIndex,
        operation: traceStep.operation,
        result_id: traceStep.resultId,
        execution_id: traceStep.executionId,
        circuit_hash: traceStep.circuitHash,
        backend: traceStep.backend,
        backend_version: traceStep.backendVersion,
        previous_result_id: traceStep.previousResultId,
      }
    }
    if (lesson) {
      body.lesson_id = lesson.lessonId
      if (lesson.sectionId !== null) body.section_id = lesson.sectionId
    }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/tutor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const detail = await safeTutorErrorDetail(res)
      throw new BackendUnavailableError(detail, res.status)
    }

    const response = TutorResponseSchema.parse(await res.json())

    return {
      answer: response.answer,
      resultId: response.result_id,
      circuitHash: response.circuit_hash,
      provenanceClass: response.provenance_class,
      verificationStatus: response.verification_status,
      usedFallbackTemplate: response.used_fallback_template,
      facts: response.facts.map((f) => ({
        id: f.id,
        kind: f.kind,
        description: f.description,
        resultId: f.result_id,
      })),
      lessonId: response.lesson_id ?? null,
      sectionId: response.section_id ?? null,
      traceStep: response.trace_step
        ? {
            stepIndex: response.trace_step.step_index,
            stepNumber: response.trace_step.step_number,
            totalSteps: response.trace_step.total_steps,
            operationIndex: response.trace_step.operation_index,
            resultId: response.trace_step.result_id,
            circuitHash: response.trace_step.circuit_hash,
            provenanceClass: response.trace_step.provenance_class,
            verificationStatus: response.trace_step.verification_status,
          }
        : null,
    }
  }

  async optimizeCircuit(circuit: Circuit, backend?: Backend): Promise<OptimizationResult> {
    // Same discipline as every other write path here: the request body has
    // exactly two fields — circuit and backend. There is no way to reach
    // this method with a probability, amplitude, count or a "verified" flag
    // attached.
    const validCircuit = CircuitSchema.parse(circuit)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuit: validCircuit, ...(backend ? { backend } : {}) }),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res)
      throw new BackendUnavailableError(detail, res.status)
    }

    const response = OptimizeResponseSchema.parse(await res.json())

    return {
      originalCircuitHash: response.original_circuit_hash,
      candidateCircuitHash: response.candidate_circuit_hash,
      originalOpCount: response.original_op_count,
      candidateOpCount: response.candidate_op_count,
      rulesApplied: response.rules_applied,
      reductionSummary: response.reduction_summary,
      status: response.status,
      equivalence: response.equivalence
        ? {
            status: response.equivalence.status,
            method: response.equivalence.method,
            globalPhase: response.equivalence.global_phase,
            checks: response.equivalence.checks,
            reason: response.equivalence.reason,
          }
        : null,
      verifierName: response.verifier_name,
      verifierVersion: response.verifier_version,
      reason: response.reason,
      candidateCircuit: response.candidate_circuit,
      resultId: response.result_id,
    }
  }

  async runMultiInputTest(
    circuit: Circuit,
    inputQubits: number[],
    outputQubits: number[],
    cases: MultiInputTestCase[],
    backend?: Backend,
  ): Promise<MultiInputTestResult> {
    // Same discipline as every other write path here: the request body has
    // exactly circuit/input_qubits/output_qubits/cases/backend — there is no
    // way to reach this method with an observed distribution, a status, or a
    // counterexample attached.
    const validCircuit = CircuitSchema.parse(circuit)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/test/multi-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circuit: validCircuit,
          input_qubits: inputQubits,
          output_qubits: outputQubits,
          cases: cases.map((c) => ({ input_bits: c.inputBits, expected_output: c.expectedOutput })),
          ...(backend ? { backend } : {}),
        }),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res)
      throw new BackendUnavailableError(detail, res.status)
    }

    const response = MultiInputTestResponseSchema.parse(await res.json())

    return {
      testId: response.test_id,
      circuitHash: response.circuit_hash,
      backend: response.backend,
      backendVersion: response.backend_version,
      inputQubits: response.input_qubits,
      outputQubits: response.output_qubits,
      cases: response.cases.map((c) => ({
        inputBits: c.input_bits,
        expectedOutput: c.expected_output,
        status: c.status,
        observedDistribution: c.observed_distribution,
        error: c.error,
        resultId: c.result_id,
        circuitHash: c.circuit_hash,
      })),
      counterexamples: response.counterexamples.map((c) => ({
        inputBits: c.input_bits,
        expectedOutput: c.expected_output,
        observedDistribution: c.observed_distribution,
        circuitHash: c.circuit_hash,
        resultId: c.result_id,
      })),
      overallStatus: response.overall_status,
    }
  }
}

/**
 * A validated wire `TraceResponse` -> the camelCase `ExecutionTraceResult`.
 * Exported so the test fixtures use this exact mapping rather than a copy.
 *
 * Field-for-field: the statevector tuples and the Bloch coordinates are passed
 * through as the very numbers the backend sent — no rounding, clamping,
 * normalising or arithmetic — each wrapped with its own step's provenance (a
 * Bloch vector is derived from that step's state, so it shares its
 * provenance). A step with no `bloch_vector` (or a backend that predates the
 * field) maps to `null`; nothing is filled in.
 */
export function traceResultFromResponse(response: TraceResponse): ExecutionTraceResult {
  return {
    circuitHash: response.circuit_hash,
    tracedCircuitHash: response.traced_circuit_hash,
    backend: response.backend,
    backendVersion: response.backend_version,
    numQubits: response.num_qubits,
    mode: response.mode,
    traceMethod: response.trace_method,
    basisOrdering: response.basis_ordering,
    steps: response.steps.map((step) => {
      const provenance = provenanceFromTraceStep(step.provenance)
      const bloch = step.bloch_vector
      return {
        stepIndex: step.step_index,
        operationIndex: step.operation_index,
        operation: step.operation,
        executionId: step.execution_id,
        state: toQuantumValue(step.statevector, provenance),
        change: step.change
          ? {
              kind: step.change.kind,
              supportBefore: step.change.support_before,
              supportAfter: step.change.support_after,
              amplitudesChanged: step.change.amplitudes_changed,
              probabilitiesChanged: step.change.probabilities_changed,
              changedBasis: step.change.changed_basis_states.map((c) => c.basis),
              summary: step.change.summary,
            }
          : null,
        blochVector: bloch
          ? {
              coordinates: toQuantumValue({ x: bloch.x, y: bloch.y, z: bloch.z }, provenance),
              method: bloch.method,
              derivedFrom: {
                stepIndex: bloch.derived_from.step_index,
                resultId: bloch.derived_from.result_id,
                executionId: bloch.derived_from.execution_id,
                circuitHash: bloch.derived_from.circuit_hash,
                backend: bloch.derived_from.backend,
                backendVersion: bloch.derived_from.backend_version,
              },
            }
          : null,
      }
    }),
    terminalMeasurements: response.terminal_measurements.map((m) => ({
      operationIndex: m.operation_index,
      operation: m.operation,
    })),
    finalResultId: response.final_result_id,
  }
}

/**
 * POST /api/execute/trace's own error body is `{detail: {code, message}}` — a
 * structured refusal — which becomes a `TraceRejectedError`. Anything else
 * (a FastAPI validation error's list `detail`, an HTML gateway page, a body
 * that isn't JSON) is NOT a trace refusal and is reported, unparsed, as the
 * same `BackendUnavailableError` every other endpoint uses. The frontend
 * never invents a code for a body that didn't carry one.
 */
async function traceErrorFromResponse(res: Response): Promise<Error> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return new BackendUnavailableError(`HTTP ${res.status}`, res.status)
  }

  const detail = TraceErrorDetailSchema.safeParse((body as { detail?: unknown } | null)?.detail)
  if (detail.success) return new TraceRejectedError(detail.data.code, detail.data.message, res.status)

  const raw = (body as { detail?: unknown } | null)?.detail
  return new BackendUnavailableError(typeof raw === 'string' ? raw : JSON.stringify(body), res.status)
}

/**
 * POST /api/tutor reports a bad lesson/section as `{detail: {code, message}}`
 * (TUTOR_LESSON_NOT_FOUND / TUTOR_SECTION_NOT_FOUND / TUTOR_SECTION_MISMATCH).
 * Show the human `message`; every other error shape is handled exactly as
 * `safeErrorDetail` does.
 */
async function safeTutorErrorDetail(res: Response): Promise<string> {
  const body = await res.clone().json().catch(() => undefined)
  const detail = (body as { detail?: unknown } | undefined)?.detail
  if (
    detail !== null &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    typeof (detail as { code?: unknown }).code === 'string' &&
    typeof (detail as { message?: unknown }).message === 'string'
  ) {
    return (detail as { message: string }).message
  }
  return safeErrorDetail(res)
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') return body.detail
    // A structured refusal (`{detail: {code, message}}`: over a size limit, a malformed backend result)
    // reads as its message, not as raw JSON.
    const structured = TraceErrorDetailSchema.safeParse(body?.detail)
    if (structured.success) return structured.data.message
    return JSON.stringify(body)
  } catch {
    return `HTTP ${res.status}`
  }
}
