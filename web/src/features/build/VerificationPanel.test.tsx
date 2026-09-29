/**
 * Tests for the Build screen's Verify action (VerificationPanel + the
 * store.runVerification wiring behind it). `@/api`'s `getApiClient` is mocked
 * so these run without a live backend; the store itself is real, so this also
 * covers "the Verify action is only available once a real execution result
 * exists" and "a failed/HTTP-erroring verification never renders a fabricated
 * report".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BackendUnavailableError } from '@/api'
import type { ExecutePayload, VerifyBellStateResult } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const verifyBellState = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(),
      verifyBellState,
      listLessons: vi.fn(),
      getLesson: vi.fn(),
      askTutor: vi.fn(),
    }),
  }
})

import { useBuildStore } from './store'
import { VerificationPanel } from './VerificationPanel'

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

const EXECUTED_CIRCUIT = {
  ...emptyCircuit(2, 2),
  ops: [
    { gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx' as const, targets: [1], controls: [0], params: [], clbits: [] },
    { gate: 'measure' as const, targets: [0], controls: [], params: [], clbits: [0] },
    { gate: 'measure' as const, targets: [1], controls: [], params: [], clbits: [1] },
  ],
}

function setExecutedResult(payload: ExecutePayload = { executionId: 'aer-local-abc', probabilities: { '00': 0.5, '11': 0.5 } }) {
  useBuildStore.setState({
    circuit: EXECUTED_CIRCUIT,
    result: toQuantumValue(payload, PROVENANCE),
    isExecuting: false,
    executionError: null,
  })
}

const INITIAL_STATE = useBuildStore.getState()

describe('VerificationPanel', () => {
  beforeEach(() => {
    verifyBellState.mockReset()
    useBuildStore.setState(INITIAL_STATE, true)
  })

  afterEach(() => {
    // Unmount before resetting stores: this afterEach runs before RTL's own
    // auto-cleanup, and resetting a store under a still-mounted component
    // is a state update outside act().
    cleanup()
    useBuildStore.setState(INITIAL_STATE, true)
  })

  it('renders nothing when there is no real execution result yet', () => {
    useBuildStore.setState({ result: null })
    const { container } = render(<VerificationPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing while a circuit is still executing', () => {
    setExecutedResult()
    useBuildStore.setState({ isExecuting: true })
    const { container } = render(<VerificationPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('sends the result_id and executed circuit, and renders a VERIFIED report', async () => {
    setExecutedResult()
    const report: VerifyBellStateResult = {
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      verifier: 'bell_state/1',
      verificationStatus: 'VERIFIED',
      checks: [{ name: 'circuit_matches_bell_pattern', status: 'PASS', detail: 'matches the canonical Bell pattern' }],
      expectedSupport: ['00', '11'],
      observedSupport: ['00', '11'],
    }
    verifyBellState.mockResolvedValueOnce(report)

    render(<VerificationPanel />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })) })

    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument())
    expect(verifyBellState).toHaveBeenCalledWith('res_abc', EXECUTED_CIRCUIT)
    expect(screen.getByText('bell_state/1')).toBeInTheDocument()
    expect(screen.getByText('res_abc')).toBeInTheDocument()
    expect(screen.getByText('hash_abc')).toBeInTheDocument()
    expect(screen.getAllByText('00')).toHaveLength(2)
    expect(screen.getAllByText('11')).toHaveLength(2)
  })

  it('renders a FAILED report distinctly from a VERIFIED one', async () => {
    setExecutedResult()
    verifyBellState.mockResolvedValueOnce({
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      verifier: 'bell_state/1',
      verificationStatus: 'FAILED',
      checks: [
        { name: 'observed_support_within_expected', status: 'FAIL', detail: 'unexpected outcome 01' },
      ],
      expectedSupport: ['00', '11'],
      observedSupport: ['00', '01', '11'],
    } satisfies VerifyBellStateResult)

    render(<VerificationPanel />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })) })

    await waitFor(() => expect(screen.getByText('Failed')).toBeInTheDocument())
    expect(screen.queryByText('Verified')).not.toBeInTheDocument()
    expect(screen.getByText(/unexpected outcome 01/)).toBeInTheDocument()
  })

  it('renders UNVERIFIABLE and ERROR distinctly from VERIFIED/FAILED', async () => {
    setExecutedResult()
    verifyBellState.mockResolvedValueOnce({
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      verifier: 'bell_state/1',
      verificationStatus: 'UNVERIFIABLE',
      checks: [{ name: 'circuit_matches_bell_pattern', status: 'FAIL', detail: 'not the Bell pattern' }],
      expectedSupport: [],
      observedSupport: [],
    } satisfies VerifyBellStateResult)

    render(<VerificationPanel />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })) })
    await waitFor(() => expect(screen.getByText('Unverifiable')).toBeInTheDocument())

    verifyBellState.mockResolvedValueOnce({
      resultId: 'res_abc',
      circuitHash: 'hash_abc',
      verifier: 'bell_state/1',
      verificationStatus: 'ERROR',
      checks: [{ name: 'circuit_hash_matches_record', status: 'FAIL', detail: 'hash mismatch' }],
      expectedSupport: [],
      observedSupport: [],
    } satisfies VerifyBellStateResult)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })) })
    await waitFor(() => expect(screen.getByText('Error')).toBeInTheDocument())
  })

  it('shows an explicit error and no fabricated report when the request fails', async () => {
    setExecutedResult()
    verifyBellState.mockRejectedValueOnce(
      new BackendUnavailableError("no provenance record found for result_id 'res_abc'", 404),
    )

    render(<VerificationPanel />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })) })

    await waitFor(() => expect(screen.getByText('Verification unavailable')).toBeInTheDocument())
    expect(screen.getByText(/no provenance record found/)).toBeInTheDocument()
    expect(screen.queryByText('Verified')).not.toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })
})
