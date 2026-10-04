/**
 * Mock `ApiClient` for local UI development when the FastAPI backend isn't
 * running. Per CLAUDE.md ("Never hard-code, mock or approximate a quantum
 * result in shipped code") this must never be the default and never render
 * indistinguishably from a real result:
 *
 *  - It is only ever selected by `getApiClient()` in `index.ts`, which
 *    requires an explicit `VITE_USE_MOCK_API=true` — a production build
 *    never enables it implicitly.
 *  - Every value carries `provenanceClass: "FIXTURE"`, a tag the real
 *    backend's schema cannot produce, which `ProvenanceBadge` renders with a
 *    hazard-stripe pattern distinct from SIMULATION/REAL_HARDWARE/RECORDED.
 *  - `resultId`s are prefixed `fixture_` so they can never collide with, or
 *    be mistaken for, a real `res_...` id from the provenance log.
 *
 * The "quantum" numbers below are illustrative placeholders for laying out
 * the results panel and charts, not a claim about any real circuit's
 * behaviour — they exist only so a developer can see the Build screen filled
 * in without a running backend.
 */
import type { Circuit } from '@/circuit/types'
import { FIXTURE, toQuantumValue, type Provenance, type QuantumValue } from '@/provenance/QuantumValue'
import { EndpointNotImplementedError, GenerationUnavailableError } from './client'
import type {
  AgreementResult,
  ApiClient,
  Backend,
  Challenge,
  ChallengeSubmission,
  CircuitProposal,
  ClassCreated,
  ClassDashboard,
  ClassJoined,
  ClassMembership,
  ClassSyncResult,
  ConceptCheckGrade,
  CreateExperimentInput,
  CreatedExperiment,
  LearnerEventKind,
  ParsedCode,
  SdkDialect,
  SharedExperiment,
  DebugReport,
  DebugRequestInput,
  RegradedAnswer,
  SavedAnswer,
  CircuitExport,
  ExperimentComparison,
  CodeViewsResult,
  EquivalenceResult,
  ExecutePayload,
  ExecutionMode,
  ExecutionTraceResult,
  GenerationRequestInput,
  GenerationStatus,
  Lesson,
  MultiInputTestCase,
  ModificationInput,
  MultiInputTestResult,
  NoiseCatalog,
  NoiseCompareInput,
  NoiseCompareResult,
  VariationalOptimizationResult,
  VariationalOptimizeInput,
  VariationalSweepInput,
  VariationalSweepResult,
  OptimizationResult,
  ReasoningRequestInput,
  ReasoningResult,
  TutorAnswerResult,
  WhatIfPreview,
  TutorLanguage,
  TutorLessonContext,
  TutorTraceStepContext,
  VerifyBellStateResult,
} from './client'

let fixtureCounter = 0
function nextFixtureId(): string {
  fixtureCounter += 1
  return `fixture_${fixtureCounter.toString(16).padStart(8, '0')}`
}

function fixtureProvenance(executionMode: string): Provenance {
  return {
    resultId: nextFixtureId(),
    circuitHash: 'qc_mockmockmock',
    backend: 'mock-adapter',
    backendVersion: '0.0.0-dev',
    executionMode,
    provenanceClass: FIXTURE,
    verificationStatus: 'STATE_CHECKED',
    createdAt: new Date().toISOString(),
  }
}

/** A plausible-looking but entirely made-up distribution over basis states. */
function fixtureDistribution(numQubits: number): Record<string, number> {
  const n = Math.min(numQubits, 4)
  const states = 2 ** n
  const weights = Array.from({ length: states }, () => Math.random())
  const total = weights.reduce((a, b) => a + b, 0)
  const dist: Record<string, number> = {}
  weights.forEach((w, i) => {
    dist[i.toString(2).padStart(n, '0')] = w / total
  })
  return dist
}

