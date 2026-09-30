/**
 * Experiment comparison state. A learner pins one real run (A), runs something else (B) and asks the SERVER to compare them.
 * The store holds only what the server said: the pinned run's identity (its circuit and the result the server issued for it),
 * the comparison the server returned, and the tutor's answers about it. It computes no difference and asserts no verdict.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError } from '@/api'
import type { ExecutePayload, ExperimentComparison, TutorAnswerResult, TutorLanguage } from '@/api'
import type { Circuit } from '@/circuit/types'
import type { QuantumValue } from '@/provenance/QuantumValue'

export interface PinnedRun {
  circuit: Circuit
  result: QuantumValue<ExecutePayload>
}

export type CompareTurn = { role: 'learner'; text: string } | { role: 'tutor'; answer: TutorAnswerResult } | { role: 'error'; message: string }

interface CompareState {
  pinned: PinnedRun | null
  comparison: ExperimentComparison | null
  isComparing: boolean
  error: string | null
  errorStatus: number | null
  turns: CompareTurn[]
  isAsking: boolean

  pin: (run: PinnedRun) => void
  unpin: () => void
  compare: (b: PinnedRun) => Promise<void>
  ask: (question: string, language: TutorLanguage) => Promise<void>
}

const cleared = () => ({ comparison: null, error: null, errorStatus: null, turns: [] as CompareTurn[], isAsking: false, isComparing: false })

let compareSeq = 0

function messageOf(err: unknown): string {
  return err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
    ? err.message
    : err instanceof Error
      ? err.message
      : String(err)
}

export const useCompareStore = create<CompareState>((set, get) => ({
  pinned: null,
  ...cleared(),

  pin: (run) => {
    compareSeq++
    set({ pinned: run, ...cleared() })
  },

  unpin: () => {
    compareSeq++
    set({ pinned: null, ...cleared() })
  },

  compare: async (b) => {
    const { pinned } = get()
    if (!pinned) return
    const mine = ++compareSeq
    set({ ...cleared(), isComparing: true })
    try {
      const comparison = await getApiClient().compareExperiments(
        { resultId: pinned.result.provenance.resultId, circuit: pinned.circuit },
        { resultId: b.result.provenance.resultId, circuit: b.circuit },
      )
      if (mine !== compareSeq) return
      set({ comparison, isComparing: false })
    } catch (err) {
      if (mine !== compareSeq) return
      set({
        error: messageOf(err),
        errorStatus: err instanceof BackendUnavailableError ? (err.status ?? null) : null,
        isComparing: false,
      })
    }
  },

  ask: async (question, language) => {
    const text = question.trim()
    const { comparison } = get()
    if (!text || !comparison || get().isAsking) return
    const id = comparison.comparisonId
    const learnerTurn: CompareTurn = { role: 'learner', text }
    set({ turns: [...get().turns, learnerTurn], isAsking: true })
    // The conversation belongs to this comparison: if it is replaced or cleared meanwhile, the answer is dropped.
    const stillMine = () => get().comparison?.comparisonId === id && get().turns.includes(learnerTurn)
    try {
      const answer = await getApiClient().askComparisonTutor(id, text, language)
      if (!stillMine()) return set({ isAsking: false })
      set({ turns: [...get().turns, { role: 'tutor', answer }], isAsking: false })
    } catch (err) {
      if (!stillMine()) return set({ isAsking: false })
      set({ turns: [...get().turns, { role: 'error', message: messageOf(err) }], isAsking: false })
    }
  },
}))
