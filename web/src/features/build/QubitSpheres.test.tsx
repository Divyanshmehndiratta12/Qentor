/**
 * Per-qubit Bloch spheres for a multi-qubit trace step: each qubit's own vector, length, purity and entanglement flag are
 * the BACKEND's (wire fixtures standing in for a server response), shown exactly as supplied and never worked out here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TraceResponseSchema } from '@/provenance/schema'
import {
  BELL_AMPLITUDE_VIEWS,
  BELL_QUBIT_STATES,
  BELL_STATES,
  CX01,
  H0,
  bellWithQubitStates,
  traceResult,
  wireTrace,
  type WireQubitFields,
} from '@/test/traceFixtures'
import { TraceViewer } from './TraceViewer'

const MINUS = '−'

afterEach(() => cleanup())

const goTo = (step: number) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Step ${step + 1}:`) }))
const card = (qubit: number) => within(screen.getByTestId(`qubit-card-${qubit}`))
const readout = (qubit: number) => [...screen.getByTestId(`qubit-readout-${qubit}`).querySelectorAll('dd')].map((dd) => dd.textContent ?? '')
const text = (testId: string) => screen.getByTestId(testId).textContent ?? ''
const endpoint = (qubit: number) => {
  const el = screen.getByTestId(`qubit-card-${qubit}`).querySelector('[data-testid="bloch-endpoint"]')!
  return { cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')) }
}

function show(trace = bellWithQubitStates()) {
  return render(<TraceViewer trace={trace} isLoading={false} error={null} />)
}

function withStates(states: WireQubitFields[][], tag = 's') {
  return traceResult({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES, qubitStates: states, tag })
}

describe('one sphere per qubit, from the backend’s own per-qubit values', () => {
  it('shows a card for every qubit, q[0] first, and no register-level sphere', () => {
    show()
    const cards = screen.getAllByTestId(/^qubit-card-\d+$/)
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['qubit-card-0', 'qubit-card-1'])
    expect(card(0).getByText('q[0]')).toBeInTheDocument()
    expect(card(1).getByText('q[1]')).toBeInTheDocument()
    expect(screen.getAllByTestId('bloch-svg')).toHaveLength(2)
    expect(screen.queryByTestId('bloch-section')).not.toBeInTheDocument()
  })

  it('the initial state: both qubits are pure, pointing +z, not entangled', () => {
    show()
    for (const q of [0, 1]) {
      expect(readout(q)).toEqual(['0.000', '0.000', '1.000'])
      expect(text(`qubit-length-${q}`)).toBe('1.000')
      expect(text(`qubit-purity-${q}`)).toBe('1.000')
      expect(text(`qubit-entanglement-${q}`)).toBe('not entangled with the rest of the register')
    }
  })

  it('after H on q0 only q0 moves: +x, while q1 stays +z', () => {
    show()
    goTo(1)
    expect(readout(0)).toEqual(['1.000', '0.000', '0.000'])
    expect(readout(1)).toEqual(['0.000', '0.000', '1.000'])
    expect(endpoint(0).cx).toBeLessThan(120) // +x leans to the left of the centre in this projection
    expect(endpoint(1).cx).toBeCloseTo(120, 6) // +z is straight up
    expect(endpoint(1).cy).toBeLessThan(120)
  })

  it('after CX the Bell pair: both arrows have length 0 and both qubits say they are entangled', () => {
    show()
    goTo(2)
    for (const q of [0, 1]) {
      expect(readout(q)).toEqual(['0.000', '0.000', '0.000'])
      expect(text(`qubit-length-${q}`)).toBe('0.000')
      expect(text(`qubit-purity-${q}`)).toBe('0.500')
      expect(text(`qubit-entanglement-${q}`)).toBe('entangled with the rest of the register')
      expect(endpoint(q)).toEqual({ cx: 120, cy: 120 }) // a zero-length vector is drawn at the centre
    }
  })

  it('each number is the exact backend value (the title holds it), rounded only for reading', () => {
    show()
    goTo(2)
    expect(screen.getByTitle('exact value from the backend: 0.5000000000000001')).toBeInTheDocument()
    expect(screen.getByTitle('exact value from the backend: 1.2246467991473532e-16')).toBeInTheDocument()
  })

  it('stepping back and forth always shows the selected step’s own values', () => {
    show()
    goTo(2)
    goTo(0)
    expect(text('qubit-length-0')).toBe('1.000')
    goTo(2)
    expect(text('qubit-length-0')).toBe('0.000')
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
    expect(readout(0)).toEqual(['1.000', '0.000', '0.000'])
  })
})

describe('the spheres follow the backend, not the gates, the statevector or each other', () => {
  it('a length and purity that contradict the vector are shown as supplied (nothing is derived from x, y, z)', () => {
    // vector (0.6, 0, 0.8) has length 1 and a true purity of 1; the "backend" says 0.25 and 0.75. The UI shows what it was told.
    const trace = withStates([
      [
        { qubit: 0, bloch: [0.6, 0, 0.8], blochLength: 0.25, purity: 0.75, entangledWithRest: true },
        { qubit: 1, bloch: [0, 0, 1], blochLength: 1, purity: 1, entangledWithRest: false },
      ],
      BELL_QUBIT_STATES[1]!,
      BELL_QUBIT_STATES[2]!,
    ])
    show(trace)
    expect(readout(0)).toEqual(['0.600', '0.000', '0.800'])
    expect(text('qubit-length-0')).toBe('0.250')
    expect(text('qubit-purity-0')).toBe('0.750')
    expect(text('qubit-entanglement-0')).toBe('entangled with the rest of the register')
  })

  it('an entanglement flag that contradicts the length is shown as supplied (nothing is thresholded here)', () => {
    const trace = withStates([
      [
        { qubit: 0, bloch: [0, 0, 0], blochLength: 0, purity: 0.5, entangledWithRest: false },
        { qubit: 1, bloch: [0, 0, 1], blochLength: 1, purity: 1, entangledWithRest: true },
      ],
      BELL_QUBIT_STATES[1]!,
      BELL_QUBIT_STATES[2]!,
    ])
    show(trace)
    expect(text('qubit-entanglement-0')).toBe('not entangled with the rest of the register')
    expect(text('qubit-entanglement-1')).toBe('entangled with the rest of the register')
  })

  it('the statevector on screen plays no part: a product statevector with per-qubit states of a Bell pair shows the Bell values', () => {
    const trace = traceResult({
      numQubits: 2,
      ops: [H0, CX01],
      states: [BELL_STATES[0]!, BELL_STATES[0]!, BELL_STATES[0]!], // every step |00>
      qubitStates: BELL_QUBIT_STATES,
      tag: 'p',
    })
    show(trace)
    goTo(2)
    expect(text('qubit-length-0')).toBe('0.000')
    expect(text('qubit-purity-1')).toBe('0.500')
  })

  it('the same gates with different backend values give a different picture (gate names play no part)', () => {
    const a = show(withStates(BELL_QUBIT_STATES, 'a'))
    goTo(1)
    const before = { r0: readout(0), r1: readout(1), p0: endpoint(0), p1: endpoint(1) }
    a.unmount()
    const swapped = [BELL_QUBIT_STATES[0]!, [BELL_QUBIT_STATES[1]![1]!, BELL_QUBIT_STATES[1]![0]!].map((q, i) => ({ ...q, qubit: i })), BELL_QUBIT_STATES[2]!]
    show(withStates(swapped, 'b'))
    goTo(1)
    expect(readout(0)).toEqual(before.r1)
    expect(readout(1)).toEqual(before.r0)
    expect(endpoint(0)).toEqual(before.p1)
  })
})

describe('unusable and out-of-range cases are explicit', () => {
  it('an UNUSABLE qubit says so, gives the backend’s reason, and draws no sphere and no number', () => {
    const trace = withStates([
      BELL_QUBIT_STATES[0]!,
      [
        { qubit: 0, bloch: [1, 0, 0], blochLength: 1, purity: 1, entangledWithRest: false },
        { qubit: 1, status: 'UNUSABLE', reason: 'the derived purity 1.3 is outside [1/2, 1]; this is not a valid qubit state' },
      ],
      BELL_QUBIT_STATES[2]!,
    ])
    show(trace)
    goTo(1)

    const bad = screen.getByTestId('qubit-card-1')
    expect(bad.getAttribute('data-status')).toBe('UNUSABLE')
    expect(within(bad).getByText('Unavailable for this qubit.')).toBeInTheDocument()
    expect(within(bad).getByText(/outside \[1\/2, 1\]/)).toBeInTheDocument()
    expect(bad.querySelector('svg')).toBeNull()
    expect(within(bad).queryByText(/\d\.\d{3}/)).toBeNull() // no number of any kind
    // the usable qubit next to it is unaffected
    expect(screen.getByTestId('qubit-card-0').getAttribute('data-status')).toBe('OK')
    expect(readout(0)).toEqual(['1.000', '0.000', '0.000'])
  })

  it('an UNUSABLE qubit still says which step and result it belongs to', () => {
    const trace = withStates([
      [{ qubit: 0, status: 'UNUSABLE', reason: 'no' }, { qubit: 1, status: 'UNUSABLE', reason: 'no' }],
      BELL_QUBIT_STATES[1]!,
      BELL_QUBIT_STATES[2]!,
    ])
    show(trace)
    expect(text('qubit-source-0')).toBe('from trace step 1 · res_s0')
  })

  it('a vector outside the unit sphere is shown as received, flagged, and not drawn', () => {
    const trace = withStates([
      [
        { qubit: 0, bloch: [2, 0, 0], blochLength: 2, purity: 2.5, entangledWithRest: false },
        { qubit: 1, bloch: [0, 0, 1], blochLength: 1, purity: 1, entangledWithRest: false },
      ],
      BELL_QUBIT_STATES[1]!,
      BELL_QUBIT_STATES[2]!,
    ])
    show(trace)
    expect(readout(0)[0]).toBe('2.000')
    expect(card(0).getByRole('alert')).toHaveTextContent(/outside the unit sphere/)
    expect(screen.getByTestId('qubit-card-0').querySelector('[data-testid="bloch-vector"]')).toBeNull()
    expect(screen.getByTestId('qubit-card-1').querySelector('[data-testid="bloch-vector"]')).not.toBeNull()
  })

  it('a backend that sends no per-qubit states is an explanation, never a row of zero spheres', () => {
    show(traceResult({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES }))
    expect(screen.getByTestId('qubit-spheres-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('bloch-svg')).not.toBeInTheDocument()
    expect(screen.queryByText('0.000')).not.toBeInTheDocument()
  })
})

describe('provenance', () => {
  it('every card names the trace step and result its values came from', () => {
    show(bellWithQubitStates('p'))
    goTo(2)
    for (const q of [0, 1]) expect(text(`qubit-source-${q}`)).toBe('from trace step 3 · res_p2')
    expect(screen.getByTestId('qubit-source-0').getAttribute('title')).toContain('hash_prefix_p2')
    expect(screen.getByTestId('qubit-source-0').getAttribute('title')).toContain('reduced-qubit-state-from-statevector/1')
  })

  it('every number sits inside a provenance-carrying wrapper naming the simulation and the step’s result', () => {
    show(bellWithQubitStates('p'))
    goTo(1)
    const wrappers = within(screen.getByTestId('qubit-card-0')).getAllByTitle(/SIMULATION · qiskit-aer · res_p1/)
    expect(wrappers.length).toBeGreaterThanOrEqual(5) // x, y, z, length, purity
  })

  it('says it is state data, not a statement that the circuit is correct', () => {
    show()
    const section = within(screen.getByTestId('qubit-spheres-section'))
    expect(section.getByText(/Backend-derived state data/)).toBeInTheDocument()
    expect(section.getByText(/not a statement about whether your\s+circuit is correct/)).toBeInTheDocument()
  })
})

describe('the wire schema keeps a value from being shown under the wrong step', () => {
  const base = () => wireTrace({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES, qubitStates: BELL_QUBIT_STATES, tag: 'w' })
  const step = (wire: Record<string, unknown>, i: number) => (wire.steps as Array<Record<string, unknown>>)[i]!

  it('accepts a well-formed response', () => {
    expect(TraceResponseSchema.safeParse(base()).success).toBe(true)
  })

  it.each([
    ['step_index', { step_index: 0 }],
    ['result_id', { result_id: 'res_other' }],
    ['execution_id', { execution_id: 'aer-local-other' }],
    ['circuit_hash', { circuit_hash: 'hash_other' }],
  ])('refuses a qubit state whose derived_from has another %s', (_name, override) => {
    const wire = wireTrace({
      numQubits: 2,
      ops: [H0, CX01],
      states: BELL_STATES,
      qubitStates: BELL_QUBIT_STATES.map((qs, i) => (i === 1 ? qs.map((q) => ({ ...q, derivedFrom: override })) : qs)),
      tag: 'w',
    })
    const parsed = TraceResponseSchema.safeParse(wire)
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('derived_from does not match its own step')
  })

  it('refuses the wrong number of qubit states, and states out of order', () => {
    const short = base()
    step(short, 1).qubit_states = (step(short, 1).qubit_states as unknown[]).slice(0, 1)
    expect(TraceResponseSchema.safeParse(short).success).toBe(false)

    const swapped = base()
    step(swapped, 1).qubit_states = [...(step(swapped, 1).qubit_states as unknown[])].reverse()
    expect(TraceResponseSchema.safeParse(swapped).success).toBe(false)
  })

  it('refuses an OK state with a missing value, and an UNUSABLE state that carries one or gives no reason', () => {
    const missing = base()
    ;((step(missing, 0).qubit_states as Array<Record<string, unknown>>)[0]!).purity = null
    expect(TraceResponseSchema.safeParse(missing).success).toBe(false)

    const carrying = base()
    Object.assign((step(carrying, 0).qubit_states as Array<Record<string, unknown>>)[0]!, { status: 'UNUSABLE', reason: 'x' })
    expect(TraceResponseSchema.safeParse(carrying).success).toBe(false)

    const noReason = base()
    Object.assign((step(noReason, 0).qubit_states as Array<Record<string, unknown>>)[0]!, {
      status: 'UNUSABLE', reason: null, bloch: null, bloch_length: null, purity: null, entangled_with_rest: null,
    })
    expect(TraceResponseSchema.safeParse(noReason).success).toBe(false)
  })

  it('refuses an amplitude view of the wrong length', () => {
    const wire = wireTrace({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES, amplitudeViews: [BELL_AMPLITUDE_VIEWS[0]!.slice(0, 3), null, null], tag: 'w' })
    expect(TraceResponseSchema.safeParse(wire).success).toBe(false)
  })

  it('an older backend that sends neither field parses as "none provided"', () => {
    const result = traceResult({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES })
    for (const s of result.steps) {
      expect(s.qubitStates).toEqual([])
      expect(s.amplitudeView).toBeNull()
    }
  })
})

describe('the values reach the component exactly as the backend sent them', () => {
  it('the client mapping passes the numbers through untouched, each under its step’s provenance', () => {
    const result = bellWithQubitStates('m')
    const final = result.steps[2]!
    expect(final.qubitStates).toHaveLength(2)
    const q1 = final.qubitStates[1]!
    expect(q1.bloch!.value).toEqual({ x: 0, y: 0, z: 0 })
    expect(q1.blochLength!.value).toBe(1.2246467991473532e-16)
    expect(q1.purity!.value).toBe(0.5000000000000001)
    expect(q1.entangledWithRest).toBe(true)
    for (const v of [q1.bloch!, q1.blochLength!, q1.purity!]) {
      expect(v.provenance.resultId).toBe('res_m2')
      expect(v.provenance.circuitHash).toBe('hash_prefix_m2')
      expect(v.provenance.provenanceClass).toBe('SIMULATION')
    }
    expect(q1.derivedFrom).toEqual({
      stepIndex: 2, resultId: 'res_m2', executionId: 'aer-local-m2', circuitHash: 'hash_prefix_m2', backend: 'qiskit-aer', backendVersion: '0.17.2',
    })
  })
})

describe('no quantum calculation happens while rendering the spheres', () => {
  it('never calls a math primitive, including while stepping', () => {
    const spies = (['sqrt', 'hypot', 'pow', 'random', 'atan2', 'atan', 'cos', 'sin', 'acos', 'asin', 'exp', 'log'] as const).map((fn) => vi.spyOn(Math, fn))
    show()
    goTo(1)
    goTo(2)
    goTo(0)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    spies.forEach((spy) => spy.mockRestore())
  })

  it('renders deterministically', () => {
    const first = show(bellWithQubitStates('d'))
    goTo(1)
    const a = { r: readout(0), p: endpoint(0) }
    first.unmount()
    show(bellWithQubitStates('d'))
    goTo(1)
    expect({ r: readout(0), p: endpoint(0) }).toEqual(a)
  })

  it('a negative backend value is shown with a typographic minus and never as −0.000', () => {
    const trace = withStates([
      [
        { qubit: 0, bloch: [-0.5, -1e-17, -0.25], blochLength: 0.5, purity: 0.625, entangledWithRest: true },
        { qubit: 1, bloch: [0, 0, 1], blochLength: 1, purity: 1, entangledWithRest: false },
      ],
      BELL_QUBIT_STATES[1]!,
      BELL_QUBIT_STATES[2]!,
    ])
    show(trace)
    expect(readout(0)).toEqual([`${MINUS}0.500`, '0.000', `${MINUS}0.250`])
  })
})
