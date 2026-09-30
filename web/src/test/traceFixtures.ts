/**
 * TEST FIXTURES ONLY — never imported by shipped code (it lives under
 * `src/test/`, next to the vitest setup file).
 *
 * These build responses shaped exactly like POST /api/execute/trace's JSON
 * (snake_case "wire" form) and the camelCase `ExecutionTraceResult` the client
 * returns from them. The amplitudes are whatever a test hands in: they stand
 * in for "what the backend returned", so tests can assert the UI shows those
 * exact values and nothing else. They make no claim to be a real simulation.
 */
import type { ExecutionTraceResult } from '@/api'
import { traceResultFromResponse } from '@/api/realClient'
import type { GateOp } from '@/circuit/types'
import { TraceResponseSchema } from '@/provenance/schema'

export type Amplitude = [number, number]

export const BASIS_ORDERING_WIRE =
  'statevector index k is the bitstring q[n-1]...q[0] read as a binary number'

export function op(gate: GateOp['gate'], fields: Partial<GateOp> = {}): GateOp {
  return { gate, targets: [], controls: [], params: [], clbits: [], ...fields }
}

export const H0 = op('h', { targets: [0] })
export const X0 = op('x', { targets: [0] })
export const Z0 = op('z', { targets: [0] })
export const CX01 = op('cx', { controls: [0], targets: [1] })
export const MEASURE0 = op('measure', { targets: [0], clbits: [0] })
export const MEASURE1 = op('measure', { targets: [1], clbits: [1] })

export interface WireTraceOptions {
  numQubits: number
  /** The traced (non-measure) operations, in order. */
  ops: GateOp[]
  /** One statevector per step: ops.length + 1 of them (initial first). */
  states: Amplitude[][]
  terminalMeasurements?: GateOp[]
  backend?: string
  backendVersion?: string
  basisOrdering?: string
  /** Distinguishes two traces' result ids so a keyed remount can be tested. */
  tag?: string
  /** One entry per step: the (x, y, z) the "backend" returned for that step's
   * Bloch vector, or null for none. Omit for a trace with no Bloch data (as
   * every multi-qubit step has). These are fixture values standing in for a
   * backend response — the UI must render exactly what is supplied here. */
  blochVectors?: Array<[number, number, number] | null>
  /** One entry per step: the wire-format `change` the "backend" returned for that step (null for none — always null for step 0).
   * Fixture values standing in for a server response; the UI must show exactly what is supplied. Omit to send no `change` key. */
  changes?: Array<WireStepChange | null>
}

export interface WireStepChange {
  kind: 'unchanged' | 'phase_only' | 'probabilities_changed'
  support_before: number
  support_after: number
  amplitudes_changed: number
  probabilities_changed: number
  changed_basis_states: Array<{
    basis: string
    before: Amplitude
    after: Amplitude
    probability_before: number
    probability_after: number
  }>
  summary: string
}

/** A wire-format (snake_case) trace response, as the backend would send it. */
export function wireTrace(options: WireTraceOptions): Record<string, unknown> {
  const {
    numQubits,
    ops,
    states,
    terminalMeasurements = [],
    backend = 'qiskit-aer',
    backendVersion = '0.17.2',
    basisOrdering = BASIS_ORDERING_WIRE,
    tag = 'a',
    blochVectors,
    changes,
  } = options

  if (states.length !== ops.length + 1) {
    throw new Error(`fixture needs ${ops.length + 1} states, got ${states.length}`)
  }
  if (blochVectors && blochVectors.length !== states.length) {
    throw new Error(`fixture needs ${states.length} bloch entries, got ${blochVectors.length}`)
  }

  if (changes && changes.length !== states.length) {
    throw new Error(`fixture needs ${states.length} change entries, got ${changes.length}`)
  }

  const steps = states.map((statevector, i) => {
    const bloch = blochVectors?.[i] ?? null
    return {
      step_index: i,
      operation_index: i === 0 ? null : i - 1,
      operation: i === 0 ? null : ops[i - 1],
      execution_id: `aer-local-${tag}${i}`,
      provenance: {
        result_id: `res_${tag}${i}`,
        circuit_hash: `hash_prefix_${tag}${i}`,
        backend,
        backend_version: backendVersion,
        execution_mode: 'statevector',
        provenance_class: 'SIMULATION',
        verification_status: 'STATE_CHECKED',
        created_at: `2026-09-29T07:18:1${i}+00:00`,
      },
      statevector,
      ...(changes ? { change: changes[i] ?? null } : {}),
      // Like the backend: an explicit null when there is no Bloch vector; when
      // there is one, `derived_from` names exactly this step.
      bloch_vector: bloch
        ? {
            x: bloch[0],
            y: bloch[1],
            z: bloch[2],
            method: 'bloch-from-statevector/1',
            derived_from: {
              step_index: i,
              result_id: `res_${tag}${i}`,
              execution_id: `aer-local-${tag}${i}`,
              circuit_hash: `hash_prefix_${tag}${i}`,
              backend,
              backend_version: backendVersion,
            },
          }
        : null,
    }
  })

  return {
    circuit_hash: `hash_submitted_${tag}`,
    traced_circuit_hash: terminalMeasurements.length ? `hash_traced_${tag}` : `hash_submitted_${tag}`,
    backend,
    backend_version: backendVersion,
    num_qubits: numQubits,
    mode: 'statevector',
    trace_method: 'prefix-statevector',
    basis_ordering: basisOrdering,
    steps,
    terminal_measurements: terminalMeasurements.map((operation, i) => ({
      operation_index: ops.length + i,
      operation,
    })),
    final_result_id: `res_${tag}${ops.length}`,
  }
}

