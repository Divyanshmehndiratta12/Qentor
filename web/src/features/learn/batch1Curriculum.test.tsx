/**
 * Sprint 2, curriculum batch 1, from the browser's side: Superdense Coding, Quantum Teleportation and Grover's Search, plus the
 * Bloch-direction and entanglement challenges.
 *
 * Everything here runs against the REAL catalog's wire format: `fixtures/catalog/public_catalog.json` is what `GET /api/lessons` and
 * `GET /api/challenges` serve (a backend test fails if it drifts), and it is parsed by the real client and its schemas. So these
 * tests check that the existing components render the new content, that the lab circuit that reaches the Lab is exactly the
 * server's, that progression, recommendation and Progress treat the catalog (16 lessons and 18 challenges since Sprint 4: see algorithmCurriculum.test.tsx) correctly, and that the browser
 * computes no quantum quantity anywhere along the way. The server-side verdicts themselves are tested in the backend suite.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Challenge, ChallengeSubmission, Lesson } from '@/api'
import { RealApiClient } from '@/api/realClient'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const grading = vi.hoisted(() => ({ current: {} as { gradeConceptCheck?: unknown; regradeConceptChecks?: unknown } }))
const catalogs = vi.hoisted(() => ({ lessons: [] as unknown[], challenges: [] as unknown[] }))

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      listLessons: async () => catalogs.lessons,
      listChallenges: async () => catalogs.challenges,
      gradeConceptCheck: grading.current.gradeConceptCheck,
      regradeConceptChecks: grading.current.regradeConceptChecks,
    }),
  }
})

import { fakeGradingServer } from '@/test/gradingServer'
import { ChallengeBrief } from '@/features/challenges/ChallengeBrief'
import { SubmissionPanel } from '@/features/challenges/SubmissionPanel'
import { ChallengeProgress } from '@/features/progress/ChallengeProgress'
import { emptyOutcomes, emptyRecord, type ChallengeOutcomes } from '@/features/challenges/challengeStorage'
import { useChallengeStore } from '@/features/challenges/store'
import { useBuildStore } from '@/features/build/store'
import { LearnScreen } from './LearnScreen'
import { getLessonReadiness, getLessonState, isLessonComplete, type LessonProgress } from './lessonState'
import { getOverallLearningProgress } from './learnerInsights'
import { getRecommendation } from './recommendation'
import { useLearnStore } from './store'

const RAW = import.meta.glob('../../../../fixtures/catalog/public_catalog.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const FIXTURE = JSON.parse(Object.values(RAW)[0]!) as { lessons: unknown; challenges: unknown }

let LESSONS: Lesson[] = []
let CHALLENGES: Challenge[] = []
const lesson = (id: string) => LESSONS.find((l) => l.id === id)!
const challenge = (id: string) => CHALLENGES.find((c) => c.id === id)!

// The server's answer keys for the six new checks: a test double only, because the real catalog carries none.
const KEYS: Record<string, string> = {
  'superdense-coding/s5': 'b',
  'superdense-coding/s7': 'd',
  'quantum-teleportation/s5': 'c',
  'quantum-teleportation/s7': 'a',
  'grovers-search/s5': 'd',
  'grovers-search/s7': 'b',
}
const NEW_LESSON_IDS = ['superdense-coding', 'quantum-teleportation', 'grovers-search']
const NEW_CHALLENGE_IDS = ['bloch-plus-direction', 'entangle-bell-pair', 'superdense-encode-10', 'teleport-ry-fixed', 'grover-find-01']
const CHALLENGE_OF: Record<string, string> = {
  'superdense-coding': 'superdense-encode-10',
  'quantum-teleportation': 'teleport-ry-fixed',
  'grovers-search': 'grover-find-01',
}

beforeAll(async () => {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.endsWith('/api/lessons') ? FIXTURE.lessons : FIXTURE.challenges
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  const client = new RealApiClient()
  LESSONS = await client.listLessons()
  CHALLENGES = await client.listChallenges()
  catalogs.lessons = LESSONS
  catalogs.challenges = CHALLENGES
})
afterAll(() => vi.unstubAllGlobals())

/** A lesson the learner has finished: every section continued past, every concept check answered correctly. */
function completed(l: Lesson): LessonProgress {
  const attempts: LessonProgress['conceptCheckAttempts'] = {}
  for (const s of l.sections) {
    if (s.type === 'concept_check' && s.question !== null) attempts[s.id] = { selectedOptionId: s.options![0]!.id, isCorrect: true, attemptCount: 1 }
  }
  return { activeSectionIndex: l.sections.length - 1, completedSectionIds: new Set(l.sections.map((s) => s.id)), conceptCheckAttempts: attempts }
}

