/** Progress with challenges: the recommendation (and why), challenge completion, recent activity, and the honest scope note. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Challenge, Lesson } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import type { LessonProgress } from '../learn/lessonState'

const client = vi.hoisted(() => ({ listLessons: vi.fn(), listChallenges: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { useLearnStore } from '../learn/store'
import { useChallengeStore } from '../challenges/store'
import { emptyRecord } from '../challenges/challengeStorage'
import { ProgressScreen } from './ProgressScreen'

const LESSON: Lesson = {
  id: 'l1',
  title: 'Superposition',
  shortDescription: 'd',
  concept: 'superposition',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'b' }],
  linkedCircuit: null,
  prerequisiteLessonIds: [],
}
const challenge = (id: string): Challenge => ({
  id,
  lessonId: 'l1',
  title: `Challenge ${id}`,
  goal: 'g',
  difficulty: 'beginner',
  successCondition: 's',
  fixedOracle: false,
  constraints: { numQubits: 1, numClbits: 0, allowedGates: ['h'], maxOps: 4, minGateCounts: {}, anchor: [], mustMeasure: [] },
  starterCircuit: emptyCircuit(1, 0),
  checks: [{ id: 'c', label: 'c' }],
  hints: ['a', 'b'],
})
const CHALLENGES = [challenge('one'), challenge('two')]
const DONE: LessonProgress = { activeSectionIndex: 0, completedSectionIds: new Set(['s1']), conceptCheckAttempts: {} }

const INITIAL_LEARN = useLearnStore.getState()
const INITIAL_CHALLENGE = useChallengeStore.getState()

function seed({ done = true, records = {}, recent = [] as { challengeId: string; attemptId: string; passed: boolean; at: string }[] } = {}) {
  useLearnStore.setState({
    lessons: [LESSON],
    lessonProgress: done ? { l1: DONE } : {},
    startedLessonIds: new Set(done ? ['l1'] : []),
  })
  useChallengeStore.setState({ challenges: CHALLENGES, outcomes: { records, recent } })
}

const open = () => {
  const onOpenLesson = vi.fn()
  const onOpenChallenge = vi.fn()
  render(<ProgressScreen onOpenLesson={onOpenLesson} onOpenChallenge={onOpenChallenge} />)
  return { onOpenLesson, onOpenChallenge }
}

beforeEach(() => {
  localStorage.clear()
  client.listLessons.mockReset().mockResolvedValue([LESSON])
  client.listChallenges.mockReset().mockResolvedValue(CHALLENGES)
  useLearnStore.setState(INITIAL_LEARN, true)
  useChallengeStore.setState(INITIAL_CHALLENGE, true)
})
afterEach(cleanup)

describe('the recommendation on Progress', () => {
  it('after finishing a lesson it offers the challenge, with a button that opens that challenge', () => {
    seed()
    const { onOpenChallenge, onOpenLesson } = open()
    expect(screen.getByTestId('recommendation-reason').getAttribute('data-kind')).toBe('try_challenge')
    expect(screen.getByTestId('recommendation-reason').textContent).toContain('Apply it with the challenge "Challenge one"')
    fireEvent.click(screen.getByRole('button', { name: 'Open challenge' }))
    expect(onOpenChallenge).toHaveBeenCalledWith('one')
    fireEvent.click(screen.getByRole('button', { name: 'Go to lesson' }))
    expect(onOpenLesson).toHaveBeenCalledWith('l1')
  })

  it('explains itself: the evidence, and that fixed rules chose it — no AI, no machine learning', () => {
    seed()
    open()
    const why = screen.getByTestId('recommendation-why')
    expect(why.textContent).toContain('"Superposition" is completed.')
    expect(why.textContent).toMatch(/fixed rules/)
    expect(why.textContent).toMatch(/No AI or machine learning/)
  })

  it('a lesson-only situation still gives the lesson recommendation and no challenge button', () => {
    seed({ done: false })
    open()
    expect(screen.getByTestId('recommendation-reason').getAttribute('data-kind')).toBe('next_lesson')
    expect(screen.queryByRole('button', { name: 'Open challenge' })).toBeNull()
  })

  it('a challenge attempted before is continued', () => {
    seed({ records: { two: { ...emptyRecord(), attempts: 2, lastAttemptId: 'att_2' } } })
    open()
    expect(screen.getByTestId('recommendation-reason').getAttribute('data-kind')).toBe('continue_challenge')
  })

  it('after three failures with all hints shown it sends the learner back to the lesson, not the challenge', () => {
    seed({ records: { one: { ...emptyRecord(), attempts: 3, hintsRevealed: 2 } } })
    open()
    expect(screen.getByTestId('recommendation-reason').getAttribute('data-kind')).toBe('revisit_lesson')
    expect(screen.queryByRole('button', { name: 'Open challenge' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Go to lesson' })).toBeInTheDocument()
  })
})

describe('challenge completion and recent activity', () => {
  const AT = '2026-05-01T10:00:00.000Z'
  const records = {
    one: { ...emptyRecord(), attempts: 2, solved: true, hintsRevealed: 1, lastAttemptId: 'att_b', lastPassed: true, lastAt: AT, solvedAt: AT },
    two: { ...emptyRecord(), attempts: 1, lastAttemptId: 'att_c', lastPassed: false, lastAt: AT },
  }
  const recent = [
    { challengeId: 'one', attemptId: 'att_a', passed: false, at: AT },
    { challengeId: 'one', attemptId: 'att_b', passed: true, at: AT },
    { challengeId: 'two', attemptId: 'att_c', passed: false, at: AT },
  ]

  it('counts solved challenges and lists each with its attempts and hints', () => {
    seed({ records, recent })
    open()
    expect(screen.getByTestId('challenges-solved').textContent).toMatch(/1\s*of 2 solved/)
    expect(screen.getByTestId('challenge-row-one').textContent).toMatch(/Solved · 2 attempts · 1 hint/)
    expect(screen.getByTestId('challenge-row-two').textContent).toMatch(/In progress · 1 attempt/)
  })

  it('opens a challenge from its row', () => {
    seed({ records, recent })
    const { onOpenChallenge } = open()
    fireEvent.click(within(screen.getByTestId('challenge-row-two')).getByRole('button', { name: 'Challenge two' }))
    expect(onOpenChallenge).toHaveBeenCalledWith('two')
  })

  it('lists recent attempts newest first, only what was really recorded', () => {
    seed({ records, recent })
    open()
    const items = within(screen.getByTestId('recent-activity')).getAllByRole('listitem')
    expect(items.map((li) => li.textContent?.split(/\s{2,}|(?=\w{3} \d)/)[0])).toEqual(['Tried Challenge two', 'Solved Challenge one', 'Tried Challenge one'])
  })

  it('says so when there is no activity, rather than showing anything', () => {
    seed()
    open()
    expect(screen.getByText('No challenge attempts yet.')).toBeInTheDocument()
    expect(screen.getByTestId('challenges-solved').textContent).toMatch(/0\s*of 2 solved/)
  })

  it('states the limitation plainly: one learner, this browser, no accounts, no cohort', () => {
    seed()
    open()
    const note = screen.getByTestId('progress-scope').textContent!
    expect(note).toMatch(/one learner/)
    expect(note).toMatch(/this browser/)
    expect(note).toMatch(/no accounts/i)
    expect(note).toMatch(/no class or cohort data/)
  })

  it('shows no leaderboard, class or ranking anywhere', () => {
    seed({ records, recent })
    open()
    expect(document.body.textContent).not.toMatch(/leaderboard|rank(ing)?\b|classmates|your class average/i)
  })

  it('renders nothing for challenges when the catalog could not load (the lesson dashboard still works)', () => {
    seed()
    useChallengeStore.setState({ challenges: [] })
    client.listChallenges.mockRejectedValue(new Error('down'))
    open()
    expect(screen.queryByTestId('challenge-progress')).toBeNull()
    expect(screen.getByTestId('recommendation-reason')).toBeInTheDocument()
  })
})
