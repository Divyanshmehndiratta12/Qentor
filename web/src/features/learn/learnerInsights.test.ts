import { describe, expect, it } from 'vitest'
import type { Lesson, LessonSection } from '@/api'
import type { LessonProgress } from './lessonState'
import {
  MASTERY_ACCURACY_THRESHOLD,
  getLessonMastery,
  getMasteryBreakdown,
  getMisconceptions,
  getNextChallenge,
  getOverallLearningProgress,
} from './learnerInsights'

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: 'l1',
    title: 'Lesson',
    shortDescription: 'desc',
    concept: 'concept',
    difficulty: 'beginner',
    estimatedMinutes: 10,
    learningObjectives: ['obj'],
    sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'body' }],
    linkedCircuit: null,
    prerequisiteLessonIds: [],
    ...overrides,
  }
}

function conceptCheck(id: string, concept: string, correctOptionId = 'a'): LessonSection {
  return {
    type: 'concept_check',
    id,
    title: 'Check',
    prompt: 'q',
    question: `${concept}?`,
    options: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ],
    correctOptionId,
    explanation: 'because',
    concept,
  }
}

function progress(overrides: Partial<LessonProgress> = {}): LessonProgress {
  return { visitedSectionIds: new Set(), conceptCheckAttempts: {}, ...overrides }
}

describe('getOverallLearningProgress', () => {
  it('is all-zero with an empty catalog', () => {
    expect(getOverallLearningProgress([], {}, new Set())).toEqual({
      totalLessons: 0,
      lessonsStarted: 0,
      lessonsCompleted: 0,
      conceptChecksAttempted: 0,
      conceptChecksCorrect: 0,
      conceptChecksTotal: 0,
      overallAccuracy: null,
    })
  })

  it('reports zero progress across an untouched catalog', () => {
    const lessons = [lesson({ id: 'a' }), lesson({ id: 'b', sections: [conceptCheck('s1', 'x')] })]
    const result = getOverallLearningProgress(lessons, {}, new Set())
    expect(result.totalLessons).toBe(2)
    expect(result.lessonsStarted).toBe(0)
    expect(result.lessonsCompleted).toBe(0)
    expect(result.conceptChecksAttempted).toBe(0)
    expect(result.conceptChecksTotal).toBe(1)
    expect(result.overallAccuracy).toBeNull()
  })

  it('aggregates partial progress across multiple lessons', () => {
    const lessons = [
      lesson({ id: 'a' }), // no checks, 1 explanation section
      lesson({ id: 'b', sections: [conceptCheck('s1', 'x')] }),
    ]
    const lessonProgress = {
      a: progress({ visitedSectionIds: new Set(['s1']) }),
      b: progress({ conceptCheckAttempts: { s1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } } }),
    }
    const result = getOverallLearningProgress(lessons, lessonProgress, new Set(['a', 'b']))

    expect(result.lessonsStarted).toBe(2)
    expect(result.lessonsCompleted).toBe(1) // only 'a' is complete (its only section is visited)
    expect(result.conceptChecksAttempted).toBe(1)
    expect(result.conceptChecksCorrect).toBe(1)
    expect(result.overallAccuracy).toBe(1)
  })

  it('counts every completed lesson once the whole catalog is done', () => {
    const lessons = [lesson({ id: 'a' }), lesson({ id: 'b' })]
    const lessonProgress = {
      a: progress({ visitedSectionIds: new Set(['s1']) }),
      b: progress({ visitedSectionIds: new Set(['s1']) }),
    }
    const result = getOverallLearningProgress(lessons, lessonProgress, new Set(['a', 'b']))
    expect(result.lessonsCompleted).toBe(2)
    expect(result.totalLessons).toBe(2)
  })
})

describe('getMasteryBreakdown reuses getLessonMastery (no second algorithm)', () => {
  it('matches getLessonMastery called directly, lesson by lesson', () => {
    const a = lesson({ id: 'a', sections: [conceptCheck('s1', 'x')] })
    const b = lesson({ id: 'b' })
    const lessonProgress = {
      a: progress({
        visitedSectionIds: new Set(['s1']),
        conceptCheckAttempts: { s1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } },
      }),
    }
    const started = new Set(['a'])

    const breakdown = getMasteryBreakdown([a, b], lessonProgress, started)

    expect(getLessonMastery(a, lessonProgress.a, true)).toBe('mastered')
    expect(getLessonMastery(b, undefined, false)).toBe('not_started')
    expect(breakdown).toEqual({ mastered: 1, developing: 0, not_started: 1 })
  })
})

