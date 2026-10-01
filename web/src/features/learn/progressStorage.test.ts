/**
 * The persisted-progress format on its own: round trip, defensive parsing of untrusted stored data, versioning, and
 * reconciliation against the real lesson catalog. No store, no React.
 */
import { describe, expect, it } from 'vitest'
import type { Lesson, LessonSection } from '@/api'
import type { KeyValueStorage } from './browserStorage'
import {
  MIGRATIONS,
  PROGRESS_SCHEMA_VERSION,
  PROGRESS_STORAGE_KEY,
  PROGRESS_UNREADABLE_KEY,
  emptyLearnerProgress,
  localStorageProgressStore,
  parseProgress,
  reconcileProgress,
  serializeProgress,
  type LearnerProgress,
} from './progressStorage'

const check = (id: string): LessonSection => ({
  type: 'concept_check',
  id,
  title: 'Check',
  prompt: 'q',
  question: 'q?',
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ],
  concept: 'superposition',
})

const lesson = (id: string, sections: LessonSection[]): Lesson => ({
  id,
  title: id,
  shortDescription: 'd',
  concept: 'c',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections,
  linkedCircuit: null,
  prerequisiteLessonIds: [],
})

const INTRO: LessonSection = { type: 'explanation', id: 'intro', title: 'Intro', body: 'b' }

const SAMPLE: LearnerProgress = {
  startedLessonIds: new Set(['l1', 'l2']),
  lessonProgress: {
    l1: {
      activeSectionIndex: 2,
      completedSectionIds: new Set(['intro', 'q1']),
      conceptCheckAttempts: { q1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 3 } },
    },
  },
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage: KeyValueStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
  }
  return { storage, data }
}

describe('serialize / parse', () => {
  it('round-trips progress exactly', () => {
    const parsed = parseProgress(serializeProgress(SAMPLE))!
    expect(parsed.startedLessonIds).toEqual(SAMPLE.startedLessonIds)
    expect(parsed.lessonProgress).toEqual(SAMPLE.lessonProgress)
  })

  it('writes the documented, versioned, sorted format', () => {
    expect(JSON.parse(serializeProgress(SAMPLE))).toEqual({
      version: 1,
      startedLessonIds: ['l1', 'l2'],
      lessons: {
        l1: {
          activeSectionIndex: 2,
          completedSectionIds: ['intro', 'q1'],
          conceptCheckAttempts: { q1: { selectedOptionId: 'b', isCorrect: false, attemptCount: 3 } },
        },
      },
    })
  })

  it('serialises equal progress identically regardless of insertion order', () => {
    const a: LearnerProgress = { startedLessonIds: new Set(['x', 'y']), lessonProgress: {} }
    const b: LearnerProgress = { startedLessonIds: new Set(['y', 'x']), lessonProgress: {} }
    expect(serializeProgress(a)).toBe(serializeProgress(b))
  })

  it('serialises completed sections and attempts in a stable order too', () => {
    const lp = (ids: string[]) => ({ activeSectionIndex: 0, completedSectionIds: new Set(ids), conceptCheckAttempts: {} })
    const a: LearnerProgress = { startedLessonIds: new Set(), lessonProgress: { l1: lp(['b', 'a', 'c']) } }
    const b: LearnerProgress = { startedLessonIds: new Set(), lessonProgress: { l1: lp(['c', 'a', 'b']) } }
    expect(serializeProgress(a)).toBe(serializeProgress(b))
    expect(JSON.parse(serializeProgress(a)).lessons.l1.completedSectionIds).toEqual(['a', 'b', 'c'])
  })

  it('stores facts only — no derived completion, mastery or misconception fields', () => {
    const stored = JSON.parse(serializeProgress(SAMPLE))
    expect(Object.keys(stored).sort()).toEqual(['lessons', 'startedLessonIds', 'version'])
    expect(Object.keys(stored.lessons.l1).sort()).toEqual(['activeSectionIndex', 'completedSectionIds', 'conceptCheckAttempts'])
    expect(Object.keys(stored.lessons.l1.conceptCheckAttempts.q1).sort()).toEqual(['attemptCount', 'isCorrect', 'selectedOptionId'])
  })
})

