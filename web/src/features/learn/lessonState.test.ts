import { describe, expect, it } from 'vitest'
import type { Lesson } from '@/api'
import { getLessonState } from './lessonState'

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: 'l1',
    title: 'Lesson',
    shortDescription: 'desc',
    concept: 'concept',
    difficulty: 'beginner',
    estimatedMinutes: 10,
    learningObjectives: ['obj'],
    sections: [],
    linkedCircuit: null,
    prerequisiteLessonIds: [],
    ...overrides,
  }
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
