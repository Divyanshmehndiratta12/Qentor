/**
 * Learner progress across a reload, end to end through the REAL store and jsdom's REAL localStorage. A "reload" is a fresh
 * module graph (`vi.resetModules()` + dynamic import): module state is gone, localStorage is not — exactly what a page reload
 * does. Everything the learner sees (completion, unlocks, mastery, misconception signals) must come back identical because it is
 * re-derived from the saved facts by the same functions; and stored data is treated as untrusted (stale, malformed, missing).
 *
 * Quiz verdicts are the SERVER's: the catalog carries no answer key, so the API client is replaced by `fakeGradingServer` (a test
 * double that holds the key). A reload saves only the selection and the last verdict, then asks the server to grade the saved
 * selections again; every verdict the learner sees after a reload is that answer, not the saved one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { BackendUnavailableError, type Lesson, type LessonSection, type RegradedAnswer } from '@/api'
import { fakeGradingServer } from '@/test/gradingServer'
import { getLessonMastery, getLessonReadiness, getLessonState, isLessonComplete } from './lessonState'
import { getMisconceptions, getOverallLearningProgress } from './learnerInsights'
import { PROGRESS_STORAGE_KEY, PROGRESS_UNREADABLE_KEY, type ProgressStore } from './progressStorage'
import { ACTIVITY_STORAGE_KEY } from './streakStorage'

const client = vi.hoisted(() => ({
  listLessons: vi.fn(),
  gradeConceptCheck: vi.fn(),
  regradeConceptChecks: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

/** The "server": which option is right for each check of the catalog below. */
const KEYS = { 'l1/q1': 'a', 'l1/q2': 'b', 'l2/q1': 'a' }
let server = fakeGradingServer({ keys: KEYS })
function useServer(next = fakeGradingServer({ keys: KEYS })) {
  server = next
  client.gradeConceptCheck.mockImplementation(server.gradeConceptCheck)
  client.regradeConceptChecks.mockImplementation(server.regradeConceptChecks)
}

const check = (id: string, concept = 'superposition'): LessonSection => ({
  type: 'concept_check',
  id,
  title: 'Check',
  prompt: 'q',
  question: 'q?',
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ],
  concept,
})
const intro: LessonSection = { type: 'explanation', id: 'intro', title: 'Intro', body: 'b' }

const lesson = (id: string, sections: LessonSection[], prerequisiteLessonIds: string[] = []): Lesson => ({
  id,
  title: `Lesson ${id}`,
  shortDescription: 'd',
  concept: 'phase',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections,
  linkedCircuit: null,
  prerequisiteLessonIds,
})

const CATALOG: Lesson[] = [
  lesson('l1', [intro, check('q1'), check('q2')]),
  lesson('l2', [intro, check('q1')], ['l1']),
  lesson('l3', [intro]),
]

type StoreModule = typeof import('./store')

/** Wait until the saved answers have been sent to the server and its answer applied (or it could not be reached). */
async function settled(s: StoreModule['useLearnStore']): Promise<void> {
  if (s.getState().lessons.length === 0) return // nothing to attach verdicts to: the re-check does not start
  await vi.waitFor(() => expect(['done', 'unverified']).toContain(s.getState().regradeStatus))
}

/** A page reload: fresh modules, same localStorage. Then the catalog loads, as it does on every visit, and the server is asked again. */
async function reload(catalog: Lesson[] = CATALOG): Promise<StoreModule['useLearnStore']> {
  vi.resetModules()
  client.listLessons.mockResolvedValue(catalog)
  const { useLearnStore } = await import('./store')
  await useLearnStore.getState().fetchLessons()
  await settled(useLearnStore)
  return useLearnStore
}

const snapshot = (s: StoreModule['useLearnStore']) => {
  const { lessons, lessonProgress, startedLessonIds } = s.getState()
  const completed = new Set(lessons.filter((l) => isLessonComplete(l, lessonProgress[l.id])).map((l) => l.id))
  return {
    completed: [...completed].sort(),
    states: lessons.map((l) => [l.id, getLessonState(l, completed)]),
    mastery: lessons.map((l) => [l.id, getLessonMastery(l, lessonProgress[l.id], startedLessonIds.has(l.id))]),
    misconceptions: getMisconceptions(lessons, lessonProgress, startedLessonIds),
    overall: getOverallLearningProgress(lessons, lessonProgress, startedLessonIds),
  }
}

