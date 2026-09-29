import { describe, expect, it } from 'vitest'
import type { Lesson, LessonSection } from '@/api'
import {
  MASTERY_ACCURACY_THRESHOLD,
  canContinueFromSection,
  getConceptCheckScore,
  getLessonMastery,
  getLessonState,
  isFullConceptCheck,
  isLessonComplete,
  type LessonProgress,
} from './lessonState'

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

function fullConceptCheck(id: string, correctOptionId = 'a'): LessonSection {
  return {
    type: 'concept_check',
    id,
    title: 'Check',
    prompt: 'q',
    question: 'q?',
    options: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ],
    correctOptionId,
    explanation: 'because',
    concept: 'concept',
  }
}

function promptOnlyConceptCheck(id: string): LessonSection {
  return {
    type: 'concept_check',
    id,
    title: 'Check',
    prompt: 'q',
    question: null,
    options: null,
    correctOptionId: null,
    explanation: null,
    concept: null,
  }
}

function progress(overrides: Partial<LessonProgress> = {}): LessonProgress {
  return { activeSectionIndex: 0, completedSectionIds: new Set(), conceptCheckAttempts: {}, ...overrides }
}

describe('getLessonState', () => {
  it('is available when there are no prerequisites', () => {
    expect(getLessonState(lesson({ prerequisiteLessonIds: [] }), new Set())).toBe('available')
  })

  it('is locked when a prerequisite has not been completed', () => {
    const l = lesson({ id: 'l2', prerequisiteLessonIds: ['l1'] })
    expect(getLessonState(l, new Set())).toBe('locked')
  })

  it('is available once every prerequisite is completed', () => {
    const l = lesson({ id: 'l2', prerequisiteLessonIds: ['l1'] })
    expect(getLessonState(l, new Set(['l1']))).toBe('available')
  })

  it('is locked if only some prerequisites are completed', () => {
    const l = lesson({ id: 'l3', prerequisiteLessonIds: ['l1', 'l2'] })
    expect(getLessonState(l, new Set(['l1']))).toBe('locked')
  })

  it('is completed when the lesson itself is marked complete, even with unmet prerequisites', () => {
    const l = lesson({ id: 'l2', prerequisiteLessonIds: ['l1'] })
    expect(getLessonState(l, new Set(['l2']))).toBe('completed')
  })
})

describe('isFullConceptCheck', () => {
  it('is true for a section with a real question', () => {
    expect(isFullConceptCheck(fullConceptCheck('s1'))).toBe(true)
  })

  it('is false for a prompt-only concept check', () => {
    expect(isFullConceptCheck(promptOnlyConceptCheck('s1'))).toBe(false)
  })

  it('is false for a non-concept_check section', () => {
    expect(isFullConceptCheck({ type: 'explanation', id: 's1', title: 't', body: 'b' })).toBe(false)
  })
})

describe('isLessonComplete', () => {
  it('is false with no progress at all', () => {
    const l = lesson({ sections: [{ type: 'explanation', id: 's1', title: 't', body: 'b' }] })
    expect(isLessonComplete(l, undefined)).toBe(false)
  })

  it('is false when some sections have not been explicitly completed', () => {
    const l = lesson({
      sections: [
        { type: 'explanation', id: 's1', title: 't', body: 'b' },
        { type: 'reflection', id: 's2', title: 't2', prompt: 'p' },
      ],
    })
    expect(isLessonComplete(l, progress({ completedSectionIds: new Set(['s1']) }))).toBe(false)
  })

  it('is true once every section is explicitly completed and there are no concept checks', () => {
    const l = lesson({
      sections: [
        { type: 'explanation', id: 's1', title: 't', body: 'b' },
        { type: 'reflection', id: 's2', title: 't2', prompt: 'p' },
      ],
    })
    expect(isLessonComplete(l, progress({ completedSectionIds: new Set(['s1', 's2']) }))).toBe(true)
  })

  it('is false when a real concept check has not been attempted, even if the section is marked completed', () => {
    const l = lesson({ sections: [fullConceptCheck('s1')] })
    expect(isLessonComplete(l, progress({ completedSectionIds: new Set(['s1']) }))).toBe(false)
  })

  it('is true once a real concept check has been attempted (correct or not) and the section completed', () => {
    const l = lesson({ sections: [fullConceptCheck('s1')] })
    const p = progress({
      completedSectionIds: new Set(['s1']),
      conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 } },
    })
    expect(isLessonComplete(l, p)).toBe(true)
  })

  it('does not require an attempt for a prompt-only concept check', () => {
    const l = lesson({ sections: [promptOnlyConceptCheck('s1')] })
    expect(isLessonComplete(l, progress({ completedSectionIds: new Set(['s1']) }))).toBe(true)
  })
})

