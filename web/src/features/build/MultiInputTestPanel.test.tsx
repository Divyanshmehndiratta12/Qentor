/**
 * Tests for the Build screen's multi-input Test panel. These focus on
 * rendering the server's own report faithfully (ALL_PASSED / SOME_FAILED with
 * a counterexample / INCOMPLETE) and on the store's reset discipline —
 * `multiInputTest` is set directly on the store for these, since the point is
 * to prove rendering and staleness-clearing, not to re-exercise the qubit
 * picker/case editor's own DOM interactions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { MultiInputTestResult } from '@/api'
import { emptyCircuit } from '@/circuit/types'

import { useBuildStore } from './store'
import { MultiInputTestPanel } from './MultiInputTestPanel'

const EXECUTED_CIRCUIT = {
  ...emptyCircuit(2, 2),
  ops: [{ gate: 'cx' as const, targets: [1], controls: [0], params: [], clbits: [] }],
}

const BASE_REPORT: Omit<MultiInputTestResult, 'cases' | 'counterexamples' | 'overallStatus'> = {
  testId: 'test_abc123',
  circuitHash: 'hash_abc',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  inputQubits: [0],
  outputQubits: [1],
}

const INITIAL_STATE = useBuildStore.getState()

function setCircuitAndReport(report: MultiInputTestResult | null) {
  useBuildStore.setState({ circuit: EXECUTED_CIRCUIT, multiInputTest: report })
}

describe('MultiInputTestPanel', () => {
  beforeEach(() => {
    useBuildStore.setState(INITIAL_STATE, true)
  })

  afterEach(() => {
    useBuildStore.setState(INITIAL_STATE, true)
  })

  it('renders nothing when the circuit has no operations', () => {
    useBuildStore.setState({ circuit: emptyCircuit(2, 2), multiInputTest: null })
    const { container } = render(<MultiInputTestPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders ALL_PASSED with every case shown as PASS', () => {
    const report: MultiInputTestResult = {
      ...BASE_REPORT,
      overallStatus: 'ALL_PASSED',
      cases: [
        {
          inputBits: '0',
          expectedOutput: '0',
          status: 'PASS',
          observedDistribution: { '0': 1 },
          error: null,
          resultId: 'res_1',
          circuitHash: 'hash_case1',
        },
        {
          inputBits: '1',
          expectedOutput: '1',
          status: 'PASS',
          observedDistribution: { '1': 1 },
          error: null,
          resultId: 'res_2',
          circuitHash: 'hash_case2',
        },
      ],
      counterexamples: [],
    }
    setCircuitAndReport(report)

    render(<MultiInputTestPanel />)

    expect(screen.getByText('All passed')).toBeInTheDocument()
    expect(screen.getAllByText('PASS')).toHaveLength(2)
    expect(screen.getByText('res_1')).toBeInTheDocument()
    expect(screen.getByText('res_2')).toBeInTheDocument()
    expect(screen.queryByText(/counterexample/i)).not.toBeInTheDocument()
  })

  it('renders SOME_FAILED with the backend-provided counterexample shown prominently', () => {
    const report: MultiInputTestResult = {
      ...BASE_REPORT,
      overallStatus: 'SOME_FAILED',
      cases: [
        {
          inputBits: '0',
          expectedOutput: '0',
          status: 'PASS',
          observedDistribution: { '0': 1 },
          error: null,
          resultId: 'res_1',
          circuitHash: 'hash_case1',
        },
        {
          inputBits: '1',
          expectedOutput: '0',
          status: 'FAIL',
          observedDistribution: { '1': 1 },
          error: null,
          resultId: 'res_2',
          circuitHash: 'hash_case2',
        },
      ],
      counterexamples: [
        {
          inputBits: '1',
          expectedOutput: '0',
          observedDistribution: { '1': 1 },
          circuitHash: 'hash_case2',
          resultId: 'res_2',
        },
      ],
    }
    setCircuitAndReport(report)

    render(<MultiInputTestPanel />)

    expect(screen.getByText('Some failed')).toBeInTheDocument()
    expect(screen.getByText('PASS')).toBeInTheDocument()
    expect(screen.getByText('FAIL')).toBeInTheDocument()
    const counterexample = screen.getByText(/counterexample/i)
    expect(counterexample).toBeInTheDocument()
    // The counterexample block cites the server's own data, not a recomputed one.
    expect(counterexample.closest('div')?.textContent).toContain('1: 1.000000')
    expect(counterexample.closest('div')?.textContent).toContain('res_2')
  })

  it('renders INCOMPLETE with the execution error surfaced, not a fabricated verdict', () => {
    const report: MultiInputTestResult = {
      ...BASE_REPORT,
      overallStatus: 'INCOMPLETE',
      cases: [
        {
          inputBits: '0',
          expectedOutput: '0',
          status: 'EXECUTION_ERROR',
          observedDistribution: null,
          error: 'AdapterUnavailable: cirq could not be imported',
          resultId: null,
          circuitHash: 'hash_case1',
        },
      ],
      counterexamples: [],
    }
    setCircuitAndReport(report)

    render(<MultiInputTestPanel />)

    expect(screen.getByText('Incomplete')).toBeInTheDocument()
    expect(screen.getByText('EXECUTION_ERROR')).toBeInTheDocument()
    expect(screen.getByText(/AdapterUnavailable: cirq could not be imported/)).toBeInTheDocument()
    expect(screen.queryByText('PASS')).not.toBeInTheDocument()
    expect(screen.queryByText('FAIL')).not.toBeInTheDocument()
  })

  it('clears a stale multi-input report when the circuit mutates, via the store reset discipline', () => {
    const report: MultiInputTestResult = {
      ...BASE_REPORT,
      overallStatus: 'ALL_PASSED',
      cases: [
        {
          inputBits: '0',
          expectedOutput: '0',
          status: 'PASS',
          observedDistribution: { '0': 1 },
          error: null,
          resultId: 'res_1',
          circuitHash: 'hash_case1',
        },
      ],
      counterexamples: [],
    }
    setCircuitAndReport(report)

    render(<MultiInputTestPanel />)
    expect(screen.getByText('All passed')).toBeInTheDocument()

    // A real store action that mutates derived state — same reset discipline
    // verification/optimization/tutor state already use.
    act(() => {
      useBuildStore.getState().setMode('shots')
    })

    expect(useBuildStore.getState().multiInputTest).toBeNull()
    expect(useBuildStore.getState().multiInputTestError).toBeNull()
    expect(screen.queryByText('All passed')).not.toBeInTheDocument()
  })
})
