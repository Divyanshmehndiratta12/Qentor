/**
 * Tests for the Progress dashboard. State is seeded directly into the real
 * `useLearnStore` (rather than clicking through Learn) so each scenario is
 * exact; `@/api`'s client is mocked only so the "fetch when there is no
 * catalog yet" path can run without a backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Lesson } from '@/api'
import type { LessonProgress } from '../learn/lessonState'

const listLessons = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(),
      verifyBellState: vi.fn(),
      askTutor: vi.fn(),
      optimizeCircuit: vi.fn(),
      runMultiInputTest: vi.fn(),
      listLessons,
    }),
  }
})

import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '../learn/store'
import { ProgressScreen } from './ProgressScreen'

function checkSection(id: string, concept: string, correctOptionId = 'x'): Lesson['sections'][number] {
  return {
    type: 'concept_check',
    id,
    title: `Check ${id}`,
    prompt: 'q',
    question: `Question ${id}?`,
    options: [
      { id: 'x', text: 'X' },
      { id: 'y', text: 'Y' },
    ],
    correctOptionId,
    explanation: 'because',
    concept,
  }
}

const LESSON_A: Lesson = {
  id: 'a',
  title: 'Lesson A',
  shortDescription: 'first',
  concept: 'superposition',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'b' }],
  linkedCircuit: null,
  prerequisiteLessonIds: [],
}

const LESSON_B: Lesson = {
  id: 'b',
  title: 'Lesson B',
  shortDescription: 'second',
  concept: 'phase',
  difficulty: 'intermediate',
  estimatedMinutes: 10,
  learningObjectives: ['o'],
  sections: [
    { type: 'explanation', id: 's1', title: 'Intro', body: 'b' },
    checkSection('s2', 'phase'),
    checkSection('s3', 'phase'),
  ],
  linkedCircuit: null,
  prerequisiteLessonIds: ['a'],
}

const LESSON_C: Lesson = {
  id: 'c',
  title: 'Lesson C',
  shortDescription: 'third',
  concept: 'entanglement',
  difficulty: 'advanced',
  estimatedMinutes: 10,
  learningObjectives: ['o'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'b' }],
  linkedCircuit: null,
  prerequisiteLessonIds: ['b'],
}

const LESSONS = [LESSON_A, LESSON_B, LESSON_C]

function progress(overrides: Partial<LessonProgress> = {}): LessonProgress {
  return { activeSectionIndex: 0, completedSectionIds: new Set(), conceptCheckAttempts: {}, ...overrides }
}

const attempt = (isCorrect: boolean, attemptCount = 1) => ({
  selectedOptionId: isCorrect ? 'x' : 'y',
  isCorrect,
  attemptCount,
})

/** Lesson A fully complete (no checks -> mastered). */
const A_COMPLETE = progress({ completedSectionIds: new Set(['s1']), activeSectionIndex: 1 })

const INITIAL_LEARN_STATE = useLearnStore.getState()
const INITIAL_BUILD_STATE = useBuildStore.getState()

function seed(state: Partial<ReturnType<typeof useLearnStore.getState>>) {
  useLearnStore.setState(state)
}

function renderScreen(onOpenLesson = vi.fn()) {
  render(<ProgressScreen onOpenLesson={onOpenLesson} />)
  return onOpenLesson
}

const region = (name: string) => screen.getByRole('region', { name })