beforeEach(() => {
  localStorage.clear()
  useServer()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  client.listLessons.mockReset()
  client.gradeConceptCheck.mockReset()
  client.regradeConceptChecks.mockReset()
})

describe('progress survives a reload', () => {
  async function learnSomething() {
    const s = await reload()
    const a = s.getState()
    a.selectLesson('l1')
    a.completeSection('l1', 'intro')
    await a.submitConceptCheckAnswer('l1', 'q1', 'a') // the server says: right
    a.completeSection('l1', 'q1')
    await a.submitConceptCheckAnswer('l1', 'q2', 'a') // the server says: wrong
    await a.submitConceptCheckAnswer('l1', 'q2', 'a') // wrong again → a "high" signal
    a.completeSection('l1', 'q2') // lesson 1 complete
    a.selectLesson('l2')
    a.setActiveSectionIndex('l2', 1)
    return s
  }

  it('lesson completion and the recommendation it causes come back', async () => {
    const before = snapshot(await learnSomething())
    expect(before.completed).toEqual(['l1'])
    expect(before.states).toContainEqual(['l2', 'available'])

    const after = snapshot(await reload())
    expect(after.completed).toEqual(['l1'])
    expect(after.states).toEqual(before.states)
  })

  it('a lesson that was NOT finished is not finished after a reload', async () => {
    const s = await reload()
    s.getState().selectLesson('l1')
    s.getState().completeSection('l1', 'intro')
    const after = await reload()
    expect(snapshot(after).completed).toEqual([])
    expect(after.getState().lessonProgress.l1!.completedSectionIds.has('intro')).toBe(true)
    expect(getLessonState(CATALOG[1]!, new Set())).toBe('available') // never locked, finished or not
    expect(getLessonReadiness(CATALOG[1]!, new Set())).toBe('builds_on_unfinished') // but l2 still builds on l1
  })

  it('quiz attempts come back: the choice, the attempt count and the verdict', async () => {
    await learnSomething()
    const after = await reload()
    const attempts = after.getState().lessonProgress.l1!.conceptCheckAttempts
    expect(attempts.q1).toMatchObject({ selectedOptionId: 'a', isCorrect: true, attemptCount: 1 })
    expect(attempts.q2).toMatchObject({ selectedOptionId: 'a', isCorrect: false, attemptCount: 2 })
  })

  it('what is saved is the selection, the verdict and the count — never the explanation, which comes back from the server', async () => {
    await learnSomething()
    const saved = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!)
    expect(saved.lessons.l1.conceptCheckAttempts.q2).toEqual({ selectedOptionId: 'a', isCorrect: false, attemptCount: 2 })
    expect(localStorage.getItem(PROGRESS_STORAGE_KEY)).not.toContain('Explanation for')
    const after = await reload()
    expect(after.getState().lessonProgress.l1!.conceptCheckAttempts.q2!.explanation).toBe('Explanation for l1/q2.') // fetched again
  })

  it('after a reload the server is sent exactly the saved selections — ids and choices, no verdicts', async () => {
    await learnSomething()
    await reload()
    const sent = client.regradeConceptChecks.mock.calls.at(-1)![0] as Array<Record<string, unknown>>
    expect(sent.map((a) => a.lessonId + '/' + a.checkId + '=' + a.selectedOptionId).sort()).toEqual(['l1/q1=a', 'l1/q2=a'])
    for (const answer of sent) expect(Object.keys(answer).sort()).toEqual(['checkId', 'lessonId', 'selectedOptionId'])
  })

  it('mastery is reconstructed exactly', async () => {
    const before = snapshot(await learnSomething())
    const after = snapshot(await reload())
    expect(after.mastery).toEqual(before.mastery)
    expect(after.mastery).toContainEqual(['l1', 'developing']) // 1 of 2 correct: complete but under 80%
    expect(after.mastery).toContainEqual(['l3', 'not_started'])
    expect(after.overall).toEqual(before.overall)
  })

  it('misconception signals are reconstructed exactly', async () => {
    const before = snapshot(await learnSomething())
    expect(before.misconceptions.length).toBeGreaterThan(0)
    expect(before.misconceptions.some((m) => m.severity === 'high' && m.sectionId === 'q2')).toBe(true)
    const after = snapshot(await reload())
    expect(after.misconceptions).toEqual(before.misconceptions)
  })

  it('the lesson being read resumes at the same step', async () => {
    await learnSomething()
    const after = await reload()
    expect(after.getState().lessonProgress.l2!.activeSectionIndex).toBe(1)
    expect(after.getState().startedLessonIds.has('l2')).toBe(true)
  })

  it('opening Learn on unchanged saved data does not rewrite storage', async () => {
    await learnSomething()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    await reload()
    expect(setItem.mock.calls.filter(([key]) => key === PROGRESS_STORAGE_KEY)).toEqual([])
  })

  it('stores no identity, no derived judgements, and makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await learnSomething()
    const stored = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!)
    expect(Object.keys(stored).sort()).toEqual(['lessons', 'startedLessonIds', 'version'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the streak keeps its own key and still works alongside', async () => {
    await learnSomething()
    expect(JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY)!).version).toBe(1)
    const after = await reload()
    expect(after.getState().activityHistory.activityDates.length).toBe(1)
  })
})

