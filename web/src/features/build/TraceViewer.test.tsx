/**
 * Tests for TraceViewer: idle / loading / error / one-step / multi-step
 * rendering, navigation, exact value rendering, provenance, terminal
 * measurements and accessibility. Traces come from the wire-format fixtures
 * (`src/test/traceFixtures.ts`), so every assertion is "the UI shows exactly
 * what the backend response said" — the viewer is given no way to compute
 * anything of its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TraceViewer } from './TraceViewer'
import { formatAmplitude } from './traceFormat'
import {
  BASIS_ORDERING_WIRE,
  CX01,
  H0,
  X0,
  bellMeasured,
  emptyOneQubit,
  hzh,
  op,
  traceResult,
  xThenMeasure,
} from '@/test/traceFixtures'
import type { ExecutionTraceResult } from '@/api'
import type { TraceFailure } from './store'

function renderViewer(
  trace: ExecutionTraceResult | null,
  extra: { isLoading?: boolean; error?: TraceFailure | null } = {},
) {
  const props = { trace, isLoading: extra.isLoading ?? false, error: extra.error ?? null }
  const utils = render(<TraceViewer {...props} />)
  return { ...utils, rerenderWith: (next: typeof props) => utils.rerender(<TraceViewer {...next} />) }
}

const timeline = () => screen.getByRole('group', { name: 'Trace steps' })
const chips = () => within(timeline()).getAllByRole('button')
const chip = (name: RegExp | string) => within(timeline()).getByRole('button', { name })
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
const previous = () => fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))

/** The rows of the statevector table as [basis label, amplitude text]. */
function tableRows(): Array<[string, string]> {
  const body = within(screen.getByRole('table')).getAllByRole('row').slice(1) // drop header
  return body.map((row) => {
    const cells = within(row).getAllByRole('cell')
    return [cells[0]!.textContent ?? '', cells[1]!.textContent ?? '']
  })
}

/** The <dd> paired with a <dt> label (provenance / identity fields). */
function field(label: string): string {
  const dt = screen.getByText(label, { selector: 'dt' })
  return dt.nextElementSibling?.textContent ?? ''
}

afterEach(() => cleanup())