describe('getMisconceptions', () => {
  it('reports nothing for an unstarted lesson, even with unattempted checks', () => {
    const l = lesson({ id: 'a', sections: [conceptCheck('s1', 'phase')] })
    expect(getMisconceptions([l], {}, new Set())).toEqual([])
  })

  it('reports nothing when every attempt so far is correct', () => {
    const l = lesson({ id: 'a', sections: [conceptCheck('s1', 'phase')] })
    const p = progress({ conceptCheckAttempts: { s1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } } })
    expect(getMisconceptions([l], { a: p }, new Set(['a']))).toEqual([])
  })

  it('flags repeated incorrect attempts (attemptCount >= 2, still wrong)', () => {
    const l = lesson({ id: 'a', sections: [conceptCheck('s1', 'phase')] })
    const p = progress({ conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 2 } } })

    const signals = getMisconceptions([l], { a: p }, new Set(['a']))

    expect(signals).toContainEqual({
      conceptId: 'phase',
      lessonId: 'a',
      sectionId: 's1',
      reason: 'phase: 2 incorrect attempts',
      severity: 'high',
    })
  })

  it('does not flag repeated-incorrect on a single, first-try wrong attempt', () => {
    const l = lesson({ id: 'a', sections: [conceptCheck('s1', 'phase')] })
    const p = progress({ conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 } } })

    const signals = getMisconceptions([l], { a: p }, new Set(['a']))

    expect(signals.some((s) => s.severity === 'high')).toBe(false)
  })

  it('flags a final incorrect answer once the lesson (with a single check) is complete', () => {
    const l = lesson({
      id: 'a',
      sections: [
        { type: 'explanation', id: 's0', title: 't', body: 'b' },
        conceptCheck('s1', 'measurement'),
      ],
    })
    const p = progress({
      visitedSectionIds: new Set(['s0', 's1']),
      conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 } },
    })

    const signals = getMisconceptions([l], { a: p }, new Set(['a']))

    expect(signals).toContainEqual({
      conceptId: 'measurement',
      lessonId: 'a',
      sectionId: 's1',
      reason: 'measurement concept check: latest answer incorrect',
      severity: 'medium',
    })
  })

  it('does not flag the final-incorrect rule while the lesson is still incomplete', () => {
    const l = lesson({
      id: 'a',
      sections: [
        { type: 'explanation', id: 's0', title: 't', body: 'b' },
        conceptCheck('s1', 'measurement'),
      ],
    })
    // s0 (explanation) never visited -> lesson not complete.
    const p = progress({
      conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 } },
    })

    const signals = getMisconceptions([l], { a: p }, new Set(['a']))

    expect(signals.some((s) => s.severity === 'medium')).toBe(false)
  })

  it(`flags low accuracy across a lesson's concept checks once all are attempted (< ${MASTERY_ACCURACY_THRESHOLD})`, () => {
    const l = lesson({ id: 'a', concept: 'x', sections: [conceptCheck('s1', 'x'), conceptCheck('s2', 'x')] })
    const p = progress({
      conceptCheckAttempts: {
        s1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 },
        s2: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 },
      },
    })

    const signals = getMisconceptions([l], { a: p }, new Set(['a']))

    expect(signals).toContainEqual({
      conceptId: 'x',
      lessonId: 'a',
      sectionId: null,
      reason: 'x: accuracy below mastery threshold (1/2)',
      severity: 'low',
    })
  })

  it('does not flag low-accuracy for a single-check lesson (covered by the other rules instead)', () => {
    const l = lesson({ id: 'a', sections: [conceptCheck('s1', 'x')] })
    const p = progress({ conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 } } })

    const signals = getMisconceptions([l], { a: p }, new Set(['a']))

    expect(signals.some((s) => s.severity === 'low')).toBe(false)
  })

  it('does not flag low-accuracy until every check in the lesson has been attempted', () => {
    const l = lesson({ id: 'a', sections: [conceptCheck('s1', 'x'), conceptCheck('s2', 'x')] })
    const p = progress({
      conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 } },
    })

    const signals = getMisconceptions([l], { a: p }, new Set(['a']))

    expect(signals.some((s) => s.severity === 'low')).toBe(false)
  })
})

describe('getNextChallenge', () => {
  it('priority A: an unresolved misconception in a started lesson, highest severity first', () => {
    const a = lesson({ id: 'a', sections: [conceptCheck('s1', 'phase')] })
    const b = lesson({ id: 'b', prerequisiteLessonIds: [] })
    const p = progress({ conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 2 } } })

    const result = getNextChallenge([a, b], { a: p }, new Set(['a']))

    expect(result).toEqual({
      lessonId: 'a',
      reason: 'phase: 2 incorrect attempts',
      challengeType: 'address_misconception',
    })
  })

  it('priority B: the first unlocked, incomplete lesson when there are no misconceptions', () => {
    const a = lesson({ id: 'a' })
    const b = lesson({ id: 'b', prerequisiteLessonIds: ['a'] })

    const result = getNextChallenge([a, b], {}, new Set())

    expect(result).toEqual({
      lessonId: 'a',
      reason: '"Lesson" is next in your learning path.',
      challengeType: 'next_lesson',
    })
  })

  it('priority B recommends resuming an already-started, incomplete lesson', () => {
    const a = lesson({ id: 'a', title: 'Qubits', sections: [conceptCheck('s1', 'x')] })
    const p = progress() // started, but the check hasn't been attempted -> not complete, no misconception

    const result = getNextChallenge([a], { a: p }, new Set(['a']))

    expect(result).toEqual({
      lessonId: 'a',
      reason: 'Pick up where you left off in "Qubits".',
      challengeType: 'next_lesson',
    })
  })

  it('priority B skips a locked lesson and recommends the next available one', () => {
    const a = lesson({ id: 'a', title: 'A' })
    const b = lesson({ id: 'b', title: 'B', prerequisiteLessonIds: ['a'] })
    const p = progress({ visitedSectionIds: new Set(['s1']) }) // a is complete

    const result = getNextChallenge([a, b], { a: p }, new Set(['a']))

    expect(result.lessonId).toBe('b')
    expect(result.challengeType).toBe('next_lesson')
  })

  it('priority C: reports the catalog complete once every lesson is done', () => {
    const a = lesson({ id: 'a' })
    const p = progress({ visitedSectionIds: new Set(['s1']) })

    const result = getNextChallenge([a], { a: p }, new Set(['a']))

    expect(result).toEqual({
      lessonId: null,
      reason: 'Every lesson in the current catalog is complete.',
      challengeType: 'catalog_complete',
    })
  })

  it('priority C: handles an empty catalog cleanly', () => {
    const result = getNextChallenge([], {}, new Set())
    expect(result).toEqual({
      lessonId: null,
      reason: 'No lessons are available yet.',
      challengeType: 'catalog_complete',
    })
  })
})
