/**
 * Shell, states and accessibility. What a keyboard or screen-reader user gets: one landmark per screen with a skip link,
 * focus that follows navigation, named controls in the circuit editor, status/alert roles that match the situation, and a
 * "Try again" wherever repeating the action makes sense — with the real stores and a mocked client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Lesson } from '@/api'
import { BackendUnavailableError } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'

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
import { StateNotice } from '@/features/shell/StateNotice'
import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '@/features/learn/store'
import { CircuitCanvas } from '@/features/build/CircuitCanvas'
import { GatePalette } from '@/features/build/GatePalette'
import { ResultsPanel } from '@/features/build/ResultsPanel'
import { LearnScreen } from '@/features/learn/LearnScreen'
import { ProgressScreen } from '@/features/progress/ProgressScreen'

const INITIAL_LEARN = useLearnStore.getState()
const INITIAL_BUILD = useBuildStore.getState()

const LESSON: Lesson = {
  id: 'l1',
  title: 'First Lesson',
  shortDescription: 'd',
  concept: 'c',
  difficulty: 'beginner',
  estimatedMinutes: 5,
  learningObjectives: ['o'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'b' }],
  linkedCircuit: null,
  prerequisiteLessonIds: [],
}

const BELL: Circuit = {
  ...emptyCircuit(2, 0),
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([LESSON])
  client.executeCircuit.mockReturnValue(new Promise(() => {}))
  client.askTutor.mockReturnValue(new Promise(() => {}))
  client.traceCircuit.mockReturnValue(new Promise(() => {}))
  useLearnStore.setState(INITIAL_LEARN, true)
  useBuildStore.setState(INITIAL_BUILD, true)
})
afterEach(() => {
  cleanup()
  useLearnStore.setState(INITIAL_LEARN, true)
  useBuildStore.setState(INITIAL_BUILD, true)
})

describe('StateNotice', () => {
  it('loading is a polite status, not an alert', () => {
    render(<StateNotice kind="loading" title="Loading things…" />)
    expect(screen.getByRole('status').textContent).toBe('Loading things…')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('empty announces nothing', () => {
    render(<StateNotice kind="empty" title="Nothing yet." />)
    expect(screen.getByText('Nothing yet.')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('error is an alert with the real detail and hint, and a retry only when one is offered', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<StateNotice kind="error" title="Failed" detail="HTTP 503 from /api/x" hint="Nothing was substituted." onRetry={onRetry} />)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Failed')).toBeTruthy()
    expect(within(alert).getByText('HTTP 503 from /api/x')).toBeTruthy()
    expect(within(alert).getByText('Nothing was substituted.')).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<StateNotice kind="error" title="Failed" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('retry label can be customised', () => {
    render(<StateNotice kind="error" title="x" onRetry={() => {}} retryLabel="Reload lessons" />)
    expect(screen.getByRole('button', { name: 'Reload lessons' })).toBeTruthy()
  })
})

describe('failed lesson fetch can be retried', () => {
  it('Learn: shows the real error, retries, and then shows the lessons', async () => {
    client.listLessons.mockRejectedValueOnce(new BackendUnavailableError('backend down: 503')).mockResolvedValue([LESSON])
    render(<LearnScreen onOpenLab={() => {}} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't load lessons.")
    expect(alert.textContent).toContain('backend down: 503')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('First Lesson')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(client.listLessons).toHaveBeenCalledTimes(2)
  })

  it('Learn: a retry that fails again shows the error again, still with a retry', async () => {
    client.listLessons.mockRejectedValue(new BackendUnavailableError('still down'))
    render(<LearnScreen onOpenLab={() => {}} />)
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(client.listLessons).toHaveBeenCalledTimes(2))
    expect(within(await screen.findByRole('alert')).getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('Progress: retries too, and the streak card stays', async () => {
    client.listLessons.mockRejectedValueOnce(new BackendUnavailableError('backend down')).mockResolvedValue([LESSON])
    render(<ProgressScreen onOpenLesson={() => {}} />)
    const alert = await screen.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getAllByText('First Lesson').length).toBeGreaterThan(0)
  })

  it('an empty catalog is an empty state, not an error', async () => {
    client.listLessons.mockResolvedValue([])
    render(<LearnScreen onOpenLab={() => {}} />)
    expect(await screen.findByText('No lessons are available yet.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('loading is announced as a status', async () => {
    client.listLessons.mockReturnValue(new Promise(() => {}))
    render(<LearnScreen onOpenLab={() => {}} />)
    expect((await screen.findByRole('status')).textContent).toBe('Loading lessons…')
  })
})

describe('a failed run can be retried', () => {
  it('shows the backend error honestly and runs again on Try again', async () => {
    client.executeCircuit.mockReset()
    client.executeCircuit.mockRejectedValueOnce(new BackendUnavailableError('aer not installed')).mockReturnValue(new Promise(() => {}))
    act(() => useBuildStore.getState().loadCircuit(BELL))
    render(<ResultsPanel />)
    await act(async () => {
      await useBuildStore.getState().runExecution()
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Backend unavailable')
    expect(alert.textContent).toContain('aer not installed')
    expect(alert.textContent).toContain('No substitute result is shown')
    const before = client.executeCircuit.mock.calls.length
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(client.executeCircuit.mock.calls.length).toBe(before + 1)
  })

  it('the empty state is plain text, and the running state is a status', () => {
    render(<ResultsPanel />)
    expect(screen.getByText('Add gates to the circuit to run it.')).toBeTruthy()
    act(() => useBuildStore.setState({ isExecuting: true }))
    expect(screen.getByRole('status').textContent).toBe('Running on backend…')
  })
})

describe('landmarks, skip link and focus', () => {
  it('has a skip link to the main content, a labelled primary nav, and exactly one main per screen', async () => {
    render(<App />)
    const skip = screen.getByRole('link', { name: 'Skip to main content' })
    expect(skip.getAttribute('href')).toBe('#main-content')
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy()

    for (const name of ['Lab', 'Learn', 'Progress']) {
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name }))
      const mains = screen.getAllByRole('main')
      expect(mains, name).toHaveLength(1)
      expect(mains[0]!.id, name).toBe('main-content')
      expect(document.getElementById('main-content'), name).toBe(mains[0])
    }
  })

  it('the Lab results and tutor regions are labelled landmarks', () => {
    render(<App />)
    expect(screen.getByRole('complementary', { name: 'Results' })).toBeTruthy()
    expect(screen.getByRole('contentinfo', { name: 'Tutor' })).toBeTruthy()
  })

  it('does not steal focus on first load', () => {
    render(<App />)
    expect(document.activeElement).toBe(document.body)
  })

  it('moving to another screen puts focus on that screen’s main content', () => {
    render(<App />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: 'Progress' }))
    expect(document.activeElement).toBe(screen.getByRole('main'))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: 'Lab' }))
    expect(document.activeElement).toBe(screen.getByRole('main'))
  })

  it('the current screen is marked in the nav', () => {
    render(<App />)
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }))
    expect(nav.getByRole('button', { name: 'Lab' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(nav.getByRole('button', { name: 'Learn' }))
    expect(nav.getByRole('button', { name: 'Learn' }).getAttribute('aria-current')).toBe('page')
    expect(nav.getByRole('button', { name: 'Lab' }).getAttribute('aria-current')).toBeNull()
  })
})

describe('the circuit editor is operable and named', () => {
  function renderEditor(circuit: Circuit = BELL) {
    act(() => useBuildStore.getState().loadCircuit(circuit))
    return render(
      <>
        <GatePalette />
        <CircuitCanvas />
      </>,
    )
  }

  it('every button has an accessible name and is reachable by Tab', () => {
    renderEditor()
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(10)
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? ''
      expect(name.trim().length, button.outerHTML).toBeGreaterThan(0)
      expect(button.getAttribute('tabindex'), button.outerHTML).not.toBe('-1')
    }
  })

  it('a control dot says what gate it belongs to — it used to be an unnamed button', () => {
    renderEditor()
    expect(screen.getByRole('button', { name: /^CX — control q0, target q1, control on q\[0\], step 2 of 2$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'H on q0, step 1 of 2' })).toBeTruthy()
  })

  it('qubit + and − say what they do', () => {
    renderEditor()
    expect(screen.getByRole('button', { name: 'Add a qubit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove a qubit' })).toBeTruthy()
  })

  it('append cells say which qubit and whether a gate is selected', () => {
    renderEditor()
    expect(screen.getByRole('button', { name: 'Append on qubit 0 — select a gate first' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'H' }))
    expect(screen.getByRole('button', { name: 'Place h on qubit 1' })).toBeTruthy()
  })

  it('the selected gate is exposed with aria-pressed, and the half-placed control wire too', () => {
    renderEditor(emptyCircuit(2, 0))
    const cx = screen.getByRole('button', { name: 'CX' })
    expect(cx.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(cx)
    expect(cx.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'H' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Place cx on qubit 0' }))
    expect(screen.getByRole('button', { name: 'Place cx on qubit 0 (already chosen)' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('the placement prompt is announced politely and an error is an alert', () => {
    renderEditor(emptyCircuit(2, 0))
    fireEvent.click(screen.getByRole('button', { name: 'CX' }))
    expect(screen.getByRole('status').textContent).toContain('click a wire')
    act(() => useBuildStore.setState({ canvasError: 'control and target must differ' }))
    expect(screen.getByRole('alert').textContent).toContain('control and target must differ')
  })

  it('the palette is a labelled toolbar and each qubit row a labelled group', () => {
    renderEditor()
    expect(screen.getByRole('toolbar', { name: 'Gate palette' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Circuit editor' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Qubit 0' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Qubit 1' })).toBeTruthy()
  })

  it('placing a gate with the keyboard path works: select (Enter on a button = click) then place', () => {
    renderEditor(emptyCircuit(1, 0))
    fireEvent.click(screen.getByRole('button', { name: 'X' }))
    fireEvent.click(screen.getByRole('button', { name: 'Place x on qubit 0' }))
    expect(useBuildStore.getState().circuit.ops).toHaveLength(1)
    // ...and removal is buttons too: pick the gate, then Delete
    fireEvent.click(screen.getByRole('button', { name: 'X on q0, step 1 of 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the selected gate' }))
    expect(useBuildStore.getState().circuit.ops).toHaveLength(0)
  })
})
