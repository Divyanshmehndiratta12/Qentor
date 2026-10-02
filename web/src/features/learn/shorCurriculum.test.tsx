/**
 * Final sprint, lesson 18 (Shor's algorithm, order-finding intuition: ONE fixed educational instance) from the browser's side, against the
 * REAL catalog's wire format (`fixtures/catalog/public_catalog.json`, which a backend test keeps in step with what the API serves). The physics
 * and the arithmetic the text states are tested in the backend suite; here the existing components must render the new content, hand the Lab
 * the server's circuit, offer no challenge (the lesson has none), and compute nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
import { useBuildStore } from '@/features/build/store'
import { useChallengeStore } from '@/features/challenges/store'
import { LearnScreen } from './LearnScreen'
import { getLessonState } from './lessonState'
import { useLearnStore } from './store'

const RAW = import.meta.glob('../../../../fixtures/catalog/public_catalog.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const FIXTURE = JSON.parse(Object.values(RAW)[0]!) as { lessons: unknown; challenges: unknown }

let LESSONS: Lesson[] = []
let CHALLENGES: Challenge[] = []
const lesson = (id: string) => LESSONS.find((l) => l.id === id)!

const ID = 'shors-algorithm'
// The server's answer keys for the two checks: a test double only, because the real catalog carries none.
const KEYS: Record<string, string> = { [`${ID}/s5`]: 'b', [`${ID}/s7`]: 'b' }

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

describe('lesson 18 as the real client reads it', () => {
  it('is the eighteenth lesson, after phase estimation as its prerequisite, with ten sections in the agreed shape and an execute lab', () => {
    const l = lesson(ID)
    expect(LESSONS.map((x) => x.id).indexOf(ID)).toBe(17)
    expect(l.title).toBe("Shor's Algorithm — Order Finding Intuition")
    expect(l.prerequisiteLessonIds).toEqual(['quantum-phase-estimation'])
    expect(l.sections.map((s) => s.type)).toEqual(['explanation', 'explanation', 'explanation', 'explanation', 'concept_check', 'interactive_lab', 'concept_check', 'explanation', 'explanation', 'reflection'])
    expect(l.sections.find((s) => s.type === 'interactive_lab')).toMatchObject({ capability: 'execute' })
  })

  it('hands the Lab one fixed 7-qubit circuit exactly as the server sent it: 29 operations, three measured counting qubits', () => {
    const circuit = lesson(ID).linkedCircuit!
    expect(circuit).toMatchObject({ num_qubits: 7, num_clbits: 3 })
    expect(circuit.ops).toHaveLength(29)
    expect(circuit.ops.filter((o) => o.gate === 'measure').map((o) => o.targets)).toEqual([[0], [1], [2]])
  })

  it('says in its description that it is a fixed instance and not a factoring implementation', () => {
    expect(lesson(ID).shortDescription).toMatch(/fixed/)
    expect(lesson(ID).shortDescription).toMatch(/not a factoring implementation/)
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

  it('has no challenge, and the catalog does not carry the server-side reason', () => {
    expect(CHALLENGES.some((c) => c.lessonId === ID)).toBe(false)
    expect(JSON.stringify(lesson(ID))).not.toMatch(/no_challenge_reason|noChallengeReason/)
  })

  it('is locked until quantum-phase-estimation is complete', () => {
    expect(getLessonState(lesson(ID), new Set())).toBe('locked')
    expect(getLessonState(lesson(ID), new Set(['quantum-phase-estimation']))).toBe('available')
    expect(getLessonState(lesson(ID), new Set([ID]))).toBe('completed')
  })
})

describe('Learn -> lesson 18 -> the Lab', () => {
  const INITIAL_LEARN = useLearnStore.getState()
  const INITIAL_BUILD = useBuildStore.getState()
  const INITIAL_CHALLENGES = useChallengeStore.getState()

  beforeEach(() => {
    const server = fakeGradingServer({ keys: KEYS })
    grading.current = {
      gradeConceptCheck: server.gradeConceptCheck,
      regradeConceptChecks: vi.fn(async (answers: { lessonId: string; checkId: string; selectedOptionId: string }[]) => {
        const known = answers.filter((a) => a.lessonId === ID && `${a.lessonId}/${a.checkId}` in KEYS)
        const graded = new Map((await server.regradeConceptChecks(known)).map((r) => [`${r.lessonId}/${r.checkId}`, r]))
        return answers.map((a) => graded.get(`${a.lessonId}/${a.checkId}`) ?? { ...a, status: 'GRADED' as const, correct: true, explanation: 'Confirmed.' })
      }),
    }
    useChallengeStore.setState({ ...INITIAL_CHALLENGES, challenges: CHALLENGES }, true)
    useBuildStore.setState(INITIAL_BUILD, true)
    const earlier = LESSONS.slice(0, 17).map((l) => l.id)
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

  it('the lab step shows the instructions and the existing execute capability line, and no number before anything has run', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={vi.fn()} />)
    const lab = await walkToLab()
    await screen.findByText(lab.instructions)
    expect(screen.getByText(/uses the existing execute capability/)).toBeInTheDocument()
    expect(screen.queryByTestId('variational-lab')).toBeNull()
    expect(useBuildStore.getState().result).toBeNull()
  })

  it('"Open in Lab" hands the Lab exactly the server’s circuit and fabricates no result', async () => {
    const onOpenLab = vi.fn()
    render(<LearnScreen onOpenLab={onOpenLab} onOpenChallenge={vi.fn()} />)
    await walkToLab()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))
    expect(onOpenLab).toHaveBeenCalledWith(lesson(ID).linkedCircuit)
    expect(useBuildStore.getState().result).toBeNull()
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

  it('offers no challenge from the lesson: the practice block is absent', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} onOpenChallenge={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${lesson(ID).title}`) }))
    await screen.findByText(lesson(ID).sections[0]!.type === 'explanation' ? (lesson(ID).sections[0] as { body: string }).body : '')
    expect(screen.queryByTestId('lesson-challenges')).toBeNull()
  })
})