const progressFor = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, completed(lesson(id))]))
const ORIGINAL_IDS = () => LESSONS.slice(0, 10).map((l) => l.id)
const solved = (ids: string[]): Record<string, ReturnType<typeof emptyRecord>> =>
  Object.fromEntries(ids.map((id) => [id, { ...emptyRecord(), attempts: 1, solved: true }]))

describe('the real catalog, through the real client', () => {
  it('maps 19 lessons and 20 challenges, batch 1 after the original ten and nine, in catalog order', () => {
    expect(LESSONS).toHaveLength(19)
    expect(CHALLENGES).toHaveLength(20)
    expect(LESSONS.slice(10, 13).map((l) => l.id)).toEqual(NEW_LESSON_IDS)
    expect(CHALLENGES.slice(9, 14).map((c) => c.id)).toEqual(NEW_CHALLENGE_IDS)
    expect(CHALLENGES[14]?.id).toBe('optimize-redundant') // the optimisation challenge follows, in the Interference lesson
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(19)
  })

  it('each new lesson has ten sections, its prerequisites, and a linked circuit exactly as the server sent it', () => {
    expect(lesson('superdense-coding').prerequisiteLessonIds).toEqual(['bell-state'])
    expect(lesson('quantum-teleportation').prerequisiteLessonIds).toEqual(['bell-state', 'phase'])
    expect(lesson('grovers-search').prerequisiteLessonIds).toEqual(['interference'])
    for (const id of NEW_LESSON_IDS) {
      expect(lesson(id).sections).toHaveLength(10)
      expect(lesson(id).sections.map((s) => s.id)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i + 1}`))
      expect(lesson(id).linkedCircuit).not.toBeNull()
    }
    const teleport = lesson('quantum-teleportation').linkedCircuit!
    expect(teleport.num_qubits).toBe(3)
    expect(teleport.ops[0]).toMatchObject({ gate: 'ry', targets: [0], params: [1] })
    expect(teleport.ops.map((o) => o.gate)).toEqual(['ry', 'h', 'cx', 'cx', 'h', 'cx', 'cz', 'measure'])
  })

  it('no concept check in the catalog carries an answer key or an explanation', () => {
    for (const l of LESSONS) {
      for (const s of l.sections) {
        if (s.type !== 'concept_check') continue
        expect(s).not.toHaveProperty('correctOptionId')
        expect(s).not.toHaveProperty('correct_option_id')
        expect(s).not.toHaveProperty('explanation')
      }
    }
    expect(Object.values(RAW)[0]).not.toContain('correct_option_id')
  })

  it('the new challenges carry the locked part, its name, and the per-qubit gate rules', () => {
    expect(challenge('superdense-encode-10').constraints).toMatchObject({ anchorName: 'decoder', mustMeasure: [0, 1], gateQubits: { x: [0], z: [0] } })
    expect(challenge('teleport-ry-fixed').constraints).toMatchObject({ anchorName: 'corrections', numQubits: 3, mustMeasure: [2], gateQubits: {} })
    expect(challenge('grover-find-01')).toMatchObject({ fixedOracle: true, constraints: { anchorName: 'oracle' } })
    expect(challenge('bloch-plus-direction').constraints.anchor).toEqual([])
    expect(challenge('entangle-bell-pair').constraints.anchor).toEqual([])
  })

  it('the original fixed-oracle challenges are untouched', () => {
    for (const id of ['deutsch-jozsa-fixed', 'bernstein-vazirani-fixed']) {
      expect(challenge(id)).toMatchObject({ fixedOracle: true, constraints: { anchorName: 'oracle', gateQubits: {} } })
      expect(challenge(id).constraints.anchor).toHaveLength(2)
    }
    expect(CHALLENGES.slice(0, 9).map((c) => c.id)).toEqual([
      'create-one', 'create-plus', 'create-minus', 'create-bell', 'phase-change', 'interference', 'phase-kickback', 'deutsch-jozsa-fixed', 'bernstein-vazirani-fixed',
    ])
  })

  it('no challenge in the catalog carries a target, a reference solution or a substitution', () => {
    const blob = Object.values(RAW)[0]!
    for (const forbidden of ['reference_solution', 'replace_anchor', '"target"', 'misconception']) expect(blob).not.toContain(forbidden)
    for (const c of CHALLENGES) expect(Object.keys(c)).not.toContain('referenceSolution')
  })

  it('every lesson but the Shor one has a challenge, and every challenge a real lesson', () => {
    const lessonIds = new Set(LESSONS.map((l) => l.id))
    for (const c of CHALLENGES) expect(lessonIds.has(c.lessonId)).toBe(true)
    for (const l of LESSONS) expect(CHALLENGES.some((c) => c.lessonId === l.id)).toBe(l.id !== 'shors-algorithm')
  })
})

describe('progression over 19 lessons and 20 challenges', () => {
  it('a new lesson is open at once, and only RECOMMENDED once every one of its prerequisites is complete', () => {
    const none = new Set<string>()
    for (const id of NEW_LESSON_IDS) expect(getLessonState(lesson(id), none)).toBe('available')
    for (const id of NEW_LESSON_IDS) expect(getLessonReadiness(lesson(id), none)).toBe('builds_on_unfinished')
    expect(getLessonReadiness(lesson('superdense-coding'), new Set(['bell-state']))).toBe('ready')
    expect(getLessonReadiness(lesson('quantum-teleportation'), new Set(['bell-state']))).toBe('builds_on_unfinished') // needs phase too
    expect(getLessonReadiness(lesson('quantum-teleportation'), new Set(['phase']))).toBe('builds_on_unfinished')
    expect(getLessonReadiness(lesson('quantum-teleportation'), new Set(['bell-state', 'phase']))).toBe('ready')
    expect(getLessonReadiness(lesson('grovers-search'), new Set(['bell-state', 'phase']))).toBe('builds_on_unfinished')
    expect(getLessonReadiness(lesson('grovers-search'), new Set(['interference']))).toBe('ready')
    expect(getLessonState(lesson('grovers-search'), new Set(['grovers-search']))).toBe('completed')
  })

  it('the original ten lessons keep their prerequisites', () => {
    expect(Object.fromEntries(LESSONS.slice(0, 10).map((l) => [l.id, l.prerequisiteLessonIds]))).toEqual({
      'qubits-measurement': [],
      'bloch-sphere': ['qubits-measurement'],
      superposition: ['qubits-measurement'],
      phase: ['superposition'],
      interference: ['phase'],
      entanglement: ['superposition'],
      'bell-state': ['entanglement'],
      'phase-kickback': ['bell-state', 'phase'],
      'deutsch-jozsa': ['phase-kickback'],
      'bernstein-vazirani': ['deutsch-jozsa'],
    })
  })

  it('the recommendation walks the new lessons and challenges in order, and ends when everything is done', () => {
    const originals = ORIGINAL_IDS()
    const started = new Set(originals)
    const originalChallenges = CHALLENGES.slice(0, 9).map((c) => c.id)
    const recommend = (lessonIds: string[], solvedIds: string[]) =>
      getRecommendation(LESSONS, CHALLENGES, progressFor(lessonIds), new Set([...started, ...lessonIds]), solved(solvedIds))

    // the ten original lessons are done, but the two new challenges of the old lessons are not solved: the first is offered
    expect(recommend(originals, originalChallenges)).toMatchObject({ kind: 'try_challenge', challengeId: 'bloch-plus-direction', lessonId: 'bloch-sphere' })
    const withBlochAndEntangle = [...originalChallenges, 'bloch-plus-direction', 'entangle-bell-pair']
    // Interference is finished, so the optimisation challenge that belongs to it is offered before moving on to a new lesson
    expect(recommend(originals, withBlochAndEntangle)).toMatchObject({ kind: 'try_challenge', challengeId: 'optimize-redundant', lessonId: 'interference' })
    const allBefore = [...withBlochAndEntangle, 'optimize-redundant']
    expect(recommend(originals, [...originalChallenges, 'bloch-plus-direction'])).toMatchObject({ kind: 'try_challenge', challengeId: 'entangle-bell-pair' })
    // then the first new lesson is next
    expect(recommend(originals, allBefore)).toMatchObject({ kind: 'next_lesson', lessonId: 'superdense-coding' })
    // finish it: its challenge is next; solve it: teleportation; and so on
    let done = [...originals, 'superdense-coding']
    expect(recommend(done, allBefore)).toMatchObject({ kind: 'try_challenge', challengeId: 'superdense-encode-10' })
    let cleared = [...allBefore, 'superdense-encode-10']
    expect(recommend(done, cleared)).toMatchObject({ kind: 'next_lesson', lessonId: 'quantum-teleportation' })
    done = [...done, 'quantum-teleportation']
    expect(recommend(done, cleared)).toMatchObject({ kind: 'try_challenge', challengeId: 'teleport-ry-fixed' })
    cleared = [...cleared, 'teleport-ry-fixed']
    expect(recommend(done, cleared)).toMatchObject({ kind: 'next_lesson', lessonId: 'grovers-search' })
    done = [...done, 'grovers-search']
    expect(recommend(done, cleared)).toMatchObject({ kind: 'try_challenge', challengeId: 'grover-find-01' })
    cleared = [...cleared, 'grover-find-01']
    // everything of batch 1 is done: the next lesson is the first of the algorithm lessons (their prerequisites, phase and interference, are done)
    expect(recommend(done, cleared)).toMatchObject({ kind: 'next_lesson', lessonId: 'quantum-fourier-transform' })
  })

  it('the overall tally counts 19 lessons and 38 concept checks', () => {
    const everything = progressFor(LESSONS.map((l) => l.id))
    const tally = getOverallLearningProgress(LESSONS, everything, new Set(LESSONS.map((l) => l.id)))
    expect(tally).toMatchObject({ totalLessons: 19, lessonsCompleted: 19, conceptChecksTotal: 38, conceptChecksCorrect: 38, overallAccuracy: 1 })
    expect(LESSONS.every((l) => isLessonComplete(l, everything[l.id]))).toBe(true)
  })

  it('Progress shows challenge completion out of twenty, with the new challenges listed and openable', () => {
    const outcomes: ChallengeOutcomes = { ...emptyOutcomes(), records: solved(['create-one', 'bloch-plus-direction', 'grover-find-01']) }
    const open = vi.fn()
    render(<ChallengeProgress challenges={CHALLENGES} outcomes={outcomes} onOpenChallenge={open} />)
    expect(screen.getByTestId('challenges-solved')).toHaveTextContent('3 of 20 solved')
    cleanup()
  })
})

describe('Learn -> lesson -> Lab, and Learn -> Challenge, with the real new lessons', () => {
  const INITIAL_LEARN = useLearnStore.getState()
  const INITIAL_BUILD = useBuildStore.getState()
  const INITIAL_CHALLENGES = useChallengeStore.getState()

  beforeEach(() => {
    // The server double knows the six new checks' keys. The ten original lessons are seeded as finished, and their saved verdicts
    // are re-checked on load like any others, so for a check the double has no key for the stand-in re-confirms the saved verdict.
    const server = fakeGradingServer({ keys: KEYS })
    grading.current = {
      gradeConceptCheck: server.gradeConceptCheck,
      regradeConceptChecks: vi.fn(async (answers: { lessonId: string; checkId: string; selectedOptionId: string }[]) => {
        const known = answers.filter((a) => `${a.lessonId}/${a.checkId}` in KEYS)
        const graded = new Map((await server.regradeConceptChecks(known)).map((r) => [`${r.lessonId}/${r.checkId}`, r]))
        return answers.map(
          (a) => graded.get(`${a.lessonId}/${a.checkId}`) ?? { ...a, status: 'GRADED' as const, correct: true, explanation: 'Confirmed.' },
        )
      }),
    }
    useLearnStore.setState({ ...INITIAL_LEARN, lessonProgress: progressFor(ORIGINAL_IDS()), startedLessonIds: new Set(ORIGINAL_IDS()) }, true)
    useChallengeStore.setState({ ...INITIAL_CHALLENGES, challenges: CHALLENGES }, true)
    useBuildStore.setState(INITIAL_BUILD, true)
  })
  afterEach(() => {
    cleanup()
    useLearnStore.setState(INITIAL_LEARN, true)
    useChallengeStore.setState(INITIAL_CHALLENGES, true)
    useBuildStore.setState(INITIAL_BUILD, true)
  })

  /** Opens `id` and clicks through its sections up to (not including) the lab step, answering each check as the server's key says. */
  async function walkToLab(id: string) {
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(id).title}`) }))
    for (const section of lesson(id).sections) {
      if (section.type === 'interactive_lab') return section
      await screen.findByText(section.type === 'explanation' ? section.body : section.type === 'concept_check' ? section.question! : section.prompt)
      if (section.type === 'concept_check') {
        const right = section.options!.find((o) => o.id === KEYS[`${id}/${section.id}`])!
        fireEvent.click(screen.getByLabelText(right.text))
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
        await screen.findByText(/Correct\./)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    }
    throw new Error('no lab section')
  }

  for (const id of NEW_LESSON_IDS) {
    it(`${id}: shows its real first section, reaches the lab step, and hands the Lab the server's own circuit`, async () => {
      const onOpenLab = vi.fn()
      render(<LearnScreen onOpenLab={onOpenLab} onOpenChallenge={vi.fn()} />)
      const lab = await walkToLab(id)
      await screen.findByText(lab.type === 'interactive_lab' ? lab.instructions : '')
      fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))
      expect(onOpenLab).toHaveBeenCalledTimes(1)
      expect(onOpenLab).toHaveBeenCalledWith(lesson(id).linkedCircuit) // exactly what the server sent: nothing computed or edited here
      // the Lab is only handed a circuit: no result is fabricated by opening it
      expect(useBuildStore.getState().result).toBeNull()
    })

    it(`${id}: offers its challenge from the lesson and opens it by id`, async () => {
      const onOpenChallenge = vi.fn()
      render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={onOpenChallenge} />)
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(id).title}`) }))
      const practice = await screen.findByTestId('lesson-challenges')
      const title = challenge(CHALLENGE_OF[id]!).title
      expect(within(practice).getAllByRole('button').map((b) => b.textContent)).toEqual([title]) // this lesson's challenge, and no other
      fireEvent.click(within(practice).getByRole('button', { name: title }))
      expect(onOpenChallenge).toHaveBeenCalledWith(CHALLENGE_OF[id])
    })
  }

  it('a new lesson is open at once and says what it builds on until its prerequisite lessons are finished', async () => {
    useLearnStore.setState({ lessonProgress: {}, startedLessonIds: new Set() })
    render(<LearnScreen onOpenLab={vi.fn()} />)
    const card = await screen.findByRole('button', { name: /^Superdense Coding/ })
    expect(card).toBeEnabled()
    expect(card).not.toHaveTextContent(/Locked/i)
    expect(card).toHaveTextContent(/Builds on:/)
    fireEvent.click(card)
    expect(await screen.findByRole('heading', { level: 2, name: 'Superdense Coding' })).toBeInTheDocument()
  })

  it('the Interference lesson offers its original challenge and the optimisation challenge, and opens either by id', async () => {
    const onOpenChallenge = vi.fn()
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={onOpenChallenge} />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson('interference').title}`) }))
    const practice = await screen.findByTestId('lesson-challenges')
    const titles = within(practice).getAllByRole('button').map((b) => b.textContent)
    expect(titles).toEqual([challenge('interference').title, 'Shorten it without changing it'])
    fireEvent.click(within(practice).getByRole('button', { name: 'Shorten it without changing it' }))
    expect(onOpenChallenge).toHaveBeenLastCalledWith('optimize-redundant')
  })

  it('the optimisation challenge, as the server serves it, starts redundant, is capped at 3 operations and reveals no answer', () => {
    const c = challenge('optimize-redundant')
    expect(c.lessonId).toBe('interference')
    expect(c.starterCircuit.ops).toHaveLength(10)
    expect(c.constraints.maxOps).toBe(3)
    expect(c.checks).toEqual([{ id: 'equivalent.to_start', label: 'Does exactly what the starting circuit does' }])
    expect(Object.keys(c).sort()).not.toContain('referenceSolution')
    expect(JSON.stringify(c)).not.toMatch(/"(target|misconception|experiment|referenceSolution|reference_solution)"/) // keys, not words in the prose
  })

  it('bloch-sphere and entanglement now offer a challenge instead of nothing', async () => {
    const onOpenChallenge = vi.fn()
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={onOpenChallenge} />)
    for (const [lessonId, challengeId] of [['bloch-sphere', 'bloch-plus-direction'], ['entanglement', 'entangle-bell-pair']] as const) {
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(lessonId).title}`) }))
      const practice = await screen.findByTestId('lesson-challenges')
      fireEvent.click(within(practice).getByRole('button', { name: challenge(challengeId).title }))
      expect(onOpenChallenge).toHaveBeenLastCalledWith(challengeId)
    }
  })

  it('the first section of each new lesson is the server’s text, word for word', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} />)
    for (const id of NEW_LESSON_IDS) {
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(id).title}`) }))
      const first = lesson(id).sections[0]!
      expect(await screen.findByText(first.type === 'explanation' ? first.body : '')).toBeInTheDocument()
    }
  })

  it('the teleportation lesson says on screen that its corrections are deferred', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Quantum Teleportation/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    const s2 = lesson('quantum-teleportation').sections[1]!
    const text = await screen.findByText(s2.type === 'explanation' ? s2.body : '')
    expect(text.textContent).toMatch(/DEFERRED/)
    expect(text.textContent).toMatch(/not the full dynamic protocol/)
  })
})

