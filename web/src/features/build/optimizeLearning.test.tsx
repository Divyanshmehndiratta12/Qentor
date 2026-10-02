/**
 * The Optimize panel as a learning flow: original -> candidate -> equivalence check -> decision, the examples a learner can load, and
 * the honest context note about compiler toolchains. The server decides every verdict; these tests pin that the browser only names the
 * stages, reads each figure from the report it was sent, loads an example as one undo step, and never shows an example's description
 * against a circuit it does not describe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { OptimizationResult } from '@/api'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import type { Provenance } from '@/provenance/QuantumValue'

const client = vi.hoisted(() => ({ optimizeCircuit: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { OptimizePanel } from './OptimizePanel'
import { OPTIMIZE_EXAMPLES } from './optimizeExamples'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const build = () => useBuildStore.getState()
const op = (gate: GateOp['gate'], targets: number[]): GateOp => ({ gate, targets, controls: [], params: [], clbits: [] })
const circuitOf = (n: number, ops: GateOp[]): Circuit => ({ ...emptyCircuit(n, 0), ops })
const MINE = circuitOf(1, [op('x', [0]), op('z', [0])])

const PROVENANCE: Provenance = {
  resultId: 'res_c',
  circuitHash: 'abc123',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-10-01T00:00:00Z',
}
const equivalent = {
  status: 'EQUIVALENT' as const,
  method: 'qiskit.quantum_info.Operator equivalence up to global phase',
  globalPhase: 0,
  checks: [{ name: 'operator_equivalent_up_to_global_phase', status: 'PASS' as const, detail: 'operators agree' }],
  reason: null,
}
const BASE: OptimizationResult = {
  originalCircuitHash: 'o',
  candidateCircuitHash: 'c',
  originalOpCount: 3,
  candidateOpCount: 1,
  rulesApplied: ['cancelled adjacent h pair on qubit(s) [0]'],
  reductionSummary: '3 -> 1 operations',
  status: 'VERIFIED_SHORTER',
  equivalence: equivalent,
  verifierName: 'qentor.verification.optimizer',
  verifierVersion: '1',
  reason: null,
  candidateCircuit: circuitOf(1, [op('x', [0])]),
  resultId: 'res_c',
  operationsRemoved: 2,
  changes: [{ kind: 'removed', originalIndex: 0, candidateIndex: null, description: 'h on q[0]' }],
  ruleNotes: [{ rule: 'cancelled adjacent h pair on qubit(s) [0]', explanation: 'Applying H twice returns every state to where it started.' }],
  candidateProvenance: PROVENANCE,
}

beforeEach(() => {
  client.optimizeCircuit.mockReset()
  useBuildStore.setState(INITIAL, true)
  build().loadCircuit(MINE)
})
afterEach(cleanup)

async function showReport(report: OptimizationResult) {
  client.optimizeCircuit.mockResolvedValue(report)
  render(<OptimizePanel />)
  fireEvent.click(screen.getByRole('button', { name: 'Optimize' }))
  return screen.findByTestId('optimization-steps')
}
const stepText = (steps: HTMLElement, name: string) => within(steps).getByText(name).closest('li')!.textContent ?? ''

describe('the four stages: original, candidate, equivalence check, decision', () => {
  it('a verified shorter circuit reads: original N, candidate M, equivalent, accepted - with Apply still the learner’s choice', async () => {
    const steps = await showReport(BASE)
    expect(within(steps).getAllByRole('listitem').map((li) => li.getAttribute('data-step'))).toEqual(['Original', 'Candidate', 'Equivalence check', 'Decision'])
    expect(stepText(steps, 'Original')).toContain('3 operations')
    expect(stepText(steps, 'Candidate')).toContain('1 operation')
    expect(stepText(steps, 'Candidate')).not.toContain('1 operations')
    expect(stepText(steps, 'Equivalence check')).toContain('Equivalent')
    expect(stepText(steps, 'Decision')).toContain('Accepted')
    expect(stepText(steps, 'Decision')).toContain('only if you press Apply')
    expect(steps).toHaveAccessibleName('How the server reached this result')
    // nothing was applied by showing it
    expect(build().circuit).toEqual(MINE)
  })

  it('reads its figures from the report: a count the server sent is shown as sent, with the noun agreeing with it', async () => {
    const steps = await showReport({ ...BASE, originalOpCount: 9, candidateOpCount: 4 })
    expect(stepText(steps, 'Original')).toContain('9 operations')
    expect(stepText(steps, 'Candidate')).toContain('4 operations')
  })

  it('says "1 operation", not "1 operations"', async () => {
    const single = await showReport({ ...BASE, originalOpCount: 1, candidateOpCount: 1 })
    expect(stepText(single, 'Original')).toContain('1 operation')
    expect(stepText(single, 'Original')).not.toContain('1 operations')
    expect(screen.getByTestId('optimization-counts')).not.toHaveTextContent('1 operations')
  })

  it('no rule matched: no candidate was built, the check did not run, there is nothing to propose', async () => {
    const steps = await showReport({ ...BASE, status: 'NO_OPTIMIZATION_FOUND', equivalence: null, candidateCircuit: null, changes: [], ruleNotes: [], rulesApplied: [], candidateProvenance: null, resultId: null, candidateOpCount: 3, operationsRemoved: 0 })
    expect(stepText(steps, 'Candidate')).toContain('None built')
    expect(stepText(steps, 'Equivalence check')).toContain('Not run')
    expect(stepText(steps, 'Decision')).toContain('Nothing to propose')
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull()
  })

  it('a rewrite the backend says is not equivalent is rejected: the candidate is withheld and nothing can be applied', async () => {
    const steps = await showReport({ ...BASE, status: 'REJECTED', equivalence: { ...equivalent, status: 'NOT_EQUIVALENT' }, candidateCircuit: null, changes: [], candidateProvenance: null, resultId: null })
    expect(stepText(steps, 'Candidate')).toContain('Withheld')
    expect(stepText(steps, 'Equivalence check')).toContain('Not equivalent')
    expect(stepText(steps, 'Decision')).toContain('Rejected')
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull()
  })

  it('a rewrite the backend cannot check is not proposed, and says why in the backend’s words', async () => {
    const steps = await showReport({
      ...BASE,
      status: 'UNVERIFIABLE',
      equivalence: { ...equivalent, status: 'UNVERIFIABLE', reason: 'mid-circuit measurement cannot be compared' },
      candidateCircuit: null,
      changes: [],
      candidateProvenance: null,
      resultId: null,
    })
    expect(stepText(steps, 'Equivalence check')).toContain('Could not be checked')
    expect(stepText(steps, 'Equivalence check')).toContain('mid-circuit measurement cannot be compared')
    expect(stepText(steps, 'Decision')).toContain('Not proposed')
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull()
  })

  it('every stage is named in words, not only a colour or position', async () => {
    const steps = await showReport(BASE)
    for (const li of within(steps).getAllByRole('listitem')) expect((li.textContent ?? '').replace(/^\d/, '').trim().length).toBeGreaterThan(20)
  })
})

describe('the examples', () => {
  it('lists three, each a button, with the Lab’s circuit untouched until one is chosen', () => {
    render(<OptimizePanel />)
    const list = screen.getByRole('list', { name: 'Optimization examples' })
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(OPTIMIZE_EXAMPLES.map((e) => e.title))
    expect(build().circuit).toEqual(MINE)
  })

  it('loading one puts exactly its circuit in the Lab as one undo step, and the learner’s own circuit comes back on undo', () => {
    render(<OptimizePanel />)
    fireEvent.click(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[0]!.title }))
    expect(build().circuit).toEqual(OPTIMIZE_EXAMPLES[0]!.circuit)
    expect(build().past.at(-1)).toEqual(MINE)
    act(() => build().undo())
    expect(build().circuit).toEqual(MINE)
  })

  it('shows what to expect in words, marks the loaded example, and sends no request until Optimize is pressed', () => {
    render(<OptimizePanel />)
    fireEvent.click(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[1]!.title }))
    expect(screen.getByTestId('optimize-example-summary')).toHaveTextContent(OPTIMIZE_EXAMPLES[1]!.summary)
    expect(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[1]!.title })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[0]!.title })).toHaveAttribute('aria-pressed', 'false')
    expect(client.optimizeCircuit).not.toHaveBeenCalled()
    expect(build().optimization).toBeNull()
  })

  it('an example then Optimize sends exactly the example’s circuit and nothing else', async () => {
    client.optimizeCircuit.mockResolvedValue(BASE)
    render(<OptimizePanel />)
    fireEvent.click(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[0]!.title }))
    fireEvent.click(screen.getByRole('button', { name: 'Optimize' }))
    await screen.findByTestId('optimization-steps')
    expect(client.optimizeCircuit).toHaveBeenCalledTimes(1)
    expect(client.optimizeCircuit.mock.calls[0]![0]).toEqual(OPTIMIZE_EXAMPLES[0]!.circuit)
  })

  it('loading an example discards a report made for the previous circuit', async () => {
    client.optimizeCircuit.mockResolvedValue(BASE)
    render(<OptimizePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize' }))
    await screen.findByTestId('optimization-steps')
    fireEvent.click(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[2]!.title }))
    expect(screen.queryByTestId('optimization-report')).toBeNull()
    expect(build().optimization).toBeNull()
  })

  it('the description disappears as soon as the circuit is edited: it would describe a circuit that is gone', () => {
    render(<OptimizePanel />)
    fireEvent.click(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[0]!.title }))
    expect(screen.getByTestId('optimize-example-summary')).toBeInTheDocument()
    act(() => build().undo())
    expect(screen.queryByTestId('optimize-example-summary')).toBeNull()
    expect(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[0]!.title })).toHaveAttribute('aria-pressed', 'false')
  })

  it('an empty Lab can load one too, and then offers Optimize', () => {
    build().loadCircuit(emptyCircuit(2, 0))
    render(<OptimizePanel />)
    expect(screen.queryByRole('button', { name: 'Optimize' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: OPTIMIZE_EXAMPLES[0]!.title }))
    expect(screen.getByRole('button', { name: 'Optimize' })).toBeEnabled()
  })
})

describe('what the panel says about itself', () => {
  it('names the Qiskit transpiler only as context and claims neither to implement nor to match it', () => {
    render(<OptimizePanel />)
    const note = screen.getByTestId('optimize-context')
    expect(note).toHaveTextContent(/Qiskit.s transpiler apply many more passes/)
    expect(note).toHaveTextContent(/does not implement the Qiskit transpiler and does not claim to match it/)
    expect(note).toHaveTextContent(/equivalence check is what decides/)
  })

  it('shows no quantum number of its own before anything has run', () => {
    render(<OptimizePanel />)
    expect(screen.getByTestId('optimize-panel').textContent).not.toMatch(/\d+\.\d+|\d+\s?%/)
  })
})
