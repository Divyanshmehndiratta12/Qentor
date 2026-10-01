/**
 * The challenge store: it sends the Lab circuit to the server and records what comes back. It never decides pass/fail; a
 * challenge is "solved" only when the server said so, and outcomes survive a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Challenge, ChallengeSubmission } from '@/api'
import { BackendUnavailableError } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { CHALLENGE_STORAGE_KEY, CHALLENGE_UNREADABLE_KEY, localStorageChallengeStore, type ChallengeStore } from './challengeStorage'

const client = vi.hoisted(() => ({ listChallenges: vi.fn(), submitChallenge: vi.fn(), listLessons: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '@/features/learn/store'
import { setChallengeStore, useChallengeStore } from './store'

const H: Circuit = { ...emptyCircuit(1, 0), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] }
const STARTER_A: Circuit = emptyCircuit(1, 0)
const STARTER_B: Circuit = emptyCircuit(2, 2)

const challenge = (id: string, starter: Circuit, hints = ['h1', 'h2', 'h3']): Challenge => ({
  id,
  lessonId: 'superposition',
  title: id,
  goal: 'goal',
  difficulty: 'beginner',
  successCondition: 'done',
  fixedOracle: false,
  constraints: { numQubits: starter.num_qubits, numClbits: starter.num_clbits, allowedGates: ['h', 'x'], maxOps: 6, minGateCounts: {}, anchor: [], anchorName: 'oracle', mustMeasure: [], gateQubits: {} },
  starterCircuit: starter,
  checks: [{ id: 'c', label: 'c' }],
  hints,
})

const CATALOG = [challenge('a', STARTER_A), challenge('b', STARTER_B)]

const verdict = (over: Partial<ChallengeSubmission> = {}): ChallengeSubmission => ({
  attemptId: 'att_1',
  challengeId: 'a',
  circuitHash: 'qc_1',
  passed: true,
  verifier: 'challenge/1',
  checks: [],
  backend: 'qiskit-aer',
  backendVersion: '1',
  finalResultId: 'res_1',
  finalProvenance: null,
  nextHintIndex: null,
  nextHint: null,
  successMessage: 'nice',
  createdAt: '2026-05-01T10:00:00.000Z',
  ...over,
})

const state = () => useChallengeStore.getState()
const record = (id: string) => state().outcomes.records[id]

const INITIAL = useChallengeStore.getState()
const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()

function memoryStore(): ChallengeStore & { saved: string[] } {
  const saved: string[] = []
  return {
    saved,
    load: () => ({ outcomes: { records: {}, recent: [] }, status: 'empty' }),
    save: (o) => {
      saved.push(JSON.stringify(o))
      return true
    },
    probe: () => true,
  }
}

let store: ReturnType<typeof memoryStore>

beforeEach(async () => {
  localStorage.clear()
  client.listChallenges.mockReset().mockResolvedValue(CATALOG)
  client.submitChallenge.mockReset()
  client.listLessons.mockReset().mockResolvedValue([])
  store = memoryStore()
  setChallengeStore(store)
  useChallengeStore.setState(INITIAL, true)
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
  await state().fetchChallenges()
})
afterEach(() => vi.restoreAllMocks())

describe('loading the catalog', () => {
  it('holds exactly what the server returned', () => {
    expect(state().challenges).toEqual(CATALOG)
    expect(state().isLoading).toBe(false)
    expect(state().error).toBeNull()
  })

  it('a failure is an error and an empty list, never a substitute', async () => {
    client.listChallenges.mockRejectedValueOnce(new BackendUnavailableError('down'))
    await state().fetchChallenges()
    expect(state().error).toBe('down')
    expect(state().challenges).toEqual([])
  })

  it('an empty catalog does not wipe saved outcomes', async () => {
    state().selectChallenge('a')
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await state().submit()
    client.listChallenges.mockResolvedValueOnce([])
    await state().fetchChallenges()
    expect(record('a')?.solved).toBe(true)
  })
})

describe('selecting a challenge', () => {
  it('loads its starter circuit into the Lab workspace', () => {
    state().selectChallenge('b')
    expect(useBuildStore.getState().circuit).toBe(STARTER_B)
    expect(state().selectedId).toBe('b')
  })

  it('reselecting the current challenge leaves the learner’s work alone', () => {
    state().selectChallenge('a')
    useBuildStore.getState().loadCircuit(H)
    state().selectChallenge('a')
    expect(useBuildStore.getState().circuit).toBe(H)
  })

  it('an unknown id selects nothing', () => {
    state().selectChallenge('a')
    state().selectChallenge('nope')
    expect(state().selectedId).toBe('a')
  })

  it('switching clears the previous verdict and error', async () => {
    state().selectChallenge('a')
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await state().submit()
    expect(state().submission).not.toBeNull()
    state().selectChallenge('b')
    expect(state().submission).toBeNull()
    expect(state().submitError).toBeNull()
  })

  it('selecting null clears the selection', () => {
    state().selectChallenge('a')
    state().selectChallenge(null)
    expect(state().selectedId).toBeNull()
  })
})

describe('submitting', () => {
  beforeEach(() => {
    state().selectChallenge('a')
    useBuildStore.getState().loadCircuit(H) // the learner built something
    // loadCircuit above does not change the selection
  })

  it('sends the challenge id and the CURRENT Lab circuit — nothing else', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await state().submit()
    expect(client.submitChallenge).toHaveBeenCalledTimes(1)
    expect(client.submitChallenge.mock.calls[0]).toEqual(['a', H])
  })

  it('records the server’s pass: solved, attempt count, attempt id, and remembers the circuit that was judged', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await state().submit()
    expect(record('a')).toMatchObject({ attempts: 1, solved: true, lastAttemptId: 'att_1', lastPassed: true, solvedAt: '2026-05-01T10:00:00.000Z' })
    expect(state().submission!.circuit).toBe(H)
    expect(state().submission!.result.passed).toBe(true)
  })

  it('a failing verdict is recorded as an attempt and does NOT solve', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict({ passed: false, successMessage: null, nextHintIndex: 1, nextHint: 'h2' }))
    await state().submit()
    expect(record('a')).toMatchObject({ attempts: 1, solved: false, lastPassed: false, solvedAt: null })
  })

  it('solved never reverts: a later failing attempt keeps the solve but shows the latest result', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await state().submit()
    client.submitChallenge.mockResolvedValueOnce(verdict({ attemptId: 'att_2', passed: false, createdAt: '2026-05-02T10:00:00.000Z' }))
    await state().submit()
    expect(record('a')).toMatchObject({ attempts: 2, solved: true, lastPassed: false, lastAttemptId: 'att_2', solvedAt: '2026-05-01T10:00:00.000Z' })
  })

  it('keeps a bounded, ordered recent-attempts list', async () => {
    for (let i = 0; i < 55; i++) {
      client.submitChallenge.mockResolvedValueOnce(verdict({ attemptId: `att_${i}`, passed: false }))
      await state().submit()
    }
    const { recent } = state().outcomes
    expect(recent).toHaveLength(50)
    expect(recent.at(-1)!.attemptId).toBe('att_54')
    expect(recent[0]!.attemptId).toBe('att_5')
  })

  it('a solve counts as learning activity for today; a failed attempt does not', async () => {
    const before = useLearnStore.getState().activityHistory
    client.submitChallenge.mockResolvedValueOnce(verdict({ passed: false }))
    await state().submit()
    expect(useLearnStore.getState().activityHistory).toBe(before)
    client.submitChallenge.mockResolvedValueOnce(verdict({ attemptId: 'att_2' }))
    await state().submit()
    expect(useLearnStore.getState().activityHistory).not.toBe(before)
  })

  it('persists every recorded outcome', async () => {
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await state().submit()
    expect(JSON.parse(store.saved.at(-1)!).records.a.solved).toBe(true)
  })

  it('a refusal (4xx) is an error with its status, and records NOTHING', async () => {
    client.submitChallenge.mockRejectedValueOnce(new BackendUnavailableError('too big', 422))
    await state().submit()
    expect(state().submitError).toBe('too big')
    expect(state().submitErrorStatus).toBe(422)
    expect(state().submission).toBeNull()
    expect(record('a')).toBeUndefined()
  })

  it('an outage is an error and never a verdict', async () => {
    client.submitChallenge.mockRejectedValueOnce(new BackendUnavailableError('could not reach'))
    await state().submit()
    expect(state().submitErrorStatus).toBeNull()
    expect(record('a')).toBeUndefined()
    expect(state().isSubmitting).toBe(false)
  })

  it('a second submit while one is in flight is ignored', async () => {
    let resolve!: (v: ChallengeSubmission) => void
    client.submitChallenge.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const first = state().submit()
    await state().submit()
    expect(client.submitChallenge).toHaveBeenCalledTimes(1)
    resolve(verdict())
    await first
    expect(record('a')!.attempts).toBe(1)
  })

  it('an answer that arrives after another challenge was selected is discarded — never shown against the wrong challenge', async () => {
    let resolve!: (v: ChallengeSubmission) => void
    client.submitChallenge.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const pending = state().submit()
    state().selectChallenge('b')
    resolve(verdict())
    await pending
    expect(state().submission).toBeNull()
    expect(record('a')).toBeUndefined()
    expect(state().isSubmitting).toBe(false)
  })

  it('does nothing with no challenge selected', async () => {
    state().selectChallenge(null)
    await state().submit()
    expect(client.submitChallenge).not.toHaveBeenCalled()
  })
})

describe('hints', () => {
  it('reveals up to and including an index, never hides one, and clamps to the real count', () => {
    state().revealHintsThrough('a', 0)
    expect(record('a')!.hintsRevealed).toBe(1)
    state().revealHintsThrough('a', 1)
    expect(record('a')!.hintsRevealed).toBe(2)
    state().revealHintsThrough('a', 0)
    expect(record('a')!.hintsRevealed).toBe(2)
    state().revealHintsThrough('a', 99)
    expect(record('a')!.hintsRevealed).toBe(3)
  })

  it('does not touch solved or attempts', () => {
    state().revealHintsThrough('a', 1)
    expect(record('a')).toMatchObject({ solved: false, attempts: 0 })
  })

  it('an unknown challenge is ignored', () => {
    state().revealHintsThrough('nope', 0)
    expect(record('nope')).toBeUndefined()
  })
})

describe('persistence across a reload', () => {
  async function reload(catalog: Challenge[] = CATALOG) {
    vi.resetModules()
    client.listChallenges.mockResolvedValue(catalog)
    const mod = await import('./store')
    await mod.useChallengeStore.getState().fetchChallenges()
    return mod.useChallengeStore
  }

  it('solved challenges, attempts and hints come back exactly', async () => {
    const first = await reload()
    first.getState().selectChallenge('a')
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await first.getState().submit()
    first.getState().revealHintsThrough('a', 1)
    const saved = first.getState().outcomes

    const second = await reload()
    expect(second.getState().outcomes).toEqual(saved)
    expect(second.getState().persistence).toBe('device')
  })

  it('unreadable saved data is set aside, the learner starts clean, and the store says so', async () => {
    localStorage.setItem(CHALLENGE_STORAGE_KEY, '{corrupt')
    const s = await reload()
    expect(s.getState().outcomes.records).toEqual({})
    expect(s.getState().outcomesRecovered).toBe(true)
    expect(localStorage.getItem(CHALLENGE_UNREADABLE_KEY)).toBe('{corrupt')
  })

  it('outcomes for a challenge that no longer exists are dropped once the catalog loads', async () => {
    const first = await reload()
    first.getState().selectChallenge('b')
    client.submitChallenge.mockResolvedValueOnce(verdict({ challengeId: 'b' }))
    await first.getState().submit()
    const second = await reload([challenge('a', STARTER_A)])
    expect(second.getState().outcomes.records.b).toBeUndefined()
  })

  it('clamps stale hint counts to the catalog', async () => {
    localStorage.setItem(
      CHALLENGE_STORAGE_KEY,
      JSON.stringify({ version: 1, records: { a: { attempts: 1, solved: false, hintsRevealed: 9 } }, recent: [] }),
    )
    const s = await reload()
    expect(s.getState().outcomes.records.a!.hintsRevealed).toBe(3)
  })

  it('a browser that will not save is reported as session-only, and everything still works', async () => {
    const failing: ChallengeStore = { load: () => ({ outcomes: { records: {}, recent: [] }, status: 'empty' }), save: () => false, probe: () => false }
    setChallengeStore(failing)
    useChallengeStore.setState({ persistence: 'session-only' })
    state().selectChallenge('a')
    client.submitChallenge.mockResolvedValueOnce(verdict())
    await state().submit()
    expect(record('a')!.solved).toBe(true)
    expect(state().persistence).toBe('session-only')
  })

  it('rehydrate re-reads storage', () => {
    localStorage.setItem(
      CHALLENGE_STORAGE_KEY,
      JSON.stringify({ version: 1, records: { a: { attempts: 2, solved: true, hintsRevealed: 0, solvedAt: '2026-05-01T10:00:00.000Z' } }, recent: [] }),
    )
    setChallengeStore(localStorageChallengeStore())
    state().rehydrate()
    expect(record('a')).toMatchObject({ attempts: 2, solved: true })
  })
})
