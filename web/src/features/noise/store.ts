/**
 * Noise Lab state: what the learner chose (a noise model, its strength, shots, an optional seed), the server's catalog of models, and the last
 * comparison the SERVER returned.
 *
 * Trust: this store holds choices and the server's answer and nothing in between. It never derives a count, a frequency or a distance, never adds
 * or removes noise, and has no function that takes ideal numbers and returns noisy ones: the one thing that can put a result in `result` is a
 * response from `compareNoise`. The circuit being run is the Lab's own (`useBuildStore`), passed in at run time, so there is only one circuit
 * representation; the result remembers the exact circuit (and choices) it was made for, so a result is never shown against a different circuit.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError, NoiseRejectedError } from '@/api'
import type { NoiseCatalog, NoiseCompareResult, NoiseModelInfo, NoiseModelName } from '@/api'
import type { Circuit } from '@/circuit/types'

/** The Noise Lab's first choice: the ideal-versus-depolarizing comparison, so a learner sees a difference on the first run. */
export const DEFAULT_NOISE_MODEL: NoiseModelName = 'depolarizing'
const FALLBACK_SHOTS = 1024

export interface NoiseRunSettings {
  noiseModel: NoiseModelName
  noiseStrength: number | null
  shots: number
  seed: number | null
}

/** What a result was made for. A result is shown only against the circuit it came from; a change of settings is told to the learner instead. */
export function circuitKey(circuit: Circuit): string {
  return JSON.stringify(circuit)
}

interface NoiseState {
  catalog: NoiseCatalog | null
  catalogError: string | null
  isLoadingCatalog: boolean

  model: NoiseModelName
  strength: number
  shots: number
  /** The seed as typed: empty means "let the server choose". */
  seedText: string

  result: NoiseCompareResult | null
  /** The circuit the shown result is a result of. */
  resultCircuitKey: string | null
  isRunning: boolean
  error: { message: string; code: string | null; status: number | null } | null

  loadCatalog: () => Promise<void>
  setModel: (model: NoiseModelName) => void
  setStrength: (strength: number) => void
  setShots: (shots: number) => void
  setSeedText: (text: string) => void
  run: (circuit: Circuit) => Promise<void>
  clearResult: () => void
}

export function modelInfo(catalog: NoiseCatalog | null, name: NoiseModelName): NoiseModelInfo | null {
  return catalog?.models.find((m) => m.name === name) ?? null
}

/** The seed the learner typed, or `null` for "choose one": `undefined` when the text is not a whole number (the form says so; nothing is sent). */
export function parseSeed(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  return /^\d{1,10}$/.test(t) ? Number(t) : undefined
}

let runSeq = 0

function failure(err: unknown): NonNullable<NoiseState['error']> {
  if (err instanceof NoiseRejectedError) return { message: err.message, code: err.code, status: err.status }
  if (err instanceof BackendUnavailableError) return { message: err.message, code: null, status: err.status ?? null }
  if (err instanceof EndpointNotImplementedError) return { message: err.message, code: null, status: null }
  return { message: err instanceof Error ? err.message : String(err), code: null, status: null }
}

export const useNoiseStore = create<NoiseState>((set, get) => ({
  catalog: null,
  catalogError: null,
  isLoadingCatalog: false,

  model: DEFAULT_NOISE_MODEL,
  strength: 0.05,
  shots: FALLBACK_SHOTS,
  seedText: '',

  result: null,
  resultCircuitKey: null,
  isRunning: false,
  error: null,

  loadCatalog: async () => {
    if (get().catalog || get().isLoadingCatalog) return
    set({ isLoadingCatalog: true, catalogError: null })
    try {
      const catalog = await getApiClient().listNoiseModels()
      const info = modelInfo(catalog, get().model)
      set({
        catalog,
        isLoadingCatalog: false,
        strength: info ? info.defaultStrength : get().strength,
        shots: Math.min(Math.max(1, get().shots), catalog.limits.maxShots, catalog.limits.defaultShots) || catalog.limits.defaultShots,
      })
    } catch (err) {
      set({ isLoadingCatalog: false, catalogError: failure(err).message })
    }
  },

  setModel: (model) => {
    const info = modelInfo(get().catalog, model)
    set({ model, strength: info ? info.defaultStrength : 0 })
  },

  setStrength: (strength) => set({ strength }),
  setShots: (shots) => set({ shots }),
  setSeedText: (seedText) => set({ seedText }),

  run: async (circuit) => {
    const { model, strength, shots, seedText } = get()
    const seed = parseSeed(seedText)
    if (seed === undefined) return // the form shows why; an invalid seed is never sent
    const settings: NoiseRunSettings = { noiseModel: model, noiseStrength: model === 'none' ? null : strength, shots, seed }
    const mine = ++runSeq
    set({ isRunning: true, error: null })
    try {
      const result = await getApiClient().compareNoise({ circuit, ...settings })
      if (mine !== runSeq) return // a newer run replaced this one
      set({ result, resultCircuitKey: circuitKey(circuit), isRunning: false })
    } catch (err) {
      if (mine !== runSeq) return
      // A failed run shows its error and shows no result: the previous result belonged to a different request.
      set({ result: null, resultCircuitKey: null, isRunning: false, error: failure(err) })
    }
  },

  clearResult: () => {
    runSeq++
    set({ result: null, resultCircuitKey: null, isRunning: false, error: null })
  },
}))