export class MockApiClient implements ApiClient {
  async executeCircuit(
    circuit: Circuit,
    mode: ExecutionMode,
    shots?: number,
    _backend?: Backend,
  ): Promise<QuantumValue<ExecutePayload>> {
    await delay(150)

    const provenance = fixtureProvenance(mode)
    const probabilities = fixtureDistribution(circuit.num_qubits)

    const payload: ExecutePayload =
      mode === 'statevector'
        ? {
            executionId: provenance.resultId,
            statevector: Object.values(probabilities).map((p) => [Math.sqrt(p), 0]),
          }
        : {
            executionId: provenance.resultId,
            probabilities,
            counts: Object.fromEntries(
              Object.entries(probabilities).map(([bits, p]) => [
                bits,
                Math.round(p * (shots ?? 1024)),
              ]),
            ),
          }

    return toQuantumValue(payload, provenance)
  }

  /**
   * Deliberately NOT faked. Unlike `executeCircuit`'s FIXTURE placeholder
   * numbers, a trace is a sequence of per-operation quantum states, and a
   * plausible-looking one would have to be computed client-side — which the
   * trace's trust rule forbids outright (no client-side amplitudes, no seeded
   * or random stand-ins). The mock adapter therefore reports, honestly, that
   * this endpoint has no mock; the UI renders that as an error, never as data.
   */
  async traceCircuit(_circuit: Circuit, _backend?: Backend): Promise<ExecutionTraceResult> {
    throw new EndpointNotImplementedError('POST /api/execute/trace (the FIXTURE mock adapter cannot produce a trace)')
  }

  /** Deliberately NOT faked: generated code, an equivalence verdict and a cross-backend comparison are the server's
   * to produce (a made-up one would be a made-up result). The UI renders this as an unavailable state. */
  async generateCode(_circuit: Circuit): Promise<CodeViewsResult> {
    throw new EndpointNotImplementedError('POST /api/circuit/code (the FIXTURE mock adapter cannot generate code)')
  }

  async checkEquivalence(_a: Circuit, _b: Circuit): Promise<EquivalenceResult> {
    throw new EndpointNotImplementedError('POST /api/verify/equivalence (the FIXTURE mock adapter cannot decide equivalence)')
  }

  async compareBackends(_circuit: Circuit, _backends?: Backend[]): Promise<AgreementResult> {
    throw new EndpointNotImplementedError('POST /api/compare/backends (the FIXTURE mock adapter cannot compare backends)')
  }

  /** Deliberately NOT faked: a challenge verdict is the server's to compute from its own statevectors. */
  async listChallenges(): Promise<Challenge[]> {
    throw new EndpointNotImplementedError('GET /api/challenges (the FIXTURE mock adapter has no challenges)')
  }

  async submitChallenge(_challengeId: string, _circuit: Circuit): Promise<ChallengeSubmission> {
    throw new EndpointNotImplementedError('POST /api/challenges/{id}/submit (the FIXTURE mock adapter cannot judge a circuit)')
  }

  /** Deliberately NOT faked: there is no substitute for a language model, so the FIXTURE adapter says it is unavailable. */
  async getGenerationStatus(): Promise<GenerationStatus> {
    return { available: false, provider: null, model: null, reason: 'The FIXTURE mock adapter has no AI code generation.' }
  }

  async generateCircuit(_request: GenerationRequestInput): Promise<CircuitProposal> {
    throw new GenerationUnavailableError('The FIXTURE mock adapter has no AI code generation.')
  }

  /** Deliberately NOT faked: a debugging report is built by the server from its own records. */
  async debugCircuit(_request: DebugRequestInput): Promise<DebugReport> {
    throw new EndpointNotImplementedError('POST /api/debug (the FIXTURE mock adapter cannot debug a circuit)')
  }

  /** Deliberately NOT faked: a comparison is computed by the server from two of its own records. */
  async compareExperiments(_a: { resultId: string; circuit: Circuit }, _b: { resultId: string; circuit: Circuit }): Promise<ExperimentComparison> {
    throw new EndpointNotImplementedError('POST /api/compare/experiments (the FIXTURE mock adapter cannot compare runs)')
  }

  /** Deliberately NOT faked: noisy counts exist only as the output of a simulator run on the server. */
  async listNoiseModels(): Promise<NoiseCatalog> {
    throw new EndpointNotImplementedError('GET /api/noise/models (the FIXTURE mock adapter has no noise models)')
  }

