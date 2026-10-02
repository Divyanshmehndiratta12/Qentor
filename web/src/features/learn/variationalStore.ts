/**
 * State of the variational (VQE-style) lab: the last sweep, the last optimisation, which run is selected, and what is loading or failed.
 * Everything in it came from the server through `ApiClient`; nothing is computed or defaulted here. A newer request supersedes an older one
 * (an answer to a superseded request is dropped), and an error shows no data: nothing is substituted.
 */
import { create } from 'zustand'
import { getApiClient } from '@/api'
import type { VariationalOptimizationResult, VariationalOptimizeInput, VariationalSweepInput, VariationalSweepResult } from '@/api'

export type RunSource = 'sweep' | 'path'

interface VariationalState {
  sweep: VariationalSweepResult | null
  isSweeping: boolean
  sweepError: string | null
  optimization: VariationalOptimizationResult | null
  isOptimizing: boolean
  optimizationError: string | null
  /** Which list the selected run is taken from, and its position in it. */
  source: RunSource
  selected: number

  runSweep: (input: VariationalSweepInput) => Promise<void>
  runOptimization: (input: VariationalOptimizeInput) => Promise<void>
  setSource: (source: RunSource) => void
  select: (index: number) => void
  reset: () => void
}

let sweepSeq = 0
let optimizeSeq = 0

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const INITIAL = {
  sweep: null,
  isSweeping: false,
  sweepError: null,
  optimization: null,
  isOptimizing: false,
  optimizationError: null,
  source: 'sweep' as RunSource,
  selected: 0,
}

export const useVariationalStore = create<VariationalState>((set, get) => ({
  ...INITIAL,

  runSweep: async (input) => {
    const seq = ++sweepSeq
    set({ isSweeping: true, sweepError: null })
    try {
      const sweep = await getApiClient().variationalSweep(input)
      if (seq !== sweepSeq) return
      // the lowest point is the server's own pick; the learner starts there and can move
      set({ sweep, isSweeping: false, source: 'sweep', selected: sweep.minimumIndex })
    } catch (err) {
      if (seq !== sweepSeq) return
      set({ sweep: null, isSweeping: false, sweepError: message(err) })
    }
  },

  runOptimization: async (input) => {
    const seq = ++optimizeSeq
    set({ isOptimizing: true, optimizationError: null })
    try {
      const optimization = await getApiClient().variationalOptimize(input)
      if (seq !== optimizeSeq) return
      set({ optimization, isOptimizing: false, source: 'path', selected: optimization.steps.length - 1 })
    } catch (err) {
      if (seq !== optimizeSeq) return
      set({ optimization: null, isOptimizing: false, optimizationError: message(err) })
    }
  },

  setSource: (source) => {
    const { sweep, optimization } = get()
    const length = source === 'sweep' ? (sweep?.points.length ?? 0) : (optimization?.steps.length ?? 0)
    if (length === 0) return // nothing to show from that list
    set({ source, selected: source === 'sweep' ? (sweep?.minimumIndex ?? 0) : length - 1 })
  },

  select: (index) => {
    const { source, sweep, optimization } = get()
    const length = source === 'sweep' ? (sweep?.points.length ?? 0) : (optimization?.steps.length ?? 0)
    if (length === 0) return
    set({ selected: Math.max(0, Math.min(length - 1, Math.floor(index))) })
  },

  reset: () => {
    ++sweepSeq
    ++optimizeSeq
    set(INITIAL)
  },
}))
