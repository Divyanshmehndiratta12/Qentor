/**
 * The Lab's "Expand canvas" toggle, in the real App: the canvas region becomes a full-window overlay with the gate palette under it, the rest of
 * the page (welcome banner, code pane, results, tutor footer, top bar, Qubi) is hidden, Esc or the button leaves it, and nothing about the circuit,
 * Undo/Redo or placement changes. `@/api` is mocked and never resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(() => new Promise(() => {})),
      verifyBellState: vi.fn(() => new Promise(() => {})),
      optimizeCircuit: vi.fn(() => new Promise(() => {})),
      runMultiInputTest: vi.fn(() => new Promise(() => {})),
      traceCircuit: vi.fn(() => new Promise(() => {})),
      generateCode: vi.fn(() => new Promise(() => {})),
      getGenerationStatus: vi.fn(() => Promise.resolve({ available: false, provider: null, model: null, reason: 'none' })),
      listLessons: vi.fn(() => Promise.resolve([])),
      askTutor: vi.fn(),
    }),
  }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import App from '@/App'
import { CircuitCanvas } from './CircuitCanvas'
import { resetGuideBubbleForTests } from '@/features/guide/GuideLauncher'
import { useBuildStore } from './store'
import { useLearnStore } from '@/features/learn/store'

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()

beforeEach(() => {
  localStorage.clear() // the welcome card is NOT dismissed here, so it is on screen until the canvas is expanded
  window.history.replaceState(null, '', '/')
  resetGuideBubbleForTests()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})
afterEach(cleanup)

const toggle = () => screen.getByRole('button', { name: /^(Expand canvas|Exit full view)$/ })
const region = () => screen.getByTestId('canvas-region')
const gates = () => useBuildStore.getState().circuit.ops.map((op) => op.gate)

/** Everything the full view hides, as getters: each is either present and visible, or hidden / absent. */
const rest = {
  welcome: () => screen.queryByRole('button', { name: /start learning/i }),
  codePane: () => screen.queryByRole('tablist', { name: 'Circuit code' }),
  results: () => screen.queryByRole('complementary', { name: 'Results' }),
  tutor: () => screen.queryByRole('contentinfo', { name: 'Tutor' }),
  topBar: () => screen.queryByRole('navigation', { name: 'Primary' }),
  qubi: () => screen.queryByTestId('guide-launcher'),
}

describe('the toggle button', () => {
  it('sits in the circuit toolbar next to Undo, Redo, remove and add a qubit, with an aria-label and aria-pressed', () => {
    render(<App />)
    const button = toggle()
    expect(button).toHaveAccessibleName('Expand canvas')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button.parentElement).toBe(screen.getByRole('button', { name: 'Undo' }).parentElement)
    for (const name of ['Redo', 'Remove a qubit', 'Add a qubit']) expect(screen.getByRole('button', { name }).parentElement).toBe(button.parentElement)
  })

  it('is only offered by the Lab: a canvas without `expandable` (Challenges, Noise Lab) has no such button', () => {
    render(<CircuitCanvas lockQubits />)
    expect(screen.queryByRole('button', { name: /expand canvas|exit full view/i })).toBeNull()
    cleanup()
    render(<CircuitCanvas />)
    expect(screen.queryByRole('button', { name: /expand canvas|exit full view/i })).toBeNull()
  })
})

describe('expanding and leaving the full view', () => {
  it('turns the canvas region into a fixed full-window overlay with the gate palette still under the canvas', () => {
    render(<App />)
    expect(region()).not.toHaveClass('fixed')
    fireEvent.click(toggle())

    expect(toggle()).toHaveAccessibleName('Exit full view')
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(toggle()).toHaveTextContent('Exit full view')
    expect(region()).toHaveClass('fixed', 'inset-0', 'z-50')
    expect(region()).toHaveAttribute('data-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Circuit canvas, full view' })).toBe(region())
    const canvas = within(region()).getByRole('group', { name: 'Circuit editor' })
    const palette = within(region()).getByRole('toolbar', { name: 'Gate palette' })
    expect(canvas).toBeVisible()
    expect(palette).toBeVisible()
    // the palette comes after the canvas in the same column: "below it"
    expect(canvas.compareDocumentPosition(palette) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('hides the welcome banner, code pane, results column, tutor footer, top bar and the Qubi launcher while expanded, and brings them back', () => {
    render(<App />)
    for (const [name, get] of Object.entries(rest)) expect(get(), `${name} before`).not.toBeNull()

    fireEvent.click(toggle())
    for (const [name, get] of Object.entries(rest)) expect(get(), `${name} while expanded`).toBeNull()

    fireEvent.click(toggle())
    expect(toggle()).toHaveAccessibleName('Expand canvas')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(region()).not.toHaveClass('fixed')
    expect(region()).toHaveAttribute('data-expanded', 'false')
    for (const [name, get] of Object.entries(rest)) expect(get(), `${name} after`).not.toBeNull()
  })

  it('Esc leaves the full view and puts focus back on the toggle', () => {
    render(<App />)
    fireEvent.click(toggle())
    expect(region()).toHaveClass('fixed')

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(region()).not.toHaveClass('fixed')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(toggle()).toHaveFocus()
    expect(rest.results()).not.toBeNull()
  })

  it('Esc does nothing when the canvas is not expanded, and other keys do not exit', () => {
    render(<App />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle())
    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
  })

  it('leaving the Lab while expanded ends the full view, so the next screen shows Qubi and the Lab opens normally again', () => {
    render(<App />)
    fireEvent.click(toggle())
    act(() => {
      window.history.pushState(null, '', '/learn')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(useBuildStore.getState().canvasExpanded).toBe(false)
    expect(rest.qubi()).not.toBeNull()
    act(() => {
      window.history.pushState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(region()).not.toHaveClass('fixed')
  })
})

describe('everything else is unchanged', () => {
  it('toggling on and off leaves the circuit, the selection and the Undo/Redo stacks exactly as they were', () => {
    render(<App />)
    act(() => {
      useBuildStore.getState().selectGate('h')
      useBuildStore.getState().onWireClick(0)
    })
    const before = useBuildStore.getState()
    const snapshot = { circuit: before.circuit, qasm: before.qasmText, past: before.past.length, future: before.future.length, op: before.selectedOpIndex }

    fireEvent.click(toggle())
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    fireEvent.keyDown(document.body, { key: 'Escape' })

    const after = useBuildStore.getState()
    expect(after.circuit).toEqual(snapshot.circuit)
    expect(after.qasmText).toBe(snapshot.qasm)
    expect([after.past.length, after.future.length, after.selectedOpIndex]).toEqual([snapshot.past, snapshot.future, snapshot.op])
  })

  it('placing gates, Undo and Redo work from the expanded canvas, and keep working after leaving it', () => {
    render(<App />)
    fireEvent.click(toggle())
    const palette = screen.getByRole('toolbar', { name: 'Gate palette' })

    fireEvent.click(within(palette).getByRole('button', { name: /^H\b/i }))
    fireEvent.click(within(region()).getByRole('button', { name: 'Place h on qubit 0' }))
    expect(gates()).toEqual(['h'])

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(gates()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(gates()).toEqual(['h'])

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(gates()).toEqual(['h'])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(gates()).toEqual([])
  })
})
