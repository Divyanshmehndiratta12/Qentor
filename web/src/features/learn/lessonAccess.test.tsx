/**
 * Lesson access: every lesson in the REAL catalog (`fixtures/catalog/public_catalog.json`, through the real client) opens
 * directly, with no prerequisite locking — while the prerequisite metadata stays in the catalog and keeps steering the
 * recommendation, and nothing a learner has done (completion, mastery, concept checks, saved progress) changes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Lesson } from '@/api'
import { RealApiClient } from '@/api/realClient'

const catalogs = vi.hoisted(() => ({ lessons: [] as unknown[] }))

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      listLessons: async () => catalogs.lessons,
      listChallenges: async () => [],
      regradeConceptChecks: async () => [],
    }),
  }
})

import { LearnScreen } from './LearnScreen'
import { getNextChallenge } from './learnerInsights'
import {
  getConceptCheckScore,
  getLessonMastery,
  getLessonReadiness,
  getLessonState,
  isLessonComplete,
  type LessonProgress,
} from './lessonState'
import { PROGRESS_STORAGE_KEY, localStorageProgressStore, parseProgress, serializeProgress } from './progressStorage'
import { useLearnStore } from './store'

const RAW = import.meta.glob('../../../../fixtures/catalog/public_catalog.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const WIRE = JSON.parse(Object.values(RAW)[0]!) as { lessons: { lessons: Array<{ id: string; prerequisite_lesson_ids: string[]; sections: Array<{ id: string }> }> } }
const FIXTURE = { body: WIRE.lessons, lessons: WIRE.lessons.lessons }

let LESSONS: Lesson[] = []
const lesson = (id: string) => LESSONS.find((l) => l.id === id)!

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(FIXTURE.body), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  )
  LESSONS = await new RealApiClient().listLessons()
  catalogs.lessons = LESSONS
})
afterAll(() => vi.unstubAllGlobals())

const INITIAL = useLearnStore.getState()
beforeEach(() => {
  localStorage.clear()
  useLearnStore.setState({ ...INITIAL, lessonProgress: {}, startedLessonIds: new Set() }, true)
})
afterEach(() => {
  cleanup()
  useLearnStore.setState(INITIAL, true)
})

function finished(l: Lesson, correct = true): LessonProgress {
  const attempts: LessonProgress['conceptCheckAttempts'] = {}
  for (const s of l.sections) {
    if (s.type === 'concept_check' && s.question !== null) {
      attempts[s.id] = { selectedOptionId: s.options![0]!.id, isCorrect: correct, attemptCount: 1 }
    }
  }
  return { activeSectionIndex: l.sections.length - 1, completedSectionIds: new Set(l.sections.map((s) => s.id)), conceptCheckAttempts: attempts }
}

describe('direct access', () => {
  it('every lesson is available with no progress at all, and none is ever locked', () => {
    expect(LESSONS).toHaveLength(19)
    for (const l of LESSONS) expect(getLessonState(l, new Set())).toBe('available')
    // not even with a lesson that builds on an id the catalog does not contain
    expect(getLessonState({ ...LESSONS[1]!, prerequisiteLessonIds: ['no-such-lesson'] }, new Set())).toBe('available')
  })

  it('every lesson opens from the list in the Learn screen and shows its own content', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} />)
    for (const l of LESSONS) {
      const card = await screen.findByRole('button', { name: new RegExp(`^${l.title}( —|$)`) })
      expect(card).toBeEnabled()
      expect(card).not.toHaveTextContent(/lock/i)
      fireEvent.click(card)
      expect(await screen.findByRole('heading', { level: 2, name: l.title })).toBeInTheDocument()
      expect(useLearnStore.getState().selectedLessonId).toBe(l.id)
    }
  })

  it('shows no lock wording anywhere in the lesson list', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} />)
    await screen.findByRole('button', { name: /^Qubits/ })
    expect(screen.queryByText(/locked/i)).not.toBeInTheDocument()
    expect(screen.queryByTitle(/first$/)).not.toBeInTheDocument()
  })
})

describe('prerequisite metadata is preserved', () => {
  it('the client keeps exactly the prerequisites the server sent, for every lesson', () => {
    for (const raw of FIXTURE.lessons) expect(lesson(raw.id).prerequisiteLessonIds).toEqual(raw.prerequisite_lesson_ids)
    expect(LESSONS.some((l) => l.prerequisiteLessonIds.length > 0)).toBe(true)
    expect(lesson('quantum-phase-estimation').prerequisiteLessonIds).toContain('quantum-fourier-transform')
  })

  it('opening a lesson and working through it out of order does not rewrite any lesson’s prerequisites', async () => {
    await useLearnStore.getState().fetchLessons()
    const prerequisites = () => JSON.stringify(useLearnStore.getState().lessons.map((l) => [l.id, l.prerequisiteLessonIds]))
    const before = prerequisites()
    expect(useLearnStore.getState().lessons).toHaveLength(19)

    useLearnStore.getState().selectLesson('shors-algorithm')
    useLearnStore.getState().completeSection('shors-algorithm', lesson('shors-algorithm').sections[0]!.id)

    expect(prerequisites()).toBe(before)
    expect(useLearnStore.getState().lessons.find((l) => l.id === 'shors-algorithm')!.prerequisiteLessonIds).toEqual(['quantum-phase-estimation'])
  })

  it('the lesson page says what the lesson builds on, and that it is still open', async () => {
    render(<LearnScreen onOpenLab={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Shor/ }))
    expect(await screen.findByText(/recommended first, but you can start here any time/)).toBeInTheDocument()
  })
})

describe('recommendations still use prerequisites', () => {
  it('the next lesson is the first one whose prerequisites are all complete, not just the first one that can be opened', () => {
    // Everything is openable, but with only the first lesson done the recommendation must still follow the prerequisite graph.
    const first = LESSONS[0]!
    const progress = { [first.id]: finished(first) }
    const done = new Set([first.id])
    const expected = LESSONS.find((l) => !done.has(l.id) && l.prerequisiteLessonIds.every((id) => done.has(id)))!
    const next = getNextChallenge(LESSONS, progress, new Set())
    expect(next).toMatchObject({ challengeType: 'next_lesson', lessonId: expected.id })
    // a lesson that builds on something unfinished is never the recommendation just because it is open
    expect(getLessonReadiness(lesson('shors-algorithm'), done)).toBe('builds_on_unfinished')
    expect(next.lessonId).not.toBe('shors-algorithm')
  })

  it('the recommendation moves past a lesson once it is complete, and the suggested card follows it', async () => {
    const first = LESSONS[0]!
    useLearnStore.setState({ lessonProgress: { [first.id]: finished(first) }, startedLessonIds: new Set([first.id]) })
    render(<LearnScreen onOpenLab={vi.fn()} />)
    const done = new Set([first.id])
    const expected = LESSONS.find((l) => !done.has(l.id) && l.prerequisiteLessonIds.every((id) => done.has(id)))!
    const card = await screen.findByRole('button', { name: new RegExp(`^${expected.title}( —|$)`) })
    expect(card).toHaveAccessibleName(/suggested next/)
    expect(screen.getAllByText('Suggested next')).toHaveLength(1)
  })
})

describe('progress, mastery and concept checks are unaffected by access', () => {
  it('opening an out-of-order lesson changes no completion or mastery of any other lesson', () => {
    const a = LESSONS[0]!
    const progress = { [a.id]: finished(a) }
    useLearnStore.setState({ lessonProgress: progress, startedLessonIds: new Set([a.id]) })
    const snapshot = () =>
      LESSONS.map((l) => {
        const p = useLearnStore.getState().lessonProgress[l.id]
        const started = useLearnStore.getState().startedLessonIds.has(l.id)
        return [l.id, isLessonComplete(l, p), getLessonMastery(l, p, started), getConceptCheckScore(l, p)] as const
      })
    const before = snapshot()

    useLearnStore.getState().selectLesson('shors-algorithm')

    const after = snapshot()
    for (let i = 0; i < before.length; i += 1) {
      if (before[i]![0] === 'shors-algorithm') continue
      expect(after[i]).toEqual(before[i])
    }
    expect(useLearnStore.getState().lessonProgress[a.id]).toBe(progress[a.id])
    expect(isLessonComplete(lesson('shors-algorithm'), useLearnStore.getState().lessonProgress['shors-algorithm'])).toBe(false)
  })

  it('a lesson finished out of order is complete and graded exactly like any other', () => {
    const l = lesson('shors-algorithm')
    expect(getConceptCheckScore(l, finished(l)).total).toBeGreaterThan(0) // so the wrong-answer case below is a real test
    expect(getLessonMastery(l, finished(l), true)).toBe('mastered')
    expect(getLessonMastery(l, finished(l, false), true)).toBe('developing') // complete, but every check wrong
    expect(getLessonMastery(l, undefined, false)).toBe('not_started')
  })
})

describe('old saved progress still loads', () => {
  // A blob exactly as the previous build wrote it (schema v1): nothing in it mentions locking.
  const OLD = JSON.stringify({
    version: 1,
    startedLessonIds: ['qubits-measurement', 'bloch-sphere'],
    lessons: {
      'qubits-measurement': {
        activeSectionIndex: 1,
        completedSectionIds: [lessonSectionsOf('qubits-measurement')[0]],
        conceptCheckAttempts: {},
      },
    },
  })

  function lessonSectionsOf(id: string): string[] {
    return FIXTURE.lessons.find((l) => l.id === id)!.sections.map((s) => s.id)
  }

  it('parses unchanged and keeps the same version, with no lock-related field required or added', () => {
    const parsed = parseProgress(OLD)!
    expect(parsed.startedLessonIds).toEqual(new Set(['qubits-measurement', 'bloch-sphere']))
    expect([...parsed.lessonProgress['qubits-measurement']!.completedSectionIds]).toEqual([lessonSectionsOf('qubits-measurement')[0]])
    expect(JSON.parse(serializeProgress(parsed)).version).toBe(1)
    expect(serializeProgress(parsed)).not.toMatch(/lock/i)
  })

  it('loads through the store from localStorage and every lesson, including the not-yet-started ones, still opens', async () => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, OLD)
    const loaded = localStorageProgressStore().load()
    expect(loaded.status).toBe('loaded')
    useLearnStore.setState({ lessonProgress: loaded.progress.lessonProgress, startedLessonIds: loaded.progress.startedLessonIds })
    render(<LearnScreen onOpenLab={vi.fn()} />)
    for (const l of LESSONS) expect(await screen.findByRole('button', { name: new RegExp(`^${l.title}( —|$)`) })).toBeEnabled()
    expect(useLearnStore.getState().startedLessonIds.has('bloch-sphere')).toBe(true)
  })
})
