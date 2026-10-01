/**
 * "Optimize circuit" as learning, from the browser's side. The server decides everything (the diff, the notes, the counts, the
 * equivalence verdict, the provenance); these tests pin that the browser sends only the circuit, parses what comes back through the
 * schema, draws it with words as well as colour, offers Apply only for a verified candidate, applies it as one undo step, and never
 * shows or applies a proposal against a circuit it was not made for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { OptimizationResult } from '@/api'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import type { Provenance } from '@/provenance/QuantumValue'
import { OptimizeResponseSchema } from '@/provenance/schema'

const client = vi.hoisted(() => ({ optimizeCircuit: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { RealApiClient } from '@/api/realClient'
import { useBuildStore } from './store'
import { OptimizePanel } from './OptimizePanel'

const INITIAL = useBuildStore.getState()
const build = () => useBuildStore.getState()
const op = (gate: GateOp['gate'], targets: number[], controls: number[] = [], params: number[] = []): GateOp => ({ gate, targets, controls, params, clbits: [] })
const circuitOf = (n: number, ops: GateOp[]): Circuit => ({ ...emptyCircuit(n, 0), ops })

const ORIGINAL = circuitOf(1, [op('h', [0]), op('h', [0]), op('x', [0])])
const CANDIDATE = circuitOf(1, [op('x', [0])])

const PROVENANCE: Provenance = {
  resultId: 'res_cand_1',
  circuitHash: 'cafebabe0123456789',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-10-01T00:00:00Z',
}

const verified = (over: Partial<OptimizationResult> = {}): OptimizationResult => ({
  originalCircuitHash: 'orig_hash',
  candidateCircuitHash: 'cafebabe0123456789',
  originalOpCount: 3,
  candidateOpCount: 1,
  rulesApplied: ['cancelled adjacent h pair on qubit(s) [0]'],
  reductionSummary: '3 -> 1 operations',
  status: 'VERIFIED_SHORTER',
  equivalence: {
    status: 'EQUIVALENT',
    method: 'qiskit.quantum_info.Operator equivalence up to global phase',
    globalPhase: 0,
    checks: [{ name: 'operator_equivalent_up_to_global_phase', status: 'PASS', detail: 'operators agree' }],
    reason: null,
  },
  verifierName: 'qentor.verification.optimizer',
  verifierVersion: '1',
  reason: null,
  candidateCircuit: CANDIDATE,
  resultId: 'res_cand_1',
  operationsRemoved: 2,
  changes: [
    { kind: 'removed', originalIndex: 0, candidateIndex: null, description: 'h on q[0]' },
    { kind: 'removed', originalIndex: 1, candidateIndex: null, description: 'h on q[0]' },
    { kind: 'kept', originalIndex: 2, candidateIndex: 0, description: 'x on q[0]' },
  ],
  ruleNotes: [{ rule: 'cancelled adjacent h pair on qubit(s) [0]', explanation: 'Applying H twice in a row returns every state to where it started, so the pair changes nothing.' }],
  candidateProvenance: PROVENANCE,
  ...over,
})

const NONE: OptimizationResult = {
  ...verified(),
  status: 'NO_OPTIMIZATION_FOUND',
  candidateCircuitHash: 'orig_hash',
  candidateOpCount: 3,
  rulesApplied: [],
  equivalence: null,
  candidateCircuit: null,
  resultId: null,
  operationsRemoved: 0,
  changes: [],
  ruleNotes: [],
  candidateProvenance: null,
}

beforeEach(() => {
  client.optimizeCircuit.mockReset()
  useBuildStore.setState(INITIAL, true)
  build().loadCircuit(ORIGINAL)
})
afterEach(cleanup)

const optimizeNow = async () => {
  render(<OptimizePanel />)
  fireEvent.click(screen.getByRole('button', { name: 'Optimize' }))
  await screen.findByTestId('optimization-report')
}

describe('Optimize panel — a verified candidate', () => {
  beforeEach(() => client.optimizeCircuit.mockResolvedValue(verified()))

  it('says what it is for before anything is asked, and sends only the circuit and the backend name', async () => {
    render(<OptimizePanel />)
    expect(screen.getByText(/cancel or merge/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Optimize' }))
    await screen.findByTestId('optimization-report')
    expect(client.optimizeCircuit).toHaveBeenCalledTimes(1)
    expect(client.optimizeCircuit.mock.calls[0]).toEqual([ORIGINAL, build().backend])
  })

  it('shows the original and proposed operation counts and how many were removed, exactly as the server said', async () => {
    await optimizeNow()
    const counts = screen.getByTestId('optimization-counts')
    expect(counts).toHaveTextContent('original3 operations')
    expect(counts).toHaveTextContent('proposed1 operations')
    expect(counts).toHaveTextContent('removed2 fewer')
    expect(screen.getByTestId('optimization-headline')).toHaveTextContent('3 operations became 1')
  })

  it('does not recompute a count: a server count that disagrees with the lists is shown as sent', async () => {
    client.optimizeCircuit.mockResolvedValue(verified({ operationsRemoved: 9 }))
    await optimizeNow()
    expect(screen.getByTestId('optimization-counts')).toHaveTextContent('removed9 fewer')
  })

  it('lists what changed in the server’s order with a word for each line, not only a colour', async () => {
    await optimizeNow()
    const rows = within(screen.getByTestId('optimization-changes')).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['−Removed h on q[0]', '−Removed h on q[0]', '=Kept x on q[0]'])
    expect(rows.map((r) => r.getAttribute('data-change'))).toEqual(['removed', 'removed', 'kept'])
  })

  it('shows the sentence behind each rule and says the rule does not decide equivalence', async () => {
    await optimizeNow()
    const rules = screen.getByTestId('optimization-rules')
    expect(rules).toHaveTextContent('cancelled adjacent h pair on qubit(s) [0]')
    expect(rules).toHaveTextContent('Applying H twice in a row returns every state to where it started')
    expect(screen.getByText(/decided by the check below, not by the rule/)).toBeInTheDocument()
  })

  it('shows a rule with no sentence by its name alone and invents no explanation', async () => {
    client.optimizeCircuit.mockResolvedValue(verified({ ruleNotes: [{ rule: 'some future rule', explanation: null }] }))
    await optimizeNow()
    const rules = screen.getByTestId('optimization-rules')
    expect(rules).toHaveTextContent('some future rule')
    expect(rules.querySelectorAll('span.block')).toHaveLength(0)
  })

  it('states the equivalence verdict, its method and each check as the backend returned them', async () => {
    await optimizeNow()
    const eq = screen.getByTestId('optimization-equivalence')
    expect(eq).toHaveTextContent('equivalent')
    expect(eq).toHaveTextContent('Operator equivalence up to global phase')
    expect(eq).toHaveTextContent('operator_equivalent_up_to_global_phase')
    expect(eq).toHaveTextContent('passed') // read out for a screen reader, not only a coloured dot
    expect(eq).toHaveTextContent('operators agree')
  })

  it('shows the candidate’s provenance (badge, result id, circuit hash) and says it is not the equivalence proof', async () => {
    await optimizeNow()
    const prov = screen.getByTestId('optimization-provenance')
    expect(prov).toHaveTextContent('Simulated')
    expect(prov).toHaveTextContent('qiskit-aer')
    expect(prov).toHaveTextContent('res_cand_1')
    expect(prov).toHaveTextContent('cafebabe0123456789')
    expect(prov).toHaveTextContent('not the equivalence proof')
  })

  it('applies the proposal only on a click, as one undo step, and undo brings the original back', async () => {
    await optimizeNow()
    expect(build().circuit).toEqual(ORIGINAL) // showing it changed nothing
    const historyBefore = build().past.length
    fireEvent.click(screen.getByRole('button', { name: 'Apply optimized circuit' }))
    expect(build().circuit).toEqual(CANDIDATE)
    expect(build().past.length).toBe(historyBefore + 1)
    act(() => build().undo())
    expect(build().circuit).toEqual(ORIGINAL)
    act(() => build().redo())
    expect(build().circuit).toEqual(CANDIDATE)
  })

  it('applying clears the optimisation report, results and the trace: nothing is shown against a circuit it was not made for', async () => {
    await optimizeNow()
    fireEvent.click(screen.getByRole('button', { name: 'Apply optimized circuit' }))
    expect(build().optimization).toBeNull()
    expect(build().result).toBeNull()
    expect(build().trace).toBeNull()
  })
})

describe('Optimize panel — nothing to propose', () => {
  it('NO_OPTIMIZATION_FOUND says so, offers no Apply, shows no candidate and no provenance', async () => {
    client.optimizeCircuit.mockResolvedValue(NONE)
    await optimizeNow()
    expect(screen.getByTestId('optimization-headline')).toHaveTextContent('nothing to propose')
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull()
    expect(screen.queryByTestId('optimization-provenance')).toBeNull()
    expect(screen.getByTestId('optimization-counts')).toHaveTextContent('candidatenone shown')
  })

  for (const status of ['REJECTED', 'UNVERIFIABLE'] as const) {
    it(`${status} offers no Apply even if a candidate circuit were attached, and shows no candidate`, async () => {
      client.optimizeCircuit.mockResolvedValue({ ...NONE, status, candidateCircuit: CANDIDATE, reason: 'could not be checked', equivalence: null })
      await optimizeNow()
      expect(screen.queryByRole('button', { name: /apply/i })).toBeNull()
      expect(screen.queryByText('proposed')).toBeNull()
      expect(screen.getByText('could not be checked')).toBeInTheDocument()
      act(() => build().applyOptimizedCircuit())
      expect(build().circuit).toEqual(ORIGINAL) // the store refuses too
    })
  }

  it('a failed request is "Optimization unavailable", says the circuit is unchanged, and substitutes nothing', async () => {
    client.optimizeCircuit.mockRejectedValue(new Error('backend down'))
    render(<OptimizePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Optimization unavailable')
    expect(alert).toHaveTextContent('backend down')
    expect(alert).toHaveTextContent('circuit is unchanged')
    expect(screen.queryByTestId('optimization-report')).toBeNull()
    expect(screen.getByRole('button', { name: 'Optimize again' })).toBeEnabled()
  })

  it('renders nothing for an empty circuit', () => {
    build().loadCircuit(emptyCircuit(1, 0))
    const { container } = render(<OptimizePanel />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('Optimize — a proposal belongs to one circuit', () => {
  const deferred = () => {
    let resolve!: (v: OptimizationResult) => void
    const promise = new Promise<OptimizationResult>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('an answer that arrives after the circuit was edited is dropped, and the busy flag is released', async () => {
    const d = deferred()
    client.optimizeCircuit.mockReturnValue(d.promise)
    const asked = build().runOptimization()
    expect(build().isOptimizing).toBe(true)
    act(() => build().insertOpAt(0, op('z', [0])))
    await act(async () => {
      d.resolve(verified())
      await asked
    })
    expect(build().optimization).toBeNull()
    expect(build().isOptimizing).toBe(false)
    act(() => build().applyOptimizedCircuit())
    expect(build().circuit.ops).toHaveLength(4) // the edit stands; the stale candidate was never applied
  })

  it('an answer that arrives after an undo is dropped too', async () => {
    act(() => build().insertOpAt(0, op('z', [0])))
    const d = deferred()
    client.optimizeCircuit.mockReturnValue(d.promise)
    const asked = build().runOptimization()
    act(() => build().undo())
    await act(async () => {
      d.resolve(verified())
      await asked
    })
    expect(build().optimization).toBeNull()
  })

  it('only the newest request owns the result, and an older answer cannot switch the busy flag off under it', async () => {
    const first = deferred()
    const second = deferred()
    client.optimizeCircuit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = build().runOptimization()
    const b = build().runOptimization()
    await act(async () => {
      first.resolve(verified({ reductionSummary: 'FIRST' }))
      await a
    })
    expect(build().optimization).toBeNull()
    expect(build().isOptimizing).toBe(true) // the second is still running
    await act(async () => {
      second.resolve(verified({ reductionSummary: 'SECOND' }))
      await b
    })
    expect(build().optimization?.reductionSummary).toBe('SECOND')
    expect(build().isOptimizing).toBe(false)
  })

  it('a stale failure is dropped as well: no error banner for a circuit that no longer exists', async () => {
    const d = deferred()
    client.optimizeCircuit.mockReturnValue(d.promise)
    const asked = build().runOptimization()
    act(() => build().insertOpAt(0, op('z', [0])))
    await act(async () => {
      d.promise.catch(() => undefined)
      ;(d as unknown as { resolve: (v: unknown) => void }).resolve(Promise.reject(new Error('late failure')))
      await asked
    })
    expect(build().optimizationError).toBeNull()
    expect(build().isOptimizing).toBe(false)
  })

  it('a new request clears the previous proposal so an old one is never shown beside "Optimizing…"', async () => {
    client.optimizeCircuit.mockResolvedValueOnce(verified())
    await build().runOptimization()
    expect(build().optimization).not.toBeNull()
    const d = deferred()
    client.optimizeCircuit.mockReturnValueOnce(d.promise)
    const next = build().runOptimization()
    expect(build().optimization).toBeNull()
    d.resolve(NONE)
    await next
  })
})

describe('the wire: POST /api/optimize through the client', () => {
  const wire = {
    original_circuit_hash: 'orig_hash',
    candidate_circuit_hash: 'cafebabe0123456789',
    original_op_count: 3,
    candidate_op_count: 1,
    rules_applied: ['cancelled adjacent h pair on qubit(s) [0]'],
    reduction_summary: '3 -> 1 operations',
    status: 'VERIFIED_SHORTER',
    equivalence: { status: 'EQUIVALENT', method: 'm', global_phase: 0, checks: [{ name: 'c', status: 'PASS', detail: 'd' }], reason: null },
    verifier_name: 'qentor.verification.optimizer',
    verifier_version: '1',
    reason: null,
    candidate_circuit: { schema: 'qentor.circuit/1', num_qubits: 1, num_clbits: 0, ops: [{ gate: 'x', targets: [0], controls: [], params: [], clbits: [] }] },
    result_id: 'res_cand_1',
    operations_removed: 2,
    changes: [{ kind: 'removed', original_index: 0, candidate_index: null, description: 'h on q[0]' }],
    rule_notes: [{ rule: 'r', explanation: null }],
    candidate_provenance: {
      result_id: 'res_cand_1',
      circuit_hash: 'cafebabe0123456789',
      backend: 'qiskit-aer',
      backend_version: '0.17.2',
      execution_mode: 'statevector',
      provenance_class: 'SIMULATION',
      verification_status: 'STATE_CHECKED',
      created_at: '2026-10-01T00:00:00Z',
    },
  }
  const respond = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  afterEach(() => vi.unstubAllGlobals())

  it('maps the new fields to the client shape, including the provenance', async () => {
    const fetchMock = respond(wire)
    vi.stubGlobal('fetch', fetchMock)
    const result = await new RealApiClient().optimizeCircuit(ORIGINAL, 'qiskit-aer')
    expect(result.operationsRemoved).toBe(2)
    expect(result.changes).toEqual([{ kind: 'removed', originalIndex: 0, candidateIndex: null, description: 'h on q[0]' }])
    expect(result.ruleNotes).toEqual([{ rule: 'r', explanation: null }])
    expect(result.candidateProvenance).toMatchObject({ resultId: 'res_cand_1', provenanceClass: 'SIMULATION', backend: 'qiskit-aer', circuitHash: 'cafebabe0123456789' })
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(Object.keys(sent).sort()).toEqual(['backend', 'circuit']) // nothing a client could use to decide a verdict
  })

  it('a null provenance (no supporting run) stays null', async () => {
    vi.stubGlobal('fetch', respond({ ...wire, candidate_provenance: null }))
    expect((await new RealApiClient().optimizeCircuit(ORIGINAL)).candidateProvenance).toBeNull()
  })

  it('refuses a response without the new fields, an unknown change kind, or a malformed provenance', () => {
    const { operations_removed: _a, ...missing } = wire
    expect(OptimizeResponseSchema.safeParse(missing).success).toBe(false)
    expect(OptimizeResponseSchema.safeParse({ ...wire, changes: [{ ...wire.changes[0], kind: 'rewritten' }] }).success).toBe(false)
    expect(OptimizeResponseSchema.safeParse({ ...wire, candidate_provenance: { result_id: 'x' } }).success).toBe(false)
    expect(OptimizeResponseSchema.safeParse({ ...wire, operations_removed: -1 }).success).toBe(false)
    expect(OptimizeResponseSchema.safeParse(wire).success).toBe(true)
  })

  it('a server error is a BackendUnavailableError with its detail, never a made-up proposal', async () => {
    vi.stubGlobal('fetch', respond({ detail: 'optimizer exploded' }, 500))
    await expect(new RealApiClient().optimizeCircuit(ORIGINAL)).rejects.toThrow('optimizer exploded')
  })
})

describe('the Lab and the challenge together', () => {
  it('the mock client stays visibly a fixture and returns the new fields in their honest empty form', async () => {
    const { MockApiClient } = await import('@/api/mockClient')
    const result = await new MockApiClient().optimizeCircuit(circuitOf(1, [op('h', [0])]))
    expect(result.status).toBe('NO_OPTIMIZATION_FOUND')
    expect(result.verifierName).toContain('FIXTURE')
    expect([result.operationsRemoved, result.changes, result.ruleNotes, result.candidateProvenance]).toEqual([0, [], [], null])
  })

  it('waitFor sanity: the panel re-reads the store when a new report lands', async () => {
    client.optimizeCircuit.mockResolvedValue(NONE)
    render(<OptimizePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize' }))
    await waitFor(() => expect(screen.getByTestId('optimization-headline')).toBeInTheDocument())
  })
})
