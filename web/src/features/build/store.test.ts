/**
 * Tests for `useBuildStore.loadCircuit` — the bridge a Learn lesson's
 * interactive_lab action uses to hand its `linkedCircuit` to the Build
 * workspace (see `App.tsx`'s `openInLab`). It must behave exactly like every
 * other circuit-mutating action here: replace the circuit and clear every
 * derived result/verification/tutor/optimization/multi-input-test state, so
 * nothing stale from a previous circuit lingers on screen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import type { ExecutePayload, MultiInputTestResult, OptimizationResult, VerifyBellStateResult } from '@/api'
import { useBuildStore } from './store'

const INITIAL_STATE = useBuildStore.getState()

const PROVENANCE: Provenance = {
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'shots',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'VERIFIED',
  createdAt: '2026-01-01T00:00:00Z',
}

const VERIFICATION: VerifyBellStateResult = {
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  verifier: 'bell_state/1',
  verificationStatus: 'VERIFIED',
  checks: [],
  expectedSupport: ['00', '11'],
  observedSupport: ['00', '11'],
}

const OPTIMIZATION: OptimizationResult = {
  originalCircuitHash: 'hash_abc',
  candidateCircuitHash: 'hash_abc',
  originalOpCount: 1,
  candidateOpCount: 1,
  rulesApplied: [],
  reductionSummary: 'unchanged',
  status: 'NO_OPTIMIZATION_FOUND',
  equivalence: null,
  verifierName: 'qentor.verification.optimizer',
  verifierVersion: '0',
  reason: null,
  candidateCircuit: null,
  resultId: null,
}

const MULTI_INPUT_TEST: MultiInputTestResult = {
  testId: 'test_abc',
  circuitHash: 'hash_abc',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  inputQubits: [0],
  outputQubits: [1],
  cases: [],
  counterexamples: [],
  overallStatus: 'ALL_PASSED',
}

describe('useBuildStore.loadCircuit', () => {
  beforeEach(() => {
    useBuildStore.setState(INITIAL_STATE, true)
  })

  afterEach(() => {
    useBuildStore.setState(INITIAL_STATE, true)
  })

  it('replaces the circuit and clears every derived execution/verification/tutor/optimization/multi-input state', () => {
    const circuit = {
      ...emptyCircuit(2, 2),
      ops: [{ gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] }],
    }

    useBuildStore.setState({
      result: toQuantumValue<ExecutePayload>({ executionId: 'x', probabilities: { '00': 1 } }, PROVENANCE),
      executionError: 'stale error',
      verification: VERIFICATION,
      verificationError: 'stale error',
      tutorTurns: [{ role: 'learner', text: 'hi' }],
      isAskingTutor: true,
      optimization: OPTIMIZATION,
      optimizationError: 'stale error',
      multiInputTest: MULTI_INPUT_TEST,
      multiInputTestError: 'stale error',
    })

    useBuildStore.getState().loadCircuit(circuit)

    const state = useBuildStore.getState()
    expect(state.circuit).toEqual(circuit)
    expect(state.result).toBeNull()
    expect(state.executionError).toBeNull()
    expect(state.verification).toBeNull()
    expect(state.verificationError).toBeNull()
    expect(state.tutorTurns).toEqual([])
    expect(state.isAskingTutor).toBe(false)
    expect(state.optimization).toBeNull()
    expect(state.optimizationError).toBeNull()
    expect(state.multiInputTest).toBeNull()
    expect(state.multiInputTestError).toBeNull()
  })

  it('does not change the selected tutor language — a learner preference, not derived state', () => {
    useBuildStore.getState().setTutorLanguage('hi')

    useBuildStore.getState().loadCircuit(emptyCircuit(1, 1))

    expect(useBuildStore.getState().tutorLanguage).toBe('hi')
  })
})