describe('stored data is untrusted: stale and invalid', () => {
  async function savedProgress() {
    const s = await reload()
    s.getState().selectLesson('l1')
    s.getState().completeSection('l1', 'intro')
    await s.getState().submitConceptCheckAnswer('l1', 'q1', 'a') // right
    s.getState().completeSection('l1', 'q1')
    await s.getState().submitConceptCheckAnswer('l1', 'q2', 'b') // right
    s.getState().completeSection('l1', 'q2')
    expect(isLessonComplete(CATALOG[0]!, s.getState().lessonProgress.l1)).toBe(true)
  }

  it('a lesson whose answer key changed on the server gets the saved choice graded again (no stale verdict) and rewrites storage', async () => {
    await savedProgress()
    useServer(fakeGradingServer({ keys: { ...KEYS, 'l1/q2': 'a' } })) // q2's key is now 'a'; the saved choice was 'b'
    const s = await reload()
    expect(s.getState().lessonProgress.l1!.conceptCheckAttempts.q2).toMatchObject({ selectedOptionId: 'b', isCorrect: false, attemptCount: 1 })
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!).lessons.l1.conceptCheckAttempts.q2.isCorrect).toBe(false)
  })

  it('a verdict someone edited in localStorage is replaced by the server’s after the reload', async () => {
    await savedProgress()
    const saved = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!)
    saved.lessons.l1.conceptCheckAttempts.q2 = { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } // 'a' is WRONG for q2
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(saved))
    const s = await reload()
    expect(s.getState().lessonProgress.l1!.conceptCheckAttempts.q2).toMatchObject({ selectedOptionId: 'a', isCorrect: false })
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!).lessons.l1.conceptCheckAttempts.q2.isCorrect).toBe(false)
  })

  it('mastery after a reload comes from the server’s verdicts, not from edited saved ones', async () => {
    await savedProgress() // both right: mastered
    const saved = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!)
    const honest = snapshot(await reload()).mastery
    expect(honest).toContainEqual(['l1', 'mastered'])
    saved.lessons.l1.conceptCheckAttempts.q1 = { selectedOptionId: 'b', isCorrect: true, attemptCount: 1 } // really wrong
    saved.lessons.l1.conceptCheckAttempts.q2 = { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } // really wrong
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(saved))
    const after = snapshot(await reload()).mastery
    expect(after).toContainEqual(['l1', 'developing']) // 0 of 2 correct, whatever the saved file claimed
  })

  it('when the server cannot be reached on reload the saved verdicts stay, and the learner is told they were not re-checked', async () => {
    await savedProgress()
    client.regradeConceptChecks.mockRejectedValue(new BackendUnavailableError('could not reach the Qentor backend: down'))
    const s = await reload()
    expect(s.getState().regradeStatus).toBe('unverified')
    expect(s.getState().lessonProgress.l1!.conceptCheckAttempts.q2).toMatchObject({ selectedOptionId: 'b', isCorrect: true })
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!).lessons.l1.conceptCheckAttempts.q2.isCorrect).toBe(true) // not rewritten
    expect(s.getState().lessonProgress.l1!.conceptCheckAttempts.q2!.explanation).toBeUndefined() // nothing invented in its place
  })

  it('a saved choice the server can no longer grade is dropped', async () => {
    await savedProgress()
    const reduced = fakeGradingServer({ keys: KEYS })
    reduced.removeCheck('l1', 'q2')
    useServer(reduced)
    const s = await reload()
    expect(s.getState().lessonProgress.l1!.conceptCheckAttempts.q2).toBeUndefined()
    expect(s.getState().lessonProgress.l1!.conceptCheckAttempts.q1).toBeDefined()
    expect(s.getState().regradeStatus).toBe('done')
  })

  it('an answer given while the saved ones are still being re-checked is not overwritten by the older re-check', async () => {
    await savedProgress()
    vi.resetModules()
    client.listLessons.mockResolvedValue(CATALOG)
    let release!: (answers: RegradedAnswer[]) => void
    client.regradeConceptChecks.mockImplementation(() => new Promise<RegradedAnswer[]>((resolve) => (release = resolve)))
    const { useLearnStore } = await import('./store')
    await useLearnStore.getState().fetchLessons()
    await vi.waitFor(() => expect(useLearnStore.getState().regradeStatus).toBe('checking'))

    await useLearnStore.getState().submitConceptCheckAnswer('l1', 'q2', 'a') // a new choice, wrong
    release([
      { lessonId: 'l1', checkId: 'q1', selectedOptionId: 'a', status: 'GRADED', correct: true, explanation: 'e1' },
      { lessonId: 'l1', checkId: 'q2', selectedOptionId: 'b', status: 'GRADED', correct: true, explanation: 'old' }, // about the OLD choice
    ])
    await vi.waitFor(() => expect(useLearnStore.getState().regradeStatus).not.toBe('checking'))
    expect(useLearnStore.getState().lessonProgress.l1!.conceptCheckAttempts.q2).toMatchObject({ selectedOptionId: 'a', isCorrect: false, attemptCount: 2 })
  })

  it('a removed section: its completion and attempt are dropped, and completion follows the new lesson', async () => {
    await savedProgress()
    const shorter = [lesson('l1', [intro, check('q1')]), ...CATALOG.slice(1)]
    const s = await reload(shorter)
    const progress = s.getState().lessonProgress.l1!
    expect(Object.keys(progress.conceptCheckAttempts)).toEqual(['q1'])
    expect([...progress.completedSectionIds].sort()).toEqual(['intro', 'q1'])
    expect(isLessonComplete(shorter[0]!, progress)).toBe(true)
  })

  it('a NEW section makes a previously complete lesson incomplete again', async () => {
    await savedProgress()
    const grown = [lesson('l1', [intro, check('q1'), check('q2'), check('q3')]), ...CATALOG.slice(1)]
    const s = await reload(grown)
    expect(isLessonComplete(grown[0]!, s.getState().lessonProgress.l1)).toBe(false)
  })

  it('a removed lesson is dropped; the rest is untouched', async () => {
    await savedProgress()
    const s = await reload([CATALOG[2]!])
    expect(Object.keys(s.getState().lessonProgress)).toEqual([])
  })

  it('a saved option that no longer exists is dropped rather than graded', async () => {
    await savedProgress()
    const relabelled = [lesson('l1', [intro, check('q1'), { ...check('q2'), options: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }] } as LessonSection]), ...CATALOG.slice(1)]
    const s = await reload(relabelled)
    expect(s.getState().lessonProgress.l1!.conceptCheckAttempts.q2).toBeUndefined()
  })

  it('nothing is dropped while the catalog has not loaded (an empty catalog is "not loaded", not "all deleted")', async () => {
    await savedProgress()
    vi.resetModules()
    client.listLessons.mockRejectedValue(new Error('backend down'))
    const { useLearnStore } = await import('./store')
    await useLearnStore.getState().fetchLessons()
    expect(useLearnStore.getState().error).toContain('backend down')
    expect(Object.keys(useLearnStore.getState().lessonProgress)).toEqual(['l1'])
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!).lessons.l1).toBeDefined()
  })

  it('a catalog that loads EMPTY does not wipe saved progress', async () => {
    await savedProgress()
    const s = await reload([])
    expect(s.getState().lessons).toEqual([])
    expect(Object.keys(s.getState().lessonProgress)).toEqual(['l1'])
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!).lessons.l1).toBeDefined()
    // ...and once the real catalog is back, the progress is all still there.
    const back = await reload()
    expect(isLessonComplete(CATALOG[0]!, back.getState().lessonProgress.l1)).toBe(true)
  })

  it.each([
    ['garbage text', '{{ not json'],
    ['a wrong-typed value', '"progress"'],
    ['an unknown newer version', '{"version":99,"lessons":{}}'],
    ['a valid shell with poisoned entries', '{"version":1,"lessons":{"l1":"x","l2":[1],"l3":{"activeSectionIndex":"no","completedSectionIds":"no","conceptCheckAttempts":"no"}}}'],
  ])('%s: the app loads, learner starts (near) empty, and nothing throws', async (_name, raw) => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, raw)
    const s = await reload()
    const completed = snapshot(s).completed
    expect(completed).toEqual([])
    expect(Object.values(s.getState().lessonProgress).every((p) => p.completedSectionIds.size === 0)).toBe(true)
  })

  it('unreadable data is set aside, flagged, and the flag clears with the next successful save', async () => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, '{{ corrupt')
    const s = await reload()
    expect(s.getState().progressRecovered).toBe(true)
    expect(localStorage.getItem(PROGRESS_UNREADABLE_KEY)).toBe('{{ corrupt')
    s.getState().selectLesson('l3')
    expect(s.getState().progressRecovered).toBe(false)
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)!).startedLessonIds).toEqual(['l3'])
    expect(localStorage.getItem(PROGRESS_UNREADABLE_KEY)).toBe('{{ corrupt') // the original is still there
  })
})