describe('parsing untrusted stored data', () => {
  it.each([
    ['not JSON', '{{ nope'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
    ['no version', '{"lessons":{}}'],
    ['a non-integer version', '{"version":1.5,"lessons":{}}'],
    ['a string version', '{"version":"1","lessons":{}}'],
    ['version 0', '{"version":0,"lessons":{}}'],
    ['a newer version this build does not know', `{"version":${PROGRESS_SCHEMA_VERSION + 1},"lessons":{}}`],
    ['lessons that is not an object', '{"version":1,"lessons":[1,2]}'],
    ['missing lessons', '{"version":1}'],
  ])('%s → unreadable (null), never a guess', (_name, raw) => {
    expect(parseProgress(raw)).toBeNull()
  })

  it('drops individual bad entries and keeps the good ones', () => {
    const raw = JSON.stringify({
      version: 1,
      startedLessonIds: ['ok', 7, '', null, 'ok', 'also-ok'],
      lessons: {
        good: {
          activeSectionIndex: 1,
          completedSectionIds: ['s1', 9, 's1', ''],
          conceptCheckAttempts: {
            q1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 },
            q2: { selectedOptionId: 'a', isCorrect: 'yes', attemptCount: 1 },
            q3: { selectedOptionId: 'a', isCorrect: true, attemptCount: 0 },
            q4: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1.5 },
            q5: { selectedOptionId: '', isCorrect: true, attemptCount: 1 },
            q6: 'garbage',
          },
        },
        bad: 'not an object',
        alsoBad: [1, 2],
      },
    })
    const parsed = parseProgress(raw)!
    expect([...parsed.startedLessonIds]).toEqual(['ok', 'also-ok'])
    expect(Object.keys(parsed.lessonProgress)).toEqual(['good'])
    expect([...parsed.lessonProgress.good!.completedSectionIds]).toEqual(['s1'])
    expect(Object.keys(parsed.lessonProgress.good!.conceptCheckAttempts)).toEqual(['q1'])
  })

  it('repairs an invalid activeSectionIndex to 0 rather than rejecting the lesson', () => {
    for (const bad of [-1, 1.5, '2', null, 10_000]) {
      const raw = JSON.stringify({ version: 1, lessons: { l: { activeSectionIndex: bad, completedSectionIds: ['s'], conceptCheckAttempts: {} } } })
      const parsed = parseProgress(raw)!
      expect(parsed.lessonProgress.l!.activeSectionIndex).toBe(0)
      expect(parsed.lessonProgress.l!.completedSectionIds.has('s')).toBe(true)
    }
  })

  it('bounds runaway input', () => {
    const lessons: Record<string, unknown> = {}
    for (let i = 0; i < 700; i += 1) lessons[`l${i}`] = { activeSectionIndex: 0, completedSectionIds: [], conceptCheckAttempts: {} }
    const parsed = parseProgress(JSON.stringify({ version: 1, lessons }))!
    expect(Object.keys(parsed.lessonProgress).length).toBe(500)
    const longId = 'x'.repeat(201)
    const parsedLong = parseProgress(JSON.stringify({ version: 1, startedLessonIds: [longId], lessons: {} }))!
    expect(parsedLong.startedLessonIds.size).toBe(0)
  })

  it('does not let a poisoned key reach the prototype', () => {
    const raw = '{"version":1,"lessons":{"__proto__":{"activeSectionIndex":0,"completedSectionIds":[],"conceptCheckAttempts":{}}}}'
    parseProgress(raw)
    expect(({} as Record<string, unknown>).activeSectionIndex).toBeUndefined()
  })
})

