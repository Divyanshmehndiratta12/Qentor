/**
 * Tests for `useLearnStore`'s progression actions: starting a lesson,
 * visiting a section, and submitting/re-submitting a concept-check answer.
 * `@/api` is not mocked here — these tests only exercise state transitions,
 * never `fetchLessons`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from './store'

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

  it('markSectionVisited records the section under that lesson', () => {
    useLearnStore.getState().markSectionVisited('a', 's1')
    expect(useLearnStore.getState().lessonProgress.a?.visitedSectionIds.has('s1')).toBe(true)
  })

  it('markSectionVisited is idempotent (visiting twice does not create a new Set)', () => {
    useLearnStore.getState().markSectionVisited('a', 's1')
    const firstSet = useLearnStore.getState().lessonProgress.a?.visitedSectionIds
    useLearnStore.getState().markSectionVisited('a', 's1')
    const secondSet = useLearnStore.getState().lessonProgress.a?.visitedSectionIds
    expect(secondSet).toBe(firstSet)
  })

  it('tracks visited sections separately per lesson', () => {
    useLearnStore.getState().markSectionVisited('a', 's1')
    useLearnStore.getState().markSectionVisited('b', 's1')
    expect(useLearnStore.getState().lessonProgress.a?.visitedSectionIds.has('s1')).toBe(true)
    expect(useLearnStore.getState().lessonProgress.b?.visitedSectionIds.has('s1')).toBe(true)
    expect(useLearnStore.getState().lessonProgress.a).not.toBe(useLearnStore.getState().lessonProgress.b)
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
    useLearnStore.getState().markSectionVisited('a', 's1')
    useLearnStore.getState().submitConceptCheckAnswer('a', 's2', 'x', 'x')

    expect(useBuildStore.getState().circuit).toBe(circuitBefore)
    expect(useBuildStore.getState().result).toBeNull()
    expect(useBuildStore.getState().isExecuting).toBe(false)
  })
})
