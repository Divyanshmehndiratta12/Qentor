/**
 * The Bloch sphere inside the trace viewer and the Lab: which vector is shown
 * for which step, what happens for a multi-qubit trace, and that browsing a
 * trace touches nothing else. Vectors come from the wire-format fixtures — what
 * the "backend" said — and the UI must show exactly those, per step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import type { ExecutePayload, ExecutionTraceResult, OptimizationResult, VerifyBellStateResult, MultiInputTestResult } from '@/api'
import {
  H0,
  HZH_BLOCH_STATES,
  HZH_BLOCH_VECTORS,
  X0,
  Z0,
  bellMeasured,
  emptyOneQubit,
  hzh,
  hzhWithBloch,
  traceResult,
} from '@/test/traceFixtures'

const traceCircuit = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(),
      verifyBellState: vi.fn(),
      askTutor: vi.fn(),
      optimizeCircuit: vi.fn(),
      runMultiInputTest: vi.fn(),
      listLessons: vi.fn(),
      traceCircuit,
    }),
  }
})

import { useBuildStore } from './store'
import { TracePanel } from './TracePanel'
import { TraceViewer } from './TraceViewer'

const MINUS = '−'

const chips = () => within(screen.getByRole('group', { name: 'Trace steps' })).getAllByRole('button')
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
const previous = () => fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
const goTo = (step: number) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Step ${step + 1}:`) }))

const sphere = () => within(screen.getByTestId('bloch-section'))
const readout = () => [...screen.getByTestId('bloch-readout').querySelectorAll('dd')].map((dd) => dd.textContent ?? '')
const endpoint = () => {
  const el = screen.getByTestId('bloch-endpoint')
  return { cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')) }
}
const sourceStep = () => {
  const dt = sphere().getByText('source step', { selector: 'dt' })
  return dt.nextElementSibling?.textContent
}

function renderViewer(trace: ExecutionTraceResult | null) {
  return render(<TraceViewer trace={trace} isLoading={false} error={null} />)
}

afterEach(() => cleanup())

describe('H → Z → H: the sphere follows the trace step by step, using the backend’s vectors', () => {
  it('Step 0 ≈ +z, Step 1 ≈ +x, Step 2 ≈ −x, Step 3 ≈ −z', () => {
    renderViewer(hzhWithBloch())

    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(readout()).toEqual(['0.000', '0.000', '1.000']) // +z
    next()
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(readout()).toEqual(['1.000', '0.000', '0.000']) // +x  (z = 2.2e-16 shows as 0.000)
    next()
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
    expect(readout()).toEqual([`${MINUS}1.000`, '0.000', '0.000']) // −x
    next()
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument()
    expect(readout()).toEqual(['0.000', '0.000', `${MINUS}1.000`]) // −z  (4.4e-16, −1.2e-16 show as 0.000)
  })

  it('Step 1 and Step 2 visibly differ in sign, and their drawn vectors are opposite through the centre', () => {
    renderViewer(hzhWithBloch())

    goTo(1)
    const plusX = { values: readout(), point: endpoint() }
    goTo(2)
    const minusX = { values: readout(), point: endpoint() }

    expect(plusX.values[0]).toBe('1.000')
    expect(minusX.values[0]).toBe(`${MINUS}1.000`)
    expect(minusX.point.cx).toBeCloseTo(240 - plusX.point.cx, 6)
    expect(minusX.point.cy).toBeCloseTo(240 - plusX.point.cy, 6)
    expect(minusX.point.cx).toBeGreaterThan(120)
    expect(plusX.point.cx).toBeLessThan(120)
  })

  it('Step 3 reaches −z: drawn straight below the centre, opposite to Step 0', () => {
    renderViewer(hzhWithBloch())
    const start = endpoint()
    expect(start.cy).toBeLessThan(120) // +z is up

    goTo(3)
    const end = endpoint()
    expect(end.cy).toBeGreaterThan(120) // −z is down
    expect(end.cx).toBeCloseTo(120, 6) // residues (4.4e-16 ...) are invisible at pixel scale
    expect(end.cy).toBeCloseTo(240 - start.cy, 6)
  })

  it('updates on Previous, on chip clicks and on keyboard navigation, always showing the selected step’s own vector', () => {
    renderViewer(hzhWithBloch())

    goTo(2)
    expect(readout()[0]).toBe(`${MINUS}1.000`)
    previous()
    expect(readout()[0]).toBe('1.000')
    chips()[3]!.focus()
    fireEvent.keyDown(chips()[3]!, { key: 'Home' })
    expect(readout()).toEqual(['0.000', '0.000', '1.000'])
    fireEvent.keyDown(chips()[0]!, { key: 'ArrowRight' })
    expect(readout()[0]).toBe('1.000')
    fireEvent.keyDown(chips()[1]!, { key: 'End' })
    expect(readout()).toEqual(['0.000', '0.000', `${MINUS}1.000`])
  })

  it('every step displays exactly the backend vector supplied for it (rounded only for reading)', () => {
    renderViewer(hzhWithBloch())

    HZH_BLOCH_VECTORS.forEach((vector, step) => {
      goTo(step)
      const shown = readout()
      vector.forEach((value, axis) => {
        const magnitude = Math.abs(value).toFixed(3) // test-side oracle from the raw number
        const negative = value < 0 && magnitude !== '0.000'
        expect(shown[axis], `step ${step}, axis ${'xyz'[axis]}`).toBe(`${negative ? MINUS : ''}${magnitude}`)
      })
      // ...and the exact number is still on the page.
      expect(screen.getByTitle(`exact value from the backend: ${vector[2]}`)).toBeInTheDocument()
    })
  })

  it('the source shown for the vector is the selected step', () => {
    renderViewer(hzhWithBloch())
    for (const step of [0, 1, 2, 3]) {
      goTo(step)
      expect(sourceStep()).toBe(`trace step ${step + 1}`)
      expect(sphere().getByText('source result', { selector: 'dt' }).nextElementSibling?.textContent).toBe(`res_a${step}`)
      expect(sphere().getByText('source circuit', { selector: 'dt' }).nextElementSibling?.textContent).toBe(`hash_prefix_a${step}`)
    }
  })

  it('a new trace starts back at step 0 with its own vector', () => {
    const view = renderViewer(hzhWithBloch('a'))
    goTo(2)
    expect(readout()[0]).toBe(`${MINUS}1.000`)

    view.rerender(<TraceViewer trace={hzhWithBloch('b')} isLoading={false} error={null} />)

    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(readout()).toEqual(['0.000', '0.000', '1.000'])
    expect(sourceStep()).toBe('trace step 1')
  })
})

describe('the sphere follows the backend, not the gates or the statevector', () => {
  it('a trace whose vector contradicts its gates and statevector shows the SUPPLIED vector', () => {
    // Statevector says |0> then "H" (textbook: +z then +x); the backend
    // vectors below say something else — the sphere must show what it was told.
    const trace = traceResult({
      numQubits: 1,
      ops: [H0],
      states: [
        [[1, 0], [0, 0]],
        [[0.7071067811865476, 0], [0.7071067811865476, 0]],
      ],
      blochVectors: [
        [0, 0.6, -0.8],
        [-0.6, 0, 0.8],
      ],
    })
    renderViewer(trace)

    expect(readout()).toEqual(['0.000', '0.600', `${MINUS}0.800`])
    next()
    expect(screen.getByText('H on q0')).toBeInTheDocument()
    expect(readout()).toEqual([`${MINUS}0.600`, '0.000', '0.800']) // not the textbook (1, 0, 0)
  })

  it('the same gates with a different backend vector give a different picture (gate names play no part)', () => {
    const withZ = traceResult({ numQubits: 1, ops: [Z0], states: [[[1, 0], [0, 0]], [[1, 0], [0, 0]]], blochVectors: [[0, 0, 1], [0, 0, 1]] })
    const withX = traceResult({ numQubits: 1, ops: [X0], states: [[[1, 0], [0, 0]], [[1, 0], [0, 0]]], blochVectors: [[0, 0, 1], [0, 0, 1]] })

    const a = renderViewer(withZ)
    next()
    const zStep = { values: readout(), point: endpoint() }
    a.unmount()
    renderViewer(withX)
    next()

    // A Z gate and an X gate, the backend returned +z for both: identical pictures.
    expect({ values: readout(), point: endpoint() }).toEqual(zStep)
  })
})

describe('multi-qubit traces (Bell): no fabricated sphere', () => {
  it('every Bell step shows an explanation, not a sphere, vector or zero coordinates', () => {
    renderViewer(bellMeasured())

    for (const step of [0, 1, 2]) {
      goTo(step)
      expect(screen.getByTestId('bloch-unavailable')).toBeInTheDocument()
      expect(screen.getByText('Bloch sphere unavailable for this state.')).toBeInTheDocument()
      expect(screen.getByText('Single-qubit Bloch vector unavailable for this multi-qubit state.')).toBeInTheDocument()
      for (const id of ['bloch-svg', 'bloch-vector', 'bloch-endpoint', 'bloch-readout']) {
        expect(screen.queryByTestId(id)).not.toBeInTheDocument()
      }
    }
    expect(document.querySelector('svg')).toBeNull()
  })

  it('the full trace and statevector viewer stay available next to the explanation', () => {
    renderViewer(bellMeasured())
    goTo(2)

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5) // header + |00⟩..|11⟩
    expect(screen.getByText('CX — control q0, target q1')).toBeInTheDocument()
    expect(screen.getByText('Terminal measurements')).toBeInTheDocument()
  })

  it('a single-qubit trace the backend sent no vectors for gets the plain "not provided" explanation', () => {
    renderViewer(hzh()) // 1 qubit, but the fixture has no bloch data (as from an older backend)

    expect(screen.getByText('Bloch sphere unavailable for this state.')).toBeInTheDocument()
    expect(screen.getByText(/backend did not provide a Bloch vector for this step/)).toBeInTheDocument()
    expect(screen.queryByTestId('bloch-svg')).not.toBeInTheDocument()
    expect(screen.queryByText(/multi-qubit/)).not.toBeInTheDocument()
  })

  it('the empty 1-qubit circuit with a vector shows the initial state’s +z', () => {
    renderViewer(traceResult({ numQubits: 1, ops: [], states: [[[1, 0], [0, 0]]], blochVectors: [[0, 0, 1]] }))
    expect(readout()).toEqual(['0.000', '0.000', '1.000'])
    expect(emptyOneQubit().steps[0]!.blochVector).toBeNull() // (the plain fixture has none)
  })
})

describe('provenance next to the sphere', () => {
  it('shows the backend, result id, execution id and prefix circuit of the step the vector came from', () => {
    renderViewer(hzhWithBloch('p'))
    goTo(2)

    const bloch = sphere()
    const field = (label: string) => bloch.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent
    expect(field('source backend')).toBe('qiskit-aer 0.17.2')
    expect(field('source result')).toBe('res_p2')
    expect(field('source execution')).toBe('aer-local-p2')
    expect(field('source circuit')).toBe('hash_prefix_p2')
    expect(bloch.getByText('Simulated')).toBeInTheDocument()
  })

  it('separates “backend-derived state data” from “circuit correctness”', () => {
    renderViewer(hzhWithBloch())
    const bloch = sphere()
    expect(bloch.getByText(/Backend-derived state data/)).toBeInTheDocument()
    expect(bloch.getByText(/not a statement about whether your circuit is correct/)).toBeInTheDocument()
  })
})

describe('the Lab: browsing a trace changes nothing else', () => {
  const INITIAL_STATE = useBuildStore.getState()
  const CIRCUIT: Circuit = { ...emptyCircuit(1), ops: [H0, Z0, H0] }
  const PROVENANCE: Provenance = {
    resultId: 'res_exec',
    circuitHash: 'hash_exec',
    backend: 'qiskit-aer',
    backendVersion: '0.17.2',
    executionMode: 'statevector',
    provenanceClass: 'SIMULATION',
    verificationStatus: 'VERIFIED',
    createdAt: '2026-01-01T00:00:00Z',
  }
  const VERIFICATION = { verificationStatus: 'VERIFIED' } as unknown as VerifyBellStateResult
  const OPTIMIZATION = { status: 'NO_OPTIMIZATION_FOUND' } as unknown as OptimizationResult
  const MULTI_INPUT = { testId: 't1', overallStatus: 'ALL_PASSED' } as unknown as MultiInputTestResult

  beforeEach(() => {
    traceCircuit.mockReset()
    useBuildStore.setState(INITIAL_STATE, true)
  })
  afterEach(() => {
    cleanup()
    useBuildStore.setState(INITIAL_STATE, true)
  })

  function seedLab() {
    const result = toQuantumValue<ExecutePayload>({ executionId: 'aer-local-x', statevector: [[1, 0], [0, 0]] }, PROVENANCE)
    const tutorTurns = [{ role: 'learner' as const, text: 'why?' }]
    act(() => {
      useBuildStore.getState().loadCircuit(CIRCUIT)
      useBuildStore.setState({ result, verification: VERIFICATION, optimization: OPTIMIZATION, multiInputTest: MULTI_INPUT, tutorTurns })
    })
    return { result, tutorTurns }
  }

  async function runTrace() {
    traceCircuit.mockResolvedValueOnce(hzhWithBloch())
    render(<TracePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Run trace' }))
    await screen.findByTestId('bloch-section')
  }

  it('Run trace from the Lab shows the sphere, and stepping through it updates the sphere', async () => {
    seedLab()
    await runTrace()

    expect(readout()).toEqual(['0.000', '0.000', '1.000'])
    goTo(2)
    expect(readout()).toEqual([`${MINUS}1.000`, '0.000', '0.000'])
    goTo(3)
    expect(readout()).toEqual(['0.000', '0.000', `${MINUS}1.000`])
  })

  it('stepping through the trace changes NOTHING in the Build store (not even a reference)', async () => {
    seedLab()
    await runTrace()
    const afterRun = useBuildStore.getState()

    goTo(1)
    goTo(2)
    goTo(3)
    previous()
    fireEvent.keyDown(chips()[2]!, { key: 'Home' })

    expect(useBuildStore.getState()).toBe(afterRun)
  })

  it('the circuit, execution result, verification, optimizer, multi-input and tutor state are untouched by the whole trace flow', async () => {
    const { result, tutorTurns } = seedLab()
    const circuit = useBuildStore.getState().circuit
    const qasm = useBuildStore.getState().qasmText

    await runTrace()
    goTo(2)
    goTo(3)

    const s = useBuildStore.getState()
    expect(s.circuit).toBe(circuit)
    expect(s.qasmText).toBe(qasm)
    expect(s.result).toBe(result)
    expect(s.verification).toBe(VERIFICATION)
    expect(s.optimization).toBe(OPTIMIZATION)
    expect(s.multiInputTest).toBe(MULTI_INPUT)
    expect(s.tutorTurns).toBe(tutorTurns)
  })

  it('a successful trace with vectors still changes exactly one store field: `trace`', async () => {
    seedLab()
    const before = useBuildStore.getState()

    await runTrace()

    const after = useBuildStore.getState()
    const changed = (Object.keys(after) as Array<keyof typeof after>).filter((key) => after[key] !== before[key])
    expect(changed).toEqual(['trace'])
  })

  it('the vector shown is the one the backend sent for the circuit the Lab held — the client sends only the circuit', async () => {
    seedLab()
    await runTrace()

    expect(traceCircuit).toHaveBeenCalledTimes(1)
    expect(traceCircuit.mock.calls[0]![0]).toEqual(CIRCUIT)
    expect(traceCircuit.mock.calls[0]).toHaveLength(1) // circuit only: nothing about coordinates goes out
    expect(HZH_BLOCH_STATES).toHaveLength(4) // (fixture sanity)
  })
})
