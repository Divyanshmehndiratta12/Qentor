/** No dead ends: the welcome entry, Learn → its challenges, and the way back. `@/api` is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Challenge, Lesson } from '@/api'
import { emptyCircuit } from '@/circuit/types'

const client = vi.hoisted(() => ({
  listLessons: vi.fn(),
  listChallenges: vi.fn(),
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
import { useBuildStore } from '@/features/build/store'
import { useChallengeStore } from '@/features/challenges/store'
import { useLearnStore } from '@/features/learn/store'
import { WELCOME_KEY } from './WelcomeCard'

const LESSON: Lesson = {
  id: 'superposition',
  title: 'Superposition Lesson',
  shortDescription: 'd',
  concept: 'superposition',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'Body.' }],
  linkedCircuit: null,
  prerequisiteLessonIds: [],
}
const challenge = (id: string, lessonId: string): Challenge => ({
  id,
  lessonId,
  title: `Challenge ${id}`,
  goal: `Goal ${id}.`,
  difficulty: 'beginner',
  successCondition: 's',
  fixedOracle: false,
  constraints: { numQubits: 1, numClbits: 0, allowedGates: ['h'], maxOps: 4, minGateCounts: {}, anchor: [], anchorName: 'oracle', mustMeasure: [], gateQubits: {} },
  starterCircuit: emptyCircuit(1, 0),
  checks: [{ id: 'c', label: 'c' }],
  hints: ['h'],
})

const INITIAL_CHALLENGE = useChallengeStore.getState()
const INITIAL_LEARN = useLearnStore.getState()
const INITIAL_BUILD = useBuildStore.getState()

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([LESSON])
  client.listChallenges.mockResolvedValue([challenge('mine', 'superposition'), challenge('other', 'elsewhere')])
  client.executeCircuit.mockReturnValue(new Promise(() => {}))
  useChallengeStore.setState(INITIAL_CHALLENGE, true)
  useLearnStore.setState(INITIAL_LEARN, true)
  useBuildStore.setState(INITIAL_BUILD, true)
})
afterEach(cleanup)

describe('the welcome entry', () => {
  it('greets a first visit on the Lab: the name, what it is, the headline, and the two actions', () => {
    render(<App />)
    const w = screen.getByTestId('welcome')
    expect(within(w).getByText(/Qentor · Interactive quantum learning/)).toBeInTheDocument()
    expect(within(w).getByRole('heading', { level: 2, name: 'Learn quantum algorithms by building and running circuits' })).toBeInTheDocument()
    expect(within(w).getByRole('button', { name: 'Start learning' })).toBeInTheDocument()
    expect(within(w).getByRole('button', { name: 'Try a challenge' })).toBeInTheDocument()
  })

  it('says where the numbers come from in three short points, not a wall of text', () => {
    render(<App />)
    const points = within(screen.getByRole('list', { name: 'What Qentor does' })).getAllByRole('listitem')
    expect(points.map((p) => p.textContent?.split(' · ')[0])).toEqual(['Build', 'Verify', 'Ask Qubi'])
    expect(points[1]).toHaveTextContent(/computed by a real simulator on the server, and says which one/)
    expect(points[2]).toHaveTextContent(/never produces them, and it never decides whether you are right/)
  })

  it('keeps the workflow and the five-step path behind "How Qentor works", closed until asked for', () => {
    render(<App />)
    const w = screen.getByTestId('welcome')
    const help = within(w).getByTestId('how-it-works') as HTMLDetailsElement
    expect(help.open).toBe(false)
    expect(within(w).getByText('How Qentor works')).toBeInTheDocument()

    fireEvent.click(within(w).getByText('How Qentor works'))
    expect(help.open).toBe(true)
    const flow = within(w).getByRole('list', { name: 'The Lab, in order' })
    expect(within(flow).getAllByRole('listitem').map((i) => i.textContent?.replace('→', '').trim())).toEqual(['Circuit', 'Gates', 'Code', 'Run', 'Results', 'Tutor'])
    expect(within(within(w).getByRole('list', { name: 'Learning path' })).getAllByRole('listitem')).toHaveLength(5)

    fireEvent.click(within(w).getByText('How Qentor works'))
    expect(help.open).toBe(false)
  })

  it('the summary is keyboard-operable and the five lines are not permanently displayed', () => {
    render(<App />)
    const summary = within(screen.getByTestId('welcome')).getByText('How Qentor works').closest('summary')!
    expect(summary.tagName).toBe('SUMMARY')
    expect(summary.className).toContain('focus-visible:outline')
    expect((screen.getByTestId('how-it-works') as HTMLDetailsElement).open).toBe(false)
  })

  it('"Start learning" goes to Learn; "Try a challenge" goes to Challenges', () => {
    render(<App />)
    fireEvent.click(within(screen.getByTestId('welcome')).getByRole('button', { name: 'Start learning' }))
    expect(window.location.pathname).toBe('/learn')
    cleanup()
    window.history.replaceState(null, '', '/')
    render(<App />)
    fireEvent.click(within(screen.getByTestId('welcome')).getByRole('button', { name: 'Try a challenge' }))
    expect(window.location.pathname).toBe('/challenges')
  })

  it('is only on the Lab, not on the other screens', () => {
    window.history.replaceState(null, '', '/learn')
    render(<App />)
    expect(screen.queryByTestId('welcome')).toBeNull()
  })

  it('"Not now" dismisses it and it stays dismissed after a reload', () => {
    render(<App />)
    fireEvent.click(within(screen.getByTestId('welcome')).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByTestId('welcome')).toBeNull()
    expect(localStorage.getItem(WELCOME_KEY)).toBe('1')
    cleanup()
    render(<App />)
    expect(screen.queryByTestId('welcome')).toBeNull()
  })

  it('is not shown to someone who has already started a lesson', () => {
    useLearnStore.setState({ startedLessonIds: new Set(['superposition']) })
    render(<App />)
    expect(screen.queryByTestId('welcome')).toBeNull()
  })

  it('still shows (and works) when the browser refuses to save the dismissal', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    render(<App />)
    fireEvent.click(within(screen.getByTestId('welcome')).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByTestId('welcome')).toBeNull()
    spy.mockRestore()
  })

  it('is one main landmark still, and the Lab is unchanged beneath it', () => {
    render(<App />)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('toolbar', { name: 'Gate palette' })).toBeInTheDocument()
  })
})

describe('Learn leads on to its challenges', () => {
  async function openLesson() {
    window.history.replaceState(null, '', '/learn')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Superposition Lesson/ }))
    await screen.findByText('Body.')
  }

  it('shows only the challenges that belong to the open lesson', async () => {
    await openLesson()
    const practice = await screen.findByTestId('lesson-challenges')
    expect(within(practice).getByRole('button', { name: 'Challenge mine' })).toBeInTheDocument()
    expect(within(practice).queryByRole('button', { name: 'Challenge other' })).toBeNull()
    expect(within(practice).getByText(/Ready to try it/)).toBeInTheDocument()
  })

  it('opening one goes to that challenge, ready to solve', async () => {
    await openLesson()
    fireEvent.click(within(await screen.findByTestId('lesson-challenges')).getByRole('button', { name: 'Challenge mine' }))
    await screen.findByRole('heading', { level: 2, name: 'Challenge mine' })
    expect(window.location.pathname).toBe('/challenges/mine')
  })

  it('says the lesson is finished once it is', async () => {
    await openLesson()
    fireEvent.click(await screen.findByRole('button', { name: /Finish|Continue/ }))
    await waitFor(() => expect(screen.getByTestId('lesson-challenges').textContent).toMatch(/You finished this lesson/))
  })

  it('a lesson with no challenge shows no practice card, and Learn still works if challenges cannot load', async () => {
    client.listChallenges.mockRejectedValue(new Error('down'))
    await openLesson()
    expect(screen.queryByTestId('lesson-challenges')).toBeNull()
    expect(screen.getByText('Body.')).toBeInTheDocument()
  })
})

describe('Progress leads on to a challenge', () => {
  it('a recommended challenge opens directly from Progress', async () => {
    window.history.replaceState(null, '', '/progress')
    useLearnStore.setState({
      lessons: [LESSON],
      startedLessonIds: new Set(['superposition']),
      lessonProgress: { superposition: { activeSectionIndex: 0, completedSectionIds: new Set(['s1']), conceptCheckAttempts: {} } },
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open challenge' }))
    await screen.findByRole('heading', { level: 2, name: 'Challenge mine' })
    expect(window.location.pathname).toBe('/challenges/mine')
  })
})
