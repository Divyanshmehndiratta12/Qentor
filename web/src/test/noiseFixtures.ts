/**
 * Test-only data for the Noise Lab: a server response (the wire shape of `POST /api/noise/compare`) and the catalog (`GET /api/noise/models`),
 * with every number hand-computed and written out here. Nothing in the app imports this file.
 *
 * Bell pair, 1000 shots each. Ideal counts {00: 507, 11: 493}; noisy counts {00: 441, 11: 430, 01: 70, 10: 59}.
 *   total variation distance = (|0.507-0.441| + |0.493-0.430| + 0.070 + 0.059) / 2 = 0.258 / 2 = 0.129
 *   share of noisy shots on outcomes the ideal run produced = (441 + 430) / 1000 = 0.871
 *   noisy shots on outcomes the ideal run never produced   = 70 + 59 = 129
 */
import { CircuitSchema, type Circuit } from '@/circuit/types'
import { NoiseCompareResponseSchema, NoiseModelsResponseSchema } from '@/provenance/schema'
import { mapNoiseCatalog, mapNoiseResult } from '@/api/noiseMap'

const prov = (id: string, backend: string, mode: string) => ({
  result_id: id,
  circuit_hash: backend === 'noise-comparison' ? 'noise_aaaa' : 'bellhash',
  backend,
  backend_version: backend === 'noise-comparison' ? 'noise-comparison/1' : '0.17.2',
  execution_mode: mode,
  provenance_class: 'SIMULATION',
  verification_status: 'STATE_CHECKED',
  created_at: '2026-01-01T00:00:00Z',
})

export const NOISE_INFO_WIRE = {
  model: 'depolarizing',
  label: 'Depolarizing gate noise',
  strength: 0.05,
  parameter: 'error probability p',
  applies_to: 'gates',
  how_applied: 'After every gate, the same one-qubit depolarizing error is applied independently to each qubit that gate touched.',
  simulation_method: 'density_matrix',
  seed: 4242,
}

export const NOISE_WIRE = {
  label: 'Simulated noise on Qiskit Aer. Not a real device: no hardware was used and no calibration data.',
  backend: 'qiskit-aer',
  noise: NOISE_INFO_WIRE,
  ideal: {
    provenance: prov('res_ideal_0001', 'qiskit-aer', 'shots'),
    execution_id: 'aer-local-ideal',
    shots: 1000,
    counts: { '00': 507, '11': 493 },
    probabilities: { '00': 0.507, '11': 0.493 },
    noise: null,
  },
  noisy: {
    provenance: prov('res_noisy_0002', 'qiskit-aer', 'noisy_shots'),
    execution_id: 'aer-noisy-run',
    shots: 1000,
    counts: { '00': 441, '11': 430, '01': 70, '10': 59 },
    probabilities: { '00': 0.441, '11': 0.43, '01': 0.07, '10': 0.059 },
    noise: NOISE_INFO_WIRE,
  },
  comparison: {
    provenance: prov('res_cmp_0003', 'noise-comparison', 'noise_comparison'),
    method: 'noise-comparison/1',
    rows: [
      { outcome: '00', ideal_count: 507, noisy_count: 441, ideal_probability: 0.507, noisy_probability: 0.441, delta: -0.066 },
      { outcome: '01', ideal_count: 0, noisy_count: 70, ideal_probability: 0.0, noisy_probability: 0.07, delta: 0.07 },
      { outcome: '10', ideal_count: 0, noisy_count: 59, ideal_probability: 0.0, noisy_probability: 0.059, delta: 0.059 },
      { outcome: '11', ideal_count: 493, noisy_count: 430, ideal_probability: 0.493, noisy_probability: 0.43, delta: -0.063 },
    ],
    metrics: {
      shots: 1000,
      total_variation_distance: 0.129,
      noisy_share_on_ideal_outcomes: 0.871,
      ideal_outcomes: ['00', '11'],
      new_outcomes: ['01', '10'],
      new_outcome_shots: 129,
      ideal_distinct_outcomes: 2,
      noisy_distinct_outcomes: 4,
      ideal_top_outcomes: [{ outcome: '00', ideal_probability: 0.507, noisy_probability: 0.441 }],
    },
    explanation: [
      { id: 'N1', text: 'Noise model: Depolarizing gate noise. After every gate, the same one-qubit depolarizing error is applied. Strength: 0.05 (error probability p).' },
      { id: 'N2', text: '129 of 1000 noisy shots (12.9%) landed on outcomes the ideal run never produced: 01, 10.' },
      { id: 'N3', text: 'The total variation distance between the two sampled distributions is 0.1290 (0 means identical, 1 means no outcome in common).' },
    ],
    note: 'Simulated noise on Qiskit Aer, not a real device. Both runs are finite samples, so small differences can come from sampling alone.',
  },
}

