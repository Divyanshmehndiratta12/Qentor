/** The recommendation is a pure, deterministic function of saved progress. Each rule, the order between them, and the evidence. */
import { describe, expect, it } from 'vitest'
import type { Challenge, Lesson, LessonSection } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { emptyRecord, type ChallengeRecord } from '@/features/challenges/challengeStorage'
import type { LessonProgress } from './lessonState'
import { getRecommendation, STRUGGLE_ATTEMPTS } from './recommendation'

const check = (id: string): LessonSection => ({
  type: 'concept_check',
  id,
  title: 'c',
  prompt: 'q',
  question: 'q?',
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ],
  concept: 'phase',
})
const intro: LessonSection = { type: 'explanation', id: 'intro', title: 'Intro', body: 'b' }

const lesson = (id: string, sections: LessonSection[] = [intro, check('q1')], prereq: string[] = []): Lesson => ({
  id,
  title: `Lesson ${id}`,
  shortDescription: 'd',
  concept: 'phase',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections,
  linkedCircuit: null,
  prerequisiteLessonIds: prereq,
})

const challenge = (id: string, lessonId: string, hints = 3): Challenge => ({
  id,
  lessonId,
  title: `Challenge ${id}`,
  goal: 'g',
  difficulty: 'beginner',
  successCondition: 's',
  fixedOracle: false,
  constraints: { numQubits: 1, numClbits: 0, allowedGates: ['h'], maxOps: 4, minGateCounts: {}, anchor: [], mustMeasure: [] },
  starterCircuit: emptyCircuit(1, 0),
  checks: [{ id: 'c', label: 'c' }],
  hints: Array.from({ length: hints }, (_, i) => `h${i}`),
})

const done = (sections: LessonSection[], correct = true): LessonProgress => ({
  activeSectionIndex: 0,
  completedSectionIds: new Set(sections.map((s) => s.id)),
  conceptCheckAttempts: Object.fromEntries(
    sections.filter((s) => s.type === 'concept_check').map((s) => [s.id, { selectedOptionId: correct ? 'a' : 'b', isCorrect: correct, attemptCount: 1 }]),
  ),
})

const L1 = lesson('l1')
const L2 = lesson('l2', undefined, ['l1'])
const LESSONS = [L1, L2]
const CHALLENGES = [challenge('c1', 'l1'), challenge('c2', 'l1'), challenge('c3', 'l2')]
const rec = (over: Partial<ChallengeRecord> = {}): ChallengeRecord => ({ ...emptyRecord(), ...over })
const started = (...ids: string[]) => new Set(ids)

