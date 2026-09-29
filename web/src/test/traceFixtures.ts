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
import type { GateOp } from '@/circuit/types'
import { provenanceFromTraceStep, toQuantumValue } from '@/provenance/QuantumValue'
import { TraceResponseSchema, type TraceResponse } from '@/provenance/schema'

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
  } = options

  if (states.length !== ops.length + 1) {
    throw new Error(`fixture needs ${ops.length + 1} states, got ${states.length}`)
  }

  const steps = states.map((statevector, i) => ({
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
      verification_status: 'VERIFIED',
      created_at: `2026-09-29T07:18:1${i}+00:00`,
    },
    statevector,
  }))

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
  const response: TraceResponse = TraceResponseSchema.parse(wireTrace(options))
  return {
    circuitHash: response.circuit_hash,
    tracedCircuitHash: response.traced_circuit_hash,
    backend: response.backend,
    backendVersion: response.backend_version,
    numQubits: response.num_qubits,
    mode: response.mode,
    traceMethod: response.trace_method,
    basisOrdering: response.basis_ordering,
    steps: response.steps.map((step) => ({
      stepIndex: step.step_index,
      operationIndex: step.operation_index,
      operation: step.operation,
      executionId: step.execution_id,
      state: toQuantumValue(step.statevector, provenanceFromTraceStep(step.provenance)),
    })),
    terminalMeasurements: response.terminal_measurements.map((m) => ({
      operationIndex: m.operation_index,
      operation: m.operation,
    })),
    finalResultId: response.final_result_id,
  }
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
