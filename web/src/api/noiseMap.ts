/**
 * The one place a Noise Lab response (`NoiseCompareResponse`) becomes the client's `NoiseCompareResult`.
 *
 * Every number is passed through untouched and wrapped with the provenance of the stored run it was read from: a count of the ideal run with the
 * ideal run's, a count of the noisy run with the noisy run's, and every difference, metric or distance with the COMPARISON record's. Nothing is
 * computed, rounded, resampled or bounded here, and there is no code path that builds a noisy number from an ideal one: this module has no input
 * to do it from other than the server's own response.
 */
import { provenanceFromTraceStep, toQuantumValue, type Provenance, type QuantumValue } from '@/provenance/QuantumValue'
import type { NoiseCompareResponse, NoiseModelsResponse } from '@/provenance/schema'
import type { NoiseCatalog, NoiseCompareResult, NoiseInfo, NoiseModelName, NoiseRun } from './client'

const MODELS: readonly NoiseModelName[] = ['none', 'depolarizing', 'bit_flip', 'phase_flip', 'amplitude_damping', 'readout_error']

function modelName(name: string): NoiseModelName {
  if ((MODELS as readonly string[]).includes(name)) return name as NoiseModelName
  throw new Error(`the server named a noise model this app does not know: ${name}`)
}

function wrapAll(values: Record<string, number>, provenance: Provenance): Record<string, QuantumValue<number>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, toQuantumValue(value, provenance)]))
}

function mapInfo(noise: NonNullable<NoiseCompareResponse['noise']>): NoiseInfo {
  return {
    model: modelName(noise.model),
    label: noise.label,
    strength: noise.strength,
    parameter: noise.parameter,
    appliesTo: noise.applies_to,
    howApplied: noise.how_applied,
    simulationMethod: noise.simulation_method,
    seed: noise.seed,
  }
}

function mapRun(run: NonNullable<NoiseCompareResponse['ideal']>): NoiseRun {
  const provenance = provenanceFromTraceStep(run.provenance)
  return {
    provenance,
    executionId: run.execution_id,
    shots: run.shots,
    counts: wrapAll(run.counts, provenance),
    frequencies: wrapAll(run.probabilities, provenance),
    noise: run.noise ? mapInfo(run.noise) : null,
  }
}

export function mapNoiseResult(response: NoiseCompareResponse): NoiseCompareResult {
  const ideal = mapRun(response.ideal)
  const noisy = response.noisy ? mapRun(response.noisy) : null
  let comparison: NoiseCompareResult['comparison'] = null
  if (response.comparison) {
    if (!noisy) throw new Error('the server sent a comparison without a noisy run')
    const c = response.comparison
    const prov = provenanceFromTraceStep(c.provenance)
    const q = (value: number) => toQuantumValue(value, prov)
    comparison = {
      provenance: prov,
      method: c.method,
      note: c.note,
      explanation: c.explanation.map((line) => ({ id: line.id, text: line.text })),
      rows: c.rows.map((row) => ({
        outcome: row.outcome,
        idealCount: toQuantumValue(row.ideal_count, ideal.provenance),
        noisyCount: toQuantumValue(row.noisy_count, noisy.provenance),
        idealFrequency: toQuantumValue(row.ideal_probability, ideal.provenance),
        noisyFrequency: toQuantumValue(row.noisy_probability, noisy.provenance),
        delta: q(row.delta),
      })),
      metrics: {
        shots: c.metrics.shots,
        totalVariationDistance: q(c.metrics.total_variation_distance),
        noisyShareOnIdealOutcomes: q(c.metrics.noisy_share_on_ideal_outcomes),
        newOutcomeShots: q(c.metrics.new_outcome_shots),
        idealDistinctOutcomes: q(c.metrics.ideal_distinct_outcomes),
        noisyDistinctOutcomes: q(c.metrics.noisy_distinct_outcomes),
        idealOutcomes: [...c.metrics.ideal_outcomes],
        newOutcomes: [...c.metrics.new_outcomes],
        idealTopOutcomes: c.metrics.ideal_top_outcomes.map((t) => ({
          outcome: t.outcome,
          idealFrequency: toQuantumValue(t.ideal_probability, ideal.provenance),
          noisyFrequency: toQuantumValue(t.noisy_probability, noisy.provenance),
        })),
      },
    }
  }
  return { label: response.label, backend: response.backend, noise: mapInfo(response.noise), ideal, noisy, comparison }
}

export function mapNoiseCatalog(response: NoiseModelsResponse): NoiseCatalog {
  return {
    label: response.label,
    backend: response.backend,
    models: response.models.map((m) => ({
      name: modelName(m.name),
      label: m.label,
      appliesTo: m.applies_to,
      parameter: m.parameter,
      parameterDescription: m.parameter_description,
      minStrength: m.min_strength,
      maxStrength: m.max_strength,
      defaultStrength: m.default_strength,
      step: m.step,
      summary: m.summary,
      howApplied: m.how_applied,
      expect: [...m.expect],
    })),
    limits: {
      maxQubits: response.limits.max_qubits,
      maxShots: response.limits.max_shots,
      maxOperations: response.limits.max_operations,
      defaultShots: response.limits.default_shots,
      maxSeed: response.limits.max_seed,
      simulationMethod: response.limits.simulation_method,
    },
  }
}
