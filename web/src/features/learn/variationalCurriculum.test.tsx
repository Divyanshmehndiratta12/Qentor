/**
 * Sprint 6, lesson 17 (a one-parameter variational, VQE-style demonstration) and its challenge, from the browser's side, against the REAL
 * catalog's wire format (`fixtures/catalog/public_catalog.json`, which a backend test keeps in step with what the API serves). The server-
 * side verdicts, the physics and every expectation value are tested in the backend suite; here the existing components must render the new
 * content, hand the Lab the server's circuit, show the variational lab only for its capability, and compute nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Challenge, Lesson, VariationalSweepResult } from '@/api'
import { RealApiClient } from '@/api/realClient'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const grading = vi.hoisted(() => ({ current: {} as { gradeConceptCheck?: unknown; regradeConceptChecks?: unknown } }))
const catalogs = vi.hoisted(() => ({ lessons: [] as unknown[], challenges: [] as unknown[] }))
const sweepClient = vi.hoisted(() => ({ variationalSweep: vi.fn(), variationalOptimize: vi.fn() }))

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      listLessons: async () => catalogs.lessons,
      listChallenges: async () => catalogs.challenges,
      gradeConceptCheck: grading.current.gradeConceptCheck,
      regradeConceptChecks: grading.current.regradeConceptChecks,
      ...sweepClient,
    }),
  }
})

import { fakeGradingServer } from '@/test/gradingServer'
import { ChallengeBrief } from '@/features/challenges/ChallengeBrief'
import { useBuildStore } from '@/features/build/store'
import { useChallengeStore } from '@/features/challenges/store'
import { LearnScreen } from './LearnScreen'
import { getLessonReadiness, getLessonState } from './lessonState'
import { useLearnStore } from './store'
import { useVariationalStore } from './variationalStore'

const RAW = import.meta.glob('../../../../fixtures/catalog/public_catalog.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const FIXTURE = JSON.parse(Object.values(RAW)[0]!) as { lessons: unknown; challenges: unknown }

let LESSONS: Lesson[] = []
let CHALLENGES: Challenge[] = []
const lesson = (id: string) => LESSONS.find((l) => l.id === id)!
const challenge = (id: string) => CHALLENGES.find((c) => c.id === id)!

const ID = 'variational-vqe'
const CHALLENGE = 'vqe-find-theta'
// The server's answer keys for the two checks: a test double only, because the real catalog carries none.
const KEYS: Record<string, string> = { [`${ID}/s5`]: 'b', [`${ID}/s7`]: 'c' }

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.endsWith('/api/lessons') ? FIXTURE.lessons : FIXTURE.challenges
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  const client = new RealApiClient()
  LESSONS = await client.listLessons()
  CHALLENGES = await client.listChallenges()
  catalogs.lessons = LESSONS
  catalogs.challenges = CHALLENGES
})
afterAll(() => vi.unstubAllGlobals())

describe('lesson 17 as the real client reads it', () => {
  it('is the seventeenth lesson with the prerequisites the brief names, ten sections in the agreed shape and a variational lab', () => {
    const l = lesson(ID)
    expect(LESSONS.map((x) => x.id).indexOf(ID)).toBe(16)
    expect(l.prerequisiteLessonIds).toEqual(['bloch-sphere', 'superposition'])
    expect(l.sections.map((s) => s.type)).toEqual(['explanation', 'explanation', 'explanation', 'explanation', 'concept_check', 'interactive_lab', 'concept_check', 'explanation', 'explanation', 'reflection'])
    const lab = l.sections.find((s) => s.type === 'interactive_lab')!
    expect(lab).toMatchObject({ capability: 'variational_sweep' })
    expect(l.linkedCircuit).toMatchObject({ num_qubits: 1, num_clbits: 0 })
    expect(l.linkedCircuit!.ops).toHaveLength(1)
    expect(l.linkedCircuit!.ops[0]).toMatchObject({ gate: 'ry', targets: [0], controls: [] })
  })

  it('its two concept checks are real questions with four options and no key or explanation in what the client holds', () => {
    const checks = lesson(ID).sections.filter((s) => s.type === 'concept_check')
    expect(checks).toHaveLength(2)
    for (const check of checks) {
      expect(check.question).toBeTruthy()
      expect(check.options).toHaveLength(4)
      expect(JSON.stringify(check)).not.toMatch(/correct_option_id|explanation|correctOptionId/)
    }
  })

  it('is always open, and is only RECOMMENDED once bloch-sphere AND superposition are complete', () => {
    for (const done of [new Set<string>(), new Set(['bloch-sphere']), new Set(['superposition'])]) {
      expect(getLessonState(lesson(ID), done)).toBe('available')
      expect(getLessonReadiness(lesson(ID), done)).toBe('builds_on_unfinished')
    }
    expect(getLessonState(lesson(ID), new Set(['bloch-sphere', 'superposition']))).toBe('available')
    expect(getLessonReadiness(lesson(ID), new Set(['bloch-sphere', 'superposition']))).toBe('ready')
    expect(getLessonState(lesson(ID), new Set([ID]))).toBe('completed')
  })

  it('its challenge is "Find θ where ⟨Z⟩ = -1": one RY gate on one qubit, no answer and no target in the public view', () => {
    const c = challenge(CHALLENGE)
    expect(c).toMatchObject({ lessonId: ID, title: 'Find θ where ⟨Z⟩ = -1', difficulty: 'intermediate' })
    expect(c.constraints).toMatchObject({ numQubits: 1, allowedGates: ['ry'], maxOps: 1 })
    expect(c.checks).toHaveLength(1)
    expect(JSON.stringify(c)).not.toMatch(/reference|target|expectation_matches|"value"|tolerance/)
    expect(c.hints).toHaveLength(3)
  })

  it('the brief names the allowed gate and shows the goal in the server’s words', () => {
    render(<ChallengeBrief challenge={challenge(CHALLENGE)} hintsRevealed={0} onRevealNextHint={vi.fn()} lessonTitle="Variational" onOpenLesson={vi.fn()} />)
    expect(screen.getByText(/Build a one-qubit circuit with a single RY gate/)).toBeInTheDocument()
    expect(screen.getByText(/The circuit is one RY gate on q\[0\]/)).toBeInTheDocument()
    cleanup()
  })
})

describe('Learn -> lesson 17 -> the variational lab', () => {
  const INITIAL_LEARN = useLearnStore.getState()
  const INITIAL_BUILD = useBuildStore.getState()
  const INITIAL_CHALLENGES = useChallengeStore.getState()
  const INITIAL_VQE = useVariationalStore.getState()

  const prov: Provenance = { resultId: 'res_s0', circuitHash: 'h', backend: 'qiskit-aer', backendVersion: '0.17.2', executionMode: 'statevector', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED', createdAt: '2026-01-01T00:00:00Z' }
  const SWEEP: VariationalSweepResult = {
    method: 'qentor.variational/1',
    expectationMethod: 'm',
    ansatz: 'RY(theta) on one qubit, started in |0>',
    observable: 'Pauli Z on q[0]',
    label: 'Educational one-parameter demonstration: not a chemistry calculation, not a scalable VQE, and it uses no quantum hardware.',
    backend: 'qiskit-aer',
    backendVersion: '0.17.2',
    provenance: { ...prov, resultId: 'res_demo', backend: 'variational-demo', executionMode: 'variational' },
    points: [0, 1, 2].map((i) => ({
      theta: toQuantumValue(i, { ...prov, resultId: `res_s${i}` }),
      expectationZ: toQuantumValue(0.5 - i * 0.5, { ...prov, resultId: `res_s${i}` }),
      bloch: toQuantumValue({ x: 0, y: 0, z: 0.5 - i * 0.5 }, { ...prov, resultId: `res_s${i}` }),
      probabilityZero: toQuantumValue(0.75 - i * 0.25, { ...prov, resultId: `res_s${i}` }),
      probabilityOne: toQuantumValue(0.25 + i * 0.25, { ...prov, resultId: `res_s${i}` }),
      resultId: `res_s${i}`,
      executionId: `e${i}`,
      circuitHash: `h${i}`,
      provenance: { ...prov, resultId: `res_s${i}` },
    })),
    minimumIndex: 2,
    maximumIndex: 0,
  }

  beforeEach(() => {
    // The saved verdicts of the sixteen earlier lessons are confirmed by the stand-in server; this lesson's checks are graded from the
    // test-side keys, exactly as the real server grades from its own.
    const server = fakeGradingServer({ keys: KEYS })
    grading.current = {
      gradeConceptCheck: server.gradeConceptCheck,
      regradeConceptChecks: vi.fn(async (answers: { lessonId: string; checkId: string; selectedOptionId: string }[]) => {
        const known = answers.filter((a) => a.lessonId === ID && `${a.lessonId}/${a.checkId}` in KEYS)
        const graded = new Map((await server.regradeConceptChecks(known)).map((r) => [`${r.lessonId}/${r.checkId}`, r]))
        return answers.map((a) => graded.get(`${a.lessonId}/${a.checkId}`) ?? { ...a, status: 'GRADED' as const, correct: true, explanation: 'Confirmed.' })
      }),
    }
    sweepClient.variationalSweep.mockReset()
    sweepClient.variationalOptimize.mockReset()
    sweepClient.variationalSweep.mockResolvedValue(SWEEP)
    useChallengeStore.setState({ ...INITIAL_CHALLENGES, challenges: CHALLENGES }, true)
    useBuildStore.setState(INITIAL_BUILD, true)
    useVariationalStore.setState(INITIAL_VQE, true)
    const earlier = LESSONS.slice(0, 16).map((l) => l.id)
    const done = Object.fromEntries(
      earlier.map((id) => {
        const l = lesson(id)
        const attempts: Record<string, { selectedOptionId: string; isCorrect: boolean; attemptCount: number }> = {}
        for (const s of l.sections) if (s.type === 'concept_check' && s.question !== null) attempts[s.id] = { selectedOptionId: s.options![0]!.id, isCorrect: true, attemptCount: 1 }
        return [id, { activeSectionIndex: l.sections.length - 1, completedSectionIds: new Set(l.sections.map((s) => s.id)), conceptCheckAttempts: attempts }]
      }),
    )
    useLearnStore.setState({ ...INITIAL_LEARN, lessonProgress: done, startedLessonIds: new Set(earlier) }, true)
  })
  afterEach(() => {
    cleanup()
    useLearnStore.setState(INITIAL_LEARN, true)
    useChallengeStore.setState(INITIAL_CHALLENGES, true)
    useBuildStore.setState(INITIAL_BUILD, true)
    useVariationalStore.setState(INITIAL_VQE, true)
  })

  async function walkToLab() {
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(ID).title}`) }))
    for (const section of lesson(ID).sections) {
      if (section.type === 'interactive_lab') return section
      await screen.findByText(section.type === 'explanation' ? section.body : section.type === 'concept_check' ? section.question! : section.prompt)
      if (section.type === 'concept_check') {
        const right = section.options!.find((o) => o.id === KEYS[`${ID}/${section.id}`])!
        fireEvent.click(screen.getByLabelText(right.text))
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
        await screen.findByText(/Correct\./)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    }
    throw new Error('no lab section')
  }

  it('the lab step shows the instructions, the honesty label and the variational lab — and no number before anything has run', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={vi.fn()} />)
    const lab = await walkToLab()
    await screen.findByText(lab.instructions)
    expect(screen.getByTestId('variational-lab')).toBeInTheDocument()
    expect(screen.getByTestId('variational-label')).toHaveTextContent(/not a chemistry calculation.*not a scalable VQE.*no quantum hardware/is)
    expect(screen.getByText(/the sweep and the optimiser below are computed by the server/)).toBeInTheDocument()
    expect(screen.queryByTestId('bloch-section')).toBeNull()
    expect(sweepClient.variationalSweep).not.toHaveBeenCalled()
  })

  it('"Open in Lab" hands the Lab exactly the server’s circuit and fabricates no result', async () => {
    const onOpenLab = vi.fn()
    render(<LearnScreen onOpenLab={onOpenLab} onOpenChallenge={vi.fn()} />)
    await walkToLab()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))
    expect(onOpenLab).toHaveBeenCalledWith(lesson(ID).linkedCircuit)
    expect(useBuildStore.getState().result).toBeNull()
  })

  it('running the sweep inside the lesson draws the server’s curve and the readout, with provenance', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={vi.fn()} />)
    await walkToLab()
    fireEvent.click(screen.getByRole('button', { name: /run the sweep/i }))
    const selected = await screen.findByText(/run res_s2/)
    expect(selected).toBeInTheDocument()
    expect(sweepClient.variationalSweep).toHaveBeenCalledWith({ thetaMin: 0, thetaMax: 2 * Math.PI, points: 25 })
    const readout = screen.getByTestId('variational-selected')
    expect(within(readout).getByText('-0.500000')).toBeInTheDocument()
    expect(within(readout).getByTestId('bloch-section')).toBeInTheDocument()
  })

  it('no other lesson shows the variational lab: the error-correction lab step has its own capability line', async () => {
    const qec = lesson('quantum-error-correction')
    const upToLab = qec.sections.slice(0, 5).map((x) => x.id)
    useLearnStore.setState({
      lessonProgress: {
        ...useLearnStore.getState().lessonProgress,
        [qec.id]: {
          activeSectionIndex: 5,
          completedSectionIds: new Set(upToLab),
          conceptCheckAttempts: { s5: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } },
        },
      },
    })
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${qec.title}`) }))
    expect(await screen.findByText(/uses the existing execute capability/)).toBeInTheDocument()
    expect(screen.queryByTestId('variational-lab')).toBeNull()
  })

  it('a wrong answer to its first check gets the server’s "not quite" and the explanation comes from the server', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(ID).title}`) }))
    for (const section of lesson(ID).sections.slice(0, 5)) {
      await screen.findByText(section.type === 'explanation' ? section.body : section.type === 'concept_check' ? section.question! : section.type === 'interactive_lab' ? section.instructions : section.prompt)
      if (section.type !== 'concept_check') {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        continue
      }
      const wrong = section.options!.find((o) => o.id !== KEYS[`${ID}/${section.id}`])!
      fireEvent.click(screen.getByLabelText(wrong.text))
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      await screen.findByText(/Not quite\./)
      expect(screen.getByTestId('quiz-explanation')).toHaveTextContent(`Explanation for ${ID}/${section.id}.`)
    }
  })

  it('offers its challenge from the lesson and opens it by id', async () => {
    const onOpenChallenge = vi.fn()
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={onOpenChallenge} />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(ID).title}`) }))
    const practice = await screen.findByTestId('lesson-challenges')
    const title = challenge(CHALLENGE).title
    expect(within(practice).getAllByRole('button').map((b) => b.textContent)).toEqual([title])
    fireEvent.click(within(practice).getByRole('button', { name: title }))
    expect(onOpenChallenge).toHaveBeenCalledWith(CHALLENGE)
  })
})
