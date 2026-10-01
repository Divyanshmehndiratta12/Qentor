/**
 * State for AI code generation. A language model PROPOSES OpenQASM 3; the server parses, validates and labels it; this store holds
 * what the server answered and nothing else. It never judges a proposal, never edits one, and never shows one as verified:
 * `proposal` is exactly the server's `CircuitProposal` (status PROPOSED or REJECTED, verification UNVERIFIED_AGAINST_INTENT).
 *
 * The four things a learner can do with a proposal reuse the Lab's own machinery, so nothing about a proposal is special-cased:
 *  - Insert: `useBuildStore.loadCircuit` (one undo step, so the previous circuit is one Ctrl+Z away);
 *  - Run: the ordinary `runExecution`, whose numbers come from the backend with provenance;
 *  - Explain: the ordinary result-grounded tutor question about the circuit on the canvas;
 *  - Reject: forget the proposal.
 *
 * Without a configured model the server says so (`availability.available === false`), and there is no other generator: the phase
 * becomes `unavailable` and nothing is substituted.
 */
import { create } from 'zustand'
import { GenerationFailedError, GenerationUnavailableError, getApiClient } from '@/api'
import type { CircuitProposal, GenerationRequestInput, GenerationStatus } from '@/api'
import { sameCircuit } from '@/circuit/edit'
import { useBuildStore } from '@/features/build/store'

export type GeneratePhase = 'idle' | 'generating' | 'proposed' | 'rejected' | 'unavailable' | 'failed'

export const PROMPT_MAX = 600
export const PROMPT_MIN = 3
/** The question "Explain" asks: the same one the Lab's own starter chip asks. */
export const EXPLAIN_QUESTION = 'What does this circuit do?'

let requestSeq = 0

interface GenerateState {
  /** What the server said about generation existing at all; `null` until asked. */
  availability: GenerationStatus | null
  checkingAvailability: boolean
  availabilityError: string | null

  prompt: string
  includeCurrentCircuit: boolean
  lessonId: string | null
  challengeId: string | null

  phase: GeneratePhase
  proposal: CircuitProposal | null
  /** The message for `failed` (retry may work) or `unavailable` (it will not). */
  error: string | null
  lastRequest: GenerationRequestInput | null

  setPrompt: (prompt: string) => void
  setIncludeCurrentCircuit: (include: boolean) => void
  setLessonId: (id: string | null) => void
  setChallengeId: (id: string | null) => void
  checkAvailability: () => Promise<void>
  generate: () => Promise<void>
  retry: () => Promise<void>
  reject: () => void
  /** Put the proposal's circuit on the canvas (undoable). Returns whether there was a PROPOSED circuit to put there. */
  insert: () => boolean
  run: () => Promise<void>
  explain: () => Promise<void>
}

const INITIAL = {
  availability: null,
  checkingAvailability: false,
  availabilityError: null,
  prompt: '',
  includeCurrentCircuit: false,
  lessonId: null,
  challengeId: null,
  phase: 'idle' as GeneratePhase,
  proposal: null,
  error: null,
  lastRequest: null,
}

export const useGenerateStore = create<GenerateState>((set, get) => ({
  ...INITIAL,

  setPrompt: (prompt) => set({ prompt: prompt.slice(0, PROMPT_MAX) }),
  setIncludeCurrentCircuit: (include) => set({ includeCurrentCircuit: include }),
  setLessonId: (id) => set({ lessonId: id }),
  setChallengeId: (id) => set({ challengeId: id }),

  checkAvailability: async () => {
    if (get().checkingAvailability) return
    set({ checkingAvailability: true, availabilityError: null })
    try {
      const availability = await getApiClient().getGenerationStatus()
      set({ availability, checkingAvailability: false, phase: availability.available ? get().phase : 'unavailable', error: availability.available ? get().error : availability.reason })
    } catch (err) {
      // The server could not be asked at all: that is not "unavailable", it is "unknown", and the panel says so.
      set({ availability: null, checkingAvailability: false, availabilityError: err instanceof Error ? err.message : String(err) })
    }
  },

  generate: async () => {
    const { prompt, includeCurrentCircuit, lessonId, challengeId } = get()
    const text = prompt.trim()
    if (text.length < PROMPT_MIN) return
    const build = useBuildStore.getState()
    const request: GenerationRequestInput = {
      prompt: text,
      language: build.tutorLanguage,
      lessonId,
      challengeId,
      circuit: includeCurrentCircuit && build.circuit.ops.length > 0 ? build.circuit : null,
    }
    const seq = ++requestSeq
    set({ phase: 'generating', error: null, proposal: null, lastRequest: request })
    try {
      const proposal = await getApiClient().generateCircuit(request)
      if (seq !== requestSeq) return // a newer request (or a Reject) superseded this one
      set({ proposal, phase: proposal.status === 'PROPOSED' ? 'proposed' : 'rejected' })
    } catch (err) {
      if (seq !== requestSeq) return
      if (err instanceof GenerationUnavailableError) {
        set({ phase: 'unavailable', error: err.message, availability: { available: false, provider: null, model: null, reason: err.message } })
      } else if (err instanceof GenerationFailedError) {
        set({ phase: 'failed', error: err.message })
      } else {
        set({ phase: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }
  },

  retry: async () => {
    const { lastRequest } = get()
    if (!lastRequest) return
    // Ask again with the same words; the context is whatever is selected now, so a retry never sends stale context.
    await get().generate()
  },

  reject: () => {
    ++requestSeq // an answer still on its way is no longer wanted
    set({ proposal: null, phase: get().availability?.available === false ? 'unavailable' : 'idle', error: null })
  },

  insert: () => {
    const { proposal } = get()
    if (!proposal || proposal.status !== 'PROPOSED' || !proposal.circuit) return false
    useBuildStore.getState().loadCircuit(proposal.circuit)
    return true
  },

  run: async () => {
    const { proposal } = get()
    if (!proposal || proposal.status !== 'PROPOSED' || !proposal.circuit) return
    if (!sameCircuit(useBuildStore.getState().circuit, proposal.circuit)) get().insert()
    await useBuildStore.getState().runExecution()
  },

  explain: async () => {
    const { proposal } = get()
    if (!proposal || proposal.status !== 'PROPOSED' || !proposal.circuit) return
    if (!sameCircuit(useBuildStore.getState().circuit, proposal.circuit)) get().insert()
    // The tutor only explains what the backend actually produced, so the circuit is run first if it has not been.
    if (!useBuildStore.getState().result) await useBuildStore.getState().runExecution()
    await useBuildStore.getState().askTutor(EXPLAIN_QUESTION)
  },
}))

/** Back to the starting state (used by tests). */
export function resetGenerateStore(): void {
  requestSeq = 0
  useGenerateStore.setState({ ...INITIAL })
}