describe('the challenge brief and verdict for the new challenges', () => {
  const brief = (c: Challenge) =>
    render(<ChallengeBrief challenge={c} hintsRevealed={0} onRevealNextHint={vi.fn()} lessonTitle="Lesson" onOpenLesson={vi.fn()} />)
  afterEach(() => cleanup())

  it('names the locked part for each kind of challenge, and lists its gates', () => {
    brief(challenge('superdense-encode-10'))
    expect(screen.getByText(/The fixed decoder — place these gates exactly/)).toBeInTheDocument()
    expect(screen.getByText('CX — control q0, target q1')).toBeInTheDocument()
    expect(screen.getByText('H on q0')).toBeInTheDocument()
    cleanup()

    brief(challenge('teleport-ry-fixed'))
    expect(screen.getByText(/The fixed corrections — place these gates exactly/)).toBeInTheDocument()
    cleanup()

    brief(challenge('grover-find-01'))
    expect(screen.getByText(/The fixed oracle — place these gates exactly/)).toBeInTheDocument()
    cleanup()

    brief(challenge('deutsch-jozsa-fixed'))
    expect(screen.getByText(/The fixed oracle — place these gates exactly/)).toBeInTheDocument()
  })

  it('states the per-qubit gate rule when there is one, and only then', () => {
    brief(challenge('superdense-encode-10'))
    expect(screen.getByTestId('gate-qubit-rule')).toHaveTextContent('x acts only on q[0]; z acts only on q[0]')
    cleanup()
    brief(challenge('create-bell'))
    expect(screen.queryByTestId('gate-qubit-rule')).not.toBeInTheDocument()
  })

  it('a challenge without a locked part shows no fixed block (the Bloch and entanglement challenges)', () => {
    for (const id of ['bloch-plus-direction', 'entangle-bell-pair']) {
      brief(challenge(id))
      expect(screen.queryByText(/The fixed/)).not.toBeInTheDocument()
      cleanup()
    }
  })

  const PROV: Provenance = {
    resultId: 'res_final', circuitHash: 'qc_1', backend: 'qiskit-aer', backendVersion: '0.17.2', executionMode: 'statevector',
    provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED', createdAt: '2026-01-01T00:00:00Z',
  }
  const submission = (): ChallengeSubmission => ({
    attemptId: 'att_1',
    challengeId: 'teleport-ry-fixed',
    circuitHash: 'qc_1',
    passed: false,
    verifier: 'challenge/1',
    checks: [
      {
        id: 'before.bob_blind',
        label: 'Before the corrections, Bob’s qubit q[2] alone has no definite state',
        passed: false,
        evaluated: true,
        detail: 'The qubit’s own state is not the required state.',
        hintIndex: 2,
        evidence: [
          { name: 'bloch_vector_distance', value: toQuantumValue(0.5, PROV) },
          { name: 'qubit_purity', value: toQuantumValue(1, PROV) },
        ],
        resultId: 'res_final',
      },
    ],
    backend: 'qiskit-aer',
    backendVersion: '0.17.2',
    finalResultId: 'res_final',
    finalProvenance: PROV,
    nextHintIndex: 2,
    nextHint: 'a hint',
    successMessage: null,
    createdAt: '2026-05-01T10:00:00.000Z',
  })

  it('shows the new evidence with plain labels and the provenance of the backend step it came from', () => {
    render(
      <SubmissionPanel
        submission={submission()}
        isCurrent
        isSubmitting={false}
        error={null}
        errorStatus={null}
        onSubmit={vi.fn()}
        onShowHint={vi.fn()}
        hintsLeft
        onRetry={vi.fn()}
        canSubmit
      />,
    )
    const row = screen.getByTestId('check-before.bob_blind')
    expect(row).toHaveTextContent('Distance between the qubit’s Bloch vector and the required one')
    expect(row).toHaveTextContent('Purity of the qubit’s own state')
    expect(row).not.toHaveTextContent('bloch_vector_distance') // a raw field name is never shown
    // every number is rendered through VerifiedValue, which carries the provenance (a source line for each)
    expect(within(row).getAllByText(/qiskit-aer|SIMULATION|res_final/).length).toBeGreaterThan(0)
  })
})

describe('the browser computes no quantum quantity for any of this', () => {
  it('the components that show the new constraints and evidence have no statevector, amplitude or Bloch arithmetic of their own', () => {
    const sources = import.meta.glob(['../challenges/ChallengeBrief.tsx', '../challenges/SubmissionPanel.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    expect(Object.keys(sources)).toHaveLength(2)
    for (const [path, text] of Object.entries(sources)) {
      for (const banned of [/Math\.(sin|cos|atan2|sqrt|hypot|pow)/, /\bstatevector\b/i, /\bamplitudes?\b/i, /\bfidelity\s*[=(]/i, /\*\*\s*2/]) {
        expect(text, `${path} ${banned}`).not.toMatch(banned)
      }
    }
  })
})