describe('getRecommendation', () => {
  it('a brand-new learner is sent to the first available lesson, with the same wording as before challenges existed', () => {
    const r = getRecommendation(LESSONS, CHALLENGES, {}, started(), {})
    expect(r).toMatchObject({ kind: 'next_lesson', lessonId: 'l1', challengeId: null })
    expect(r.reason).toBe('"Lesson l1" is next in your learning path.')
    expect(r.evidence).toContain('0 of 2 lessons completed.')
  })

  it('works with no challenge catalog at all (it could not be loaded)', () => {
    const r = getRecommendation(LESSONS, [], {}, started(), {})
    expect(r.kind).toBe('next_lesson')
  })

  it('a completed lesson with an unsolved challenge recommends the first such challenge, and says why', () => {
    const r = getRecommendation(LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), {})
    expect(r).toMatchObject({ kind: 'try_challenge', challengeId: 'c1', lessonId: 'l1' })
    expect(r.reason).toContain('You finished "Lesson l1"')
    expect(r.evidence).toEqual(['"Lesson l1" is completed.', 'Concept checks in "Lesson l1": 1 of 1 correct.'])
  })

  it('never recommends a challenge for a lesson that is not completed', () => {
    const half: LessonProgress = { activeSectionIndex: 1, completedSectionIds: new Set(['intro']), conceptCheckAttempts: {} }
    const r = getRecommendation(LESSONS, CHALLENGES, { l1: half }, started('l1'), {})
    expect(r.kind).toBe('next_lesson')
    expect(r.challengeId).toBeNull()
  })

  it('skips a solved challenge and moves to the next unsolved one', () => {
    const r = getRecommendation(LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), { c1: rec({ attempts: 1, solved: true }) })
    expect(r).toMatchObject({ kind: 'try_challenge', challengeId: 'c2' })
  })

  it('prefers a challenge already attempted (continue) over a fresh one', () => {
    const r = getRecommendation(LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), { c2: rec({ attempts: 2 }) })
    expect(r).toMatchObject({ kind: 'continue_challenge', challengeId: 'c2' })
    expect(r.reason).toContain('2 times')
    expect(r.evidence).toContain('Challenge "Challenge c2": 2 attempts so far, not solved yet.')
  })

  it('after several failures with every hint shown it sends the learner back to the lesson', () => {
    const r = getRecommendation(LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), {
      c1: rec({ attempts: STRUGGLE_ATTEMPTS, hintsRevealed: 3 }),
    })
    expect(r).toMatchObject({ kind: 'revisit_lesson', lessonId: 'l1', challengeId: 'c1' })
    expect(r.evidence[0]).toContain('all 3 hints shown')
  })

  it('but not while hints remain unseen, or below the attempt threshold', () => {
    const a = getRecommendation(LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), { c1: rec({ attempts: 5, hintsRevealed: 2 }) })
    expect(a.kind).toBe('continue_challenge')
    const b = getRecommendation(LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), { c1: rec({ attempts: STRUGGLE_ATTEMPTS - 1, hintsRevealed: 3 }) })
    expect(b.kind).toBe('continue_challenge')
  })

  it('a solved challenge is never a struggle', () => {
    const r = getRecommendation(LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), { c1: rec({ attempts: 9, hintsRevealed: 3, solved: true }) })
    expect(r.kind).not.toBe('revisit_lesson')
  })

  it('an unresolved misconception outranks every challenge rule', () => {
    const wrong = done(L1.sections, false)
    wrong.conceptCheckAttempts.q1 = { selectedOptionId: 'b', isCorrect: false, attemptCount: 2 }
    const r = getRecommendation(LESSONS, CHALLENGES, { l1: wrong }, started('l1'), { c1: rec({ attempts: 9, hintsRevealed: 3 }) })
    expect(r.kind).toBe('address_misconception')
    expect(r.lessonId).toBe('l1')
    expect(r.challengeId).toBeNull()
  })

  it('once lesson 1 is done and its challenges solved, the next lesson is recommended with its prerequisites as evidence', () => {
    const records = { c1: rec({ attempts: 1, solved: true }), c2: rec({ attempts: 1, solved: true }) }
    const r = getRecommendation(LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), records)
    expect(r).toMatchObject({ kind: 'next_lesson', lessonId: 'l2' })
    expect(r.evidence).toContain('1 of 2 lessons completed.')
    expect(r.evidence).toContain('Prerequisites for "Lesson l2" are complete: Lesson l1.')
  })

  it('a challenge for a lesson the catalog no longer has is ignored', () => {
    const r = getRecommendation(LESSONS, [challenge('ghost', 'gone')], { l1: done(L1.sections) }, started('l1'), {})
    expect(r.kind).toBe('next_lesson')
  })

  it('everything done says so, and offers nowhere to go', () => {
    const progress = { l1: done(L1.sections), l2: done(L2.sections) }
    const records = Object.fromEntries(CHALLENGES.map((c) => [c.id, rec({ attempts: 1, solved: true })]))
    const r = getRecommendation(LESSONS, CHALLENGES, progress, started('l1', 'l2'), records)
    expect(r).toMatchObject({ kind: 'all_done', lessonId: null, challengeId: null })
    expect(r.reason).toBe('Every lesson in the current catalog is complete.')
  })

  it('no lessons at all', () => {
    expect(getRecommendation([], [], {}, started(), {}).reason).toBe('No lessons are available yet.')
  })

  it('is deterministic: the same saved data always gives the same answer', () => {
    const args = [LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), { c2: rec({ attempts: 2 }) }] as const
    expect(getRecommendation(...args)).toEqual(getRecommendation(...args))
  })

  it('does not depend on the order the records object was built in', () => {
    const a = { c1: rec({ attempts: 1 }), c2: rec({ attempts: 1 }) }
    const b = { c2: rec({ attempts: 1 }), c1: rec({ attempts: 1 }) }
    const args = (records: typeof a) => [LESSONS, CHALLENGES, { l1: done(L1.sections) }, started('l1'), records] as const
    expect(getRecommendation(...args(a))).toEqual(getRecommendation(...args(b)))
  })
})