/** The camelCase `ExecutionTraceResult`, built by the SAME zod parse +
 * provenance mapping `RealApiClient.traceCircuit` uses (so viewer tests
 * exercise realistic domain objects, not hand-shaped ones). */
export function traceResult(options: WireTraceOptions): ExecutionTraceResult {
  return traceResultFromResponse(TraceResponseSchema.parse(wireTrace(options)))
}

// ---- Ready-made scenarios (the circuits named in the task) ----------------

/** Empty 1-qubit circuit: a single initial step. */
export const emptyOneQubit = (tag = 'a') =>
  traceResult({ numQubits: 1, ops: [], states: [[[1, 0], [0, 0]]], tag })

/** X, then a terminal measure: two steps, and the measure is metadata only. */
export const xThenMeasure = (tag = 'a') =>
  traceResult({
    numQubits: 1,
    ops: [X0],
    states: [
      [[1, 0], [0, 0]],
      [[0, 0], [1, 0]],
    ],
    terminalMeasurements: [MEASURE0],
    tag,
  })

/** H, Z, H — four steps. The numbers are just labelled test data. */
export const hzh = (tag = 'a') =>
  traceResult({
    numQubits: 1,
    ops: [H0, Z0, H0],
    states: [
      [[1, 0], [0, 0]],
      [[0.7071067811865476, 0], [0.7071067811865476, 0]],
      [[0.7071067811865476, 0], [-0.7071067811865476, 0]],
      [[0, 0], [1, 0]],
    ],
    tag,
  })

/** H, Z, H with the backend's REAL Bloch vectors for each step (values
 * copied verbatim from the backend's own H -> Z -> H trace, including its
 * ~1e-16 residues): +z, +x, -x, -z. */
export const HZH_BLOCH_STATES: Amplitude[][] = [
  [[1, 0], [0, 0]],
  [[0.7071067811865476, 0], [0.7071067811865475, 0]],
  [[0.7071067811865476, 0], [-0.7071067811865475, 0]],
  [[2.220446049250313e-16, 6.123233995736765e-17], [1, -6.123233995736766e-17]],
]
export const HZH_BLOCH_VECTORS: Array<[number, number, number]> = [
  [0, 0, 1],
  [1, 0, 2.220446049250313e-16],
  [-1, 0, 2.220446049250313e-16],
  [4.440892098500626e-16, -1.2246467991473532e-16, -1],
]
export const hzhWithBloch = (tag = 'a') =>
  traceResult({ numQubits: 1, ops: [H0, Z0, H0], states: HZH_BLOCH_STATES, blochVectors: HZH_BLOCH_VECTORS, tag })

/** A one-step, one-qubit trace whose single step carries the given Bloch
 * vector — for rendering a specific supplied (x, y, z). The statevector is
 * just |0>; the sphere must ignore it and show the supplied vector. */
export const singleBloch = (vector: [number, number, number], tag = 'a') =>
  traceResult({ numQubits: 1, ops: [], states: [[[1, 0], [0, 0]]], blochVectors: [vector], tag })

/** Bell circuit with terminal measures: 3 steps + 2 measurements. */
export const bellMeasured = (tag = 'a') =>
  traceResult({
    numQubits: 2,
    ops: [H0, CX01],
    states: [
      [[1, 0], [0, 0], [0, 0], [0, 0]],
      [[0.7071067811865476, 0], [0.7071067811865476, 0], [0, 0], [0, 0]],
      [[0.7071067811865476, 0], [0, 0], [0, 0], [0.7071067811865476, 0]],
    ],
    terminalMeasurements: [MEASURE0, MEASURE1],
    tag,
  })
