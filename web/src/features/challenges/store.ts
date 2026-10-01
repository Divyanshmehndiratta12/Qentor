/**
 * Challenge store — one store per feature, like `useBuildStore` and `useLearnStore`.
 *
 * `challenges` is exactly what `GET /api/challenges` returned. The verdict on a circuit is the SERVER's (`submitChallenge`):
 * this store sends the current Lab circuit and records what comes back; it never decides pass/fail, never computes a
 * fidelity, and never marks anything solved unless the server said `passed: true`. Outcomes (attempts, solved, hints shown,
 * recent attempts) persist to this browser only (`challengeStorage.ts`), with the server's attempt id kept for traceability.
 *
 * The circuit being solved lives in `useBuildStore` — the same canvas, trace and tutor as the Lab — so a learner can Run,
 * inspect the trace and ask the tutor about the very circuit they are trying to submit. Selecting a *different* challenge loads
 * its starter circuit; reselecting the current one leaves the work alone.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError } from '@/api'
import type { Challenge, ChallengeSubmission } from '@/api'
import type { Circuit } from '@/circuit/types'
import { useBuildStore } from '@/features/build/store'
import { reportClassroomEvent } from '@/features/classroom/events'
import { recordChallengeActivity } from '@/features/learn/store'
import {
  emptyRecord,
  localStorageChallengeStore,
  reconcileOutcomes,
  serializeOutcomes,
  type ChallengeOutcomes,
  type ChallengeStore,
} from './challengeStorage'

export type Persistence = 'device' | 'session-only'

let outcomeStore: ChallengeStore = localStorageChallengeStore()

/** Swap the persistence backend (a fake in tests, a server-backed store later). Does not itself load or save anything. */
export function setChallengeStore(store: ChallengeStore): void {
  outcomeStore = store
}

const MAX_RECENT = 50

interface ChallengeState {
  challenges: Challenge[]
  isLoading: boolean
  error: string | null
  selectedId: string | null

  outcomes: ChallengeOutcomes
  persistence: Persistence
  outcomesRecovered: boolean

  isSubmitting: boolean
  submitError: string | null
  /** HTTP status behind `submitError` when the server answered (a 4xx is a refusal, not an outage). */
  submitErrorStatus: number | null
  /** The server's verdict on `circuit`. Shown as current only while `circuit` is still the circuit on screen. */
  submission: { challengeId: string; result: ChallengeSubmission; circuit: Circuit } | null

  fetchChallenges: () => Promise<void>
  rehydrate: () => void
  selectChallenge: (id: string | null) => void
  /** Show hints up to and including `index` (0-based). Never hides one already shown. */
  revealHintsThrough: (challengeId: string, index: number) => void
  submit: () => Promise<void>
}

const boot = outcomeStore.load()

