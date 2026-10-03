/**
 * Sprint 4, the algorithm curriculum, from the browser's side: the Quantum Fourier Transform, Quantum Phase Estimation and Quantum Error
 * Correction lessons, and the QFT, QPE and QEC challenges.
 *
 * Everything runs against the REAL catalog's wire format: `fixtures/catalog/public_catalog.json` is what `GET /api/lessons` and
 * `GET /api/challenges` serve (a backend test fails if it drifts), parsed by the real client and its schemas. So these tests check that
 * the existing components render the new content, that the lab circuit that reaches the Lab is exactly the server's (angles included,
 * to the last digit), that prerequisites, recommendation and Progress treat 16 lessons and 18 challenges correctly, that nothing a
 * learner can see carries an answer key or a challenge target, and that the browser computes no quantum quantity along the way. The
 * server-side verdicts and the physics are tested in the backend suite.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Challenge, Lesson } from '@/api'
import { RealApiClient } from '@/api/realClient'

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

const QFT = 'quantum-fourier-transform'
const QPE = 'quantum-phase-estimation'
const QEC = 'quantum-error-correction'
const NEW_LESSON_IDS = [QFT, QPE, QEC]
const NEW_CHALLENGE_IDS = ['qft-2qubit', 'qpe-estimate-t', 'qec-correct-flip-q1']
const CHALLENGE_OF: Record<string, string> = { [QFT]: 'qft-2qubit', [QPE]: 'qpe-estimate-t', [QEC]: 'qec-correct-flip-q1' }

// The server's answer keys for the six new checks: a test double only, because the real catalog carries none.
const KEYS: Record<string, string> = {
  [`${QFT}/s5`]: 'b',
  [`${QFT}/s7`]: 'c',
  [`${QPE}/s5`]: 'c',
  [`${QPE}/s7`]: 'd',
  [`${QEC}/s5`]: 'a',
  [`${QEC}/s7`]: 'c',
}

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

function completed(l: Lesson): LessonProgress {
  const attempts: LessonProgress['conceptCheckAttempts'] = {}
  for (const s of l.sections) {
    if (s.type === 'concept_check' && s.question !== null) attempts[s.id] = { selectedOptionId: s.options![0]!.id, isCorrect: true, attemptCount: 1 }
  }
  return { activeSectionIndex: l.sections.length - 1, completedSectionIds: new Set(l.sections.map((s) => s.id)), conceptCheckAttempts: attempts }
}
const progressFor = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, completed(lesson(id))]))
const solved = (ids: string[]): Record<string, ReturnType<typeof emptyRecord>> =>
  Object.fromEntries(ids.map((id) => [id, { ...emptyRecord(), attempts: 1, solved: true }]))
const FIRST_THIRTEEN = () => LESSONS.slice(0, 13).map((l) => l.id)
const FIRST_FIFTEEN_CHALLENGES = () => CHALLENGES.slice(0, 15).map((c) => c.id)

describe('the real catalog, through the real client', () => {
  it('maps 18 lessons and 19 challenges, the algorithm ones after the first thirteen and in order, the variational one and then the Shor lesson last', () => {
    expect(LESSONS).toHaveLength(18)
    expect(CHALLENGES).toHaveLength(19)
    expect(LESSONS.slice(13, 16).map((l) => l.id)).toEqual(NEW_LESSON_IDS)
    expect(CHALLENGES.slice(15, 18).map((c) => c.id)).toEqual(NEW_CHALLENGE_IDS)
    expect(LESSONS[16]?.id).toBe('variational-vqe')
    expect(LESSONS[17]?.id).toBe('shors-algorithm') // no challenge: its reason is validated on the server
    expect(CHALLENGES[18]?.id).toBe('vqe-find-theta')
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(18)
    expect(new Set(CHALLENGES.map((c) => c.id)).size).toBe(19)
  })

  it('every earlier lesson and challenge is exactly where it was', () => {
    expect(LESSONS.slice(0, 13).map((l) => l.id)).toEqual([
      'qubits-measurement', 'bloch-sphere', 'superposition', 'phase', 'interference', 'entanglement', 'bell-state',
      'phase-kickback', 'deutsch-jozsa', 'bernstein-vazirani', 'superdense-coding', 'quantum-teleportation', 'grovers-search',
    ])
    expect(CHALLENGES.slice(0, 15).map((c) => c.id)).toEqual([
      'create-one', 'create-plus', 'create-minus', 'create-bell', 'phase-change', 'interference', 'phase-kickback', 'deutsch-jozsa-fixed',
      'bernstein-vazirani-fixed', 'bloch-plus-direction', 'entangle-bell-pair', 'superdense-encode-10', 'teleport-ry-fixed', 'grover-find-01',
      'optimize-redundant',
    ])
  })

  it('each new lesson has ten sections in the agreed shape and its prerequisites', () => {
    expect(lesson(QFT).prerequisiteLessonIds).toEqual(['phase', 'interference'])
    expect(lesson(QPE).prerequisiteLessonIds).toEqual([QFT, 'phase-kickback'])
    expect(lesson(QEC).prerequisiteLessonIds).toEqual(['entanglement'])
    for (const id of NEW_LESSON_IDS) {
      expect(lesson(id).sections).toHaveLength(10)
      expect(lesson(id).sections.map((s) => s.type)).toEqual([
        'explanation', 'explanation', 'explanation', 'explanation', 'concept_check', 'interactive_lab', 'concept_check', 'explanation', 'explanation', 'reflection',
      ])
      expect(lesson(id).sections.map((s) => s.id)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i + 1}`))
      expect(lesson(id).linkedCircuit).not.toBeNull()
    }
  })

  it('the linked circuits arrive exactly as the server wrote them, angles to the last digit', () => {
    const qft = lesson(QFT).linkedCircuit!
    expect([qft.num_qubits, qft.num_clbits]).toEqual([3, 3])
    expect(qft.ops.map((o) => o.gate)).toEqual(['x', 'h', 'cp', 'cp', 'h', 'cp', 'h', 'swap', 'measure', 'measure', 'measure'])
    expect(qft.ops.filter((o) => o.gate === 'cp').map((o) => [o.controls, o.targets, o.params[0]])).toEqual([
      [[1], [2], Math.PI / 2], [[0], [2], Math.PI / 4], [[0], [1], Math.PI / 2],
    ])
    expect(qft.ops[7]).toMatchObject({ gate: 'swap', targets: [0, 2] })

    const qpe = lesson(QPE).linkedCircuit!
    expect([qpe.num_qubits, qpe.num_clbits]).toEqual([4, 3])
    expect(qpe.ops.map((o) => o.gate)).toEqual(['x', 'h', 'h', 'h', 'cp', 'cp', 'swap', 'h', 'cp', 'h', 'cp', 'cp', 'h', 'measure', 'measure', 'measure'])
    expect(qpe.ops.filter((o) => o.gate === 'cp').map((o) => o.params[0])).toEqual([Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI / 4, -Math.PI / 2])
    expect(qpe.ops.filter((o) => o.gate === 'cp' && o.targets[0] === 3)).toHaveLength(2) // only two controlled powers: S four times is the identity

    const qec = lesson(QEC).linkedCircuit!
    expect([qec.num_qubits, qec.num_clbits]).toEqual([5, 5])
    expect(qec.ops).toHaveLength(20)
    expect(qec.ops[0]).toMatchObject({ gate: 'ry', targets: [0], params: [1] })
    expect(qec.ops[3]).toMatchObject({ gate: 'x', targets: [1] }) // the fixed injected error
    expect(qec.ops.filter((o) => o.gate === 'ccx')).toHaveLength(3)
    expect(qec.ops.slice(-5).map((o) => o.gate)).toEqual(Array(5).fill('measure'))
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
    const raw = Object.values(RAW)[0]!
    expect(raw).not.toContain('correct_option_id')
    for (const id of NEW_LESSON_IDS) {
      for (const s of lesson(id).sections) if (s.type === 'concept_check') expect(s.options).toHaveLength(4)
    }
  })

  it('the new challenges carry the locked part, its name and the toolbox, and nothing that would give the answer away', () => {
    expect(challenge('qft-2qubit').constraints).toMatchObject({ numQubits: 2, anchor: [], maxOps: 8, minGateCounts: { cp: 1 } })
    expect(challenge('qpe-estimate-t').constraints).toMatchObject({ numQubits: 4, numClbits: 3, anchorName: 'controlled powers of T', mustMeasure: [0, 1, 2] })
    expect(challenge('qpe-estimate-t').constraints.anchor.map((o) => o.params[0])).toEqual([Math.PI / 4, Math.PI / 2, Math.PI])
    expect(challenge('qpe-estimate-t').fixedOracle).toBe(false)
    expect(challenge('qec-correct-flip-q1').constraints).toMatchObject({ numQubits: 5, anchorName: 'injected error' })
    expect(challenge('qec-correct-flip-q1').constraints.anchor).toEqual([{ gate: 'x', targets: [1], controls: [], params: [], clbits: [] }])
    const blob = Object.values(RAW)[0]!
    for (const forbidden of ['reference_solution', 'replace_anchor', '"target"', 'misconception', 'equivalent_to']) expect(blob).not.toContain(forbidden)
    for (const c of CHALLENGES) expect(Object.keys(c)).not.toContain('referenceSolution')
  })

  it('the checks a learner sees are labels only, and name what the server verifies', () => {
    expect(challenge('qft-2qubit').checks).toEqual([{ id: 'equivalent.to_qft', label: 'Does exactly what the 2-qubit QFT does' }])
    expect(challenge('qec-correct-flip-q1').checks.map((c) => c.id)).toEqual([
      'before.encoded', 'after.error', 'final.syndrome', 'final.q1_restored', 'final.restored',
    ])
    expect(challenge('qpe-estimate-t').checks.map((c) => c.id)).toEqual(['before.prepared', 'final.reads_phase', 'final.is_general'])
  })

  it('every lesson but the Shor one has a challenge and every challenge a real lesson', () => {
    const lessonIds = new Set(LESSONS.map((l) => l.id))
    for (const c of CHALLENGES) expect(lessonIds.has(c.lessonId)).toBe(true)
    for (const l of LESSONS) expect(CHALLENGES.some((c) => c.lessonId === l.id)).toBe(l.id !== 'shors-algorithm')
    for (const [lessonId, challengeId] of Object.entries(CHALLENGE_OF)) expect(challenge(challengeId).lessonId).toBe(lessonId)
  })
})

describe('progression over 18 lessons and 19 challenges', () => {
  it('every lesson is open from the start; a new lesson is only RECOMMENDED once every one of its prerequisites is complete', () => {
    const none = new Set<string>()
    for (const l of LESSONS) expect(getLessonState(l, none)).toBe('available')
    for (const id of NEW_LESSON_IDS) expect(getLessonReadiness(lesson(id), none)).toBe('builds_on_unfinished')
    expect(getLessonReadiness(lesson(QFT), new Set(['phase']))).toBe('builds_on_unfinished') // needs interference too
    expect(getLessonReadiness(lesson(QFT), new Set(['interference']))).toBe('builds_on_unfinished')
    expect(getLessonReadiness(lesson(QFT), new Set(['phase', 'interference']))).toBe('ready')
    expect(getLessonReadiness(lesson(QPE), new Set(['phase', 'interference', 'phase-kickback']))).toBe('builds_on_unfinished') // needs the QFT itself
    expect(getLessonReadiness(lesson(QPE), new Set([QFT]))).toBe('builds_on_unfinished') // and phase kickback
    expect(getLessonReadiness(lesson(QPE), new Set([QFT, 'phase-kickback']))).toBe('ready')
    expect(getLessonReadiness(lesson(QEC), new Set(['bell-state']))).toBe('builds_on_unfinished')
    expect(getLessonReadiness(lesson(QEC), new Set(['entanglement']))).toBe('ready')
    expect(getLessonState(lesson(QEC), new Set([QEC]))).toBe('completed')
  })

  it('QEC is not recommended after the QFT or QPE, and QPE is recommended after the QFT', () => {
    const base = new Set(FIRST_THIRTEEN())
    expect(getLessonReadiness(lesson(QEC), base)).toBe('ready')
    expect(getLessonReadiness(lesson(QPE), base)).toBe('builds_on_unfinished')
    expect(getLessonReadiness(lesson(QPE), new Set([...base, QFT]))).toBe('ready')
  })

  it('the recommendation walks the algorithm lessons and challenges in order, and ends when everything is done', () => {
    const started = new Set(FIRST_THIRTEEN())
    const recommend = (lessonIds: string[], solvedIds: string[]) =>
      getRecommendation(LESSONS, CHALLENGES, progressFor(lessonIds), new Set([...started, ...lessonIds]), solved(solvedIds))
    let done = FIRST_THIRTEEN()
    let cleared = FIRST_FIFTEEN_CHALLENGES()
    expect(recommend(done, cleared)).toMatchObject({ kind: 'next_lesson', lessonId: QFT })
    done = [...done, QFT]
    expect(recommend(done, cleared)).toMatchObject({ kind: 'try_challenge', challengeId: 'qft-2qubit', lessonId: QFT })
    cleared = [...cleared, 'qft-2qubit']
    expect(recommend(done, cleared)).toMatchObject({ kind: 'next_lesson', lessonId: QPE })
    done = [...done, QPE]
    expect(recommend(done, cleared)).toMatchObject({ kind: 'try_challenge', challengeId: 'qpe-estimate-t', lessonId: QPE })
    cleared = [...cleared, 'qpe-estimate-t']
    expect(recommend(done, cleared)).toMatchObject({ kind: 'next_lesson', lessonId: QEC })
    done = [...done, QEC]
    expect(recommend(done, cleared)).toMatchObject({ kind: 'try_challenge', challengeId: 'qec-correct-flip-q1', lessonId: QEC })
    cleared = [...cleared, 'qec-correct-flip-q1']
    // the variational lesson (prerequisites: bloch-sphere and superposition) and its challenge come last
    expect(recommend(done, cleared)).toMatchObject({ kind: 'next_lesson', lessonId: 'variational-vqe' })
    done = [...done, 'variational-vqe']
    expect(recommend(done, cleared)).toMatchObject({ kind: 'try_challenge', challengeId: 'vqe-find-theta', lessonId: 'variational-vqe' })
    cleared = [...cleared, 'vqe-find-theta']
    // Shor's order-finding lesson (prerequisite: quantum-phase-estimation) is last and has no challenge, so finishing it ends the path
    expect(recommend(done, cleared)).toMatchObject({ kind: 'next_lesson', lessonId: 'shors-algorithm' })
    done = [...done, 'shors-algorithm']
    expect(recommend(done, cleared).kind).toBe('all_done')
  })

  it('prior completion records are untouched: a learner who finished the first thirteen is simply offered the next lesson', () => {
    const recommendation = getRecommendation(LESSONS, CHALLENGES, progressFor(FIRST_THIRTEEN()), new Set(FIRST_THIRTEEN()), solved(FIRST_FIFTEEN_CHALLENGES()))
    expect(recommendation).toMatchObject({ kind: 'next_lesson', lessonId: QFT })
    const everything = progressFor(FIRST_THIRTEEN())
    for (const l of LESSONS.slice(0, 13)) expect(isLessonComplete(l, everything[l.id])).toBe(true)
  })

  it('the overall tally counts 18 lessons and 36 concept checks', () => {
    const everything = progressFor(LESSONS.map((l) => l.id))
    const tally = getOverallLearningProgress(LESSONS, everything, new Set(LESSONS.map((l) => l.id)))
    expect(tally).toMatchObject({ totalLessons: 18, lessonsCompleted: 18, conceptChecksTotal: 36, conceptChecksCorrect: 36, overallAccuracy: 1 })
  })

  it('Progress shows challenge completion out of nineteen, with the new challenges listed and openable', () => {
    const outcomes: ChallengeOutcomes = { ...emptyOutcomes(), records: solved(['create-one', 'qft-2qubit', 'qec-correct-flip-q1']) }
    const open = vi.fn()
    render(<ChallengeProgress challenges={CHALLENGES} outcomes={outcomes} onOpenChallenge={open} />)
    expect(screen.getByTestId('challenges-solved')).toHaveTextContent('3 of 19 solved')
    for (const id of NEW_CHALLENGE_IDS) fireEvent.click(screen.getByRole('button', { name: new RegExp(challenge(id).title.replace(/[()]/g, '.')) }))
    expect(open.mock.calls.map((c) => c[0])).toEqual(NEW_CHALLENGE_IDS)
    cleanup()
  })
})

describe('Learn -> lesson -> Lab, and Learn -> Challenge, with the real new lessons', () => {
  const INITIAL_LEARN = useLearnStore.getState()
  const INITIAL_BUILD = useBuildStore.getState()
  const INITIAL_CHALLENGES = useChallengeStore.getState()
  let underTest = QFT

  beforeEach(() => {
    // Every lesson before the one under test is seeded as finished and its saved verdicts are confirmed by the stand-in server; the
    // checks of the lesson under test are graded from the test-side keys, exactly as the real server grades from its own.
    const server = fakeGradingServer({ keys: KEYS })
    grading.current = {
      gradeConceptCheck: server.gradeConceptCheck,
      regradeConceptChecks: vi.fn(async (answers: { lessonId: string; checkId: string; selectedOptionId: string }[]) => {
        const known = answers.filter((a) => a.lessonId === underTest && `${a.lessonId}/${a.checkId}` in KEYS)
        const graded = new Map((await server.regradeConceptChecks(known)).map((r) => [`${r.lessonId}/${r.checkId}`, r]))
        return answers.map((a) => graded.get(`${a.lessonId}/${a.checkId}`) ?? { ...a, status: 'GRADED' as const, correct: true, explanation: 'Confirmed.' })
      }),
    }
    useChallengeStore.setState({ ...INITIAL_CHALLENGES, challenges: CHALLENGES }, true)
    useBuildStore.setState(INITIAL_BUILD, true)
  })
  afterEach(() => {
    cleanup()
    useLearnStore.setState(INITIAL_LEARN, true)
    useChallengeStore.setState(INITIAL_CHALLENGES, true)
    useBuildStore.setState(INITIAL_BUILD, true)
  })

  const seedBefore = (id: string) => {
    underTest = id
    const earlier = LESSONS.slice(0, LESSONS.findIndex((l) => l.id === id)).map((l) => l.id)
    useLearnStore.setState({ ...INITIAL_LEARN, lessonProgress: progressFor(earlier), startedLessonIds: new Set(earlier) }, true)
  }

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
    it(`${id}: shows its real sections, reaches the lab step, and hands the Lab the server's own circuit`, async () => {
      seedBefore(id)
      const onOpenLab = vi.fn()
      render(<LearnScreen onOpenLab={onOpenLab} onOpenChallenge={vi.fn()} />)
      const lab = await walkToLab(id)
      await screen.findByText(lab.type === 'interactive_lab' ? lab.instructions : '')
      fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))
      expect(onOpenLab).toHaveBeenCalledTimes(1)
      expect(onOpenLab).toHaveBeenCalledWith(lesson(id).linkedCircuit) // exactly what the server sent: nothing computed or edited here
      expect(useBuildStore.getState().result).toBeNull() // opening the Lab fabricates no result
    })

    it(`${id}: a wrong answer gets the server's "not quite" and a right one its explanation, with no key in the page before it`, async () => {
      seedBefore(id)
      render(<LearnScreen onOpenLab={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(id).title}`) }))
      for (const section of lesson(id).sections.slice(0, 5)) {
        await screen.findByText(section.type === 'explanation' ? section.body : section.type === 'concept_check' ? section.question! : section.type === 'interactive_lab' ? section.instructions : section.prompt)
        if (section.type !== 'concept_check') {
          fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
          continue
        }
        const key = KEYS[`${id}/${section.id}`]!
        const wrong = section.options!.find((o) => o.id !== key)!
        fireEvent.click(screen.getByLabelText(wrong.text))
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
        await screen.findByText(/Not quite\./)
        expect(screen.getByTestId('quiz-explanation')).toHaveTextContent(`Explanation for ${id}/${section.id}.`) // the (stand-in) server's, not the page's own
      }
    })

    it(`${id}: offers its challenge from the lesson and opens it by id`, async () => {
      seedBefore(id)
      const onOpenChallenge = vi.fn()
      render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={onOpenChallenge} />)
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(id).title}`) }))
      const practice = await screen.findByTestId('lesson-challenges')
      const title = challenge(CHALLENGE_OF[id]!).title
      expect(within(practice).getAllByRole('button').map((b) => b.textContent)).toEqual([title])
      fireEvent.click(within(practice).getByRole('button', { name: title }))
      expect(onOpenChallenge).toHaveBeenCalledWith(CHALLENGE_OF[id])
    })
  }

  it('the new lessons are open at once, and say what they build on while their prerequisites are unfinished', async () => {
    underTest = QFT
    useLearnStore.setState({ lessonProgress: {}, startedLessonIds: new Set() })
    render(<LearnScreen onOpenLab={vi.fn()} />)
    for (const id of NEW_LESSON_IDS) {
      const card = await screen.findByRole('button', { name: new RegExp(`^${lesson(id).title}`) })
      expect(card).toBeEnabled()
      expect(card).not.toHaveTextContent(/Locked/i)
      expect(card).toHaveTextContent(/Builds on:/)
    }
  })

  it('every one of the 18 lessons opens straight from the list, with no progress at all', async () => {
    useLearnStore.setState({ lessonProgress: {}, startedLessonIds: new Set() })
    render(<LearnScreen onOpenLab={vi.fn()} />)
    for (const l of LESSONS) {
      // The card's accessible name is the title, optionally followed by " — completed / suggested next / builds on …".
      const card = await screen.findByRole('button', { name: new RegExp(`^${l.title}( —|$)`) })
      expect(card).toBeEnabled()
      fireEvent.click(card)
      expect(await screen.findByRole('heading', { level: 2, name: l.title })).toBeInTheDocument()
    }
    expect(LESSONS).toHaveLength(18)
  })

  it('the honesty statements are on screen, word for word', async () => {
    const check = async (id: string, sectionIndex: number, expected: RegExp[]) => {
      cleanup()
      seedBefore(id)
      render(<LearnScreen onOpenLab={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(id).title}`) }))
      for (let i = 0; i < sectionIndex; i += 1) {
        const section = lesson(id).sections[i]!
        await screen.findByText(section.type === 'explanation' ? section.body : section.type === 'concept_check' ? section.question! : section.type === 'interactive_lab' ? section.instructions : section.prompt)
        if (section.type === 'concept_check') {
          const right = section.options!.find((o) => o.id === KEYS[`${id}/${section.id}`])!
          fireEvent.click(screen.getByLabelText(right.text))
          fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
          await screen.findByText(/Correct\./)
        }
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      }
      const target = lesson(id).sections[sectionIndex]!
      const node = await screen.findByText(target.type === 'explanation' ? target.body : '')
      for (const pattern of expected) expect(node.textContent).toMatch(pattern)
    }
    await check(QFT, 0, [/ONE fixed 3-qubit example/, /small educational example/, /does not claim that the QFT is fast/])
    await check(QPE, 0, [/ONE exact fixed example, not the general algorithm/])
    await check(QEC, 0, [/ONE fixed 5-qubit example/, /NOT a realistic noise model/])
    await check(QEC, 2, [/does not model physical noise/, /shows no error rate/])
  })
})

describe('the challenge briefs for the new challenges', () => {
  const brief = (c: Challenge) => render(<ChallengeBrief challenge={c} hintsRevealed={0} onRevealNextHint={vi.fn()} lessonTitle="Lesson" onOpenLesson={vi.fn()} />)
  afterEach(() => cleanup())

  it('QPE names its fixed controlled powers of T and lists their gates', () => {
    brief(challenge('qpe-estimate-t'))
    expect(screen.getByText(/The fixed controlled powers of T — place these gates exactly/)).toBeInTheDocument()
    expect(screen.queryByText(/fixed oracle/i)).not.toBeInTheDocument() // the controlled powers are not an oracle
  })

  it('QEC names its injected error as given and fixed', () => {
    brief(challenge('qec-correct-flip-q1'))
    expect(screen.getByText(/The fixed injected error — place these gates exactly/)).toBeInTheDocument()
    expect(screen.getByText('X on q1')).toBeInTheDocument()
    expect(screen.getByText(/NOT a noise model/)).toBeInTheDocument()
  })

  it('QFT shows no fixed block: the learner builds all of it', () => {
    brief(challenge('qft-2qubit'))
    expect(screen.queryByText(/The fixed/)).not.toBeInTheDocument()
  })
})

describe('the browser computes no quantum quantity for any of this', () => {
  it('the angle reader and the lesson and challenge components do no state, amplitude or phase arithmetic of their own', () => {
    const sources = import.meta.glob(['../../circuit/angle.ts', '../challenges/ChallengeBrief.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(sources)).toHaveLength(2)
    for (const [path, text] of Object.entries(sources)) {
      for (const banned of [/Math\.(sin|cos|atan2|sqrt|hypot)/, /\bstatevector\b/i, /\bamplitudes?\b/i, /\bfidelity\s*[=(]/i]) expect(text, `${path} ${banned}`).not.toMatch(banned)
    }
  })
})
