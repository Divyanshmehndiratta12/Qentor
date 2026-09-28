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
import type {
  ApiClient,
  Backend,
  ExecutePayload,
  ExecutionMode,
  MultiInputTestCase,
  MultiInputTestResult,
  OptimizationResult,
  TutorAnswerResult,
  VerifyBellStateResult,
} from './client'
import type { Lesson, LessonSummary } from './types'

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
    verificationStatus: 'VERIFIED',
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

  async listLessons(): Promise<LessonSummary[]> {
    await delay(80)
    return [
      { id: 'bell-primer', title: 'Superposition & the Bell state', concept: 'superposition', masteryFraction: 0.4 },
      { id: 'phase-kickback', title: 'Phase kickback', concept: 'phase-kickback', masteryFraction: 0 },
      { id: 'deutsch-jozsa', title: 'Deutsch–Jozsa', concept: 'oracle-algorithms', masteryFraction: 0 },
      { id: 'bernstein-vazirani', title: 'Bernstein–Vazirani', concept: 'oracle-algorithms', masteryFraction: null },
    ]
  }

  async getLesson(id: string): Promise<Lesson> {
    const summary = (await this.listLessons()).find((l) => l.id === id)
    if (!summary) throw new Error(`no fixture lesson with id ${id}`)
    return {
      ...summary,
      steps: [
        { kind: 'explain', body: 'FIXTURE lesson content — backend /api/lessons does not exist yet.' },
      ],
    }
  }

  /** FIXTURE only: the real deterministic tutor lives server-side
   * (qentor.tutor). This builds a tiny fact sheet from the circuit alone so
   * the Build screen's Tutor panel has something to show without a running
   * backend — clearly labelled FIXTURE, never confusable with a grounded
   * server answer. */
  async askTutor(resultId: string, circuit: Circuit, question: string): Promise<TutorAnswerResult> {
    await delay(200)

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
      verificationStatus: 'VERIFIED',
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