/** The same response when the learner chose "None": the ideal run only. */
export const IDEAL_ONLY_WIRE = {
  label: NOISE_WIRE.label,
  backend: 'qiskit-aer',
  noise: { ...NOISE_INFO_WIRE, model: 'none', label: 'None (ideal only)', strength: 0, parameter: 'none', applies_to: 'none', how_applied: 'No noise model is used; the circuit runs on the ideal simulator.' },
  ideal: NOISE_WIRE.ideal,
  noisy: null,
  comparison: null,
}

const spec = (name: string, label: string, applies: string, parameter: string, max: number, def: number, expect: string[]) => ({
  name,
  label,
  applies_to: applies,
  parameter,
  parameter_description: `the ${parameter} of the ${label.toLowerCase()}`,
  min_strength: 0,
  max_strength: max,
  default_strength: def,
  step: 0.005,
  summary: `Summary of ${label}.`,
  how_applied: `How ${label} is applied.`,
  expect,
})

export const CATALOG_WIRE = {
  label: NOISE_WIRE.label,
  backend: 'qiskit-aer',
  models: [
    { ...spec('none', 'None (ideal only)', 'none', 'none', 0, 0, ['An ideal run is still a finite sample.']), step: 0 },
    spec('depolarizing', 'Depolarizing gate noise', 'gates', 'error probability p', 0.3, 0.05, ['A larger p moves probability onto outcomes the ideal circuit never produces.']),
    spec('bit_flip', 'Bit-flip gate noise', 'gates', 'flip probability p', 0.5, 0.05, ['A bit flip swaps 0 and 1 on that qubit.']),
    spec('phase_flip', 'Phase-flip gate noise', 'gates', 'flip probability p', 0.5, 0.05, ['A phase flip cannot change a basis measurement directly.']),
    spec('amplitude_damping', 'Amplitude-damping gate noise', 'gates', 'decay probability gamma', 0.5, 0.1, ['It moves probability from 1s towards 0s.']),
    spec('readout_error', 'Readout error', 'measurement', 'flip probability p', 0.5, 0.05, ['It acts only on measurement.']),
  ],
  limits: { max_qubits: 8, max_shots: 20000, max_operations: 500, default_shots: 1024, max_seed: 2147483647, simulation_method: 'density_matrix' },
}

export const BELL_MEASURED: Circuit = CircuitSchema.parse({
  num_qubits: 2,
  num_clbits: 2,
  ops: [
    { gate: 'h', targets: [0] },
    { gate: 'cx', targets: [1], controls: [0] },
    { gate: 'measure', targets: [0], clbits: [0] },
    { gate: 'measure', targets: [1], clbits: [1] },
  ],
})

export const parseNoiseResult = (wire: unknown = NOISE_WIRE) => mapNoiseResult(NoiseCompareResponseSchema.parse(wire))
export const parseCatalog = (wire: unknown = CATALOG_WIRE) => mapNoiseCatalog(NoiseModelsResponseSchema.parse(wire))