describe('canContinueFromSection', () => {
  it('allows continuing from an explanation section immediately', () => {
    const section: LessonSection = { type: 'explanation', id: 's1', title: 't', body: 'b' }
    expect(canContinueFromSection(section, undefined)).toBe(true)
  })

  it('allows continuing from a reflection section immediately', () => {
    const section: LessonSection = { type: 'reflection', id: 's1', title: 't', prompt: 'p' }
    expect(canContinueFromSection(section, undefined)).toBe(true)
  })

  it('allows continuing from an interactive_lab section immediately', () => {
    const section: LessonSection = {
      type: 'interactive_lab',
      id: 's1',
      title: 't',
      instructions: 'i',
      capability: 'execute',
    }
    expect(canContinueFromSection(section, undefined)).toBe(true)
  })

  it('allows continuing from a prompt-only concept check immediately', () => {
    expect(canContinueFromSection(promptOnlyConceptCheck('s1'), undefined)).toBe(true)
  })

  it('blocks continuing from a full concept check until it has been attempted', () => {
    const section = fullConceptCheck('s1')
    expect(canContinueFromSection(section, undefined)).toBe(false)
    expect(canContinueFromSection(section, progress())).toBe(false)
  })

  it('allows continuing from a full concept check once attempted, regardless of correctness', () => {
    const section = fullConceptCheck('s1')
    const p = progress({
      conceptCheckAttempts: { s1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 } },
    })
    expect(canContinueFromSection(section, p)).toBe(true)
  })
})

describe('getConceptCheckScore', () => {
  it('reports zero attempted/correct with no progress', () => {
    const l = lesson({ sections: [fullConceptCheck('s1'), fullConceptCheck('s2')] })
    expect(getConceptCheckScore(l, undefined)).toEqual({ attempted: 0, correct: 0, total: 2 })
  })

  it('counts only question-bearing concept checks toward total', () => {
    const l = lesson({ sections: [fullConceptCheck('s1'), promptOnlyConceptCheck('s2')] })
    expect(getConceptCheckScore(l, undefined).total).toBe(1)
  })

  it('counts attempted and correct from the latest attempt per section', () => {
    const l = lesson({ sections: [fullConceptCheck('s1'), fullConceptCheck('s2')] })
    const p = progress({
      conceptCheckAttempts: {
        s1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 },
        s2: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 },
      },
    })
    expect(getConceptCheckScore(l, p)).toEqual({ attempted: 2, correct: 1, total: 2 })
  })
})

describe('getLessonMastery (unchanged rule, now fed by explicit completion)', () => {
  it('is not_started when the lesson has never been started', () => {
    const l = lesson({ sections: [fullConceptCheck('s1')] })
    expect(getLessonMastery(l, undefined, false)).toBe('not_started')
  })

  it('is developing once started but not complete', () => {
    const l = lesson({ sections: [fullConceptCheck('s1')] })
    expect(getLessonMastery(l, progress(), true)).toBe('developing')
  })

  it('is developing when complete but below the accuracy threshold', () => {
    const l = lesson({ sections: [fullConceptCheck('s1'), fullConceptCheck('s2')] })
    const p = progress({
      completedSectionIds: new Set(['s1', 's2']),
      conceptCheckAttempts: {
        s1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 },
        s2: { selectedOptionId: 'b', isCorrect: false, attemptCount: 1 },
      },
    })
    // 1/2 = 0.5, below MASTERY_ACCURACY_THRESHOLD.
    expect(getLessonMastery(l, p, true)).toBe('developing')
  })

  it(`is mastered when complete with accuracy >= ${MASTERY_ACCURACY_THRESHOLD}`, () => {
    const l = lesson({ sections: [fullConceptCheck('s1')] })
    const p = progress({
      completedSectionIds: new Set(['s1']),
      conceptCheckAttempts: { s1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 } },
    })
    expect(getLessonMastery(l, p, true)).toBe('mastered')
  })

  it('is mastered once complete when the lesson has no question-bearing concept checks at all', () => {
    const l = lesson({ sections: [{ type: 'explanation', id: 's1', title: 't', body: 'b' }] })
    const p = progress({ completedSectionIds: new Set(['s1']) })
    expect(getLessonMastery(l, p, true)).toBe('mastered')
  })
})