  async compareNoise(_input: NoiseCompareInput): Promise<NoiseCompareResult> {
    throw new EndpointNotImplementedError('POST /api/noise/compare (the FIXTURE mock adapter cannot simulate noise)')
  }

  /** Deliberately NOT faked: every cost is read by the server from a backend run. */
  async variationalSweep(_input: VariationalSweepInput): Promise<VariationalSweepResult> {
    throw new EndpointNotImplementedError('POST /api/variational/sweep (the FIXTURE mock adapter cannot run the ansatz)')
  }

  async variationalOptimize(_input: VariationalOptimizeInput): Promise<VariationalOptimizationResult> {
    throw new EndpointNotImplementedError('POST /api/variational/optimize (the FIXTURE mock adapter cannot run the ansatz)')
  }

  /** Deliberately NOT faked: an analysis is computed by the server from its own backend runs. */
  async analyzeReasoning(_request: ReasoningRequestInput): Promise<ReasoningResult> {
    throw new EndpointNotImplementedError('POST /api/reasoning/analyze (the FIXTURE mock adapter cannot analyse a circuit)')
  }

  async previewWhatIf(_circuit: Circuit, _modification: ModificationInput): Promise<WhatIfPreview> {
    throw new EndpointNotImplementedError('POST /api/reasoning/what-if/preview (the FIXTURE mock adapter cannot build a counterfactual)')
  }

  async askComparisonTutor(_comparisonId: string, _question: string, _language?: TutorLanguage): Promise<TutorAnswerResult> {
    throw new EndpointNotImplementedError('POST /api/tutor/comparison (the FIXTURE mock adapter has no comparisons)')
  }

  /** Deliberately NOT faked: a verdict comes only from the server's own answer key, which no client holds. */
  async gradeConceptCheck(_lessonId: string, _checkId: string, _selectedOptionId: string): Promise<ConceptCheckGrade> {
    throw new EndpointNotImplementedError('POST /api/lessons/{id}/concept-checks/{id}/grade (the FIXTURE mock adapter cannot grade)')
  }

  async regradeConceptChecks(_answers: SavedAnswer[]): Promise<RegradedAnswer[]> {
    throw new EndpointNotImplementedError('POST /api/assessments/regrade (the FIXTURE mock adapter cannot grade)')
  }

  /** Deliberately NOT faked: classes, learners, events, shared experiments and parsed code exist only on the server. */
  async createClass(_title?: string): Promise<ClassCreated> {
    throw new EndpointNotImplementedError('POST /api/classes (the FIXTURE mock adapter has no classroom)')
  }

  async joinClass(_classCode: string, _learnerToken: string | null): Promise<ClassJoined> {
    throw new EndpointNotImplementedError('POST /api/classes/join (the FIXTURE mock adapter has no classroom)')
  }

  async getMyClass(_learnerToken: string): Promise<ClassMembership> {
    throw new EndpointNotImplementedError('GET /api/classes/me (the FIXTURE mock adapter has no classroom)')
  }

  async leaveClass(_learnerToken: string): Promise<boolean> {
    throw new EndpointNotImplementedError('POST /api/classes/leave (the FIXTURE mock adapter has no classroom)')
  }

  async syncClassProgress(_learnerToken: string, _answers: SavedAnswer[]): Promise<ClassSyncResult> {
    throw new EndpointNotImplementedError('POST /api/classes/sync-progress (the FIXTURE mock adapter has no classroom)')
  }

  async reportLearnerEvent(_learnerToken: string, _kind: LearnerEventKind, _subjectId: string): Promise<'RECORDED' | 'DUPLICATE'> {
    throw new EndpointNotImplementedError('POST /api/learner-events (the FIXTURE mock adapter has no classroom)')
  }

  async getClassDashboard(_classCode: string, _instructorKey: string): Promise<ClassDashboard> {
    throw new EndpointNotImplementedError('GET /api/classes/{code}/dashboard (the FIXTURE mock adapter has no classroom)')
  }