describe('version migration', () => {
  it('the shipped chain is empty, and a current-version blob runs no migration step', () => {
    // Version 1 is the only version that exists, so the shipped table is empty and a current-version blob runs no step.
    expect(Object.keys(MIGRATIONS)).toEqual([])
    const neverRuns = () => {
      throw new Error('must not run at the current version')
    }
    expect(parseProgress('{"version":1,"lessons":{}}', { 1: neverRuns })).not.toBeNull()
  })

  it('upgrades an older blob through every step in order (chain exercised with a pretend version 3)', () => {
    const order: number[] = []
    const migrations = {
      1: (d: Record<string, unknown>) => {
        order.push(1)
        return { ...d, lessons: d.oldLessons }
      },
      2: (d: Record<string, unknown>) => {
        order.push(2)
        return { ...d, startedLessonIds: ['from-step-2'] }
      },
    }
    const raw = JSON.stringify({ version: 1, oldLessons: { l: { activeSectionIndex: 1, completedSectionIds: [], conceptCheckAttempts: {} } } })
    const parsed = parseProgress(raw, migrations, 3)!
    expect(order).toEqual([1, 2])
    expect(parsed.lessonProgress.l!.activeSectionIndex).toBe(1)
    expect([...parsed.startedLessonIds]).toEqual(['from-step-2'])
  })

  it('a step that throws, or a gap in the chain, makes the blob unreadable', () => {
    const raw = JSON.stringify({ version: 1, lessons: {} })
    expect(parseProgress(raw, { 1: () => { throw new Error('bad') } }, 2)).toBeNull()
    expect(parseProgress(raw, {}, 3)).toBeNull()
    expect(parseProgress(JSON.stringify({ version: 4, lessons: {} }), {}, 3)).toBeNull()
  })

  it('version 0 is never valid, even if a step were registered for it', () => {
    expect(parseProgress('{"version":0,"lessons":{}}', { 0: (d) => d })).toBeNull()
  })

  it('a version below the current one with a missing step is unreadable, not guessed', () => {
    expect(parseProgress('{"version":0,"lessons":{}}', {})).toBeNull()
  })
})

describe('reconcileProgress against the real catalog', () => {
  const L1 = lesson('l1', [INTRO, check('q1'), check('q2')])

  it('keeps valid progress; the saved verdict stays PROVISIONAL (the catalog has no key to check it against)', () => {
    const stored: LearnerProgress = {
      startedLessonIds: new Set(['l1']),
      lessonProgress: {
        l1: {
          activeSectionIndex: 1,
          completedSectionIds: new Set(['intro']),
          conceptCheckAttempts: {
            q1: { selectedOptionId: 'a', isCorrect: false, attemptCount: 1 },
            q2: { selectedOptionId: 'a', isCorrect: true, attemptCount: 2 },
          },
        },
      },
    }
    const out = reconcileProgress([L1], stored).lessonProgress.l1!
    // reconcile keeps the verdicts exactly as saved: only the server (regradeSavedAnswers, see store.test / progressPersistence.test)
    // may replace one, and nothing here can decide correctness because the catalog carries no answer key
    expect(out.conceptCheckAttempts.q1).toEqual({ selectedOptionId: 'a', isCorrect: false, attemptCount: 1 })
    expect(out.conceptCheckAttempts.q2).toEqual({ selectedOptionId: 'a', isCorrect: true, attemptCount: 2 })
    expect(out.activeSectionIndex).toBe(1)
  })

  it('an in-memory explanation is kept only with the attempt it explained, and is never serialised', () => {
    const stored: LearnerProgress = {
      startedLessonIds: new Set(['l1']),
      lessonProgress: {
        l1: {
          activeSectionIndex: 0,
          completedSectionIds: new Set(),
          conceptCheckAttempts: { q1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1, explanation: 'because' } },
        },
      },
    }
    expect(reconcileProgress([L1], stored).lessonProgress.l1!.conceptCheckAttempts.q1!.explanation).toBe('because')
    expect(serializeProgress(stored)).not.toContain('because')
    expect(JSON.parse(serializeProgress(stored)).lessons.l1.conceptCheckAttempts.q1).toEqual({ selectedOptionId: 'a', isCorrect: true, attemptCount: 1 })
  })

  it('a saved explanation in storage is ignored on load (it comes back from the server)', () => {
    const raw = JSON.stringify({
      version: 1,
      startedLessonIds: ['l1'],
      lessons: { l1: { activeSectionIndex: 0, completedSectionIds: [], conceptCheckAttempts: { q1: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1, explanation: 'planted' } } } },
    })
    expect(parseProgress(raw)!.lessonProgress.l1!.conceptCheckAttempts.q1).toEqual({ selectedOptionId: 'a', isCorrect: true, attemptCount: 1 })
  })

  it('drops lessons, sections and options the catalog no longer has', () => {
    const stored: LearnerProgress = {
      startedLessonIds: new Set(['l1', 'gone']),
      lessonProgress: {
        gone: { activeSectionIndex: 0, completedSectionIds: new Set(['x']), conceptCheckAttempts: {} },
        l1: {
          activeSectionIndex: 0,
          completedSectionIds: new Set(['intro', 'deleted-section']),
          conceptCheckAttempts: {
            q1: { selectedOptionId: 'removed-option', isCorrect: true, attemptCount: 1 },
            'deleted-check': { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 },
            intro: { selectedOptionId: 'a', isCorrect: true, attemptCount: 1 }, // not a concept check
          },
        },
      },
    }
    const out = reconcileProgress([L1], stored)
    expect(Object.keys(out.lessonProgress)).toEqual(['l1'])
    expect([...out.startedLessonIds]).toEqual(['l1'])
    expect([...out.lessonProgress.l1!.completedSectionIds]).toEqual(['intro'])
    expect(out.lessonProgress.l1!.conceptCheckAttempts).toEqual({})
  })

  it('clamps a stale section index into the lesson', () => {
    const stored: LearnerProgress = {
      startedLessonIds: new Set(),
      lessonProgress: { l1: { activeSectionIndex: 150, completedSectionIds: new Set(), conceptCheckAttempts: {} } },
    }
    expect(reconcileProgress([L1], stored).lessonProgress.l1!.activeSectionIndex).toBe(2)
  })

  it('a lesson with recorded progress counts as started', () => {
    const stored: LearnerProgress = {
      startedLessonIds: new Set(),
      lessonProgress: { l1: { activeSectionIndex: 0, completedSectionIds: new Set(['intro']), conceptCheckAttempts: {} } },
    }
    expect(reconcileProgress([L1], stored).startedLessonIds.has('l1')).toBe(true)
  })

  it('does not mutate its input', () => {
    const stored = parseProgress(serializeProgress(SAMPLE))!
    const before = serializeProgress(stored)
    reconcileProgress([lesson('l1', [INTRO])], stored)
    expect(serializeProgress(stored)).toBe(before)
  })
})

