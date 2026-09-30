/**
 * Debugger state, kept per SCOPE ('lab' | 'challenge') so each screen's report survives switching tabs without one screen showing
 * the other's. The report itself is whatever `POST /api/debug` returned - built by the server from its own records; this store
 * only holds it, along with the circuit it was made for so the UI can say when it has gone stale.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError } from '@/api'
import type { Circuit } from '@/circuit/types'
import type { DebugReport, DebugRequestInput } from '@/api'

export type DebugScope = 'lab' | 'challenge'

export interface DebugEntry {
  report: DebugReport | null
  /** The circuit the report was made for; the report is stale once the circuit on screen is no longer this one. */
  circuit: Circuit | null
  isDebugging: boolean
  error: string | null
  errorStatus: number | null
}

const EMPTY: DebugEntry = { report: null, circuit: null, isDebugging: false, error: null, errorStatus: null }

interface DebugState {
  entries: Record<DebugScope, DebugEntry>
  debug: (scope: DebugScope, input: DebugRequestInput) => Promise<void>
  clear: (scope: DebugScope) => void
}

// Newest request per scope wins: a slow answer to an earlier click never overwrites a later one.
const seq: Record<DebugScope, number> = { lab: 0, challenge: 0 }

export const useDebugStore = create<DebugState>((set, get) => {
  const patch = (scope: DebugScope, over: Partial<DebugEntry>) =>
    set({ entries: { ...get().entries, [scope]: { ...get().entries[scope], ...over } } })

  return {
    entries: { lab: EMPTY, challenge: EMPTY },

    debug: async (scope, input) => {
      const mine = ++seq[scope]
      patch(scope, { isDebugging: true, error: null, errorStatus: null })
      try {
        const report = await getApiClient().debugCircuit(input)
        if (mine !== seq[scope]) return
        patch(scope, { report, circuit: input.circuit, isDebugging: false })
      } catch (err) {
        if (mine !== seq[scope]) return
        const message =
          err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err)
        patch(scope, {
          error: message,
          errorStatus: err instanceof BackendUnavailableError ? (err.status ?? null) : null,
          isDebugging: false,
        })
      }
    },

    clear: (scope) => {
      seq[scope]++
      set({ entries: { ...get().entries, [scope]: EMPTY } })
    },
  }
})
