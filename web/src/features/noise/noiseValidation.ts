/**
 * Checks a learner's Noise Lab entries before they are sent, so a value the server would refuse is flagged in words instead of by a failed request.
 * They only describe whether a value is inside the server's catalog ranges; the server validates every value again and is the authority.
 */
import type { NoiseCatalog, NoiseModelInfo } from '@/api'
import { parseSeed } from './store'

export function strengthProblem(info: NoiseModelInfo | null, strength: number): string | null {
  if (!info || info.name === 'none') return null
  if (!Number.isFinite(strength)) return 'Enter a number.'
  if (strength < info.minStrength || strength > info.maxStrength) return `Use a value from ${info.minStrength} to ${info.maxStrength} for this model.`
  return null
}

export function shotsProblem(catalog: NoiseCatalog | null, shots: number): string | null {
  const max = catalog?.limits.maxShots ?? 20_000
  if (!Number.isInteger(shots) || shots < 1 || shots > max) return `Use a whole number of shots from 1 to ${max}.`
  return null
}

export function seedProblem(catalog: NoiseCatalog | null, seedText: string): string | null {
  const seed = parseSeed(seedText)
  if (seed === undefined) return 'Use a whole number (or leave it empty).'
  const max = catalog?.limits.maxSeed ?? 2_147_483_647
  if (seed !== null && seed > max) return `Use a number up to ${max}.`
  return null
}