describe('ProgressScreen', () => {
  beforeEach(() => {
    listLessons.mockReset()
    localStorage.clear()
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 29, 12, 0, 0)) // 2026-09-29 local
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    localStorage.clear()
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  describe('zero state', () => {
    beforeEach(() => seed({ lessons: LESSONS }))

    it('shows 0% overall and nothing started or completed', () => {
      renderScreen()
      const overall = region('Overall progress')
      expect(within(overall).getByText('0%')).toBeInTheDocument()
      // "Lessons started" and "Lessons completed" both read 0 of 3.
      expect(within(overall).getAllByText('0 of 3', { selector: 'dd' })).toHaveLength(2)
      expect(within(overall).getByRole('progressbar', { name: 'Overall lesson completion' })).toHaveAttribute(
        'aria-valuenow',
        '0',
      )
    })

    it('says "No attempts yet" instead of a misleading 0% accuracy', () => {
      renderScreen()
      const checks = region('Concept-check performance')
      expect(within(checks).getByText('No attempts yet')).toBeInTheDocument()
      expect(within(checks).queryByText(/accuracy/)).not.toBeInTheDocument()
      expect(within(checks).getByText('0 of 2')).toBeInTheDocument() // attempted of total (Lesson B has 2 checks)
    })

    it('puts every lesson in the "Not started" mastery bucket', () => {
      renderScreen()
      const mastery = region('Mastery')
      expect(within(mastery).getByText('Not started').previousElementSibling).toHaveTextContent('3')
      expect(within(mastery).getByText('Mastered').previousElementSibling).toHaveTextContent('0')
    })

    it('has no needs-attention signals and recommends the first available lesson', () => {
      renderScreen()
      expect(within(region('Needs attention')).getByText('No open signals right now.')).toBeInTheDocument()
      expect(within(region('Next challenge')).getByText('"Lesson A" is next in your learning path.')).toBeInTheDocument()
    })

    it('shows an empty streak', () => {
      renderScreen()
      expect(screen.getByRole('group', { name: 'Current streak: 0 days' })).toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Longest streak: 0 days' })).toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Last activity: No activity yet' })).toBeInTheDocument()
      expect(screen.getByText(/Active on 0 of the last 7 days/)).toBeInTheDocument()
    })

    it('lists every lesson as not started, with dependents shown as locked and disabled', () => {
      renderScreen()
      const list = within(region('Lessons'))
      expect(list.getAllByText('Not started')).toHaveLength(3)
      expect(list.getByRole('button', { name: /^Lesson A/ })).toBeEnabled()
      expect(list.getByRole('button', { name: 'Lesson B — locked, complete Lesson A first' })).toBeDisabled()
      expect(list.getByRole('button', { name: 'Lesson C — locked, complete Lesson B first' })).toBeDisabled()
    })
  })

  describe('partial progress', () => {
    beforeEach(() => {
      seed({
        lessons: LESSONS,
        startedLessonIds: new Set(['a', 'b']),
        lessonProgress: {
          a: A_COMPLETE,
          // B: intro done, first check answered correctly, second wrong twice.
          b: progress({
            completedSectionIds: new Set(['s1']),
            conceptCheckAttempts: { s2: attempt(true), s3: attempt(false, 2) },
          }),
        },
      })
    })

    it('reports started / completed counts and the completion percentage', () => {
      renderScreen()
      const overall = region('Overall progress')
      expect(within(overall).getByText('33%')).toBeInTheDocument()
      expect(within(overall).getByText('2 of 3', { selector: 'dd' })).toBeInTheDocument() // started
      expect(within(overall).getByText('1 of 3', { selector: 'dd' })).toBeInTheDocument() // completed
      expect(within(overall).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33')
      expect(within(overall).getByRole('progressbar')).toHaveAttribute(
        'aria-valuetext',
        '1 of 3 lessons completed',
      )
    })

    it('reports concept-check attempted / correct / accuracy from the latest answers', () => {
      renderScreen()
      const checks = region('Concept-check performance')
      expect(within(checks).getByText('50%')).toBeInTheDocument() // 1 correct of 2 attempted
      expect(within(checks).getByText('accuracy')).toBeInTheDocument()
      expect(within(checks).getByText('2 of 2')).toBeInTheDocument()
      expect(within(checks).getByText('1', { selector: 'dd' })).toBeInTheDocument()
    })

    it('buckets mastery via the existing rule: A mastered, B developing, C not started', () => {
      renderScreen()
      const mastery = region('Mastery')
      expect(within(mastery).getByText('Mastered').previousElementSibling).toHaveTextContent('1')
      expect(within(mastery).getByText('Developing').previousElementSibling).toHaveTextContent('1')
      expect(within(mastery).getByText('Not started').previousElementSibling).toHaveTextContent('1')
    })

    it('surfaces the existing repeated-incorrect misconception signal', () => {
      renderScreen()
      expect(
        within(region('Needs attention')).getByRole('button', { name: /phase: 2 incorrect attempts/ }),
      ).toBeInTheDocument()
    })

    it('recommends addressing the misconception (getNextChallenge priority A)', () => {
      renderScreen()
      expect(within(region('Next challenge')).getByText('phase: 2 incorrect attempts')).toBeInTheDocument()
    })

    it('shows per-lesson status, mastery, and section progress as text', () => {
      renderScreen()
      const list = within(region('Lessons'))

      const a = list.getByRole('button', { name: /^Lesson A/ })
      expect(within(a).getByText('Completed')).toBeInTheDocument()
      expect(within(a).getByText('Mastery: Mastered')).toBeInTheDocument()
      expect(within(a).getByText('1/1 sections')).toBeInTheDocument()

      const b = list.getByRole('button', { name: /^Lesson B/ })
      expect(within(b).getByText('Developing')).toBeInTheDocument()
      expect(within(b).queryByText(/Mastery:/)).not.toBeInTheDocument() // not meaningful until complete
      expect(within(b).getByText('1/3 sections')).toBeInTheDocument()
      expect(within(b).getByText('phase')).toBeInTheDocument() // concept
    })
  })

  describe('completed lessons', () => {
    it('shows 100%, every lesson completed, and the catalog-complete message', () => {
      seed({
        lessons: LESSONS,
        startedLessonIds: new Set(['a', 'b', 'c']),
        lessonProgress: {
          a: A_COMPLETE,
          b: progress({
            completedSectionIds: new Set(['s1', 's2', 's3']),
            conceptCheckAttempts: { s2: attempt(true), s3: attempt(true) },
          }),
          c: progress({ completedSectionIds: new Set(['s1']) }),
        },
      })
      renderScreen()

      expect(within(region('Overall progress')).getByText('100%')).toBeInTheDocument()
      expect(within(region('Concept-check performance')).getByText('100%')).toBeInTheDocument()
      expect(within(region('Mastery')).getByText('Mastered').previousElementSibling).toHaveTextContent('3')
      expect(within(region('Next challenge')).getByText('Every lesson in the current catalog is complete.')).toBeInTheDocument()
      expect(within(region('Next challenge')).queryByRole('button')).not.toBeInTheDocument()
      expect(within(region('Lessons')).getAllByText('Completed')).toHaveLength(3)
      // Nothing is locked any more.
      expect(within(region('Lessons')).getAllByRole('button').every((b) => !(b as HTMLButtonElement).disabled)).toBe(true)
    })

    it('shows a completed-but-low-accuracy lesson as Completed with Developing mastery', () => {
      seed({
        lessons: [LESSON_A, LESSON_B],
        startedLessonIds: new Set(['a', 'b']),
        lessonProgress: {
          a: A_COMPLETE,
          b: progress({
            completedSectionIds: new Set(['s1', 's2', 's3']),
            conceptCheckAttempts: { s2: attempt(false), s3: attempt(false) },
          }),
        },
      })
      renderScreen()

      const b = within(region('Lessons')).getByRole('button', { name: /^Lesson B/ })
      expect(within(b).getByText('Completed')).toBeInTheDocument()
      expect(within(b).getByText('Mastery: Developing')).toBeInTheDocument()
    })
  })

  describe('streak and recent activity', () => {
    it('renders current streak, longest streak and last activity (today)', () => {
      seed({
        lessons: LESSONS,
        activityHistory: {
          activityDates: ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-27', '2026-09-28', '2026-09-29'],
        },
      })
      renderScreen()

      expect(screen.getByRole('group', { name: 'Current streak: 3 days' })).toHaveTextContent('3')
      expect(screen.getByRole('group', { name: 'Longest streak: 4 days' })).toHaveTextContent('4')
      expect(screen.getByRole('group', { name: 'Last activity: Today (2026-09-29)' })).toBeInTheDocument()
    })

    it('keeps a streak alive from yesterday and labels last activity "Yesterday"', () => {
      seed({ lessons: LESSONS, activityHistory: { activityDates: ['2026-09-27', '2026-09-28'] } })
      renderScreen()

      expect(screen.getByRole('group', { name: 'Current streak: 2 days' })).toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Last activity: Yesterday (2026-09-28)' })).toBeInTheDocument()
    })

    it('resets the current streak to 0 after a gap but keeps the longest', () => {
      seed({ lessons: LESSONS, activityHistory: { activityDates: ['2026-09-20', '2026-09-21', '2026-09-22'] } })
      renderScreen()

      expect(screen.getByRole('group', { name: 'Current streak: 0 days' })).toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Longest streak: 3 days' })).toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Last activity: 2026-09-22' })).toBeInTheDocument()
    })

    it('uses singular "day" for a 1-day streak', () => {
      seed({ lessons: LESSONS, activityHistory: { activityDates: ['2026-09-29'] } })
      renderScreen()
      expect(screen.getByRole('group', { name: 'Current streak: 1 day' })).toBeInTheDocument()
    })

    it('renders a 7-day strip with a text alternative for every day', () => {
      seed({ lessons: LESSONS, activityHistory: { activityDates: ['2026-09-24', '2026-09-27', '2026-09-29'] } })
      renderScreen()

      const strip = screen.getByRole('list', { name: 'Activity over the last 7 days' })
      const days = within(strip).getAllByRole('listitem')
      expect(days).toHaveLength(7)

      // Oldest first, ending today; each item states its state in words.
      const stateOf = (i: number) => days[i]!.textContent
      expect(stateOf(0)).toContain('2026-09-23: no activity')
      expect(stateOf(1)).toContain('2026-09-24: active')
      expect(stateOf(4)).toContain('2026-09-27: active')
      expect(stateOf(5)).toContain('2026-09-28: no activity')
      expect(stateOf(6)).toContain('2026-09-29: active')
      expect(days[6]).toHaveTextContent('Today')

      expect(screen.getByText(/Active on 3 of the last 7 days/)).toBeInTheDocument()
    })

    it('shows the streak even when the catalog fails to load', async () => {
      listLessons.mockRejectedValueOnce(new Error('could not reach the Qentor backend'))
      seed({ activityHistory: { activityDates: ['2026-09-29'] } })
      renderScreen()

      expect(await screen.findByRole('alert')).toHaveTextContent('could not reach the Qentor backend')
      expect(screen.getByRole('group', { name: 'Current streak: 1 day' })).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Overall progress' })).not.toBeInTheDocument()
    })

    it('states plainly that the streak is local to this browser', () => {
      seed({ lessons: LESSONS })
      renderScreen()
      expect(screen.getByText('this browser only')).toBeInTheDocument()
      expect(screen.getByText(/not an account, not shared, and not a global streak/)).toBeInTheDocument()
    })
  })

  describe('navigation out of Progress', () => {
    beforeEach(() => {
      seed({
        lessons: LESSONS,
        startedLessonIds: new Set(['a', 'b']),
        lessonProgress: {
          a: A_COMPLETE,
          b: progress({ completedSectionIds: new Set(['s1']), conceptCheckAttempts: { s3: attempt(false, 2) } }),
        },
      })
    })

    it('clicking an available lesson row opens that lesson', () => {
      const onOpenLesson = renderScreen()
      fireEvent.click(within(region('Lessons')).getByRole('button', { name: /^Lesson B/ }))
      expect(onOpenLesson).toHaveBeenCalledExactlyOnceWith('b')
    })

    it('a locked lesson row cannot be opened', () => {
      const onOpenLesson = renderScreen()
      const locked = within(region('Lessons')).getByRole('button', { name: /Lesson C — locked/ })
      expect(locked).toBeDisabled()
      fireEvent.click(locked)
      expect(onOpenLesson).not.toHaveBeenCalled()
    })

    it('a needs-attention signal opens its lesson', () => {
      const onOpenLesson = renderScreen()
      fireEvent.click(within(region('Needs attention')).getByRole('button', { name: /phase: 2 incorrect attempts/ }))
      expect(onOpenLesson).toHaveBeenCalledExactlyOnceWith('b')
    })

    it('"Go to lesson" opens the recommended next-challenge lesson', () => {
      const onOpenLesson = renderScreen()
      fireEvent.click(within(region('Next challenge')).getByRole('button', { name: 'Go to lesson' }))
      expect(onOpenLesson).toHaveBeenCalledExactlyOnceWith('b')
    })

    it('every lesson row and action is a real, keyboard-focusable button', () => {
      renderScreen()
      const rows = within(region('Lessons')).getAllByRole('button')
      expect(rows).toHaveLength(3)
      const enabled = rows.filter((b) => !(b as HTMLButtonElement).disabled)
      for (const row of enabled) {
        row.focus()
        expect(row).toHaveFocus()
      }
    })
  })

  describe('loading the catalog', () => {
    it('fetches the real catalog when there is none yet', async () => {
      listLessons.mockResolvedValueOnce([LESSON_A])
      renderScreen()

      await waitFor(() => expect(listLessons).toHaveBeenCalledTimes(1))
      expect(await screen.findByRole('region', { name: 'Overall progress' })).toBeInTheDocument()
      expect(within(region('Lessons')).getByRole('button', { name: /^Lesson A/ })).toBeInTheDocument()
    })

    it('does not refetch when the catalog is already loaded', () => {
      seed({ lessons: LESSONS })
      renderScreen()
      expect(listLessons).not.toHaveBeenCalled()
    })

    it('shows a loading state and no fabricated lesson data while loading', () => {
      listLessons.mockReturnValueOnce(new Promise(() => {}))
      renderScreen()
      expect(screen.getByText(/Loading lessons/)).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Lessons' })).not.toBeInTheDocument()
    })

    it('shows a clean empty state for an empty catalog', async () => {
      listLessons.mockResolvedValueOnce([])
      renderScreen()
      expect(await screen.findByText('No lessons are available yet.')).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Lessons' })).not.toBeInTheDocument()
    })

    it('does not loop refetching after a failed load', async () => {
      listLessons.mockRejectedValue(new Error('backend down'))
      renderScreen()
      await screen.findByRole('alert')
      expect(listLessons).toHaveBeenCalledTimes(1)
    })
  })

  describe('isolation', () => {
    it('never mutates any Build/Lab state, however the dashboard is used', () => {
      seed({
        lessons: LESSONS,
        startedLessonIds: new Set(['a', 'b']),
        lessonProgress: { a: A_COMPLETE, b: progress({ conceptCheckAttempts: { s3: attempt(false, 2) } }) },
        activityHistory: { activityDates: ['2026-09-29'] },
      })
      const before = useBuildStore.getState()
      const onOpenLesson = renderScreen()

      fireEvent.click(within(region('Lessons')).getByRole('button', { name: /^Lesson A/ }))
      fireEvent.click(within(region('Needs attention')).getByRole('button', { name: /phase/ }))
      fireEvent.click(within(region('Next challenge')).getByRole('button', { name: 'Go to lesson' }))

      expect(onOpenLesson).toHaveBeenCalledTimes(3)
      // Same object: not a single Build/Lab field (circuit, result,
      // verification, optimization, tutor turns, multi-input) was set.
      expect(useBuildStore.getState()).toBe(before)
    })

    it('rendering and interacting never records activity or alters lesson progress', () => {
      seed({ lessons: LESSONS })
      const before = useLearnStore.getState()
      renderScreen()
      fireEvent.click(within(region('Lessons')).getByRole('button', { name: /^Lesson A/ }))

      expect(useLearnStore.getState().activityHistory).toBe(before.activityHistory)
      expect(useLearnStore.getState().lessonProgress).toBe(before.lessonProgress)
      expect(localStorage.getItem('qentor.learn.activity.v1')).toBeNull()
    })
  })
})