export const useChallengeStore = create<ChallengeState>((set, get) => ({
  challenges: [],
  isLoading: false,
  error: null,
  selectedId: null,

  outcomes: boot.outcomes,
  persistence: outcomeStore.probe() ? 'device' : 'session-only',
  outcomesRecovered: boot.status === 'recovered',

  isSubmitting: false,
  submitError: null,
  submitErrorStatus: null,
  submission: null,

  fetchChallenges: async () => {
    set({ isLoading: true, error: null })
    try {
      const challenges = await getApiClient().listChallenges()
      set({ challenges, isLoading: false })
      reconcileWithCatalog()
    } catch (err) {
      set({ error: messageOf(err), challenges: [], isLoading: false })
    }
  },

  rehydrate: () => {
    const loaded = outcomeStore.load()
    set({
      outcomes: loaded.outcomes,
      persistence: outcomeStore.probe() ? 'device' : 'session-only',
      outcomesRecovered: loaded.status === 'recovered',
    })
    reconcileWithCatalog()
  },

  selectChallenge: (id) => {
    if (id === get().selectedId) return
    const challenge = id === null ? null : get().challenges.find((c) => c.id === id)
    if (id !== null && !challenge) return // an unknown id selects nothing rather than pointing at nothing
    set({ selectedId: id, submission: null, submitError: null, submitErrorStatus: null, isSubmitting: false })
    if (challenge) {
      useBuildStore.getState().loadCircuit(challenge.starterCircuit)
      reportClassroomEvent('challenge_started', challenge.id) // a no-op unless this browser is in a class
    }
  },

  revealHintsThrough: (challengeId, index) => {
    const challenge = get().challenges.find((c) => c.id === challengeId)
    if (!challenge) return
    const wanted = Math.min(index + 1, challenge.hints.length)
    const record = get().outcomes.records[challengeId] ?? emptyRecord()
    if (record.hintsRevealed >= wanted) return
    updateRecord(challengeId, { ...record, hintsRevealed: wanted })
  },

  submit: async () => {
    const { selectedId, challenges } = get()
    const challenge = challenges.find((c) => c.id === selectedId)
    if (!challenge || get().isSubmitting) return

    const circuit = useBuildStore.getState().circuit
    set({ isSubmitting: true, submitError: null, submitErrorStatus: null })
    try {
      const result = await getApiClient().submitChallenge(challenge.id, circuit)
      // Discard an answer to a question that is no longer the one on screen (another challenge was selected meanwhile).
      if (get().selectedId !== challenge.id) return set({ isSubmitting: false })
      set({ submission: { challengeId: challenge.id, result, circuit }, isSubmitting: false })
      recordOutcome(challenge.id, result)
    } catch (err) {
      if (get().selectedId !== challenge.id) return set({ isSubmitting: false })
      set({
        submitError: messageOf(err),
        submitErrorStatus: err instanceof BackendUnavailableError ? (err.status ?? null) : null,
        isSubmitting: false,
      })
    }
  },
}))

function messageOf(err: unknown): string {
  return err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
    ? err.message
    : err instanceof Error
      ? err.message
      : String(err)
}

function persistOutcomes(): void {
  const { outcomes, persistence, outcomesRecovered } = useChallengeStore.getState()
  const saved = outcomeStore.save(outcomes)
  const next: Persistence = saved ? 'device' : 'session-only'
  if (next !== persistence || (saved && outcomesRecovered)) {
    useChallengeStore.setState({ persistence: next, outcomesRecovered: saved ? false : outcomesRecovered })
  }
}

function updateRecord(challengeId: string, record: ReturnType<typeof emptyRecord>): void {
  const { outcomes } = useChallengeStore.getState()
  useChallengeStore.setState({ outcomes: { ...outcomes, records: { ...outcomes.records, [challengeId]: record } } })
  persistOutcomes()
}

/** Record what the server said about an attempt. `solved` only ever flips to true from the server's `passed`. */
function recordOutcome(challengeId: string, result: ChallengeSubmission): void {
  const { outcomes } = useChallengeStore.getState()
  const before = outcomes.records[challengeId] ?? emptyRecord()
  const firstSolve = result.passed && !before.solved
  const record = {
    ...before,
    attempts: before.attempts + 1,
    solved: before.solved || result.passed,
    lastAttemptId: result.attemptId,
    lastPassed: result.passed,
    lastAt: result.createdAt,
    solvedAt: firstSolve ? result.createdAt : before.solvedAt,
  }
  const recent = [...outcomes.recent, { challengeId, attemptId: result.attemptId, passed: result.passed, at: result.createdAt }].slice(-MAX_RECENT)
  useChallengeStore.setState({ outcomes: { records: { ...outcomes.records, [challengeId]: record }, recent } })
  persistOutcomes()
  if (result.passed) recordChallengeActivity()
}

/** Once the real catalog is here, check stored outcomes against it. Writes back only if something changed. */
function reconcileWithCatalog(): void {
  const { challenges, outcomes } = useChallengeStore.getState()
  if (challenges.length === 0) return // "not loaded yet", not "every challenge was deleted"
  const reconciled = reconcileOutcomes(challenges, outcomes)
  if (serializeOutcomes(reconciled) === serializeOutcomes(outcomes)) return
  useChallengeStore.setState({ outcomes: reconciled })
  persistOutcomes()
}