describe('session-only when the browser will not save', () => {
  const failing = (): ProgressStore => ({
    load: () => ({ progress: { startedLessonIds: new Set(), lessonProgress: {} }, status: 'empty' }),
    save: () => false,
    probe: () => false,
  })

  it('progress still works in memory, nothing throws, and the state says session-only', async () => {
    const s = await reload()
    const mod = await import('./store')
    mod.setProgressStore(failing())
    expect(() => s.getState().completeSection('l3', 'intro')).not.toThrow()
    expect(s.getState().persistence).toBe('session-only')
    expect(isLessonComplete(CATALOG[2]!, s.getState().lessonProgress.l3)).toBe(true)
  })

  it('a later successful save flips it back to saved-on-this-device', async () => {
    const s = await reload()
    const mod = await import('./store')
    mod.setProgressStore(failing())
    s.getState().selectLesson('l3')
    expect(s.getState().persistence).toBe('session-only')
    mod.setProgressStore({ load: failing().load, save: () => true, probe: () => true })
    s.getState().setActiveSectionIndex('l3', 0)
    s.getState().selectLesson('l1')
    expect(s.getState().persistence).toBe('device')
  })

  it('starts as session-only when localStorage cannot be written at all', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const s = await reload()
    expect(s.getState().persistence).toBe('session-only')
  })
})

