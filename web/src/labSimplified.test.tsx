/**
 * The simplified Lab, in the real App: every control is still there, the flow reads Circuit -> Gates -> Code -> Run -> Results -> Tutor, and the
 * empty states are compact. Nothing here changes what is computed; `@/api` is mocked and `executeCircuit` never resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import type { ExecutePayload } from '@/api'

const askTutor = vi.fn()
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
      askTutor,
    }),
  }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import App from './App'
import { resetGuideBubbleForTests } from '@/features/guide/GuideLauncher'
import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '@/features/learn/store'

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()

const PROVENANCE: Provenance = {
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'shots',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
}

const footer = () => document.querySelector('footer[aria-label="Tutor"]') as HTMLElement

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('qentor.welcome.dismissed.v1', '1')
  window.history.replaceState(null, '', '/')
  askTutor.mockReset()
  resetGuideBubbleForTests()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})
afterEach(cleanup)

describe('the Lab still exposes every control, in the order of the flow', () => {
  it('has the circuit editor, gate palette, code tabs, Run, Results and the Tutor', () => {
    render(<App />)
    expect(screen.getByRole('group', { name: 'Circuit editor' })).toBeInTheDocument()
    const palette = screen.getByRole('toolbar', { name: 'Gate palette' })
    for (const gate of ['H', 'X', 'CX', 'SWAP', 'M']) expect(within(palette).getByRole('button', { name: new RegExp(`^${gate}\\b`, 'i') })).toBeInTheDocument()
    const tabs = within(screen.getByRole('tablist', { name: 'Circuit code' })).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['OpenQASM 3', 'Qiskit', 'Cirq', 'PennyLane'])
    expect(screen.getByRole('button', { name: /^Run$/ })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Results' })).toBeInTheDocument()
    expect(footer()).toBeInTheDocument()
    expect(within(footer()).getByLabelText('Ask the tutor')).toBeInTheDocument()
  })

  it('reads Circuit -> Gates -> Code -> Run -> Results -> Tutor down the page', () => {
    render(<App />)
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const circuit = screen.getByRole('group', { name: 'Circuit editor' })
    const gates = screen.getByRole('toolbar', { name: 'Gate palette' })
    const code = screen.getByRole('tablist', { name: 'Circuit code' })
    const results = screen.getByRole('complementary', { name: 'Results' })
    expect(before(circuit, gates)).toBe(true)
    expect(before(gates, code)).toBe(true)
    expect(before(code, results)).toBe(true)
    expect(before(results, footer())).toBe(true)
  })

  it('names each stage with the same small uppercase label: Circuit, Gates, Code, Results, Tutor', () => {
    render(<App />)
    expect(screen.getByText(/^Circuit ·/)).toBeInTheDocument()
    expect(within(screen.getByRole('toolbar', { name: 'Gate palette' })).getByText('Gates')).toBeInTheDocument()
    expect(screen.getByText('Code')).toBeInTheDocument()
    expect(within(screen.getByRole('complementary', { name: 'Results' })).getByRole('heading', { level: 2, name: 'Results' })).toBeInTheDocument()
    expect(within(footer()).getByRole('heading', { level: 2, name: 'Tutor' })).toBeInTheDocument()
  })

  it('the instructions for editing the circuit are still there (one quiet line), and so is the empty-circuit invitation', () => {
    render(<App />)
    expect(screen.getByText(/Click a gate to pick it/)).toBeInTheDocument()
    expect(screen.getByTestId('empty-circuit-hint')).toBeInTheDocument()
  })

  it('the code tabs still switch (OpenQASM 3 -> Qiskit)', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: 'Qiskit' }))
    expect(screen.getByRole('tab', { name: 'Qiskit' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'OpenQASM 3' })).toHaveAttribute('aria-selected', 'false')
  })

  it('the code editor says it is editable and in step with the canvas, in one chip (no second title row)', () => {
    render(<App />)
    expect(screen.getByText('synced with canvas')).toBeInTheDocument()
    expect(screen.getByText(/editable/)).toBeInTheDocument()
    expect(screen.getAllByText('OpenQASM 3')).toHaveLength(1) // the tab only
  })
})

describe('empty states are compact', () => {
  it('Results with nothing to show: one plain line, and the tools below are dividers, not nested boxes', () => {
    render(<App />)
    const results = screen.getByRole('complementary', { name: 'Results' })
    const empty = within(results).getByText('Add gates to the circuit to run it.')
    expect(empty.tagName).toBe('P')
    expect(empty.className).not.toContain('border')
    for (const group of results.querySelectorAll('[data-testid^="results-group-"]')) {
      expect(group.className).toContain('border-t')
      expect(group.className).not.toContain('rounded')
    }
  })

  it('the trace says in one short line that there is none yet', () => {
    render(<App />)
    const note = screen.getByText(/No trace yet/)
    expect(note.textContent!.length).toBeLessThan(80)
  })

  it('the Tutor with nothing to ask about: one line ("Run the circuit, then ask Qubi."), in a short footer', () => {
    render(<App />)
    expect(within(footer()).getByText(/Run the circuit, then ask Qubi\./)).toBeInTheDocument()
    expect(footer()).toHaveAttribute('data-compact', 'true')
    expect(footer().className).toContain('lg:h-44')
    expect(footer().className).not.toContain('lg:h-64')
    // no bordered card around it
    expect(within(footer()).getByText(/Run the circuit, then ask Qubi\./).closest('.rounded-lg')).toBeNull()
  })

  it('the compact tutor keeps its honesty line: it only explains results the backend produced', () => {
    render(<App />)
    expect(within(footer()).getByText(/only explains results the backend actually produced/)).toBeInTheDocument()
  })

  it('the Tutor footer grows back as soon as there is a result to ask about', () => {
    render(<App />)
    act(() => {
      useBuildStore.setState({
        circuit: { ...emptyCircuit(1, 1), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] },
        result: toQuantumValue<ExecutePayload>({ executionId: 'aer-local-abc', probabilities: { '0': 0.5, '1': 0.5 } }, PROVENANCE),
      })
    })
    expect(footer()).toHaveAttribute('data-compact', 'false')
    expect(footer().className).toContain('lg:h-64')
    expect(within(footer()).getByText(/Ask about the circuit you just ran/)).toBeInTheDocument()
  })

  it('and for the modes that need room (Generate code, Debug), even with no result', () => {
    render(<App />)
    fireEvent.click(within(footer()).getByRole('tab', { name: 'Generate code' }))
    expect(footer()).toHaveAttribute('data-compact', 'false')
    fireEvent.click(within(footer()).getByRole('tab', { name: 'Explain' }))
    expect(footer()).toHaveAttribute('data-compact', 'true')
  })
})

describe('Qubi on the Lab', () => {
  it('is on the screen with its name, and opens the existing tutor panel (one tutor, not two)', () => {
    render(<App />)
    const qubi = screen.getByRole('button', { name: 'Open Qubi AI Tutor' })
    expect(qubi).toHaveTextContent('Qubi')
    expect(qubi).toHaveTextContent('AI Tutor')

    fireEvent.click(qubi)

    const panel = screen.getByRole('complementary', { name: 'Qubi · AI Tutor' })
    const embedded = panel.querySelector('[data-tutor-context="lab"]')
    expect(embedded).not.toBeNull() // the existing TutorPanel, in the Lab's conversation
    expect(within(panel).getAllByLabelText('Ask the tutor')).toHaveLength(1)
    expect(askTutor).not.toHaveBeenCalled()
  })

  it('does not take any control away: Run, the palette and the tutor input are all still reachable with it open', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Qubi AI Tutor' }))
    expect(screen.getByRole('button', { name: /^Run$/ })).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Gate palette' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('Ask the tutor').length).toBeGreaterThanOrEqual(1)
  })

  it('the tutor input and its Ask button are marked as something Qubi steers clear of', () => {
    render(<App />)
    expect(within(footer()).getByLabelText('Ask the tutor')).toHaveAttribute('data-qubi-avoid')
    expect(within(footer()).getByRole('button', { name: 'Ask' })).toHaveAttribute('data-qubi-avoid')
  })
})