describe('the localStorage store', () => {
  it('load: nothing stored → empty; stored → loaded', () => {
    const { storage } = fakeStorage()
    const store = localStorageProgressStore(() => storage)
    expect(store.load().status).toBe('empty')
    store.save(SAMPLE)
    const loaded = store.load()
    expect(loaded.status).toBe('loaded')
    expect(loaded.progress.lessonProgress).toEqual(SAMPLE.lessonProgress)
  })

  it('unreadable data → recovered: starts empty and keeps the raw text aside instead of destroying it', () => {
    const { storage, data } = fakeStorage({ [PROGRESS_STORAGE_KEY]: '{{ corrupt' })
    const loaded = localStorageProgressStore(() => storage).load()
    expect(loaded.status).toBe('recovered')
    expect(loaded.progress).toEqual(emptyLearnerProgress())
    expect(data.get(PROGRESS_UNREADABLE_KEY)).toBe('{{ corrupt')
  })

  it('an unknown newer version is recovered the same way (set aside, not overwritten blind)', () => {
    const raw = `{"version":${PROGRESS_SCHEMA_VERSION + 1},"lessons":{}}`
    const { storage, data } = fakeStorage({ [PROGRESS_STORAGE_KEY]: raw })
    expect(localStorageProgressStore(() => storage).load().status).toBe('recovered')
    expect(data.get(PROGRESS_UNREADABLE_KEY)).toBe(raw)
  })

  it('no storage at all → empty load, failed save, failed probe (session-only)', () => {
    const store = localStorageProgressStore(() => null)
    expect(store.load().status).toBe('empty')
    expect(store.save(SAMPLE)).toBe(false)
    expect(store.probe()).toBe(false)
  })

  it('a storage that throws on read, write or probe never throws to the caller', () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('nope')
      },
    }
    const store = localStorageProgressStore(() => throwing)
    expect(store.load().status).toBe('empty')
    expect(store.save(SAMPLE)).toBe(false)
    expect(store.probe()).toBe(false)
  })

  it('probe leaves no trace behind', () => {
    const { storage, data } = fakeStorage()
    expect(localStorageProgressStore(() => storage).probe()).toBe(true)
    expect([...data.keys()]).toEqual([])
  })
})
