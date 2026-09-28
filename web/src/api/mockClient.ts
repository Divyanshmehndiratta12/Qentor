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
import type { ApiClient, ExecutePayload, ExecutionMode } from './client'
import type { Lesson, LessonSummary, TutorQuery, TutorReply } from './types'

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

  async askTutor(query: TutorQuery): Promise<TutorReply> {
    await delay(300)
    return {
      segments: [
        'FIXTURE tutor reply — no tutor module exists server-side yet.',
        `You asked about ${query.resultIds.length} result(s).`,
      ],
      factReferences: query.resultIds.map((id) => ({ resultId: id, label: 'referenced result' })),
      candidateCircuit: null,
      usedFallbackTemplate: true,
      rejectedClaimCount: 0,
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
