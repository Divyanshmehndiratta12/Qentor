/**
 * The real implementation of `ApiClient`. Every response is parsed through a
 * zod schema before it leaves this file, and the only thing handed back to a
 * caller is a `QuantumValue` built from that parsed data — never a raw
 * `fetch` JSON object a component could render without a provenance badge.
 */
import { CircuitSchema, type Circuit } from '@/circuit/types'
import { provenanceFromExecuteResponse, toQuantumValue, type QuantumValue } from '@/provenance/QuantumValue'
import {
  ExecuteResponseSchema,
  LessonCatalogResponseSchema,
  MultiInputTestResponseSchema,
  OptimizeResponseSchema,
  ShotsPayloadSchema,
  StatevectorPayloadSchema,
  TutorResponseSchema,
  VerifyBellStateResponseSchema,
} from '@/provenance/schema'
import {
  BackendUnavailableError,
  type ApiClient,
  type Backend,
  type ExecutePayload,
  type ExecutionMode,
  type Lesson,
  type MultiInputTestCase,
  type MultiInputTestResult,
  type OptimizationResult,
  type TutorAnswerResult,
  type TutorLanguage,
  type VerifyBellStateResult,
} from './client'

export class RealApiClient implements ApiClient {
  private readonly baseUrl: string

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl
  }

  async executeCircuit(
    circuit: Circuit,
    mode: ExecutionMode,
    shots?: number,
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
        body: JSON.stringify({ circuit: validCircuit, mode, shots: shots ?? null }),
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
      payload = { executionId: sv.execution_id, statevector: sv.statevector }
    } else {
      const shots = ShotsPayloadSchema.parse(response.payload)
      payload = {
        executionId: shots.execution_id,
        counts: shots.counts,
        probabilities: shots.probabilities,
      }
    }

    return toQuantumValue(payload, provenance)
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
      sections: lesson.sections,
      linkedCircuit: lesson.linked_circuit,
      prerequisiteLessonIds: lesson.prerequisite_lesson_ids,
    }))
  }

  async askTutor(
    resultId: string,
    circuit: Circuit,
    question: string,
    language: TutorLanguage = 'en',
  ): Promise<TutorAnswerResult> {
    // Same discipline as verifyBellState: the request body has exactly four
    // fields — result_id, circuit, question and language. There is no way to
    // reach this method with a probability, count, amplitude or verdict
    // attached. `language` only ever selects the answer's wrapper language.
    const validCircuit = CircuitSchema.parse(circuit)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/tutor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result_id: resultId, circuit: validCircuit, question, language }),
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

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') return body.detail
    return JSON.stringify(body)
  } catch {
    return `HTTP ${res.status}`
  }
}
