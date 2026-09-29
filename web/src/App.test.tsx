/**
 * App-level test for the Learn -> Lab -> Learn round trip. This is the only
 * place `App.tsx`'s real `openInLab` (`useBuildStore.loadCircuit` + screen
 * switch) is exercised together with a real `LearnScreen` unmount/remount, so
 * it's what verifies that a lesson resumes on the same step after Lab.
 *
 * `@/api`'s client is mocked: `executeCircuit` never resolves, so Lab's
 * debounced auto-execute can neither fabricate nor fail a result while the
 * screen is mounted — the test only cares about which circuit Lab holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Lesson } from '@/api'
import { emptyCircuit } from '@/circuit/types'

const listLessons = vi.fn()
const traceCircuit = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(() => new Promise(() => {})),
      verifyBellState: vi.fn(() => new Promise(() => {})),
      askTutor: vi.fn(() => new Promise(() => {})),
      optimizeCircuit: vi.fn(() => new Promise(() => {})),
      runMultiInputTest: vi.fn(() => new Promise(() => {})),
      listLessons,
      traceCircuit,
    }),
  }
})

import App from './App'
import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '@/features/learn/store'

const LAB_CIRCUIT = {
  ...emptyCircuit(2, 2),
  ops: [
    { gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx' as const, targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

const LESSON: Lesson = {
  id: 'bell',
  title: 'Bell Lesson',
  shortDescription: 'desc',
  concept: 'entanglement',
  difficulty: 'beginner',
  estimatedMinutes: 10,
  learningObjectives: ['obj'],
  sections: [
    { type: 'explanation', id: 's1', title: 'Intro', body: 'Explanation body.' },
    { type: 'interactive_lab', id: 's2', title: 'Lab', instructions: 'Build it.', capability: 'execute' },
    { type: 'reflection', id: 's3', title: 'Reflect', prompt: 'Reflection prompt.' },
  ],
  linkedCircuit: LAB_CIRCUIT,
  prerequisiteLessonIds: [],
}

const INITIAL_LEARN_STATE = useLearnStore.getState()
const INITIAL_BUILD_STATE = useBuildStore.getState()

describe('App: Learn -> Lab -> Learn', () => {
  beforeEach(() => {
    localStorage.clear()
    listLessons.mockReset()
    listLessons.mockResolvedValue([LESSON])
    traceCircuit.mockReset()
    traceCircuit.mockReturnValue(new Promise(() => {})) // never resolves: only the request is observed
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  afterEach(() => {
    // Unmount before resetting stores: this afterEach runs before RTL's own
    // auto-cleanup, and resetting a store under a still-mounted component
    // is a state update outside act().
    cleanup()
    localStorage.clear()
    useLearnStore.setState(INITIAL_LEARN_STATE, true)
    useBuildStore.setState(INITIAL_BUILD_STATE, true)
  })

  it('Open in Lab loads the lesson circuit into Lab, and returning to Learn resumes the same step without completing it', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Learn' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Bell Lesson/ }))
    await screen.findByText('Explanation body.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // completes s1 -> lab step
    await screen.findByText('Build it.')

    const circuitBefore = useBuildStore.getState().circuit
    expect(circuitBefore).not.toEqual(LAB_CIRCUIT)

    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))

    // Lab now holds the lesson's own canonical circuit (via loadCircuit) and
    // Learn is unmounted.
    expect(useBuildStore.getState().circuit).toEqual(LAB_CIRCUIT)
    expect(screen.queryByText('Build it.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lab' })).toHaveAttribute('aria-current', 'page')

    // Opening the lab step neither completed it nor advanced the step.
    const progress = useLearnStore.getState().lessonProgress.bell
    expect(progress?.completedSectionIds.has('s2') ?? false).toBe(false)
    expect(progress?.activeSectionIndex).toBe(1)

    // Back to Learn: the same lesson, on the same step.
    fireEvent.click(screen.getByRole('button', { name: 'Learn' }))
    expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
    expect(screen.getByText('Build it.')).toBeInTheDocument()
    expect(screen.getByText('1/3 completed')).toBeInTheDocument()

    // Still needs an explicit Continue — Lab never completed anything.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByText('Reflection prompt.')).toBeInTheDocument())
    expect(useLearnStore.getState().lessonProgress.bell?.completedSectionIds.has('s2')).toBe(true)
  })

  it('the Lab has a Trace section, and Run trace sends the circuit the Lab currently holds', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Trace' })).toBeInTheDocument()
    expect(screen.getByText(/No trace yet/)).toBeInTheDocument()
    expect(traceCircuit).not.toHaveBeenCalled()

    const held = useBuildStore.getState().circuit
    fireEvent.click(screen.getByRole('button', { name: 'Run trace' }))

    expect(await screen.findByText('Tracing on backend…')).toBeInTheDocument()
    expect(traceCircuit).toHaveBeenCalledTimes(1)
    expect(traceCircuit.mock.calls[0]![0]).toBe(held)
  })

  it('a lesson circuit opened in the Lab is what Run trace sends', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Learn' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Bell Lesson/ }))
    await screen.findByText('Explanation body.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Build it.')
    fireEvent.click(screen.getByRole('button', { name: 'Open in Lab' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Run trace' }))

    expect(traceCircuit).toHaveBeenCalledTimes(1)
    expect(traceCircuit.mock.calls[0]![0]).toEqual(LAB_CIRCUIT)
    expect(useBuildStore.getState().circuit).toEqual(LAB_CIRCUIT) // unchanged by tracing
  })

  it('Progress is a real navigation button that shows the dashboard and marks itself as the current page', async () => {
    render(<App />)
    const progressNav = screen.getByRole('button', { name: 'Progress' })
    expect(progressNav).not.toHaveAttribute('aria-current')

    fireEvent.click(progressNav)

    expect(await screen.findByRole('heading', { level: 1, name: 'Progress' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Streak' })).toBeInTheDocument()
    // Selected state is exposed semantically (and drawn with an underline, not colour alone).
    expect(screen.getByRole('button', { name: 'Progress' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Lab' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('button', { name: 'Learn' })).not.toHaveAttribute('aria-current')
    // Lab-only toolbar controls are not shown on Progress.
    expect(screen.queryByRole('button', { name: /^Run/ })).not.toBeInTheDocument()
  })

  it('the Progress nav item is a native, focusable <button> (so Tab/Enter/Space work without custom key handling)', () => {
    render(<App />)
    const progressNav = screen.getByRole('button', { name: 'Progress' })
    progressNav.focus()
    expect(progressNav).toHaveFocus()
    expect(progressNav.tagName).toBe('BUTTON')
    expect(progressNav).toHaveAttribute('type', 'button')
    expect(progressNav).not.toHaveAttribute('tabindex', '-1')
  })

  it('opening a lesson from Progress switches to Learn with that lesson selected', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }))
    const row = await screen.findByRole('button', { name: /^Bell Lesson/ })

    fireEvent.click(row)

    // Learn is showing, with the chosen lesson open on its first step.
    expect(await screen.findByText('Explanation body.')).toBeInTheDocument()
    expect(useLearnStore.getState().selectedLessonId).toBe('bell')
    expect(screen.getByRole('button', { name: 'Learn' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('heading', { level: 1, name: 'Progress' })).not.toBeInTheDocument()
  })

  it('reflects a lesson completed in Learn on the Progress screen, without touching Lab', async () => {
    render(<App />)
    const circuitBefore = useBuildStore.getState().circuit

    fireEvent.click(screen.getByRole('button', { name: 'Learn' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Bell Lesson/ }))
    await screen.findByText('Explanation body.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Build it.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Reflection prompt.')
    fireEvent.click(screen.getByRole('button', { name: 'Finish lesson' }))
    await screen.findByRole('heading', { name: 'Lesson complete' })

    fireEvent.click(screen.getByRole('button', { name: 'Progress' }))

    const overall = await screen.findByRole('region', { name: 'Overall progress' })
    expect(overall).toHaveTextContent('100%')
    expect(screen.getByRole('group', { name: 'Current streak: 1 day' })).toBeInTheDocument() // finishing the lesson counted
    expect(useBuildStore.getState().circuit).toBe(circuitBefore)
  })

  it('stepping through a lesson does not touch Lab until Open in Lab is clicked', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Learn' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Bell Lesson/ }))
    await screen.findByText('Explanation body.')

    const circuitBefore = useBuildStore.getState().circuit
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Build it.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Reflection prompt.')
    fireEvent.click(screen.getByRole('button', { name: 'Finish lesson' }))
    await screen.findByRole('heading', { name: 'Lesson complete' })

    expect(useBuildStore.getState().circuit).toBe(circuitBefore)
  })
})
