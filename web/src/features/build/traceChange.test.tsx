/**
 * The trace viewer's "what changed" surface. Everything shown comes from the wire fixture — what the "backend" said — and the
 * viewer must show exactly that: the server's sentence, the server's list of changed basis states, the previous step's own
 * amplitudes as the "before" column. It works nothing out itself: a fixture whose amplitudes moved but whose `change` says
 * "unchanged" must show no highlight (a client-side diff would betray itself), and a trace with no `change` at all (an older
 * server) must degrade to the plain table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  CX01,
  H0,
  bellMeasured,
  traceResult,
  type Amplitude,
  type WireStepChange,
} from '@/test/traceFixtures'
import { TraceViewer } from './TraceViewer'

afterEach(cleanup)

const R = 0.7071067811865476
const BELL_STATES: Amplitude[][] = [
  [[1, 0], [0, 0], [0, 0], [0, 0]],
  [[R, 0], [R, 0], [0, 0], [0, 0]],
  [[R, 0], [0, 0], [0, 0], [R, 0]],
]

const H_CHANGE: WireStepChange = {
  kind: 'probabilities_changed',
  support_before: 1,
  support_after: 2,
  amplitudes_changed: 2,
  probabilities_changed: 2,
  changed_basis_states: [
    { basis: '00', before: [1, 0], after: [R, 0], probability_before: 1, probability_after: 0.5 },
    { basis: '01', before: [0, 0], after: [R, 0], probability_before: 0, probability_after: 0.5 },
  ],
  summary: 'SERVER-SENTENCE-H: 2 amplitudes moved; 2 outcome probabilities changed.',
}
const CX_CHANGE: WireStepChange = {
  kind: 'probabilities_changed',
  support_before: 2,
  support_after: 2,
  amplitudes_changed: 2,
  probabilities_changed: 2,
  changed_basis_states: [
    { basis: '01', before: [R, 0], after: [0, 0], probability_before: 0.5, probability_after: 0 },
    { basis: '11', before: [0, 0], after: [R, 0], probability_before: 0, probability_after: 0.5 },
  ],
  summary: 'SERVER-SENTENCE-CX: 2 amplitudes moved; 2 outcome probabilities changed.',
}

const bell = (changes?: Array<WireStepChange | null>) =>
  traceResult({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES, changes, tag: 'c' })

const show = (trace = bell([null, H_CHANGE, CX_CHANGE]), extra: Partial<Parameters<typeof TraceViewer>[0]> = {}) =>
  render(<TraceViewer trace={trace} isLoading={false} error={null} {...extra} />)

const btn = (name: string) => screen.getByRole('button', { name })
const rows = () => [...document.querySelectorAll('tbody tr')] as HTMLElement[]
const changedRows = () => rows().filter((r) => r.getAttribute('data-changed') === 'true').map((r) => r.querySelector('td')!.textContent!.replace(/[^01|⟩]/g, ''))

describe('First / Previous / Next / Last', () => {
  it('First and Last jump to the ends and say where they are; Previous and Next keep their names', () => {
    show()
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    fireEvent.click(btn('Last step'))
    expect(screen.getByText('Step 3 of 3')).toBeTruthy()
    fireEvent.click(btn('Previous step'))
    expect(screen.getByText('Step 2 of 3')).toBeTruthy()
    fireEvent.click(btn('First step'))
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    fireEvent.click(btn('Next step'))
    expect(screen.getByText('Step 2 of 3')).toBeTruthy()
  })

  it('disables the backward pair on the first step and the forward pair on the last', () => {
    show()
    expect((btn('First step') as HTMLButtonElement).disabled).toBe(true)
    expect((btn('Previous step') as HTMLButtonElement).disabled).toBe(true)
    expect((btn('Next step') as HTMLButtonElement).disabled).toBe(false)
    expect((btn('Last step') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(btn('Last step'))
    expect((btn('Next step') as HTMLButtonElement).disabled).toBe(true)
    expect((btn('Last step') as HTMLButtonElement).disabled).toBe(true)
    expect((btn('First step') as HTMLButtonElement).disabled).toBe(false)
  })

  it('in controlled mode reports the zero-based index to the parent (Last → final step index, First → 0)', () => {
    const onSelectStep = vi.fn()
    show(bell([null, H_CHANGE, CX_CHANGE]), { selectedStep: 1, onSelectStep })
    fireEvent.click(btn('Last step'))
    expect(onSelectStep).toHaveBeenLastCalledWith(2)
    fireEvent.click(btn('First step'))
    expect(onSelectStep).toHaveBeenLastCalledWith(0)
    expect(onSelectStep).toHaveBeenCalledTimes(2)
  })

  it('a one-step trace has nothing to move to', () => {
    show(traceResult({ numQubits: 1, ops: [], states: [[[1, 0], [0, 0]]], changes: [null], tag: 'one' }))
    for (const name of ['First step', 'Previous step', 'Next step', 'Last step']) {
      expect((btn(name) as HTMLButtonElement).disabled).toBe(true)
    }
  })
})

describe('what changed', () => {
  it('shows the SERVER sentence for the selected step, and none for the initial state', () => {
    show()
    expect(screen.queryByTestId('step-change')).toBeNull()
    fireEvent.click(btn('Next step'))
    expect(screen.getByTestId('step-change').textContent).toContain('SERVER-SENTENCE-H: 2 amplitudes moved')
    fireEvent.click(btn('Next step'))
    const card = screen.getByTestId('step-change')
    expect(card.textContent).toContain('SERVER-SENTENCE-CX')
    expect(card.textContent).not.toContain('SERVER-SENTENCE-H')
    expect(card.getAttribute('data-change-kind')).toBe('probabilities_changed')
  })

  it('marks exactly the rows the server listed, and no others', () => {
    show()
    fireEvent.click(btn('Next step'))
    expect(changedRows()).toEqual(['|00⟩', '|01⟩'])
    fireEvent.click(btn('Next step'))
    expect(changedRows()).toEqual(['|01⟩', '|11⟩'])
  })

  it('a changed row is announced to assistive tech, not only coloured', () => {
    show()
    fireEvent.click(btn('Next step'))
    const changed = rows().filter((r) => r.getAttribute('data-changed') === 'true')
    expect(changed.length).toBe(2)
    for (const row of changed) expect(row.textContent).toContain('changed:')
    expect(rows().filter((r) => r.getAttribute('data-changed') !== 'true').every((r) => !r.textContent!.includes('changed:'))).toBe(true)
  })

  it('shows the previous step’s own amplitudes as the before column (and only when there is a previous step)', () => {
    show()
    expect(screen.queryByRole('columnheader', { name: 'before' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'after' })).toBeNull()
    fireEvent.click(btn('Next step'))
    expect(screen.getByRole('columnheader', { name: 'before' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'after' })).toBeTruthy()
    const firstRow = rows()[0]!.querySelectorAll('td')
    // |00⟩ went 1 → R: the before cell shows the previous state's value, the after cell this step's.
    expect(firstRow[1]!.textContent).toContain('1')
    expect(firstRow[2]!.textContent).toContain('0.707')
    const secondRow = rows()[1]!.querySelectorAll('td')
    expect(secondRow[1]!.textContent).toContain('0')
    expect(secondRow[2]!.textContent).toContain('0.707')
  })

  it('a phase-only change is shown as the server described it — the viewer adds no explanation of its own', () => {
    const phase: WireStepChange = {
      kind: 'phase_only',
      support_before: 2,
      support_after: 2,
      amplitudes_changed: 1,
      probabilities_changed: 0,
      changed_basis_states: [
        { basis: '01', before: [R, 0], after: [-R, 0], probability_before: 0.5, probability_after: 0.5 },
      ],
      summary: 'SERVER-PHASE: 1 amplitude moved; no outcome probability changed.',
    }
    show(bell([null, H_CHANGE, phase]))
    fireEvent.click(btn('Last step'))
    const card = screen.getByTestId('step-change')
    expect(card.getAttribute('data-change-kind')).toBe('phase_only')
    expect(card.textContent).toBe('What changed: SERVER-PHASE: 1 amplitude moved; no outcome probability changed.')
  })
})

describe('the browser works nothing out', () => {
  it('amplitudes that moved but a change that says "unchanged" → no highlight and no invented sentence', () => {
    const lie: WireStepChange = {
      kind: 'unchanged',
      support_before: 1,
      support_after: 1,
      amplitudes_changed: 0,
      probabilities_changed: 0,
      changed_basis_states: [],
      summary: 'SERVER-SAYS-NOTHING-MOVED.',
    }
    show(bell([null, lie, lie]))
    fireEvent.click(btn('Next step'))
    expect(changedRows()).toEqual([])
    const card = screen.getByTestId('step-change')
    expect(card.textContent).toContain('SERVER-SAYS-NOTHING-MOVED')
    expect(card.getAttribute('data-change-kind')).toBe('unchanged')
  })

  it('a trace with no change data (an older server) shows the plain table: no card, no before column, no marks', () => {
    show(bell(undefined))
    fireEvent.click(btn('Next step'))
    expect(screen.queryByTestId('step-change')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'before' })).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'amplitude' })).toBeTruthy()
    expect(changedRows()).toEqual([])
  })

  it('every amplitude still renders through the provenance wrapper, before column included', () => {
    show()
    fireEvent.click(btn('Next step'))
    // 4 rows × (label + before + after). Each value carries ITS OWN step's provenance in the wrapper's title:
    // the before column is the previous step's result, the after column this step's.
    for (const row of rows()) {
      const cells = row.querySelectorAll('td')
      expect(cells.length).toBe(3)
      expect(cells[1]!.querySelector('[title]')!.getAttribute('title')).toContain('res_c0')
      expect(cells[2]!.querySelector('[title]')!.getAttribute('title')).toContain('res_c1')
    }
  })
})

describe('multi-qubit states', () => {
  it('still explain why there is no Bloch sphere, next to the change card', () => {
    show()
    fireEvent.click(btn('Next step'))
    const unavailable = screen.getByTestId('bloch-unavailable')
    expect(within(unavailable).getByText(/unavailable for this multi-qubit state/)).toBeTruthy()
    expect(screen.getByTestId('step-change')).toBeTruthy()
  })

  it('a measured-Bell trace keeps its terminal measurements separate from the steps', () => {
    show(bellMeasured('m'))
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    expect(screen.getByText(/Terminal measurements/)).toBeTruthy()
  })
})
