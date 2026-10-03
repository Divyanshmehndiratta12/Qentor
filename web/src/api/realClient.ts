/**
 * The real implementation of `ApiClient`. Every response is parsed through a
 * zod schema before it leaves this file, and the only thing handed back to a
 * caller is a `QuantumValue` built from that parsed data — never a raw
 * `fetch` JSON object a component could render without a provenance badge.
 */
import type { z } from 'zod'
import { CircuitSchema, type Circuit } from '@/circuit/types'
import {
  provenanceFromTraceStep,
  toQuantumValue,
  type Provenance,
  type QuantumValue,
} from '@/provenance/QuantumValue'
import {
  AgreementResponseSchema,
  ChallengeCatalogResponseSchema,
  ChallengeSubmitResponseSchema,
  ConceptCheckGradeResponseSchema,
  DebugResponseSchema,
  ExperimentCompareResponseSchema,
  ExportResponseSchema,
  CodeResponseSchema,
  EquivalenceResponseSchema,
  ExecuteResponseSchema,
  GenerateCircuitResponseSchema,
  GenerationStatusSchema,
  GradeErrorDetailSchema,
  LessonCatalogResponseSchema,
  MultiInputTestResponseSchema,
  OptimizeResponseSchema,
  ReasoningResponseSchema,
  RegradeResponseSchema,
  TraceErrorDetailSchema,
  TraceResponseSchema,
  TutorResponseSchema,
  VariationalOptimizeResponseSchema,
  VariationalSweepResponseSchema,
  VerifyBellStateResponseSchema,
  WhatIfPreviewResponseSchema,
  type ComparisonBodyResponse,
  type LessonSectionResponse,
  type TraceResponse,
} from '@/provenance/schema'
import * as classroom from './classroomHttp'
import { quantumValueFromExecuteResponse } from './executeValue'
import { mapQubitState } from './qubitStateMap'
import { learnerHeaders } from './learnerToken'
import {
  BackendUnavailableError,
  GenerationFailedError,
  GenerationUnavailableError,
  GradeRejectedError,
  TraceRejectedError,
  type ApiClient,
  type AgreementResult,
  type Backend,
  type Challenge,
  type ChallengeSubmission,
  type CircuitProposal,
  type ClassCreated,
  type ClassDashboard,
  type ClassJoined,
  type ClassMembership,
  type ClassSyncResult,
  type CodeViewsResult,
  type ComparisonBody,
  type CreateExperimentInput,
  type CreatedExperiment,
  type LearnerEventKind,
  type ParsedCode,
  type SdkDialect,
  type SharedExperiment,
  type GenerationRequestInput,
  type GenerationStatus,
  type ConceptCheckGrade,
  type RegradedAnswer,
  type SavedAnswer,
  type DebugReport,
  type DebugRequestInput,
  type CircuitExport,
  type ExperimentComparison,
  type EquivalenceResult,
  type ExecutePayload,
  type ExecutionMode,
  type ExecutionTraceResult,
  type Lesson,
  type LessonSection,
  type MultiInputTestCase,
  type MultiInputTestResult,
  type ModificationInput,
  type OptimizationResult,
  type ReasoningRequestInput,
  type ReasoningResult,
  type TutorAnswerResult,
  type TutorLanguage,
  type TutorLessonContext,
  type TutorTraceStepContext,
  type VariationalOptimizationResult,
  type VariationalOptimizeInput,
  type VariationalPoint,
  type VariationalSweepInput,
  type VariationalSweepResult,
  type VerifyBellStateResult,
  type WhatIfPreview,
} from './client'

/** A concept check is rebuilt field by field, never spread, so nothing the wire carried beyond the public fields (a
 * `correct_option_id` or `explanation` from a server that should not have sent them) can reach a component. Every other
 * section field is a single-word name shared verbatim between the wire shape and the domain type. */
function mapLessonSection(section: LessonSectionResponse): LessonSection {
  if (section.type !== 'concept_check') return section
  return {
    type: 'concept_check',
    id: section.id,
    title: section.title,
    prompt: section.prompt,
    question: section.question,
    options: section.options,
    concept: section.concept,
  }
}

