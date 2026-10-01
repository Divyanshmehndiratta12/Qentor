/**
 * axe-core (jsdom, structural rules) over the classroom screens: Classroom (join, teach, instructor dashboard populated and empty) and
 * the shell with the class indicator. Names, roles, headings, labels,
 * duplicate ids, table structure. Colour contrast is covered from the theme (`a11y/contrast.test.ts`) and in the real-browser audit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'

const client = vi.hoisted(() => ({
  listLessons: vi.fn(),
  listChallenges: vi.fn(),
  getGenerationStatus: vi.fn(),
  getMyClass: vi.fn(),
  getClassDashboard: vi.fn(),
  regradeConceptChecks: vi.fn(),
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  traceCircuit: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import App from '@/App'
import type { ClassDashboard } from '@/api'
import { useBuildStore } from '@/features/build/store'
import { resetClassroomForTests } from './store'

const KEY = 'qi_' + 'b'.repeat(32)
const TOKEN = 'ql_' + 'a'.repeat(32)
const INITIAL_BUILD = useBuildStore.getState()

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } },
  })
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)
}

const DASH: ClassDashboard = {
  classCode: 'WXYZ-6789',
  title: 'Period 3',
  createdAt: 'c',
  learnersInClass: 2,
  learnersLeft: 0,
  activeLearners: 2,
  activeWindowDays: 7,
  eventsTotal: 8,
  empty: false,
  dataNote: 'Anonymous classroom data.',
  lessons: [{ lessonId: 'a', title: 'Superposition', started: 2, completed: 1, developing: 1, assessmentAnswered: 4, assessmentCorrect: 3, checks: [] }],
  challenges: [{ challengeId: 'c', title: 'Bell pair', lessonId: 'a', started: 2, attemptingLearners: 2, attempts: 3, solvedLearners: 1, failedAttempts: 2, failurePatterns: [{ checkId: 'k', label: 'Entangled', count: 2, learners: 1 }] }],
  misconceptions: [{ kind: 'concept', category: 'kickback', lessonId: 'a', challengeId: null, learnersAffected: 1, stillIncorrect: 1, sampleSize: 2, explanation: null }],
  recent: [{ alias: 'Learner 4F2A', kind: 'lesson_started', subjectId: 'a', subjectLabel: 'Superposition', outcome: null, createdAt: '2026-10-01T12:00:00Z' }],
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  localStorage.setItem('qentor.welcome.dismissed', '1')
  resetClassroomForTests()
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([])
  client.listChallenges.mockResolvedValue([])
  client.regradeConceptChecks.mockResolvedValue([])
  client.getGenerationStatus.mockResolvedValue({ available: false, provider: null, model: null, reason: 'none' })
  useBuildStore.setState(INITIAL_BUILD, true)
})
afterEach(cleanup)

describe('axe: the classroom screens', () => {
  it('Classroom: join and teach, with no violations and one level-one heading', async () => {
    window.history.replaceState(null, '', '/classroom')
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Classroom' })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(await violations()).toEqual([])
  })

  it('Classroom: in a class, with a created class and a populated dashboard', async () => {
    resetClassroomForTests({
      learnerToken: TOKEN,
      membership: { classCode: 'ABCD-2345', classTitle: 'Period 3', alias: 'Learner 4F2A' },
      teaching: [{ classCode: 'WXYZ-6789', title: 'Period 3', instructorKey: KEY, createdAt: 'c' }],
    })
    client.getMyClass.mockResolvedValue({ inClass: true, tokenKnown: true, classCode: 'ABCD-2345', classTitle: 'Period 3', alias: 'Learner 4F2A', joinedAt: 'j' })
    client.getClassDashboard.mockResolvedValue(DASH)
    window.history.replaceState(null, '', '/classroom')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open dashboard' }))
    await screen.findByTestId('lessons-table')
    expect(await violations()).toEqual([])
  })

  it('Classroom: an empty class dashboard', async () => {
    resetClassroomForTests({ learnerToken: null, membership: null, teaching: [{ classCode: 'WXYZ-6789', title: 'Period 3', instructorKey: KEY, createdAt: 'c' }] })
    client.getClassDashboard.mockResolvedValue({ ...DASH, empty: true, learnersInClass: 0, activeLearners: 0, eventsTotal: 0, lessons: [], challenges: [], misconceptions: [], recent: [] })
    window.history.replaceState(null, '', '/classroom')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open dashboard' }))
    await screen.findByTestId('dashboard-empty')
    expect(await violations()).toEqual([])
  })

  it('the shell with the class indicator in both states', async () => {
    window.history.replaceState(null, '', '/')
    const { unmount } = render(<App />)
    expect(await screen.findByTestId('class-chip')).toHaveAttribute('data-in-class', 'false')
    expect(await violations()).toEqual([])
    unmount()
    resetClassroomForTests({ learnerToken: TOKEN, membership: { classCode: 'ABCD-2345', classTitle: 'Period 3', alias: 'Learner 4F2A' }, teaching: [] })
    client.getMyClass.mockResolvedValue({ inClass: true, tokenKnown: true, classCode: 'ABCD-2345', classTitle: 'Period 3', alias: 'Learner 4F2A', joinedAt: 'j' })
    render(<App />)
    expect(await screen.findByTestId('class-chip')).toHaveAttribute('data-in-class', 'true')
    expect(await violations()).toEqual([])
  })
})
