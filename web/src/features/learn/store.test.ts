/**
 * Tests for `useLearnStore`'s progression actions: starting a lesson,
 * navigating/completing a section, and submitting/re-submitting a
 * concept-check answer. A concept-check answer is graded by the SERVER, so the
 * API client is replaced by `fakeGradingServer` (a test double that holds the answer
 * key the real catalog does not); these tests never call `fetchLessons`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendUnavailableError, GradeRejectedError, type Lesson } from '@/api'
import { useBuildStore } from '@/features/build/store'
import { fakeGradingServer } from '@/test/gradingServer'
import { useLearnStore } from './store'
import { ACTIVITY_STORAGE_KEY } from './streakStorage'

const client = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client.current }
})

const INITIAL_LEARN_STATE = useLearnStore.getState()
const INITIAL_BUILD_STATE = useBuildStore.getState()

/** The "server": lesson a's checks s1, s2 and q1 are all answered correctly by option x. */
const KEYS = { 'a/s1': 'x', 'a/s2': 'x', 'a/q1': 'x' }
let server = fakeGradingServer({ keys: KEYS })
beforeEach(() => {
  server = fakeGradingServer({ keys: KEYS })
  client.current = server
})

describe('useLearnStore', () => {
  beforeEach(() => {
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  afterEach(() => {
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  it('selectLesson marks the lesson started exactly once', () => {
    useLearnStore.getState().selectLesson('a')
    expect(useLearnStore.getState().startedLessonIds.has('a')).toBe(true)

    useLearnStore.getState().selectLesson('b')
    useLearnStore.getState().selectLesson('a')
    // Still only ever the two distinct lessons started, not re-added.
    expect(useLearnStore.getState().startedLessonIds).toEqual(new Set(['a', 'b']))
  })

  it('selecting null does not start any lesson', () => {
    useLearnStore.getState().selectLesson(null)
    expect(useLearnStore.getState().startedLessonIds.size).toBe(0)
    expect(useLearnStore.getState().selectedLessonId).toBeNull()
  })

  it('completeSection records the section under that lesson', () => {
    useLearnStore.getState().completeSection('a', 's1')
    expect(useLearnStore.getState().lessonProgress.a?.completedSectionIds.has('s1')).toBe(true)
  })

  it('completeSection is idempotent (completing twice does not create a new Set)', () => {
    useLearnStore.getState().completeSection('a', 's1')
    const firstSet = useLearnStore.getState().lessonProgress.a?.completedSectionIds
    useLearnStore.getState().completeSection('a', 's1')
    const secondSet = useLearnStore.getState().lessonProgress.a?.completedSectionIds
    expect(secondSet).toBe(firstSet)
  })

  it('tracks completed sections separately per lesson', () => {
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().completeSection('b', 's1')
    expect(useLearnStore.getState().lessonProgress.a?.completedSectionIds.has('s1')).toBe(true)
    expect(useLearnStore.getState().lessonProgress.b?.completedSectionIds.has('s1')).toBe(true)
    expect(useLearnStore.getState().lessonProgress.a).not.toBe(useLearnStore.getState().lessonProgress.b)
  })

  it('setActiveSectionIndex records which step is current for that lesson', () => {
    useLearnStore.getState().setActiveSectionIndex('a', 2)
    expect(useLearnStore.getState().lessonProgress.a?.activeSectionIndex).toBe(2)
  })

  it('setActiveSectionIndex is a no-op (same object) when the index does not change', () => {
    useLearnStore.getState().setActiveSectionIndex('a', 1)
    const first = useLearnStore.getState().lessonProgress.a
    useLearnStore.getState().setActiveSectionIndex('a', 1)
    const second = useLearnStore.getState().lessonProgress.a
    expect(second).toBe(first)
  })

  it('setActiveSectionIndex never marks the section completed', () => {
    useLearnStore.getState().setActiveSectionIndex('a', 3)
    expect(useLearnStore.getState().lessonProgress.a?.completedSectionIds.size).toBe(0)
  })

  it('a new lesson starts at activeSectionIndex 0 with nothing completed', () => {
    expect(useLearnStore.getState().lessonProgress.a).toBeUndefined()
    useLearnStore.getState().completeSection('a', 's1')
    expect(useLearnStore.getState().lessonProgress.a?.activeSectionIndex).toBe(0)
  })

  it('submitConceptCheckAnswer records the SERVER’s verdict: a correct attempt', async () => {
    expect(await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')).toBe(true)
    const attempt = useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1
    expect(attempt).toEqual({ selectedOptionId: 'x', isCorrect: true, attemptCount: 1, explanation: 'Explanation for a/s1.' })
  })

  it('submitConceptCheckAnswer records the SERVER’s verdict: an incorrect attempt', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y')
    const attempt = useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1
    expect(attempt).toEqual({ selectedOptionId: 'y', isCorrect: false, attemptCount: 1, explanation: 'Explanation for a/s1.' })
  })

  it('a retry (second submission) overwrites the answer and increments attemptCount', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y')
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')
    const attempt = useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1
    expect(attempt).toMatchObject({ selectedOptionId: 'x', isCorrect: true, attemptCount: 2 })
  })

  it('sends the server only the ids and the chosen option — no verdict, no key', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's2', 'y')
    expect(server.gradeConceptCheck.mock.calls).toEqual([['a', 's2', 'y']])
  })

  it('the verdict is whatever the server says, even if it contradicts what the client might expect', async () => {
    server.setKey('a', 's1', 'y') // the server's key is y now
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')
    expect(useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1?.isCorrect).toBe(false)
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y')
    expect(useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1?.isCorrect).toBe(true)
  })

  it('shows "grading" while the server is being asked, and clears it when it answers', async () => {
    let release!: () => void
    client.current = {
      ...server,
      gradeConceptCheck: vi.fn(
        () => new Promise((resolve) => (release = () => resolve({ lessonId: 'a', checkId: 's1', selectedOptionId: 'x', correct: true, explanation: 'e' }))),
      ),
    }
    const pending = useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')
    expect(useLearnStore.getState().gradingStatus['a/s1']).toEqual({ state: 'grading' })
    expect(useLearnStore.getState().lessonProgress.a).toBeUndefined() // nothing recorded before the server answers
    release()
    expect(await pending).toBe(true)
    expect(useLearnStore.getState().gradingStatus).toEqual({})
  })

  it('ignores a second submission of the same check while the first is still being graded', async () => {
    let release!: () => void
    const slow = vi.fn(
      () => new Promise((resolve) => (release = () => resolve({ lessonId: 'a', checkId: 's1', selectedOptionId: 'x', correct: true, explanation: 'e' }))),
    )
    client.current = { ...server, gradeConceptCheck: slow }
    const first = useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')
    expect(await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y')).toBe(false)
    expect(slow).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1?.attemptCount).toBe(1)
  })

  it('records NOTHING when the server cannot be reached, and says so — no verdict is guessed', async () => {
    client.current = { ...server, gradeConceptCheck: vi.fn().mockRejectedValue(new BackendUnavailableError('could not reach the Qentor backend: down')) }
    expect(await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')).toBe(false)
    expect(useLearnStore.getState().lessonProgress.a).toBeUndefined()
    expect(useLearnStore.getState().activityHistory.activityDates).toEqual([])
    const status = useLearnStore.getState().gradingStatus['a/s1']
    expect(status).toMatchObject({ state: 'failed' })
    expect((status as { message: string }).message).toContain('could not reach the Qentor backend')
    expect((status as { message: string }).message).toContain('Nothing was recorded')
  })

  it('records NOTHING when the server refuses, and shows the server’s own code', async () => {
    client.current = { ...server, gradeConceptCheck: vi.fn().mockRejectedValue(new GradeRejectedError('OPTION_NOT_FOUND', 'zzz is not an option', 422)) }
    expect(await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'zzz')).toBe(false)
    expect(useLearnStore.getState().lessonProgress.a).toBeUndefined()
    expect((useLearnStore.getState().gradingStatus['a/s1'] as { message: string }).message).toContain('OPTION_NOT_FOUND')
  })

  it('refuses a verdict that is about a different question', async () => {
    client.current = {
      ...server,
      gradeConceptCheck: vi.fn().mockResolvedValue({ lessonId: 'a', checkId: 's2', selectedOptionId: 'x', correct: true, explanation: 'e' }),
    }
    expect(await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')).toBe(false)
    expect(useLearnStore.getState().lessonProgress.a).toBeUndefined()
    expect(useLearnStore.getState().gradingStatus['a/s1']).toMatchObject({ state: 'failed' })
  })

  it('a failed grade leaves an earlier recorded attempt exactly as it was, and a later success clears the failure', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y')
    const before = useLearnStore.getState().lessonProgress.a
    client.current = { ...server, gradeConceptCheck: vi.fn().mockRejectedValue(new BackendUnavailableError('down')) }
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')
    expect(useLearnStore.getState().lessonProgress.a).toBe(before)
    client.current = server
    expect(await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x')).toBe(true)
    expect(useLearnStore.getState().gradingStatus).toEqual({})
  })

  it('never mutates the Build circuit or any of its derived state', async () => {
    const circuitBefore = useBuildStore.getState().circuit

    useLearnStore.getState().selectLesson('a')
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().setActiveSectionIndex('a', 1)
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's2', 'x')

    expect(useBuildStore.getState().circuit).toBe(circuitBefore)
    expect(useBuildStore.getState().result).toBeNull()
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })
})

describe('useLearnStore learning-activity recording', () => {
  // Local time on purpose: activity days are the browser's local calendar
  // date. Only `Date` is faked, so timers/promises behave normally.
  const DAY_1 = new Date(2026, 8, 29, 10, 0, 0) // 2026-09-29 local
  const DAY_2 = new Date(2026, 8, 30, 9, 0, 0) // 2026-09-30 local

  const TWO_STEP_LESSON: Lesson = {
    id: 'a',
    title: 'A',
    shortDescription: 'd',
    concept: 'c',
    difficulty: 'beginner',
    estimatedMinutes: 5,
    learningObjectives: ['o'],
    sections: [
      { type: 'explanation', id: 's1', title: 'one', body: 'b' },
      { type: 'reflection', id: 's2', title: 'two', prompt: 'p' },
    ],
    linkedCircuit: null,
    prerequisiteLessonIds: [],
  }

  const activityDates = () => useLearnStore.getState().activityHistory.activityDates

  beforeEach(() => {
    localStorage.clear()
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(DAY_1)
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  it('starts with no activity', () => {
    expect(activityDates()).toEqual([])
  })

  it('submitting a concept-check answer the server graded records today, right or wrong', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y') // wrong
    expect(activityDates()).toEqual(['2026-09-29'])
  })

  it('completing the LESSON (its last section) records today', () => {
    useLearnStore.setState({ lessons: [TWO_STEP_LESSON] })
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().completeSection('a', 's2')
    expect(activityDates()).toEqual(['2026-09-29'])
  })

  it('completing a section that does NOT finish the lesson records nothing', () => {
    useLearnStore.setState({ lessons: [TWO_STEP_LESSON] })
    useLearnStore.getState().completeSection('a', 's1')
    expect(activityDates()).toEqual([])
  })

  it('does not record for a lesson id the catalog does not contain', () => {
    useLearnStore.getState().completeSection('unknown', 's1')
    expect(activityDates()).toEqual([])
  })

  it('records nothing for navigation, selection or idempotent re-completion', () => {
    useLearnStore.setState({ lessons: [TWO_STEP_LESSON] })
    useLearnStore.getState().selectLesson('a')
    useLearnStore.getState().setActiveSectionIndex('a', 1)
    useLearnStore.getState().setActiveSectionIndex('a', 0)
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().completeSection('a', 's1') // already completed: no-op
    expect(activityDates()).toEqual([])
    expect(localStorage.getItem(ACTIVITY_STORAGE_KEY)).toBeNull()
  })

  it('completing an already-complete lesson again does not add anything new', () => {
    useLearnStore.setState({ lessons: [TWO_STEP_LESSON] })
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().completeSection('a', 's2')
    useLearnStore.getState().completeSection('a', 's2')
    expect(activityDates()).toEqual(['2026-09-29'])
  })

  it('several actions on the same calendar day are ONE activity day', async () => {
    useLearnStore.setState({ lessons: [TWO_STEP_LESSON] })
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y')
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'x')
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().completeSection('a', 's2')
    expect(activityDates()).toEqual(['2026-09-29'])
  })

  it('same-day activity does not rewrite the persisted history', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'x')
    // The lesson progress is saved again (the attempt count changed) — the ACTIVITY history is not, it already has today.
    expect(setItem.mock.calls.filter(([key]) => key === ACTIVITY_STORAGE_KEY)).toEqual([])
    setItem.mockRestore()
  })

  it('activity on a later calendar day adds a second, sorted day', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y')
    vi.setSystemTime(DAY_2)
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'x')
    expect(activityDates()).toEqual(['2026-09-29', '2026-09-30'])
  })

  it('persists to localStorage in the documented format', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y')
    expect(JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY)!)).toEqual({
      version: 1,
      activityDates: ['2026-09-29'],
    })
  })

  it('survives a page reload: a freshly loaded store reads the saved history', async () => {
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y')

    vi.resetModules() // simulates the page reloading: module state is gone, localStorage is not
    const reloaded = await import('./store')

    expect(reloaded.useLearnStore).not.toBe(useLearnStore)
    expect(reloaded.useLearnStore.getState().activityHistory.activityDates).toEqual(['2026-09-29'])
    // Lesson progress survives too (see progressPersistence.test.tsx for the full round trip).
    expect(reloaded.useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.q1?.selectedOptionId).toBe('y')
  })

  it('recovers from malformed saved data on load with an empty history', async () => {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, '{{ definitely not json')

    vi.resetModules()
    const reloaded = await import('./store')

    expect(reloaded.useLearnStore.getState().activityHistory.activityDates).toEqual([])
  })

  it('keeps working (in memory) when localStorage writes fail', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await expect(useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y')).resolves.toBe(true)
    expect(activityDates()).toEqual(['2026-09-29'])
    setItem.mockRestore()
  })

  it('never touches the Build/Lab state', async () => {
    const before = useBuildStore.getState()
    useLearnStore.setState({ lessons: [TWO_STEP_LESSON] })
    await useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y')
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().completeSection('a', 's2')
    expect(useBuildStore.getState()).toBe(before)
  })
})
