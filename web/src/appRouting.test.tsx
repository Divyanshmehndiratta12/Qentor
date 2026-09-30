/**
 * The address bar and the screen stay in step: a direct visit to /learn or /progress opens that screen, navigating updates the
 * path, Back/Forward follow it. (The server serves the same shell for each of these paths — backend/tests/test_static_site.py.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { challengeIdFromPath, pathForChallenge, pathForScreen, screenFromPath } from '@/features/shell/routes'

const client = vi.hoisted(() => ({
  listLessons: vi.fn(),
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

import App from './App'
import type { Lesson } from '@/api'
import { emptyCircuit } from '@/circuit/types'

const LAB_LESSON: Lesson = {
  id: 'bell',
  title: 'Bell Lesson',
  shortDescription: 'd',
  concept: 'entanglement',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections: [{ type: 'interactive_lab', id: 's1', title: 'Lab', instructions: 'Build it.', capability: 'execute' }],
  linkedCircuit: {
    ...emptyCircuit(1, 0),
    ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }],
  },
  prerequisiteLessonIds: [],
}

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([])
  client.executeCircuit.mockReturnValue(new Promise(() => {}))
})
afterEach(cleanup)

const nav = () => within(screen.getByRole('navigation', { name: 'Primary' }))
const current = () => nav().getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page')?.textContent

describe('paths and screens', () => {
  it.each([
    ['/', 'lab'],
    ['/learn', 'learn'],
    ['/progress', 'progress'],
    ['/challenges', 'challenges'],
    ['/challenges/', 'challenges'],
    ['/challenges/create-bell', 'challenges'],
    ['/learn/', 'learn'],
    ['/progress//', 'progress'],
    ['/unknown', 'lab'],
    ['/learn/deep/link', 'lab'],
    ['/LEARN', 'lab'],
    ['', 'lab'],
  ])('%j shows %s', (path, screenName) => {
    expect(screenFromPath(path)).toBe(screenName)
  })

  it('every screen has exactly one path, and it maps back', () => {
    for (const screenName of ['lab', 'learn', 'challenges', 'progress'] as const) {
      expect(screenFromPath(pathForScreen(screenName))).toBe(screenName)
    }
    expect(new Set(['lab', 'learn', 'challenges', 'progress'].map((s) => pathForScreen(s as 'lab'))).size).toBe(4)
  })

  it.each([
    ['/challenges/create-bell', 'create-bell'],
    ['/challenges/create-bell/', 'create-bell'],
    ['/challenges', null],
    ['/challenges/', null],
    ['/learn/create-bell', null],
    ['/challenges/Create-Bell', null],
    ['/challenges/a/b', null],
    ['/challenges/%3Cscript%3E', null],
    ['/challenges/' + 'x'.repeat(81), null],
  ])('the challenge id in %j is %j', (path, id) => {
    expect(challengeIdFromPath(path)).toBe(id)
  })

  it('a challenge path maps back to its id', () => {
    expect(challengeIdFromPath(pathForChallenge('create-one'))).toBe('create-one')
    expect(pathForChallenge(null)).toBe('/challenges')
  })
})

describe('the app follows the address bar', () => {
  it('a direct visit to /learn opens Learn, and /progress opens Progress', () => {
    window.history.replaceState(null, '', '/learn')
    render(<App />)
    expect(current()).toBe('Learn')
    cleanup()
    window.history.replaceState(null, '', '/progress')
    render(<App />)
    expect(current()).toBe('Progress')
  })

  it('an unknown path opens the Lab', () => {
    window.history.replaceState(null, '', '/nowhere')
    render(<App />)
    expect(current()).toBe('Lab')
  })

  it('navigating updates the path', () => {
    render(<App />)
    fireEvent.click(nav().getByRole('button', { name: 'Learn' }))
    expect(window.location.pathname).toBe('/learn')
    fireEvent.click(nav().getByRole('button', { name: 'Progress' }))
    expect(window.location.pathname).toBe('/progress')
    fireEvent.click(nav().getByRole('button', { name: 'Lab' }))
    expect(window.location.pathname).toBe('/')
  })

  it('clicking the screen you are already on adds no history entry', () => {
    window.history.replaceState(null, '', '/learn')
    render(<App />)
    const before = window.history.length
    fireEvent.click(nav().getByRole('button', { name: 'Learn' }))
    expect(window.history.length).toBe(before)
  })

  it('Back and Forward move between screens (popstate)', () => {
    render(<App />)
    fireEvent.click(nav().getByRole('button', { name: 'Learn' }))
    expect(current()).toBe('Learn')
    act(() => {
      window.history.replaceState(null, '', '/progress') // what the browser does when the entry changes
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(current()).toBe('Progress')
    act(() => {
      window.history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(current()).toBe('Lab')
  })

  it('the real history.back() also moves the screen', async () => {
    render(<App />)
    fireEvent.click(nav().getByRole('button', { name: 'Learn' }))
    fireEvent.click(nav().getByRole('button', { name: 'Progress' }))
    act(() => window.history.back())
    await waitFor(() => expect(current()).toBe('Learn'))
    expect(window.location.pathname).toBe('/learn')
  })

  it('Open in Lab (from a lesson) moves the address to the Lab', async () => {
    client.listLessons.mockResolvedValue([LAB_LESSON])
    window.history.replaceState(null, '', '/learn')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /Bell Lesson/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Lab' }))
    expect(current()).toBe('Lab')
    expect(window.location.pathname).toBe('/')
  })

  it('opening a lesson from Progress moves the address to Learn', async () => {
    client.listLessons.mockResolvedValue([LAB_LESSON])
    window.history.replaceState(null, '', '/progress')
    render(<App />)
    const lessonsRegion = (await screen.findByRole('heading', { name: 'Lessons' })).closest('section') as HTMLElement
    fireEvent.click(within(lessonsRegion).getByRole('button', { name: /^Bell Lesson/ }))
    expect(current()).toBe('Learn')
    expect(window.location.pathname).toBe('/learn')
  })

  it('stops listening to popstate when unmounted', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<App />)
    unmount()
    expect(remove).toHaveBeenCalledWith('popstate', expect.any(Function))
    remove.mockRestore()
  })
})
