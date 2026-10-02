/**
 * The reasoning engine from the client's side: a structured intent, the circuit and identifiers go out - never a number, an expected
 * result or a counterfactual circuit - and every number that comes back is wrapped with the ANALYSIS record's provenance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError } from './client'
import type { Circuit } from '@/circuit/types'

const H: Circuit = { schema: 'qentor.circuit/1', num_qubits: 1, num_clbits: 0, ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] }
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const PROV = {
  result_id: 'res_analysis',
  circuit_hash: HASH_A,
  backend: 'reasoning-engine',
  backend_version: 'qentor.reasoning/1',
  execution_mode: 'analysis',
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
  created_at: '2026-01-01T00:00:00Z',
}
const SOURCE = {
  role: 'theoretical',
  result_id: 'res_run',
  execution_id: 'aer-local-1',
  circuit_hash: HASH_A,
  backend: 'qiskit-aer',
  backend_version: '0.17.2',
  execution_mode: 'statevector',
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
}
const COMMON = {
  analysis_id: 'res_analysis',
  status: 'OK',
  reason: null,
  method: 'qentor.reasoning/1',
  circuit_hash: HASH_A,
  sources: [SOURCE],
  provenance: PROV,
  facts: [{ id: 'R1', kind: 'reasoning_status', description: 'analysis res_analysis', result_id: 'res_analysis' }],
  answer: 'From the backend’s own run: outcome 1: theoretical probability 0.500000 (R2).',
  used_fallback_template: true,
}

const PROBABILITY = {
  ...COMMON,
  intent: 'PROBABILITY',
  data: {
    num_qubits: 1,
    bit_order: 'outcomes are written q[0]…q[0]',
    items: [
      { label: 'outcome 1', outcome: '1', qubit: null, value: null, theoretical_probability: 0.5, sampled_frequency: 0.48, sampled_count: 480, shots: 1000, difference: 0.02 },
    ],
    notes: [],
  },
}

const OPTIMIZE_NONE = {
  ...COMMON,
  intent: 'OPTIMIZE',
  status: 'NO_IMPROVEMENT',
  reason: 'no rewrite rule matched this circuit, so there is no shorter circuit to offer',
  data: {
    optimization_status: 'NO_OPTIMIZATION_FOUND',
    original_circuit_hash: HASH_A,
    original_qasm: 'OPENQASM 3.0;',
    original_op_count: 1,
    candidate_circuit: null,
    candidate_qasm: null,
    candidate_circuit_hash: null,
    candidate_op_count: null,
    operations_removed: 0,
    rules_applied: [],
    rewrites: [],
    changes: [],
    equivalence: null,
    verifier: 'qentor.verification.optimizer/1',
    candidate_result_id: null,
  },
}

const COMPARISON = {
  circuit: {
    same_circuit: false,
    num_qubits_a: 1,
    num_qubits_b: 1,
    num_ops_a: 1,
    num_ops_b: 0,
    changes: [{ tag: 'delete', a_start: 0, a_ops: ['h(q0)'], b_start: 0, b_ops: [] }],
    equivalence_status: 'NOT_EQUIVALENT',
    equivalence_reason: null,
  },
  measurement: {
    comparable: true,
    reason: null,
    kind_a: 'theoretical_probability',
    kind_b: 'theoretical_probability',
    rows: [
      { outcome: '0', a: 0.5, b: 1, difference: 0.5 },
      { outcome: '1', a: 0.5, b: null, difference: null },
    ],
    total_variation_distance: 0.5,
    max_difference: 0.5,
    note: null,
  },
  state: { comparable: true, reason: null, fidelity: 0.5, max_probability_difference: 0.5, max_amplitude_difference: 0.7, note: null },
}
const WHAT_IF = {
  ...COMMON,
  intent: 'WHAT_IF',
  data: {
    description: 'remove operation 0 (h on q[0])',
    original_circuit_hash: HASH_A,
    counterfactual_circuit_hash: HASH_B,
    counterfactual_qasm: 'OPENQASM 3.0;',
    original_op_count: 1,
    counterfactual_op_count: 0,
    changes: [{ kind: 'removed', original_index: 0, candidate_index: null, description: 'h on q[0]' }],
    comparison: COMPARISON,
    compared_values: 'theoretical probabilities',
  },
}

const QUBIT = (q: number, entangled: boolean) => ({
  qubit: q,
  status: 'OK',
  reason: null,
  bloch: { x: 0, y: 0, z: 1 },
  bloch_length: 1,
  purity: entangled ? 0.5 : 1,
  entangled_with_rest: entangled,
})
const TRACE = {
  ...COMMON,
  intent: 'TRACE_CHANGE',
  data: {
    step_index: 2,
    step_number: 3,
    total_steps: 3,
    num_qubits: 1,
    bit_order: 'outcomes are written q[0]…q[0]',
    operation: { index: 1, gate: 'cx', description: 'cx control q[0], target q[1]' },
    after_probabilities: { '11': 0.5 },
    after_qubits: [QUBIT(0, true)],
    before_probabilities: { '01': 0.5 },
    before_qubits: [QUBIT(0, false)],
    change_kind: 'probabilities_changed',
    change_summary: 'Outcome probabilities changed on 2 basis states',
    probability_changes: [{ outcome: '11', before: 0, after: 0.5, difference: 0.5 }],
  },
}

describe('RealApiClient — reasoning engine', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const body = (call = 0) => JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string)
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(json(PROBABILITY))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  describe('what goes out', () => {
    it('a probability request is the intent, the circuit, a result id and a typed target — no number', async () => {
      await new RealApiClient().analyzeReasoning({ intent: 'PROBABILITY', circuit: H, resultId: 'res_run', target: { kind: 'basis_state', bits: '1' }, language: 'hi', backend: 'cirq' })
      expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/reasoning\/analyze$/)
      expect(body()).toEqual({ intent: 'PROBABILITY', circuit: H, language: 'hi', backend: 'cirq', result_id: 'res_run', target: { kind: 'basis_state', bits: '1' } })
    })

    it('an optimize request is only the intent and the circuit', async () => {
      fetchMock.mockResolvedValueOnce(json(OPTIMIZE_NONE))
      await new RealApiClient().analyzeReasoning({ intent: 'OPTIMIZE', circuit: H })
      expect(body()).toEqual({ intent: 'OPTIMIZE', circuit: H, language: 'en' })
    })

    it('a what-if request names ONE modification and sends back the hashes it was shown', async () => {
      fetchMock.mockResolvedValueOnce(json(WHAT_IF))
      await new RealApiClient().analyzeReasoning({
        intent: 'WHAT_IF',
        circuit: H,
        modification: { op: 'remove_gate', index: 0 },
        expectedCircuitHash: HASH_A,
        counterfactualCircuitHash: HASH_B,
      })
      expect(body()).toEqual({
        intent: 'WHAT_IF',
        circuit: H,
        language: 'en',
        expected_circuit_hash: HASH_A,
        modification: { op: 'remove_gate', index: 0 },
        counterfactual_circuit_hash: HASH_B,
      })
      expect(Object.keys(body())).not.toContain('counterfactual_circuit')
    })

    it('every modification kind is spelled the way the server’s model spells it', async () => {
      const spelled = async (modification: Parameters<RealApiClient['analyzeReasoning']>[0] extends infer R ? (R extends { modification: infer M } ? M : never) : never) => {
        fetchMock.mockResolvedValueOnce(json(WHAT_IF))
        await new RealApiClient().analyzeReasoning({ intent: 'WHAT_IF', circuit: H, modification })
        return body(fetchMock.mock.calls.length - 1).modification
      }
      expect(await spelled({ op: 'replace_gate', index: 0, gate: 'x' })).toEqual({ op: 'replace_gate', index: 0, gate: 'x' })
      expect(await spelled({ op: 'replace_gate', index: 0, gate: 'rx', angle: 0.5 })).toEqual({ op: 'replace_gate', index: 0, gate: 'rx', angle: 0.5 })
      expect(await spelled({ op: 'set_angle', index: 1, angle: 3 })).toEqual({ op: 'set_angle', index: 1, angle: 3 })
      expect(await spelled({ op: 'insert_gate', index: 0, gate: 'cx', targets: [1], controls: [0] })).toEqual({ op: 'insert_gate', index: 0, gate: 'cx', targets: [1], controls: [0] })
      expect(await spelled({ op: 'insert_gate', index: 0, gate: 'ry', targets: [0], angle: 1 })).toEqual({ op: 'insert_gate', index: 0, gate: 'ry', targets: [0], controls: [], angle: 1 })
    })

    it('a trace-change request carries the step’s identity only', async () => {
      fetchMock.mockResolvedValueOnce(json(TRACE))
      await new RealApiClient().analyzeReasoning({
        intent: 'TRACE_CHANGE',
        circuit: H,
        traceStep: {
          stepIndex: 1,
          operationIndex: 0,
          operation: H.ops[0]!,
          resultId: 'res_s1',
          executionId: 'e1',
          circuitHash: HASH_A,
          backend: 'qiskit-aer',
          backendVersion: '0.17.2',
          previousResultId: 'res_s0',
        },
      })
      const step = body().trace_step
      expect(Object.keys(step).sort()).toEqual(
        ['backend', 'backend_version', 'circuit_hash', 'execution_id', 'operation', 'operation_index', 'previous_result_id', 'result_id', 'step_index'],
      )
    })

    it('the what-if preview sends the circuit and the modification', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          description: 'remove operation 0 (h on q[0])',
          original_circuit_hash: HASH_A,
          counterfactual_circuit: { ...H, ops: [] },
          counterfactual_circuit_hash: HASH_B,
          counterfactual_qasm: 'OPENQASM 3.0;',
          original_op_count: 1,
          counterfactual_op_count: 0,
          changes: [{ kind: 'removed', original_index: 0, candidate_index: null, description: 'h on q[0]' }],
        }),
      )
      const preview = await new RealApiClient().previewWhatIf(H, { op: 'remove_gate', index: 0 })
      expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/reasoning\/what-if\/preview$/)
      expect(body()).toEqual({ circuit: H, modification: { op: 'remove_gate', index: 0 } })
      expect(preview).toMatchObject({ counterfactualCircuitHash: HASH_B, originalOpCount: 1, counterfactualOpCount: 0 })
      expect(preview.counterfactualCircuit.ops).toEqual([])
      expect(preview.changes[0]).toEqual({ kind: 'removed', originalIndex: 0, candidateIndex: null, description: 'h on q[0]' })
    })
  })

  describe('what comes back', () => {
    it('wraps every probability with the ANALYSIS record’s provenance', async () => {
      const r = await new RealApiClient().analyzeReasoning({ intent: 'PROBABILITY', circuit: H, resultId: 'res_run', target: { kind: 'most_likely' } })
      if (r.intent !== 'PROBABILITY') throw new Error('wrong intent')
      const row = r.rows[0]!
      expect(row.theoretical!.value).toBe(0.5)
      expect(row.sampled!.value).toBe(0.48)
      expect(row.difference!.value).toBe(0.02)
      for (const q of [row.theoretical!, row.sampled!, row.difference!]) {
        expect(q.provenance).toMatchObject({ resultId: 'res_analysis', backend: 'reasoning-engine', executionMode: 'analysis', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED' })
      }
      expect(row.sampledCount).toBe(480)
      expect(r.bitOrder).toContain('q[0]')
      expect(r.provenance.resultId).toBe('res_analysis')
    })

    it('names the backend runs the analysis rests on, field for field', async () => {
      const r = await new RealApiClient().analyzeReasoning({ intent: 'PROBABILITY', circuit: H, resultId: 'res_run', target: { kind: 'most_likely' } })
      expect(r.sources).toEqual([
        {
          role: 'theoretical',
          resultId: 'res_run',
          executionId: 'aer-local-1',
          circuitHash: HASH_A,
          backend: 'qiskit-aer',
          backendVersion: '0.17.2',
          executionMode: 'statevector',
          provenanceClass: 'SIMULATION',
          verificationStatus: 'STATE_CHECKED',
        },
      ])
    })

    it('keeps the answer and the R# facts exactly as the server wrote them', async () => {
      const r = await new RealApiClient().analyzeReasoning({ intent: 'PROBABILITY', circuit: H, resultId: 'res_run', target: { kind: 'most_likely' } })
      expect(r.answer).toBe(COMMON.answer)
      expect(r.facts).toEqual([{ id: 'R1', kind: 'reasoning_status', description: 'analysis res_analysis', resultId: 'res_analysis' }])
      expect(r.usedFallbackTemplate).toBe(true)
    })

    it('a sampled value the server did not report stays null — it is not turned into 0', async () => {
      const payload = { ...PROBABILITY, data: { ...PROBABILITY.data, items: [{ ...PROBABILITY.data.items[0]!, sampled_frequency: null, sampled_count: null, shots: null, difference: null }] } }
      fetchMock.mockResolvedValueOnce(json(payload))
      const r = await new RealApiClient().analyzeReasoning({ intent: 'PROBABILITY', circuit: H, resultId: 'res_run', target: { kind: 'most_likely' } })
      if (r.intent !== 'PROBABILITY') throw new Error('wrong intent')
      expect(r.rows[0]!.sampled).toBeNull()
      expect(r.rows[0]!.difference).toBeNull()
    })

    it('an explicit no-improvement result carries no candidate circuit', async () => {
      fetchMock.mockResolvedValueOnce(json(OPTIMIZE_NONE))
      const r = await new RealApiClient().analyzeReasoning({ intent: 'OPTIMIZE', circuit: H })
      if (r.intent !== 'OPTIMIZE') throw new Error('wrong intent')
      expect(r.status).toBe('NO_IMPROVEMENT')
      expect(r.reason).toMatch(/no rewrite rule/)
      expect(r.candidateCircuit).toBeNull()
      expect(r.candidateOpCount).toBeNull()
      expect(r.operationsRemoved).toBe(0)
    })

    it('a verified candidate keeps the server’s counts, rewrites and equivalence verdict', async () => {
      const verified = {
        ...OPTIMIZE_NONE,
        status: 'OK',
        reason: null,
        data: {
          ...OPTIMIZE_NONE.data,
          optimization_status: 'VERIFIED_SHORTER',
          original_op_count: 3,
          candidate_circuit: { ...H, ops: [] },
          candidate_circuit_hash: HASH_B,
          candidate_op_count: 1,
          operations_removed: 2,
          rewrites: [{ rule: 'cancelled adjacent h pair on qubit(s) [0]', explanation: 'H twice changes nothing' }],
          changes: [{ kind: 'removed', original_index: 0, candidate_index: null, description: 'h on q[0]' }],
          equivalence: { status: 'EQUIVALENT', method: 'qiskit.quantum_info.Operator.equiv', global_phase: 0, reason: null },
          candidate_result_id: 'res_cand',
        },
      }
      fetchMock.mockResolvedValueOnce(json(verified))
      const r = await new RealApiClient().analyzeReasoning({ intent: 'OPTIMIZE', circuit: H })
      if (r.intent !== 'OPTIMIZE') throw new Error('wrong intent')
      expect(r).toMatchObject({ originalOpCount: 3, candidateOpCount: 1, operationsRemoved: 2, candidateResultId: 'res_cand' })
      expect(r.equivalence).toEqual({ status: 'EQUIVALENT', method: 'qiskit.quantum_info.Operator.equiv', reason: null })
      expect(r.rewrites).toEqual([{ rule: 'cancelled adjacent h pair on qubit(s) [0]', explanation: 'H twice changes nothing' }])
    })

    it('a what-if keeps an outcome absent from a run as null, and wraps the comparison’s numbers', async () => {
      fetchMock.mockResolvedValueOnce(json(WHAT_IF))
      const r = await new RealApiClient().analyzeReasoning({ intent: 'WHAT_IF', circuit: H, modification: { op: 'remove_gate', index: 0 } })
      if (r.intent !== 'WHAT_IF') throw new Error('wrong intent')
      expect(r.comparison.measurement.rows[1]!.b).toBeNull()
      expect(r.comparison.measurement.totalVariationDistance!.provenance.resultId).toBe('res_analysis')
      expect(r.comparison.state.fidelity!.value).toBe(0.5)
      expect(r.comparison.circuit.equivalenceStatus).toBe('NOT_EQUIVALENT')
      expect(r).toMatchObject({ counterfactualCircuitHash: HASH_B, counterfactualOpCount: 0 })
    })

    it('a trace change wraps probabilities and per-qubit states and says which qubits are entangled', async () => {
      fetchMock.mockResolvedValueOnce(json(TRACE))
      const r = await new RealApiClient().analyzeReasoning({ intent: 'TRACE_CHANGE', circuit: H, traceStep: { stepIndex: 1, operationIndex: 0, operation: H.ops[0]!, resultId: 'a', executionId: 'b', circuitHash: HASH_A, backend: 'qiskit-aer', backendVersion: '1', previousResultId: 'p' } })
      if (r.intent !== 'TRACE_CHANGE') throw new Error('wrong intent')
      expect(r.probabilityChanges[0]!.difference.value).toBe(0.5)
      expect(r.probabilityChanges[0]!.after.provenance.resultId).toBe('res_analysis')
      expect(r.afterQubits[0]).toMatchObject({ entangledWithRest: true })
      expect(r.afterQubits[0]!.bloch!.provenance.backend).toBe('reasoning-engine')
      expect(r.beforeQubits[0]).toMatchObject({ entangledWithRest: false })
      expect(r.operation).toEqual({ index: 1, gate: 'cx', description: 'cx control q[0], target q[1]' })
    })

    it('the initial state has no operation and no before', async () => {
      const initial = { ...TRACE, status: 'INITIAL_STATE', reason: 'this is the initial state', data: { ...TRACE.data, step_index: 0, step_number: 1, operation: null, before_probabilities: undefined, before_qubits: undefined, change_kind: undefined, change_summary: undefined, probability_changes: undefined } }
      fetchMock.mockResolvedValueOnce(json(initial))
      const r = await new RealApiClient().analyzeReasoning({ intent: 'TRACE_CHANGE', circuit: H, traceStep: { stepIndex: 0, operationIndex: null, operation: null, resultId: 'a', executionId: 'b', circuitHash: HASH_A, backend: 'qiskit-aer', backendVersion: '1', previousResultId: null } })
      if (r.intent !== 'TRACE_CHANGE') throw new Error('wrong intent')
      expect(r.operation).toBeNull()
      expect(r.beforeQubits).toEqual([])
      expect(r.probabilityChanges).toEqual([])
      expect(r.changeKind).toBeNull()
    })
  })

  describe('refusals and failures', () => {
    it('a stale circuit is a refusal with the server’s message and its 409', async () => {
      fetchMock.mockResolvedValueOnce(json({ detail: { code: 'REASONING_STALE_CIRCUIT', message: 'the circuit has changed' } }, 409))
      await expect(new RealApiClient().analyzeReasoning({ intent: 'OPTIMIZE', circuit: H })).rejects.toMatchObject({ status: 409, message: 'the circuit has changed' })
    })

    it('an invalid modification is a refusal with the server’s message', async () => {
      fetchMock.mockResolvedValueOnce(json({ detail: { code: 'WHATIF_INDEX_OUT_OF_RANGE', message: 'operation 9 does not exist' } }, 422))
      await expect(new RealApiClient().previewWhatIf(H, { op: 'remove_gate', index: 9 })).rejects.toMatchObject({ status: 422, message: 'operation 9 does not exist' })
    })

    it('a response that is not an analysis is refused, not displayed', async () => {
      fetchMock.mockResolvedValueOnce(json({ intent: 'PROBABILITY', analysis_id: 'x' }))
      await expect(new RealApiClient().analyzeReasoning({ intent: 'OPTIMIZE', circuit: H })).rejects.toThrow()
      fetchMock.mockResolvedValueOnce(json({ ...PROBABILITY, intent: 'MAKE_UP_AN_ANSWER' }))
      await expect(new RealApiClient().analyzeReasoning({ intent: 'OPTIMIZE', circuit: H })).rejects.toThrow()
    })

    it('an unreachable server is "unavailable", never substitute data', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('offline'))
      await expect(new RealApiClient().analyzeReasoning({ intent: 'OPTIMIZE', circuit: H })).rejects.toBeInstanceOf(BackendUnavailableError)
    })

    it('a circuit the model would refuse never leaves the browser', async () => {
      const bad = { ...H, num_qubits: 0 } as Circuit
      await expect(new RealApiClient().analyzeReasoning({ intent: 'OPTIMIZE', circuit: bad })).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
