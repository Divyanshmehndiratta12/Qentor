/**
 * Tests for `useLearnStore`'s progression actions: starting a lesson,
 * navigating/completing a section, and submitting/re-submitting a
 * concept-check answer. `@/api` is not mocked here — these tests only
 * exercise state transitions, never `fetchLessons`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Lesson } from '@/api'
import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from './store'
import { ACTIVITY_STORAGE_KEY } from './streakStorage'

const INITIAL_LEARN_STATE = useLearnStore.getState()
const INITIAL_BUILD_STATE = useBuildStore.getState()

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

  it('submitConceptCheckAnswer records a correct attempt', () => {
    useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x', 'x')
    const attempt = useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1
    expect(attempt).toEqual({ selectedOptionId: 'x', isCorrect: true, attemptCount: 1 })
  })

  it('submitConceptCheckAnswer records an incorrect attempt', () => {
    useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y', 'x')
    const attempt = useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1
    expect(attempt).toEqual({ selectedOptionId: 'y', isCorrect: false, attemptCount: 1 })
  })

  it('a retry (second submission) overwrites the answer and increments attemptCount', () => {
    useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y', 'x')
    useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'x', 'x')
    const attempt = useLearnStore.getState().lessonProgress.a?.conceptCheckAttempts.s1
    expect(attempt).toEqual({ selectedOptionId: 'x', isCorrect: true, attemptCount: 2 })
  })

  it('never mutates the Build circuit or any of its derived state', () => {
    const circuitBefore = useBuildStore.getState().circuit

    useLearnStore.getState().selectLesson('a')
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().setActiveSectionIndex('a', 1)
    useLearnStore.getState().submitConceptCheckAnswer('a', 's2', 'x', 'x')

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

  it('submitting a concept-check answer records today, right or wrong', () => {
    useLearnStore.getState().submitConceptCheckAnswer('a', 's1', 'y', 'x') // wrong
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

  it('several actions on the same calendar day are ONE activity day', () => {
    useLearnStore.setState({ lessons: [TWO_STEP_LESSON] })
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y', 'x')
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'x', 'x')
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().completeSection('a', 's2')
    expect(activityDates()).toEqual(['2026-09-29'])
  })

  it('same-day activity does not rewrite the persisted history', () => {
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y', 'x')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'x', 'x')
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('activity on a later calendar day adds a second, sorted day', () => {
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y', 'x')
    vi.setSystemTime(DAY_2)
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'x', 'x')
    expect(activityDates()).toEqual(['2026-09-29', '2026-09-30'])
  })

  it('persists to localStorage in the documented format', () => {
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y', 'x')
    expect(JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY)!)).toEqual({
      version: 1,
      activityDates: ['2026-09-29'],
    })
  })

  it('survives a page reload: a freshly loaded store reads the saved history', async () => {
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y', 'x')

    vi.resetModules() // simulates the page reloading: module state is gone, localStorage is not
    const reloaded = await import('./store')

    expect(reloaded.useLearnStore).not.toBe(useLearnStore)
    expect(reloaded.useLearnStore.getState().activityHistory.activityDates).toEqual(['2026-09-29'])
    // ...while session-only lesson progress correctly did NOT survive.
    expect(reloaded.useLearnStore.getState().lessonProgress).toEqual({})
  })

  it('recovers from malformed saved data on load with an empty history', async () => {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, '{{ definitely not json')

    vi.resetModules()
    const reloaded = await import('./store')

    expect(reloaded.useLearnStore.getState().activityHistory.activityDates).toEqual([])
  })

  it('keeps working (in memory) when localStorage writes fail', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y', 'x')).not.toThrow()
    expect(activityDates()).toEqual(['2026-09-29'])
    setItem.mockRestore()
  })

  it('never touches the Build/Lab state', () => {
    const before = useBuildStore.getState()
    useLearnStore.setState({ lessons: [TWO_STEP_LESSON] })
    useLearnStore.getState().submitConceptCheckAnswer('a', 'q1', 'y', 'x')
    useLearnStore.getState().completeSection('a', 's1')
    useLearnStore.getState().completeSection('a', 's2')
    expect(useBuildStore.getState()).toBe(before)
  })
})