export class RealApiClient implements ApiClient {
  private readonly baseUrl: string

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl
  }

  async getGenerationStatus(): Promise<GenerationStatus> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/generate/status`)
    } catch (err) {
      throw new BackendUnavailableError(`could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new BackendUnavailableError(await safeErrorDetail(res), res.status)
    return GenerationStatusSchema.parse(await res.json())
  }

  async generateCircuit(input: GenerationRequestInput): Promise<CircuitProposal> {
    // The learner's words, identifiers and the current circuit as context. There is no field through which a quantum value, a
    // result or a verdict could be sent, and nothing here evaluates what comes back: it is parsed, mapped and handed on.
    const body: Record<string, unknown> = { prompt: input.prompt.trim(), language: input.language ?? 'en' }
    if (input.lessonId) body.lesson_id = input.lessonId
    if (input.sectionId) body.section_id = input.sectionId
    if (input.challengeId) body.challenge_id = input.challengeId
    if (input.circuit && input.circuit.ops.length > 0) body.circuit = CircuitSchema.parse(input.circuit)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/generate/circuit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new BackendUnavailableError(`could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      const detail = await structuredDetail(res)
      if (res.status === 503 && detail?.code === 'AI_GENERATION_UNAVAILABLE') throw new GenerationUnavailableError(detail.message)
      if (res.status === 502 && detail?.code === 'AI_GENERATION_FAILED') throw new GenerationFailedError(detail.message)
      throw new BackendUnavailableError(detail?.message ?? `HTTP ${res.status}`, res.status)
    }
    const r = GenerateCircuitResponseSchema.parse(await res.json())
    return {
      status: r.status,
      label: r.label,
      verificationStatus: r.verification_status,
      generator: r.generator,
      model: r.model,
      rawQasm: r.raw_qasm,
      circuit: r.circuit,
      canonicalQasm: r.canonical_qasm,
      circuitHash: r.circuit_hash,
      summary: r.summary,
      explanation: r.explanation,
      explanationSource: r.explanation_source,
      explanationNote: r.explanation_note,
      problems: r.problems,
      constraintNotes: r.constraint_notes,
    }
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

    return quantumValueFromExecuteResponse(ExecuteResponseSchema.parse(await res.json()))
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
  private async postParsed<S extends z.ZodType>(path: string, body: unknown, schema: S, extraHeaders: Record<string, string> = {}): Promise<z.infer<S>> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
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

  async listChallenges(): Promise<Challenge[]> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/challenges`)
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) throw new BackendUnavailableError(await safeErrorDetail(res), res.status)

    const response = ChallengeCatalogResponseSchema.parse(await res.json())
    return response.challenges.map((c) => ({
      id: c.id,
      lessonId: c.lesson_id,
      title: c.title,
      goal: c.goal,
      difficulty: c.difficulty,
      successCondition: c.success_condition,
      fixedOracle: c.fixed_oracle,
      constraints: {
        numQubits: c.constraints.num_qubits,
        numClbits: c.constraints.num_clbits,
        allowedGates: c.constraints.allowed_gates,
        maxOps: c.constraints.max_ops,
        minGateCounts: c.constraints.min_gate_counts,
        anchor: c.constraints.anchor,
        anchorName: c.constraints.anchor_name,
        mustMeasure: c.constraints.must_measure,
        gateQubits: c.constraints.gate_qubits,
      },
      starterCircuit: c.starter_circuit,
      checks: c.checks,
      hints: c.hints,
    }))
  }

  async submitChallenge(challengeId: string, circuit: Circuit): Promise<ChallengeSubmission> {
    // The body is the circuit and nothing else: there is no field through which a verdict could be suggested.
    const response = await this.postParsed(
      `/api/challenges/${encodeURIComponent(challengeId)}/submit`,
      { circuit: CircuitSchema.parse(circuit) },
      ChallengeSubmitResponseSchema,
      learnerHeaders(),
    )
    return {
      attemptId: response.attempt_id,
      challengeId: response.challenge_id,
      circuitHash: response.circuit_hash,
      passed: response.passed,
      verifier: response.verifier,
      checks: response.checks.map((c) => {
        // A number is only ever shown with the record it came from: if the server names no record for a number, or the
        // record is missing, the response is malformed and is refused rather than shown bare.
        const record = c.result_id !== null ? response.provenance[c.result_id] : undefined
        if (c.evidence.length > 0 && !record) {
          throw new BackendUnavailableError(`challenge check ${c.id} returned numbers without a provenance record`)
        }
        return {
          id: c.id,
          label: c.label,
          passed: c.passed,
          evaluated: c.evaluated,
          detail: c.detail,
          hintIndex: c.hint_index,
          evidence: c.evidence.map((e) => ({ name: e.name, value: toQuantumValue(e.value, provenanceFromTraceStep(record!)) })),
          resultId: c.result_id,
        }
      }),
      backend: response.backend,
      backendVersion: response.backend_version,
      finalResultId: response.final_result_id,
      finalProvenance:
        response.final_result_id !== null && response.provenance[response.final_result_id]
          ? provenanceFromTraceStep(response.provenance[response.final_result_id]!)
          : null,
      nextHintIndex: response.next_hint_index,
      nextHint: response.next_hint,
      successMessage: response.success_message,
      createdAt: response.created_at,
    }
  }

  async debugCircuit(input: DebugRequestInput): Promise<DebugReport> {
    // Identifiers and the learner's own words only. The trace step is identity (indices, operation, record ids); the server
    // verifies it against the circuit itself. Nothing quantum can be attached, and nothing is.
    const body: Record<string, unknown> = { circuit: CircuitSchema.parse(input.circuit), language: input.language ?? 'en' }
    if (input.resultId) body.result_id = input.resultId
    if (input.challengeId && input.attemptId) {
      body.challenge_id = input.challengeId
      body.attempt_id = input.attemptId
    }
    const goal = input.goal?.trim()
    if (goal) body.goal = goal
    if (input.traceStep) {
      body.trace_step = {
        step_index: input.traceStep.stepIndex,
        operation_index: input.traceStep.operationIndex,
        operation: input.traceStep.operation,
        result_id: input.traceStep.resultId,
        execution_id: input.traceStep.executionId,
        circuit_hash: input.traceStep.circuitHash,
        backend: input.traceStep.backend,
        backend_version: input.traceStep.backendVersion,
        previous_result_id: input.traceStep.previousResultId,
      }
    }
    const response = await this.postParsed('/api/debug', body, DebugResponseSchema)
    const section = (s: { text: string; fact_ids: string[] }) => ({ text: s.text, factIds: s.fact_ids })
    return {
      observed: section(response.observed),
      evidence: response.evidence.map(section),
      mismatch: section(response.mismatch),
      nextExperiment: section(response.next_experiment),
      hint: response.hint ? section(response.hint) : null,
      facts: response.facts.map((f) => ({ id: f.id, kind: f.kind, description: f.description, resultId: f.result_id })),
      usedFallbackTemplate: response.used_fallback_template,
      groundedIn: response.grounded_in,
      resultId: response.result_id,
      circuitHash: response.circuit_hash,
      provenanceClass: response.provenance_class,
      verificationStatus: response.verification_status,
      attemptId: response.attempt_id,
      engineEvidence: response.engine_evidence.map(section),
      analysisId: response.analysis_id ?? null,
    }
  }

  async analyzeReasoning(input: ReasoningRequestInput): Promise<ReasoningResult> {
    // A structured intent, the circuit and identifiers. The body has no field for a probability, an expected optimisation, a
    // counterfactual circuit or a verdict; what comes back is parsed and wrapped with the analysis record's provenance, never computed.
    const body: Record<string, unknown> = { intent: input.intent, circuit: CircuitSchema.parse(input.circuit), language: input.language ?? 'en' }
    if (input.expectedCircuitHash) body.expected_circuit_hash = input.expectedCircuitHash
    if (input.backend) body.backend = input.backend
    if (input.intent === 'PROBABILITY') {
      body.result_id = input.resultId
      body.target = input.target
    } else if (input.intent === 'WHAT_IF') {
      body.modification = modificationBody(input.modification)
      if (input.counterfactualCircuitHash) body.counterfactual_circuit_hash = input.counterfactualCircuitHash
    } else if (input.intent === 'TRACE_CHANGE') {
      body.trace_step = {
        step_index: input.traceStep.stepIndex,
        operation_index: input.traceStep.operationIndex,
        operation: input.traceStep.operation,
        result_id: input.traceStep.resultId,
        execution_id: input.traceStep.executionId,
        circuit_hash: input.traceStep.circuitHash,
        backend: input.traceStep.backend,
        backend_version: input.traceStep.backendVersion,
        previous_result_id: input.traceStep.previousResultId,
      }
    }
    const response = await this.postParsed('/api/reasoning/analyze', body, ReasoningResponseSchema)
    const prov = provenanceFromTraceStep(response.provenance)
    const q = (v: number | null) => (v === null ? null : toQuantumValue(v, prov))
    const common = {
      analysisId: response.analysis_id,
      status: response.status,
      reason: response.reason,
      method: response.method,
      circuitHash: response.circuit_hash,
      sources: response.sources.map((s) => ({
        role: s.role,
        resultId: s.result_id,
        executionId: s.execution_id,
        circuitHash: s.circuit_hash,
        backend: s.backend,
        backendVersion: s.backend_version,
        executionMode: s.execution_mode,
        provenanceClass: s.provenance_class,
        verificationStatus: s.verification_status,
      })),
      provenance: prov,
      facts: response.facts.map((f) => ({ id: f.id, kind: f.kind, description: f.description, resultId: f.result_id })),
      answer: response.answer,
      usedFallbackTemplate: response.used_fallback_template,
    }
    switch (response.intent) {
      case 'PROBABILITY':
        return {
          ...common,
          intent: 'PROBABILITY',
          numQubits: response.data.num_qubits,
          bitOrder: response.data.bit_order,
          rows: response.data.items.map((i) => ({
            label: i.label,
            outcome: i.outcome,
            qubit: i.qubit,
            value: i.value,
            theoretical: q(i.theoretical_probability),
            sampled: q(i.sampled_frequency),
            sampledCount: i.sampled_count,
            shots: i.shots,
            difference: q(i.difference),
          })),
          notes: response.data.notes,
        }
      case 'OPTIMIZE': {
        const d = response.data
        return {
          ...common,
          intent: 'OPTIMIZE',
          optimizationStatus: d.optimization_status,
          originalCircuitHash: d.original_circuit_hash,
          originalOpCount: d.original_op_count,
          candidateCircuit: d.candidate_circuit,
          candidateCircuitHash: d.candidate_circuit_hash,
          candidateOpCount: d.candidate_op_count,
          operationsRemoved: d.operations_removed,
          rewrites: d.rewrites,
          changes: d.changes.map(mapOpChange),
          equivalence: d.equivalence ? { status: d.equivalence.status, method: d.equivalence.method, reason: d.equivalence.reason } : null,
          verifier: d.verifier,
          candidateResultId: d.candidate_result_id,
        }
      }
      case 'WHAT_IF': {
        const d = response.data
        return {
          ...common,
          intent: 'WHAT_IF',
          description: d.description,
          originalCircuitHash: d.original_circuit_hash,
          counterfactualCircuitHash: d.counterfactual_circuit_hash,
          counterfactualQasm: d.counterfactual_qasm,
          originalOpCount: d.original_op_count,
          counterfactualOpCount: d.counterfactual_op_count,
          changes: d.changes.map(mapOpChange),
          comparison: comparisonBody(d.comparison, prov),
          comparedValues: d.compared_values,
        }
      }
      case 'TRACE_CHANGE': {
        const d = response.data
        const qubits = (rows: typeof d.after_qubits) =>
          rows.map((r) => ({
            qubit: r.qubit,
            status: r.status,
            reason: r.reason,
            bloch: r.bloch ? toQuantumValue({ x: r.bloch.x, y: r.bloch.y, z: r.bloch.z }, prov) : null,
            purity: q(r.purity),
            entangledWithRest: r.entangled_with_rest,
          }))
        return {
          ...common,
          intent: 'TRACE_CHANGE',
          stepIndex: d.step_index,
          stepNumber: d.step_number,
          totalSteps: d.total_steps,
          numQubits: d.num_qubits,
          bitOrder: d.bit_order,
          operation: d.operation,
          changeKind: d.change_kind ?? null,
          changeSummary: d.change_summary ?? null,
          probabilityChanges: (d.probability_changes ?? []).map((c) => ({
            outcome: c.outcome,
            before: toQuantumValue(c.before, prov),
            after: toQuantumValue(c.after, prov),
            difference: toQuantumValue(c.difference, prov),
          })),
          beforeQubits: qubits(d.before_qubits ?? []),
          afterQubits: qubits(d.after_qubits),
        }
      }
      default:
        return { ...common, intent: response.intent }
    }
  }

  async variationalSweep(input: VariationalSweepInput): Promise<VariationalSweepResult> {
    // Angles and a point count: the learner's own choices. Defaults are the server's. There is no field through which a value could go.
    const body: Record<string, unknown> = {}
    if (input.thetaMin !== undefined) body.theta_min = input.thetaMin
    if (input.thetaMax !== undefined) body.theta_max = input.thetaMax
    if (input.points !== undefined) body.points = input.points
    if (input.backend) body.backend = input.backend
    const r = await this.postParsed('/api/variational/sweep', body, VariationalSweepResponseSchema)
    return {
      ...variationalCommon(r),
      points: r.points.map(variationalPoint),
      minimumIndex: r.minimum_index,
      maximumIndex: r.maximum_index,
    }
  }

  async variationalOptimize(input: VariationalOptimizeInput): Promise<VariationalOptimizationResult> {
    const body: Record<string, unknown> = { theta_start: input.thetaStart }
    if (input.steps !== undefined) body.steps = input.steps
    if (input.learningRate !== undefined) body.learning_rate = input.learningRate
    if (input.backend) body.backend = input.backend
    const r = await this.postParsed('/api/variational/optimize', body, VariationalOptimizeResponseSchema)
    return {
      ...variationalCommon(r),
      steps: r.steps.map((s) => ({
        step: s.step,
        point: variationalPoint(s.point),
        // the gradient is built from the three runs of this step; it carries the provenance of the step's own run
        gradient: toQuantumValue(s.gradient, provenanceFromTraceStep(s.point.provenance)),
        plus: variationalPoint(s.plus),
        minus: variationalPoint(s.minus),
      })),
      lowestIndex: r.lowest_index,
      converged: r.converged,
      learningRate: r.learning_rate,
      shift: r.shift,
      notes: r.notes,
    }
  }

  async previewWhatIf(circuit: Circuit, modification: ModificationInput): Promise<WhatIfPreview> {
    const response = await this.postParsed(
      '/api/reasoning/what-if/preview',
      { circuit: CircuitSchema.parse(circuit), modification: modificationBody(modification) },
      WhatIfPreviewResponseSchema,
    )
    return {
      description: response.description,
      originalCircuitHash: response.original_circuit_hash,
      counterfactualCircuit: response.counterfactual_circuit,
      counterfactualCircuitHash: response.counterfactual_circuit_hash,
      counterfactualQasm: response.counterfactual_qasm,
      originalOpCount: response.original_op_count,
      counterfactualOpCount: response.counterfactual_op_count,
      changes: response.changes.map(mapOpChange),
    }
  }

  async compareExperiments(
    a: { resultId: string; circuit: Circuit },
    b: { resultId: string; circuit: Circuit },
  ): Promise<ExperimentComparison> {
    const response = await this.postParsed(
      '/api/compare/experiments',
      {
        result_id_a: a.resultId,
        circuit_a: CircuitSchema.parse(a.circuit),
        result_id_b: b.resultId,
        circuit_b: CircuitSchema.parse(b.circuit),
      },
      ExperimentCompareResponseSchema,
    )
    // Every number is wrapped with the COMPARISON's own provenance record: a difference has no meaning apart from it.
    const prov = provenanceFromTraceStep(response.provenance)
    return {
      comparisonId: response.comparison_id,
      method: response.method,
      a: { provenance: provenanceFromTraceStep(response.a.provenance), executionId: response.a.execution_id, shots: response.a.shots, numQubits: response.a.num_qubits },
      b: { provenance: provenanceFromTraceStep(response.b.provenance), executionId: response.b.execution_id, shots: response.b.shots, numQubits: response.b.num_qubits },
      ...comparisonBody(response, prov),
      provenance: prov,
    }
  }

  async askComparisonTutor(comparisonId: string, question: string, language: TutorLanguage = 'en'): Promise<TutorAnswerResult> {
    const response = await this.postParsed('/api/tutor/comparison', { comparison_id: comparisonId, question, language }, TutorResponseSchema)
    return {
      answer: response.answer,
      resultId: response.result_id,
      circuitHash: response.circuit_hash,
      provenanceClass: response.provenance_class,
      verificationStatus: response.verification_status,
      usedFallbackTemplate: response.used_fallback_template,
      facts: response.facts.map((f) => ({ id: f.id, kind: f.kind, description: f.description, resultId: f.result_id })),
    }
  }

  async exportCircuit(circuit: Circuit, resultId?: string | null): Promise<CircuitExport> {
    const body: Record<string, unknown> = { circuit: CircuitSchema.parse(circuit) }
    if (resultId) body.result_id = resultId
    const r = await this.postParsed('/api/export/circuit', body, ExportResponseSchema)
    return {
      format: r.format,
      circuitHash: r.circuit_hash,
      circuit: r.circuit,
      qasm: r.qasm,
      generator: r.generator,
      code: r.code,
      execution: r.execution ? provenanceFromTraceStep(r.execution) : null,
      note: r.note,
    }
  }

  createClass(title?: string): Promise<ClassCreated> {
    return classroom.createClass(this.baseUrl, title)
  }

  joinClass(classCode: string, learnerToken: string | null): Promise<ClassJoined> {
    return classroom.joinClass(this.baseUrl, classCode, learnerToken)
  }

  getMyClass(learnerToken: string): Promise<ClassMembership> {
    return classroom.getMyClass(this.baseUrl, learnerToken)
  }

  leaveClass(learnerToken: string): Promise<boolean> {
    return classroom.leaveClass(this.baseUrl, learnerToken)
  }

  syncClassProgress(learnerToken: string, answers: SavedAnswer[]): Promise<ClassSyncResult> {
    return classroom.syncClassProgress(this.baseUrl, learnerToken, answers)
  }

  reportLearnerEvent(learnerToken: string, kind: LearnerEventKind, subjectId: string): Promise<'RECORDED' | 'DUPLICATE'> {
    return classroom.reportLearnerEvent(this.baseUrl, learnerToken, kind, subjectId)
  }

  getClassDashboard(classCode: string, instructorKey: string): Promise<ClassDashboard> {
    return classroom.getClassDashboard(this.baseUrl, classCode, instructorKey)
  }

  deleteClass(classCode: string, instructorKey: string): Promise<{ eventsDeleted: number }> {
    return classroom.deleteClass(this.baseUrl, classCode, instructorKey)
  }

  createExperiment(input: CreateExperimentInput): Promise<CreatedExperiment> {
    return classroom.createExperiment(this.baseUrl, input)
  }

  getExperiment(experimentId: string): Promise<SharedExperiment> {
    return classroom.getExperiment(this.baseUrl, experimentId)
  }

  parseCode(dialect: SdkDialect, code: string): Promise<ParsedCode> {
    return classroom.parseCode(this.baseUrl, dialect, code)
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

  async gradeConceptCheck(lessonId: string, checkId: string, selectedOptionId: string): Promise<ConceptCheckGrade> {
    // The body is the chosen option id and nothing else: no verdict, no key, no score. The ids go in the path, encoded.
    let res: Response
    try {
      res = await fetch(
        `${this.baseUrl}/api/lessons/${encodeURIComponent(lessonId)}/concept-checks/${encodeURIComponent(checkId)}/grade`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...learnerHeaders() },
          body: JSON.stringify({ selected_option_id: selectedOptionId }),
        },
      )
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) throw await gradeErrorFromResponse(res)

    const grade = ConceptCheckGradeResponseSchema.parse(await res.json())
    return {
      lessonId: grade.lesson_id,
      checkId: grade.check_id,
      selectedOptionId: grade.selected_option_id,
      correct: grade.correct,
      explanation: grade.explanation,
    }
  }

  async regradeConceptChecks(answers: SavedAnswer[]): Promise<RegradedAnswer[]> {
    // Identifiers only, as saved: which option was picked for which check. The verdicts come back from the server.
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/assessments/regrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers: answers.map((a) => ({ lesson_id: a.lessonId, check_id: a.checkId, selected_option_id: a.selectedOptionId })),
        }),
      })
    } catch (err) {
      throw new BackendUnavailableError(
        `could not reach the Qentor backend: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) throw await gradeErrorFromResponse(res)

    return RegradeResponseSchema.parse(await res.json()).results.map((r) => ({
      lessonId: r.lesson_id,
      checkId: r.check_id,
      selectedOptionId: r.selected_option_id,
      status: r.status,
      correct: r.correct,
      explanation: r.explanation,
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
      operationsRemoved: response.operations_removed,
      changes: response.changes.map((c) => ({
        kind: c.kind,
        originalIndex: c.original_index,
        candidateIndex: c.candidate_index,
        description: c.description,
      })),
      ruleNotes: response.rule_notes,
      candidateProvenance: response.candidate_provenance ? provenanceFromTraceStep(response.candidate_provenance) : null,
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
        // Per-qubit states and the polar amplitude view are the backend's numbers, passed through untouched and
        // wrapped with the same step provenance as the statevector they were derived from.
        qubitStates: step.qubit_states.map((q) => mapQubitState(q, provenance)),
        amplitudeView:
          step.amplitude_view.length > 0
            ? toQuantumValue(
                step.amplitude_view.map((a) => ({ magnitude: a.magnitude, probability: a.probability, phase: a.phase })),
                provenance,
              )
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
 * A grading endpoint's refusal is `{detail: {code, message}}` and becomes a `GradeRejectedError` carrying the server's own
 * code. Anything else (an HTML gateway page, a body that is not JSON, FastAPI's list of validation errors from some other
 * layer) is not a grading refusal and is reported, unparsed, as `BackendUnavailableError`: no code is invented for it.
 */
async function gradeErrorFromResponse(res: Response): Promise<Error> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return new BackendUnavailableError(`HTTP ${res.status}`, res.status)
  }
  const detail = GradeErrorDetailSchema.safeParse((body as { detail?: unknown } | null)?.detail)
  if (detail.success) return new GradeRejectedError(detail.data.code, detail.data.message, res.status)
  const raw = (body as { detail?: unknown } | null)?.detail
  return new BackendUnavailableError(typeof raw === 'string' ? raw : JSON.stringify(body), res.status)
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

/** One variational run: each number wrapped with the provenance of the run it was read from. */
function variationalPoint(p: {
  theta: number
  expectation_z: number
  bloch: { x: number; y: number; z: number }
  probabilities: { '0': number; '1': number }
  result_id: string
  execution_id: string
  circuit_hash: string
  provenance: Parameters<typeof provenanceFromTraceStep>[0]
}): VariationalPoint {
  const prov = provenanceFromTraceStep(p.provenance)
  return {
    theta: toQuantumValue(p.theta, prov),
    expectationZ: toQuantumValue(p.expectation_z, prov),
    bloch: toQuantumValue({ x: p.bloch.x, y: p.bloch.y, z: p.bloch.z }, prov),
    probabilityZero: toQuantumValue(p.probabilities['0'], prov),
    probabilityOne: toQuantumValue(p.probabilities['1'], prov),
    resultId: p.result_id,
    executionId: p.execution_id,
    circuitHash: p.circuit_hash,
    provenance: prov,
  }
}

function variationalCommon(r: {
  method: string
  expectation_method: string
  ansatz: string
  observable: string
  label: string
  backend: string
  backend_version: string
  provenance: Parameters<typeof provenanceFromTraceStep>[0]
}) {
  return {
    method: r.method,
    expectationMethod: r.expectation_method,
    ansatz: r.ansatz,
    observable: r.observable,
    label: r.label,
    backend: r.backend,
    backendVersion: r.backend_version,
    provenance: provenanceFromTraceStep(r.provenance),
  }
}

/** The wire shape of an OpChange from the optimiser's diff (kept / removed / added), in the domain shape. */
function mapOpChange(c: { kind: 'kept' | 'removed' | 'added'; original_index: number | null; candidate_index: number | null; description: string }) {
  return { kind: c.kind, originalIndex: c.original_index, candidateIndex: c.candidate_index, description: c.description }
}

/** A modification as the server's request model spells it (snake-free already; optional angle/controls only when set). */
function modificationBody(m: ModificationInput): Record<string, unknown> {
  switch (m.op) {
    case 'remove_gate':
      return { op: m.op, index: m.index }
    case 'replace_gate':
      return { op: m.op, index: m.index, gate: m.gate, ...(m.angle === undefined || m.angle === null ? {} : { angle: m.angle }) }
    case 'set_angle':
      return { op: m.op, index: m.index, angle: m.angle }
    case 'insert_gate':
      return {
        op: m.op,
        index: m.index,
        gate: m.gate,
        targets: m.targets,
        controls: m.controls ?? [],
        ...(m.angle === undefined || m.angle === null ? {} : { angle: m.angle }),
      }
  }
}

/** The circuit, measurement and state difference of a comparison, every number wrapped with the provenance of the record it came from. */
function comparisonBody(c: ComparisonBodyResponse, prov: Provenance): ComparisonBody {
  const q = (v: number | null) => (v === null ? null : toQuantumValue(v, prov))
  const m = c.measurement
  const s = c.state
  return {
    circuit: {
      sameCircuit: c.circuit.same_circuit,
      numQubitsA: c.circuit.num_qubits_a,
      numQubitsB: c.circuit.num_qubits_b,
      numOpsA: c.circuit.num_ops_a,
      numOpsB: c.circuit.num_ops_b,
      changes: c.circuit.changes.map((x) => ({ tag: x.tag, aStart: x.a_start, aOps: x.a_ops, bStart: x.b_start, bOps: x.b_ops })),
      equivalenceStatus: c.circuit.equivalence_status,
      equivalenceReason: c.circuit.equivalence_reason,
    },
    measurement: {
      comparable: m.comparable,
      reason: m.reason,
      kindA: m.kind_a,
      kindB: m.kind_b,
      rows: m.rows.map((r) => ({ outcome: r.outcome, a: q(r.a), b: q(r.b), difference: q(r.difference) })),
      totalVariationDistance: q(m.total_variation_distance),
      maxDifference: q(m.max_difference),
      note: m.note,
    },
    state: {
      comparable: s.comparable,
      reason: s.reason,
      fidelity: q(s.fidelity),
      maxProbabilityDifference: q(s.max_probability_difference),
      maxAmplitudeDifference: q(s.max_amplitude_difference),
      note: s.note,
    },
  }
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

/** A structured refusal body (`{detail: {code, message}}`), or `null` for anything else. */
async function structuredDetail(res: Response): Promise<{ code: string; message: string } | null> {
  try {
    const body = await res.json()
    const parsed = TraceErrorDetailSchema.safeParse(body?.detail)
    return parsed.success ? { code: parsed.data.code, message: parsed.data.message } : null
  } catch {
    return null
  }
}