  async deleteClass(_classCode: string, _instructorKey: string): Promise<{ eventsDeleted: number }> {
    throw new EndpointNotImplementedError('DELETE /api/classes/{code} (the FIXTURE mock adapter has no classroom)')
  }

  async createExperiment(_input: CreateExperimentInput): Promise<CreatedExperiment> {
    throw new EndpointNotImplementedError('POST /api/experiments (the FIXTURE mock adapter cannot share)')
  }

  async getExperiment(_experimentId: string): Promise<SharedExperiment> {
    throw new EndpointNotImplementedError('GET /api/experiments/{id} (the FIXTURE mock adapter has no shared experiments)')
  }

  async parseCode(_dialect: SdkDialect, _code: string): Promise<ParsedCode> {
    throw new EndpointNotImplementedError('POST /api/circuit/parse-code (the FIXTURE mock adapter cannot read code)')
  }

  /** Deliberately NOT faked: the export bundle is written by the server. */
  async exportCircuit(_circuit: Circuit, _resultId?: string | null): Promise<CircuitExport> {
    throw new EndpointNotImplementedError('POST /api/export/circuit (the FIXTURE mock adapter cannot export)')
  }

  /** FIXTURE only: the real verifier lives server-side. This recognises the
   * same h -> cx shape `qentor.verification.bell_state` does, purely so the
   * Build screen's Verify action has something to show without a running
   * backend — every field is clearly labelled FIXTURE, never confusable with
   * a real verification report. */
  async verifyBellState(resultId: string, circuit: Circuit): Promise<VerifyBellStateResult> {
    await delay(150)

    const nonMeasureOps = circuit.ops.filter((op) => op.gate !== 'measure')
    const isBellShaped =
      circuit.num_qubits === 2 &&
      nonMeasureOps.length === 2 &&
      nonMeasureOps[0]?.gate === 'h' &&
      nonMeasureOps[1]?.gate === 'cx'

    if (!isBellShaped) {
      return {
        resultId,
        circuitHash: 'qc_mockmockmock',
        verifier: 'bell_state/1 (FIXTURE)',
        verificationStatus: 'UNVERIFIABLE',
        checks: [
          {
            name: 'circuit_matches_bell_pattern',
            status: 'FAIL',
            detail: 'FIXTURE — the mock adapter only recognises h(q0) -> cx(q0, q1).',
          },
        ],
        expectedSupport: [],
        observedSupport: [],
      }
    }

    return {
      resultId,
      circuitHash: 'qc_mockmockmock',
      verifier: 'bell_state/1 (FIXTURE)',
      verificationStatus: 'VERIFIED',
      checks: [
        { name: 'circuit_matches_bell_pattern', status: 'PASS', detail: 'FIXTURE — mock adapter check' },
        { name: 'observed_support_within_expected', status: 'PASS', detail: 'FIXTURE — mock adapter check' },
        { name: 'expected_support_fully_observed', status: 'PASS', detail: 'FIXTURE — mock adapter check' },
      ],
      expectedSupport: ['00', '11'],
      observedSupport: ['00', '11'],
    }
  }