describe('the persistence note (what the learner is told)', () => {
  async function renderNote() {
    vi.resetModules()
    const { useLearnStore } = await import('./store')
    const { PersistenceNote } = await import('./PersistenceNote')
    render(<PersistenceNote />)
    return useLearnStore
  }

  it('says "saved on this device" — and that there is no account — when saving works', async () => {
    await renderNote()
    const note = screen.getByTestId('persistence-note')
    expect(note.getAttribute('data-persistence')).toBe('device')
    expect(note.textContent).toContain('Saved on this device')
    expect(note.textContent).toContain('no account')
    expect(screen.queryByTestId('progress-recovered')).toBeNull()
  })

  it('says "session only" and that progress is lost on reload when saving does not work', async () => {
    const s = await renderNote()
    act(() => s.setState({ persistence: 'session-only' }))
    const note = screen.getByTestId('persistence-note')
    expect(note.getAttribute('data-persistence')).toBe('session-only')
    expect(note.textContent).toContain('Session only')
    expect(note.textContent).toContain('lost when you reload')
    expect(note.textContent).not.toContain('Saved on this device')
  })

  it('mentions recovery only when saved data was set aside', async () => {
    const s = await renderNote()
    act(() => s.setState({ progressRecovered: true }))
    expect(screen.getByTestId('progress-recovered').textContent).toContain('starting fresh')
  })

  it('says saved quiz answers were not re-checked only when the server could not be reached', async () => {
    const s = await renderNote()
    expect(screen.queryByTestId('answers-unverified')).toBeNull()
    for (const status of ['idle', 'checking', 'done'] as const) {
      act(() => s.setState({ regradeStatus: status }))
      expect(screen.queryByTestId('answers-unverified')).toBeNull()
    }
    act(() => s.setState({ regradeStatus: 'unverified' }))
    expect(screen.getByTestId('answers-unverified').textContent).toContain('couldn’t be re-checked with the server')
  })

  it('never claims sync, cloud or an account', async () => {
    await renderNote()
    expect(screen.getByTestId('persistence-note').textContent).not.toMatch(/sync(ed)?\b|cloud|signed in|log ?in/i)
  })
})
