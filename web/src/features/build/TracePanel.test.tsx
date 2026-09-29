/**
 * Lab integration tests: TracePanel + the real `useBuildStore.runTrace`.
 * `@/api`'s `getApiClient` is mocked (no live backend), the store is real —
 * so these cover exactly what the Lab does with a trace: which circuit it
 * sends, what state it writes, and, just as importantly, what it must not
 * touch (the circuit, the normal execution result, verification, optimizer,
 * multi-input test, tutor).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TraceRejectedError, BackendUnavailableError } from '@/api'
import type { ExecutePayload, MultiInputTestResult, OptimizationResult, VerifyBellStateResult } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { H0, MEASURE0, X0, hzh, xThenMeasure } from '@/test/traceFixtures'

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

const EXEC_PROVENANCE: Provenance = {
  resultId: 'res_exec',
  circuitHash: 'hash_exec',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'VERIFIED',
  createdAt: '2026-01-01T00:00:00Z',
}

const X_MEASURE_CIRCUIT: Circuit = { ...emptyCircuit(1, 1), ops: [X0, MEASURE0] }
const HZH_CIRCUIT: Circuit = { ...emptyCircuit(1), ops: [H0, op('z'), H0] }
function op(gate: 'z') {
  return { gate, targets: [0], controls: [], params: [], clbits: [] }
}

const INITIAL_STATE = useBuildStore.getState()

/** A promise the test resolves/rejects by hand, to observe the in-flight state. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setCircuit(circuit: Circuit) {
  act(() => {
    useBuildStore.getState().loadCircuit(circuit)
  })
}

const runButton = () => screen.getByRole('button', { name: /Run trace|Tracing…/ })

describe('TracePanel in the Lab', () => {
  beforeEach(() => {
    traceCircuit.mockReset()
    useBuildStore.setState(INITIAL_STATE, true)
  })

  afterEach(() => {
    cleanup()
    useBuildStore.setState(INITIAL_STATE, true)
  })

  describe('requesting a trace', () => {
    it('starts idle, with a Run trace button and no request made', () => {
      render(<TracePanel />)

      expect(screen.getByRole('heading', { name: 'Trace' })).toBeInTheDocument()
      expect(runButton()).toBeEnabled()
      expect(screen.getByText(/No trace yet/)).toBeInTheDocument()
      expect(traceCircuit).not.toHaveBeenCalled()
    })

    it('sends the CURRENT Build circuit (the very object in the store) to the backend', async () => {
      setCircuit(X_MEASURE_CIRCUIT)
      const current = useBuildStore.getState().circuit
      traceCircuit.mockResolvedValueOnce(xThenMeasure())
      render(<TracePanel />)

      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })

      expect(traceCircuit).toHaveBeenCalledTimes(1)
      expect(traceCircuit.mock.calls[0]![0]).toBe(current)
      expect(traceCircuit.mock.calls[0]![0]).toEqual(X_MEASURE_CIRCUIT)
    })

    it('follows the circuit: after an edit, the next trace sends the edited circuit', async () => {
      setCircuit(X_MEASURE_CIRCUIT)
      traceCircuit.mockResolvedValue(xThenMeasure())
      render(<TracePanel />)
      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })

      setCircuit(HZH_CIRCUIT)
      traceCircuit.mockResolvedValue(hzh())
      fireEvent.click(runButton())
      await screen.findByText('Step 0 of 3')

      expect(traceCircuit.mock.calls[1]![0]).toEqual(HZH_CIRCUIT)
    })

    it('does no eligibility checking of its own: even an empty circuit is sent to the backend to decide', async () => {
      traceCircuit.mockResolvedValueOnce(
        hzh(), // whatever the backend answers is what is shown
      )
      render(<TracePanel />)
      expect(useBuildStore.getState().circuit.ops).toHaveLength(0)

      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })

      expect(traceCircuit).toHaveBeenCalledTimes(1)
    })

    it('shows a loading state (and disables the button) while the backend works', async () => {
      const pending = deferred<ReturnType<typeof hzh>>()
      traceCircuit.mockReturnValueOnce(pending.promise)
      render(<TracePanel />)

      fireEvent.click(runButton())

      expect(await screen.findByRole('status')).toHaveTextContent('Tracing on backend…')
      expect(runButton()).toBeDisabled()
      expect(runButton()).toHaveTextContent('Tracing…')

      await act(async () => {
        pending.resolve(hzh())
      })
      expect(await screen.findByRole('group', { name: 'Trace steps' })).toBeInTheDocument()
      expect(runButton()).toBeEnabled()
    })

    it('shows exactly what the backend returned — X then measure: two steps, measure listed separately', async () => {
      setCircuit(X_MEASURE_CIRCUIT)
      traceCircuit.mockResolvedValueOnce(xThenMeasure())
      render(<TracePanel />)

      fireEvent.click(runButton())
      const timeline = await screen.findByRole('group', { name: 'Trace steps' })

      expect(within(timeline).getAllByRole('button')).toHaveLength(2)
      expect(screen.getByText('Terminal measurements')).toBeInTheDocument()
      expect(screen.getByText('op 1: Measure q0 → c0')).toBeInTheDocument()
      expect(screen.getAllByRole('table')).toHaveLength(1)
    })
  })

  describe('errors', () => {
    it('renders the backend’s structured refusal cleanly and stores no trace', async () => {
      traceCircuit.mockRejectedValueOnce(
        new TraceRejectedError('TRACE_MID_CIRCUIT_MEASUREMENT', 'op[2] (x) comes after a measurement (op[1])', 422),
      )
      render(<TracePanel />)

      fireEvent.click(runButton())

      const alert = await screen.findByRole('alert')
      expect(within(alert).getByText('Trace not available')).toBeInTheDocument()
      expect(within(alert).getByTestId('trace-error-code')).toHaveTextContent('TRACE_MID_CIRCUIT_MEASUREMENT')
      expect(alert).toHaveTextContent('comes after a measurement')
      expect(useBuildStore.getState().trace).toBeNull()
      expect(useBuildStore.getState().traceError).toEqual({
        kind: 'rejected',
        code: 'TRACE_MID_CIRCUIT_MEASUREMENT',
        message: 'op[2] (x) comes after a measurement (op[1])',
      })
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(runButton()).toBeEnabled() // can retry
    })

    it('renders an unreachable backend as an unexpected failure — no fallback data', async () => {
      traceCircuit.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend: Failed to fetch'))
      render(<TracePanel />)

      fireEvent.click(runButton())

      const alert = await screen.findByRole('alert')
      expect(within(alert).getByText('Trace failed unexpectedly')).toBeInTheDocument()
      expect(alert).toHaveTextContent('could not reach the Qentor backend')
      expect(useBuildStore.getState().trace).toBeNull()
    })

    it('a response that failed validation is reported as unexpected, without dumping the raw error', async () => {
      const zodLike = new Error('[ {"code":"custom","path":["steps",1]} ]')
      zodLike.name = 'ZodError'
      traceCircuit.mockRejectedValueOnce(zodLike)
      render(<TracePanel />)

      fireEvent.click(runButton())

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent("did not match the expected shape")
      expect(alert).not.toHaveTextContent('"code":"custom"')
    })

    it('the mock adapter’s "no fake trace" answer is shown as an error, never as data', async () => {
      const { EndpointNotImplementedError } = await import('@/api')
      traceCircuit.mockRejectedValueOnce(new EndpointNotImplementedError('POST /api/execute/trace'))
      render(<TracePanel />)

      fireEvent.click(runButton())

      expect(await screen.findByRole('alert')).toHaveTextContent('has no backend implementation yet')
      expect(useBuildStore.getState().trace).toBeNull()
    })

    it('a retry after an error clears the error and shows the new trace', async () => {
      traceCircuit.mockRejectedValueOnce(new TraceRejectedError('TRACE_BACKEND_UNAVAILABLE', 'down', 503))
      render(<TracePanel />)
      fireEvent.click(runButton())
      await screen.findByRole('alert')

      traceCircuit.mockResolvedValueOnce(hzh())
      fireEvent.click(runButton())

      await screen.findByRole('group', { name: 'Trace steps' })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(useBuildStore.getState().traceError).toBeNull()
    })
  })

  describe('a trace never mutates or erases anything else in the Lab', () => {
    const VERIFICATION: VerifyBellStateResult = {
      resultId: 'res_exec',
      circuitHash: 'hash_exec',
      verifier: 'bell_state/1',
      verificationStatus: 'VERIFIED',
      checks: [],
      expectedSupport: ['00', '11'],
      observedSupport: ['00', '11'],
    }
    const OPTIMIZATION = { status: 'NO_OPTIMIZATION_FOUND' } as unknown as OptimizationResult
    const MULTI_INPUT = { testId: 't1', overallStatus: 'ALL_PASSED' } as unknown as MultiInputTestResult

    /** Fills every other Lab slice, so we can prove a trace leaves each one alone. */
    function seedLab() {
      const result = toQuantumValue<ExecutePayload>({ executionId: 'aer-local-x', statevector: [[1, 0], [0, 0]] }, EXEC_PROVENANCE)
      const tutorTurns = [{ role: 'learner' as const, text: 'why?' }]
      act(() => {
        useBuildStore.getState().loadCircuit(X_MEASURE_CIRCUIT)
        useBuildStore.setState({
          result,
          verification: VERIFICATION,
          optimization: OPTIMIZATION,
          multiInputTest: MULTI_INPUT,
          tutorTurns,
          executionError: null,
          verificationError: null,
          optimizationError: null,
          multiInputTestError: null,
        })
      })
      return { result, tutorTurns }
    }

    it('leaves the circuit and its QASM untouched', async () => {
      seedLab()
      const { circuit, qasmText, mode, shots } = useBuildStore.getState()
      traceCircuit.mockResolvedValueOnce(xThenMeasure())
      render(<TracePanel />)

      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })

      const after = useBuildStore.getState()
      expect(after.circuit).toBe(circuit)
      expect(after.qasmText).toBe(qasmText)
      expect(after.mode).toBe(mode)
      expect(after.shots).toBe(shots)
    })

    it('does not erase or replace the normal execution result', async () => {
      const { result } = seedLab()
      traceCircuit.mockResolvedValueOnce(xThenMeasure())
      render(<TracePanel />)

      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })

      expect(useBuildStore.getState().result).toBe(result)
      expect(useBuildStore.getState().isExecuting).toBe(false)
      expect(useBuildStore.getState().executionError).toBeNull()
    })

    it('does not alter verification, optimizer, multi-input or tutor state — on success', async () => {
      const { tutorTurns } = seedLab()
      traceCircuit.mockResolvedValueOnce(xThenMeasure())
      render(<TracePanel />)

      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })

      const s = useBuildStore.getState()
      expect(s.verification).toBe(VERIFICATION)
      expect(s.optimization).toBe(OPTIMIZATION)
      expect(s.multiInputTest).toBe(MULTI_INPUT)
      expect(s.tutorTurns).toBe(tutorTurns)
      expect(s.isVerifying).toBe(false)
      expect(s.isOptimizing).toBe(false)
      expect(s.isMultiInputTesting).toBe(false)
      expect(s.isAskingTutor).toBe(false)
    })

    it('does not alter any of that state when the trace FAILS either', async () => {
      const { result, tutorTurns } = seedLab()
      const circuit = useBuildStore.getState().circuit
      traceCircuit.mockRejectedValueOnce(new TraceRejectedError('TRACE_TOO_MANY_OPERATIONS', 'too long', 422))
      render(<TracePanel />)

      fireEvent.click(runButton())
      await screen.findByRole('alert')

      const s = useBuildStore.getState()
      expect(s.circuit).toBe(circuit)
      expect(s.result).toBe(result)
      expect(s.verification).toBe(VERIFICATION)
      expect(s.optimization).toBe(OPTIMIZATION)
      expect(s.multiInputTest).toBe(MULTI_INPUT)
      expect(s.tutorTurns).toBe(tutorTurns)
    })

    it('a successful trace changes exactly one field of the whole Build store: `trace`', async () => {
      seedLab()
      const before = useBuildStore.getState()
      traceCircuit.mockResolvedValueOnce(xThenMeasure())
      render(<TracePanel />)

      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })

      const after = useBuildStore.getState()
      const changed = (Object.keys(after) as Array<keyof typeof after>).filter((key) => after[key] !== before[key])
      // (`isTracing` flips true then back to false, so it ends where it began.)
      expect(changed).toEqual(['trace'])
    })

    it('a failed trace changes exactly one field: `traceError`', async () => {
      seedLab()
      const before = useBuildStore.getState()
      traceCircuit.mockRejectedValueOnce(new TraceRejectedError('TRACE_MODE_UNSUPPORTED', 'no', 422))
      render(<TracePanel />)

      fireEvent.click(runButton())
      await screen.findByRole('alert')

      const after = useBuildStore.getState()
      const changed = (Object.keys(after) as Array<keyof typeof after>).filter((key) => after[key] !== before[key])
      expect(changed).toEqual(['traceError'])
    })

    it('changing execution mode or re-running the normal execution does NOT erase a trace of the unchanged circuit', async () => {
      seedLab()
      traceCircuit.mockResolvedValueOnce(xThenMeasure())
      render(<TracePanel />)
      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })
      const trace = useBuildStore.getState().trace

      // The Build screen re-executes on a debounce; the mode toggle resets
      // execution-derived state. Neither changes the circuit, so the trace stays.
      act(() => {
        useBuildStore.getState().setMode('shots')
        useBuildStore.getState().setMode('statevector')
      })

      expect(useBuildStore.getState().trace).toBe(trace)
      expect(screen.getByRole('group', { name: 'Trace steps' })).toBeInTheDocument()
    })
  })

  describe('a trace belongs to the circuit it was taken from', () => {
    async function withTrace() {
      setCircuit(X_MEASURE_CIRCUIT)
      traceCircuit.mockResolvedValueOnce(xThenMeasure())
      render(<TracePanel />)
      fireEvent.click(runButton())
      await screen.findByRole('group', { name: 'Trace steps' })
    }

    it.each([
      ['adding a gate', () => useBuildStore.getState().selectGate('h')],
    ])('is cleared by %s', async () => {
      await withTrace()
      act(() => {
        useBuildStore.getState().selectGate('h')
        useBuildStore.getState().onWireClick(0)
      })
      expect(useBuildStore.getState().trace).toBeNull()
      expect(screen.queryByRole('group', { name: 'Trace steps' })).not.toBeInTheDocument()
      expect(screen.getByText(/No trace yet/)).toBeInTheDocument()
    })

    it('is cleared by removing an operation', async () => {
      await withTrace()
      act(() => useBuildStore.getState().removeOpAt(0))
      expect(useBuildStore.getState().trace).toBeNull()
    })

    it('is cleared by editing the QASM', async () => {
      await withTrace()
      act(() => {
        useBuildStore.getState().applyQasmEdit('OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nh q[0];\n')
      })
      expect(useBuildStore.getState().trace).toBeNull()
    })

    it('is cleared by changing the qubit count and by loading another circuit', async () => {
      await withTrace()
      act(() => useBuildStore.getState().setNumQubits(2))
      expect(useBuildStore.getState().trace).toBeNull()

      traceCircuit.mockResolvedValueOnce(hzh())
      fireEvent.click(runButton())
      await screen.findByText('Step 0 of 3')
      act(() => useBuildStore.getState().loadCircuit(X_MEASURE_CIRCUIT))
      expect(useBuildStore.getState().trace).toBeNull()
    })

    it('a response that arrives after the circuit changed is discarded, not shown against the wrong circuit', async () => {
      setCircuit(X_MEASURE_CIRCUIT)
      const pending = deferred<ReturnType<typeof xThenMeasure>>()
      traceCircuit.mockReturnValueOnce(pending.promise)
      render(<TracePanel />)
      fireEvent.click(runButton())
      await screen.findByRole('status')

      setCircuit(HZH_CIRCUIT) // learner edits while the request is in flight
      await act(async () => {
        pending.resolve(xThenMeasure())
      })

      expect(useBuildStore.getState().trace).toBeNull()
      expect(useBuildStore.getState().isTracing).toBe(false)
      expect(screen.queryByRole('group', { name: 'Trace steps' })).not.toBeInTheDocument()
      expect(screen.getByText(/No trace yet/)).toBeInTheDocument()
    })

    it('an older, slower request never overwrites a newer one', async () => {
      const slow = deferred<ReturnType<typeof xThenMeasure>>()
      const fast = deferred<ReturnType<typeof hzh>>()
      traceCircuit.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
      render(<TracePanel />)

      // Two requests for the same circuit (bypassing the disabled button via the store).
      act(() => {
        void useBuildStore.getState().runTrace()
        void useBuildStore.getState().runTrace()
      })
      await act(async () => {
        fast.resolve(hzh('fast'))
      })
      await screen.findByText('Step 0 of 3')
      await act(async () => {
        slow.resolve(xThenMeasure('slow'))
      })

      expect(useBuildStore.getState().trace?.steps[0]?.state.provenance.resultId).toBe('res_fast0')
      await waitFor(() => expect(screen.getByText('Step 0 of 3')).toBeInTheDocument())
    })
  })
})