describe('TraceViewer states', () => {
  it('idle: says no trace has been requested, and shows no steps or state', () => {
    renderViewer(null)

    expect(screen.getByText(/No trace yet/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Trace steps' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('loading: shows a status and nothing else — not even a previous trace', () => {
    renderViewer(hzh(), { isLoading: true })

    expect(screen.getByRole('status')).toHaveTextContent('Tracing on backend…')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText(/No trace yet/)).not.toBeInTheDocument()
  })

  it('a structured backend refusal: shows its code and message, and explicitly no substitute trace', () => {
    renderViewer(null, {
      error: {
        kind: 'rejected',
        code: 'TRACE_MODE_UNSUPPORTED',
        message: "execution trace is only available in statevector mode; 'shots' mode returns sampled counts",
      },
    })

    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Trace not available')).toBeInTheDocument()
    expect(within(alert).getByTestId('trace-error-code')).toHaveTextContent('TRACE_MODE_UNSUPPORTED')
    expect(alert).toHaveTextContent("only available in statevector mode")
    expect(alert).toHaveTextContent('No substitute trace is shown')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Trace steps' })).not.toBeInTheDocument()
  })

  it('an unexpected failure: reported differently from a refusal, still with no data', () => {
    renderViewer(null, { error: { kind: 'unexpected', message: 'could not reach the Qentor backend: Failed to fetch' } })

    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Trace failed unexpectedly')).toBeInTheDocument()
    expect(alert).toHaveTextContent('could not reach the Qentor backend')
    expect(within(alert).queryByTestId('trace-error-code')).not.toBeInTheDocument()
    expect(alert).toHaveTextContent('No substitute trace is shown')
  })

  it('an error takes precedence over a stale trace', () => {
    renderViewer(hzh(), { error: { kind: 'unexpected', message: 'boom' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('one-step trace (empty circuit)', () => {
  it('shows just the initial state, with navigation disabled at both ends', () => {
    renderViewer(emptyOneQubit())

    expect(screen.getByText('Step 0 of 0')).toBeInTheDocument()
    expect(screen.getByText('Initial state')).toBeInTheDocument()
    expect(chips()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled()
    expect(tableRows()).toEqual([
      ['|0⟩', '1.000 + 0.000i'],
      ['|1⟩', '0.000 + 0.000i'],
    ])
  })
})

describe('multi-step trace (H, Z, H)', () => {
  it('starts on step 0 and steps forward through every operation with its metadata', () => {
    renderViewer(hzh())

    expect(chips()).toHaveLength(4)
    expect(screen.getByText('Step 0 of 3')).toBeInTheDocument()
    expect(screen.getByText('Initial state')).toBeInTheDocument()
    expect(tableRows()).toEqual([
      ['|0⟩', '1.000 + 0.000i'],
      ['|1⟩', '0.000 + 0.000i'],
    ])

    next()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('H on q0')).toBeInTheDocument()
    expect(screen.getByText(/Operation 0 of your circuit/)).toBeInTheDocument()
    expect(tableRows()).toEqual([
      ['|0⟩', '0.707 + 0.000i'],
      ['|1⟩', '0.707 + 0.000i'],
    ])

    next()
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()
    expect(screen.getByText('Z on q0')).toBeInTheDocument()
    expect(screen.getByText(/Operation 1 of your circuit/)).toBeInTheDocument()
    expect(tableRows()).toEqual([
      ['|0⟩', '0.707 + 0.000i'],
      ['|1⟩', '−0.707 + 0.000i'],
    ])

    next()
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument()
    expect(screen.getByText(/Operation 2 of your circuit/)).toBeInTheDocument()
    expect(tableRows()).toEqual([
      ['|0⟩', '0.000 + 0.000i'],
      ['|1⟩', '1.000 + 0.000i'],
    ])
    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled()
  })

  it('Previous walks back; it is disabled at step 0', () => {
    renderViewer(hzh())
    next()
    next()

    previous()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    previous()
    expect(screen.getByText('Step 0 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled()
  })

  it('clicking a timeline chip jumps straight to that step', () => {
    renderViewer(hzh())

    fireEvent.click(chip('Step 3: H on q0'))

    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument()
    expect(tableRows()[1]).toEqual(['|1⟩', '1.000 + 0.000i'])
  })

  it('a new trace starts back at step 0', () => {
    const { rerenderWith } = renderViewer(hzh('a'))
    next()
    next()
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()

    rerenderWith({ trace: hzh('b'), isLoading: false, error: null })

    expect(screen.getByText('Step 0 of 3')).toBeInTheDocument()
    expect(field('result')).toBe('res_b0')
  })
})

describe('operation metadata', () => {
  it('describes a controlled gate with its control and target', () => {
    renderViewer(bellMeasured())
    next()
    next()

    expect(screen.getByText('CX — control q0, target q1')).toBeInTheDocument()
    expect(chip(/Step 2: CX — control q0, target q1/)).toBeInTheDocument()
  })

  it('shows a rotation angle from the circuit (the learner’s own parameter)', () => {
    const trace = traceResult({
      numQubits: 1,
      ops: [op('rx', { targets: [0], params: [1.5707963267948966] })],
      states: [
        [[1, 0], [0, 0]],
        [[0.7, 0], [0, -0.7]],
      ],
    })
    renderViewer(trace)
    next()

    expect(screen.getByText('RX(1.571 rad) on q0')).toBeInTheDocument()
  })

  it('labels each timeline chip with its step number and gate', () => {
    renderViewer(bellMeasured())

    expect(chips().map((c) => c.textContent)).toEqual(['● 0initial', '1H q0', '2CX q0→q1'])
  })
})

describe('statevector values come straight from the response', () => {
  it('renders exactly the formatted backend values — including a non-normalised, awkward state', () => {
    // Not a physical state on purpose: a viewer that normalised, rounded away
    // or "corrected" anything would show something different.
    const trace = traceResult({
      numQubits: 1,
      ops: [X0],
      states: [
        [[0.123456, -0.654321], [-0.0004, 1.5]],
        [[9.999, 0], [0, -0.0004]],
      ],
    })
    renderViewer(trace)

    expect(tableRows()).toEqual([
      ['|0⟩', '0.123 − 0.654i'],
      ['|1⟩', '0.000 + 1.500i'], // -0.0004 shows as 0.000, never "-0.000"
    ])

    next()
    expect(tableRows()).toEqual([
      ['|0⟩', '9.999 + 0.000i'],
      ['|1⟩', '0.000 + 0.000i'], // im -0.0004 also displays as plain 0.000, with a "+"
    ])
  })

  it('every rendered amplitude equals formatAmplitude of the response value, step after step', () => {
    const trace = hzh()
    renderViewer(trace)

    for (const step of trace.steps) {
      expect(tableRows().map(([, amplitude]) => amplitude)).toEqual(step.state.value.map(formatAmplitude))
      if (step.stepIndex < trace.steps.length - 1) next()
    }
  })

  it('labels a 2-qubit register |00⟩…|11⟩ in index order, per the backend ordering', () => {
    renderViewer(bellMeasured())
    next()
    next()

    expect(tableRows()).toEqual([
      ['|00⟩', '0.707 + 0.000i'],
      ['|01⟩', '0.000 + 0.000i'],
      ['|10⟩', '0.000 + 0.000i'],
      ['|11⟩', '0.707 + 0.000i'],
    ])
    expect(screen.getByText(BASIS_ORDERING_WIRE)).toBeInTheDocument() // stated beside the data
  })

  it('shows raw indices, with a note, when the backend ordering is not one it knows how to label', () => {
    const trace = traceResult({
      numQubits: 2,
      ops: [],
      states: [[[1, 0], [0, 0], [0, 0], [0, 0]]],
      basisOrdering: 'some future ordering nobody documented',
    })
    renderViewer(trace)

    expect(tableRows().map(([label]) => label)).toEqual(['0', '1', '2', '3'])
    expect(screen.getByText(/isn’t one the viewer knows how to label/)).toBeInTheDocument()
    expect(screen.getByText('some future ordering nobody documented')).toBeInTheDocument()
  })

  it('shows no probability, magnitude or derived column — only backend amplitudes', () => {
    renderViewer(hzh())

    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['basis state', 'amplitude'])
    expect(screen.queryByText(/probabilit/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})

describe('trace does not perform quantum calculations at render time', () => {
  it('never calls a math primitive while rendering or navigating', () => {
    const spies = (['sqrt', 'hypot', 'pow', 'random', 'atan2', 'cos', 'sin', 'acos', 'exp', 'log'] as const).map(
      (fn) => vi.spyOn(Math, fn),
    )

    renderViewer(bellMeasured())
    next()
    next()
    previous()
    fireEvent.click(chips()[2]!)

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    spies.forEach((spy) => spy.mockRestore())
  })

  it('renders deterministically: the same trace shows the same values every time', () => {
    const trace = bellMeasured()
    const first = renderViewer(trace)
    next()
    next()
    const a = tableRows()
    first.unmount()

    renderViewer(trace)
    next()
    next()
    expect(tableRows()).toEqual(a)
  })
})

describe('provenance', () => {
  it('shows the step’s badge, backend, result id, execution id, circuit and run status', () => {
    renderViewer(hzh())

    const card = screen.getByText('Provenance').closest('div')!.parentElement!
    expect(within(card).getByText('Simulated')).toBeInTheDocument() // ProvenanceBadge
    expect(field('backend')).toBe('qiskit-aer 0.17.2')
    expect(field('result')).toBe('res_a0')
    expect(field('execution')).toBe('aer-local-a0')
    expect(field('circuit')).toBe('hash_prefix_a0')
    expect(field('run status')).toBe('VERIFIED')
  })

  it('provenance follows the selected step (each step is its own run on its own prefix circuit)', () => {
    renderViewer(hzh())

    next()
    expect(field('result')).toBe('res_a1')
    expect(field('execution')).toBe('aer-local-a1')
    expect(field('circuit')).toBe('hash_prefix_a1')

    next()
    expect(field('result')).toBe('res_a2')
    expect(field('circuit')).toBe('hash_prefix_a2')
  })

  it('every displayed amplitude carries provenance (VerifiedValue tooltip names the run)', () => {
    renderViewer(hzh())
    next()

    const tagged = screen.getAllByTitle(/res_a1/)
    // one per amplitude row (2) — the badge's own tooltip is on the badge, not a row.
    expect(tagged.filter((el) => el.tagName === 'SPAN' && /SIMULATION · qiskit-aer · res_a1/.test(el.getAttribute('title')!))).toHaveLength(2)
  })

  it('marks only the last step as the final result of the trace', () => {
    renderViewer(hzh())
    expect(screen.queryByText('final result', { selector: 'dd' })).not.toBeInTheDocument()

    fireEvent.click(chip(/^Step 3/))
    expect(screen.getByText('final result', { selector: 'dd' })).toBeInTheDocument()
    expect(field('result')).toBe('res_a3')
  })

  it('states that run status is about the execution, not the circuit’s correctness', () => {
    renderViewer(hzh())

    expect(
      screen.getByText(/Run status describes this backend execution only — it does not say your circuit is correct/),
    ).toBeInTheDocument()
    // The status is labelled as a *run* status; nothing calls the circuit itself verified/correct.
    expect(field('run status')).toBe('VERIFIED')
    expect(screen.queryByText(/circuit verified|verified circuit|circuit is correct\s*$/i)).not.toBeInTheDocument()
  })

  it('explains that “circuit” is the step’s own prefix, and exposes submitted/traced identity', () => {
    renderViewer(bellMeasured())

    expect(screen.getByText(/your circuit cut off after this step/)).toBeInTheDocument()
    expect(field('submitted circuit')).toBe('hash_submitted_a')
    expect(field('traced circuit')).toBe('hash_traced_a') // differs: measurements stripped
    expect(field('final result')).toBe('res_a2')
    expect(field('method')).toBe('prefix-statevector')
  })

  it('shows the backend identity in the trace header', () => {
    renderViewer(bellMeasured())
    expect(screen.getByText('qiskit-aer 0.17.2', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('statevector')).toBeInTheDocument()
    expect(screen.getByText('· 2 qubits')).toBeInTheDocument()
    expect(screen.getByText('· 3 steps')).toBeInTheDocument()
  })
})

describe('terminal measurements (X then measure)', () => {
  it('has exactly two steps — initial |0⟩ and after-X |1⟩ — and no measurement step', () => {
    renderViewer(xThenMeasure())

    expect(chips()).toHaveLength(2)
    expect(within(timeline()).queryByText(/measure/i)).not.toBeInTheDocument()

    expect(screen.getByText('Step 0 of 1')).toBeInTheDocument()
    expect(tableRows()).toEqual([
      ['|0⟩', '1.000 + 0.000i'],
      ['|1⟩', '0.000 + 0.000i'],
    ])

    next()
    expect(screen.getByText('Step 1 of 1')).toBeInTheDocument()
    expect(screen.getByText('X on q0')).toBeInTheDocument()
    expect(tableRows()).toEqual([
      ['|0⟩', '0.000 + 0.000i'],
      ['|1⟩', '1.000 + 0.000i'],
    ])
    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled()
  })

  it('lists the measurement separately as metadata, with no state of its own', () => {
    renderViewer(xThenMeasure())

    const section = screen.getByText('Terminal measurements').parentElement!
    expect(within(section).getByText('op 1: Measure q0 → c0')).toBeInTheDocument()
    expect(within(section).getByText(/Not a step/)).toBeInTheDocument()
    expect(within(section).queryByRole('table')).not.toBeInTheDocument()
    // Only ONE statevector table exists — none for the measurement.
    expect(screen.getAllByRole('table')).toHaveLength(1)
  })

  it('every terminal measurement of a Bell trace is listed, and none becomes a step', () => {
    renderViewer(bellMeasured())

    expect(chips()).toHaveLength(3)
    const section = screen.getByText('Terminal measurements').parentElement!
    expect(within(section).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'op 2: Measure q0 → c0',
      'op 3: Measure q1 → c1',
    ])
  })

  it('shows no Terminal measurements section when the circuit has none', () => {
    renderViewer(hzh())
    expect(screen.queryByText('Terminal measurements')).not.toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('all navigation is real, natively focusable buttons with meaningful names', () => {
    renderViewer(bellMeasured())

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(5) // prev, next, 3 chips
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON')
      expect(button).toHaveAttribute('type', 'button')
      expect(button.getAttribute('tabindex')).not.toBe('-1')
      expect(button.getAttribute('aria-label') ?? button.textContent).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next step' })).toBeInTheDocument()
    expect(chips().map((c) => c.getAttribute('aria-label'))).toEqual([
      'Step 0: initial state',
      'Step 1: H on q0',
      'Step 2: CX — control q0, target q1',
    ])
  })

  it('marks the current step with aria-current AND a visible marker, not colour alone', () => {
    renderViewer(bellMeasured())

    expect(chips().filter((c) => c.getAttribute('aria-current') === 'step')).toHaveLength(1)
    expect(chips()[0]).toHaveAttribute('aria-current', 'step')
    expect(chips()[0]!.textContent).toContain('●')
    expect(chips()[1]!.textContent).not.toContain('●')

    next()
    expect(chips()[0]).not.toHaveAttribute('aria-current')
    expect(chips()[1]).toHaveAttribute('aria-current', 'step')
    expect(chips()[1]!.textContent).toContain('●')
    // ...and the position is also stated in words.
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
  })

  it('the step timeline is a labelled group and the step counter is announced politely', () => {
    renderViewer(hzh())
    expect(screen.getByRole('group', { name: 'Trace steps' })).toBeInTheDocument()
    expect(screen.getByText('Step 0 of 3')).toHaveAttribute('aria-live', 'polite')
  })

  it('arrow keys move between steps and move focus with them; Home/End jump', () => {
    renderViewer(hzh())
    const first = chips()[0]!
    first.focus()
    expect(first).toHaveFocus()

    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(chips()[1]).toHaveFocus()

    fireEvent.keyDown(chips()[1]!, { key: 'End' })
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument()
    expect(chips()[3]).toHaveFocus()

    fireEvent.keyDown(chips()[3]!, { key: 'ArrowLeft' })
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()

    fireEvent.keyDown(chips()[2]!, { key: 'Home' })
    expect(screen.getByText('Step 0 of 3')).toBeInTheDocument()
    expect(chips()[0]).toHaveFocus()
  })

  it('arrow keys stop at the ends and ignore unrelated keys', () => {
    renderViewer(hzh())
    const first = chips()[0]!

    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(screen.getByText('Step 0 of 3')).toBeInTheDocument()

    fireEvent.keyDown(first, { key: 'a' })
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(screen.getByText('Step 0 of 3')).toBeInTheDocument()

    fireEvent.keyDown(first, { key: 'End' })
    fireEvent.keyDown(chips()[3]!, { key: 'ArrowRight' })
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument()
  })

  it('Previous/Next keep focus inside the trace controls as the step changes', () => {
    renderViewer(hzh())
    const nextButton = screen.getByRole('button', { name: 'Next step' })
    nextButton.focus()
    fireEvent.click(nextButton)
    // Focus moves to the newly selected chip so keyboard users stay oriented.
    expect(chips()[1]).toHaveFocus()
  })

  it('error and loading states are announced (alert / status roles)', () => {
    const { unmount } = renderViewer(null, { isLoading: true })
    expect(screen.getByRole('status')).toBeInTheDocument()
    unmount()
    renderViewer(null, { error: { kind: 'unexpected', message: 'x' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})

describe('a big register still renders every basis state', () => {
  it('renders 2^3 rows for a 3-qubit trace with 3-bit labels', () => {
    const eight = Array.from({ length: 8 }, (_, i): [number, number] => [i === 0 ? 1 : 0, 0])
    renderViewer(traceResult({ numQubits: 3, ops: [], states: [eight] }))

    const rows = tableRows()
    expect(rows).toHaveLength(8)
    expect(rows[0]).toEqual(['|000⟩', '1.000 + 0.000i'])
    expect(rows[5]![0]).toBe('|101⟩')
    expect(rows[7]![0]).toBe('|111⟩')
  })
})

describe('sanity of fixtures used above', () => {
  it('the Bell fixture has CX at op index 1 and two terminal measurements', () => {
    const trace = bellMeasured()
    expect(trace.steps[2]!.operation).toEqual(CX01)
    expect(trace.steps[1]!.operation).toEqual(H0)
    expect(trace.terminalMeasurements).toHaveLength(2)
  })
})