  /** FIXTURE only: the real catalog (`qentor.lessons`) lives server-side and
   * is served whole by GET /api/lessons. This returns a small, clearly
   * FIXTURE-labelled catalog in the same shape so the Learn screen has
   * something to show without a running backend — ids are prefixed
   * `fixture-` so they can never collide with, or be mistaken for, a real
   * registered lesson id. */
  async listLessons(): Promise<Lesson[]> {
    await delay(80)
    return [
      {
        id: 'fixture-superposition',
        title: 'FIXTURE — Superposition',
        shortDescription: 'FIXTURE — the real catalog lives server-side (GET /api/lessons).',
        concept: 'superposition',
        difficulty: 'beginner',
        estimatedMinutes: 12,
        learningObjectives: ['FIXTURE — mock adapter objective.'],
        sections: [
          {
            type: 'explanation',
            id: 's1',
            title: 'FIXTURE',
            body: 'FIXTURE — mock adapter content only, not real lesson prose.',
          },
        ],
        linkedCircuit: null,
        prerequisiteLessonIds: [],
      },
      {
        id: 'fixture-bell-state',
        title: 'FIXTURE — Bell State',
        shortDescription: 'FIXTURE — the real catalog lives server-side (GET /api/lessons).',
        concept: 'bell-state',
        difficulty: 'intermediate',
        estimatedMinutes: 15,
        learningObjectives: ['FIXTURE — mock adapter objective.'],
        sections: [
          {
            type: 'interactive_lab',
            id: 's1',
            title: 'FIXTURE lab',
            instructions: 'FIXTURE — mock adapter content only.',
            capability: 'execute',
          },
        ],
        linkedCircuit: {
          schema: 'qentor.circuit/1',
          num_qubits: 2,
          num_clbits: 2,
          ops: [
            { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
            { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
          ],
        },
        prerequisiteLessonIds: ['fixture-superposition'],
      },
    ]
  }

  /** FIXTURE only: the real deterministic tutor lives server-side
   * (qentor.tutor). This builds a tiny fact sheet from the circuit alone so
   * the Build screen's Tutor panel has something to show without a running
   * backend — clearly labelled FIXTURE, never confusable with a grounded
   * server answer. */
  async askTutor(
    resultId: string | null,
    circuit: Circuit | null,
    question: string,
    _language: TutorLanguage = 'en',
    lesson?: TutorLessonContext,
    _traceStep?: TutorTraceStepContext,
  ): Promise<TutorAnswerResult> {
    await delay(200)

    // A lesson-only question has no circuit/result to summarise. The real
    // lesson-aware answer lives server-side (qentor.tutor.lesson_answers); the
    // fixture only says so, and carries no provenance (there is none).
    if (resultId === null || circuit === null) {
      return {
        answer: `FIXTURE — the real lesson-aware tutor lives server-side. You asked "${question}".`,
        resultId: null,
        circuitHash: null,
        provenanceClass: null,
        verificationStatus: null,
        usedFallbackTemplate: true,
        facts: [],
        lessonId: lesson?.lessonId ?? null,
        sectionId: lesson?.sectionId ?? null,
      }
    }

    const gateList = circuit.ops.map((op) => op.gate).join(', ') || 'no operations'
    const circuitFact = {
      id: 'F1',
      kind: 'circuit_summary',
      description: `FIXTURE — ${circuit.num_qubits}-qubit, ${circuit.num_clbits}-clbit circuit: ${gateList}`,
      resultId,
    }

    return {
      answer:
        `FIXTURE — the real tutor lives server-side. You asked "${question}" about ` +
        `a ${circuit.num_qubits}-qubit circuit (${gateList}). See ${circuitFact.id}.`,
      resultId,
      circuitHash: 'qc_mockmockmock',
      provenanceClass: FIXTURE,
      verificationStatus: 'STATE_CHECKED',
      usedFallbackTemplate: true,
      facts: [circuitFact],
    }
  }

  /** FIXTURE only: the real verified optimizer (qentor.verification.optimizer
   * + equivalence) lives server-side. This only recognises the simplest case
   * — two adjacent, identical single-qubit gates on the same qubit — purely
   * so the Build screen's Optimize action has something to show without a
   * running backend. Never confusable with a real, Operator-verified report:
   * every field is labelled FIXTURE, and `backend` is accepted but unused,
   * matching the real endpoint's shape without pretending to select an
   * adapter that isn't actually running. */
  async optimizeCircuit(circuit: Circuit, _backend?: Backend): Promise<OptimizationResult> {
    await delay(150)

    const cancellable = ['h', 'x', 'y', 'z']
    let cancelIndex = -1
    for (let i = 0; i < circuit.ops.length - 1; i += 1) {
      const a = circuit.ops[i]
      const b = circuit.ops[i + 1]
      if (a && b && a.gate === b.gate && cancellable.includes(a.gate) && a.targets[0] === b.targets[0]) {
        cancelIndex = i
        break
      }
    }

    if (cancelIndex === -1) {
      return {
        originalCircuitHash: 'qc_mockmockmock',
        candidateCircuitHash: 'qc_mockmockmock',
        originalOpCount: circuit.ops.length,
        candidateOpCount: circuit.ops.length,
        rulesApplied: [],
        reductionSummary: `${circuit.ops.length} -> ${circuit.ops.length} operations (unchanged, FIXTURE)`,
        status: 'NO_OPTIMIZATION_FOUND',
        equivalence: null,
        verifierName: 'qentor.verification.optimizer (FIXTURE)',
        verifierVersion: '0',
        reason: 'FIXTURE — the mock adapter only recognises two adjacent identical single-qubit gates.',
        candidateCircuit: null,
        resultId: null,
        operationsRemoved: 0,
        changes: [],
        ruleNotes: [],
        candidateProvenance: null,
      }
    }

    const ops = circuit.ops.filter((_, i) => i !== cancelIndex && i !== cancelIndex + 1)
    const candidateCircuit: Circuit = { ...circuit, ops }
    return {
      originalCircuitHash: 'qc_mockmockmock',
      candidateCircuitHash: 'qc_mockmockmock_candidate',
      originalOpCount: circuit.ops.length,
      candidateOpCount: ops.length,
      rulesApplied: [`FIXTURE — cancelled adjacent ${circuit.ops[cancelIndex]?.gate} pair`],
      reductionSummary: `${circuit.ops.length} -> ${ops.length} operations (FIXTURE)`,
      status: 'VERIFIED_SHORTER',
      equivalence: {
        status: 'EQUIVALENT',
        method: 'FIXTURE — mock adapter, no real equivalence check performed',
        globalPhase: 0,
        checks: [
          { name: 'operator_equivalent_up_to_global_phase', status: 'PASS', detail: 'FIXTURE — mock adapter check' },
        ],
        reason: null,
      },
      verifierName: 'qentor.verification.optimizer (FIXTURE)',
      verifierVersion: '0',
      reason: null,
      candidateCircuit,
      resultId: null,
      operationsRemoved: circuit.ops.length - ops.length,
      changes: circuit.ops.map((op, i) => ({
        kind: i === cancelIndex || i === cancelIndex + 1 ? ('removed' as const) : ('kept' as const),
        originalIndex: i,
        candidateIndex: null,
        description: `FIXTURE — ${op.gate}`,
      })),
      ruleNotes: [],
      candidateProvenance: null,
    }
  }

  /** FIXTURE only: the real harness (qentor.verification.multi_input_harness)
   * runs each case statevector-exact server-side. This just checks whether
   * `inputBits === expectedOutput` (an "identity function" fixture rule) so
   * the Build screen's multi-input test panel has something to show without
   * a running backend — `backend` is accepted but unused, and every id/hash
   * is fixture-prefixed so it can never be mistaken for a real one. */
  async runMultiInputTest(
    _circuit: Circuit,
    inputQubits: number[],
    outputQubits: number[],
    cases: MultiInputTestCase[],
    _backend?: Backend,
  ): Promise<MultiInputTestResult> {
    await delay(150)

    const resultCases = cases.map((c, i) => {
      const passes = c.inputBits === c.expectedOutput
      const observedDistribution = passes ? { [c.expectedOutput]: 1 } : { [c.inputBits]: 1 }
      return {
        inputBits: c.inputBits,
        expectedOutput: c.expectedOutput,
        status: passes ? ('PASS' as const) : ('FAIL' as const),
        observedDistribution,
        error: null,
        resultId: nextFixtureId(),
        circuitHash: `qc_mockmockmock_case${i}`,
      }
    })

    const counterexamples = resultCases
      .filter((c) => c.status === 'FAIL')
      .map((c) => ({
        inputBits: c.inputBits,
        expectedOutput: c.expectedOutput,
        observedDistribution: c.observedDistribution,
        circuitHash: c.circuitHash,
        resultId: c.resultId,
      }))

    return {
      testId: `test_fixture_${nextFixtureId()}`,
      circuitHash: 'qc_mockmockmock',
      backend: 'mock-adapter',
      backendVersion: '0.0.0-dev',
      inputQubits,
      outputQubits,
      cases: resultCases,
      counterexamples,
      overallStatus: counterexamples.length > 0 ? 'SOME_FAILED' : 'ALL_PASSED',
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
