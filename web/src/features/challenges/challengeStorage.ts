/**
 * Browser-local persistence for challenge outcomes — what the SERVER told this browser about attempts, and nothing derived.
 *
 * Same scope and rules as `features/learn/progressStorage.ts`: local to one browser on one device, no account, no sync; stored
 * data is untrusted input (shape-checked, bounded, set aside rather than destroyed when unreadable, versioned with a migration
 * chain, reconciled against the real catalog after it loads). Kept under its own key so the lesson-progress schema is untouched.
 *
 * What is stored (`qentor.challenges.v1`):
 *   { version: 1,
 *     records: { <challengeId>: { attempts, solved, hintsRevealed, lastAttemptId, lastPassed, lastAt, solvedAt } },
 *     recent:  [ { challengeId, attemptId, passed, at } ... newest last, bounded ] }
 * `solved` means: the server returned `passed: true` for an attempt of this challenge. The server's attempt id is kept so the
 * verdict can be traced; this file cannot verify it (there is no account to verify against), and the UI says "on this device".
 * Nothing about a quantum state is stored — only outcomes.
 */
import { browserStorage, type KeyValueStorage } from '@/features/learn/browserStorage'

export const CHALLENGE_STORAGE_KEY = 'qentor.challenges.v1'
export const CHALLENGE_UNREADABLE_KEY = 'qentor.challenges.unreadable'
const PROBE_KEY = 'qentor.challenges.probe'
export const CHALLENGE_SCHEMA_VERSION = 1

const MAX_CHALLENGES = 200
const MAX_RECENT = 50
const MAX_ID_LENGTH = 200
const MAX_COUNT = 1_000_000

export interface ChallengeRecord {
  attempts: number
  solved: boolean
  /** How many hints the learner asked to see (0 = none). */
  hintsRevealed: number
  lastAttemptId: string | null
  lastPassed: boolean | null
  lastAt: string | null
  solvedAt: string | null
}

export interface ChallengeEvent {
  challengeId: string
  attemptId: string
  passed: boolean
  at: string
}

export interface ChallengeOutcomes {
  records: Record<string, ChallengeRecord>
  /** Newest last. Bounded to `MAX_RECENT`. */
  recent: ChallengeEvent[]
}

export function emptyOutcomes(): ChallengeOutcomes {
  return { records: {}, recent: [] }
}

export function emptyRecord(): ChallengeRecord {
  return { attempts: 0, solved: false, hintsRevealed: 0, lastAttemptId: null, lastPassed: null, lastAt: null, solvedAt: null }
}

export type LoadStatus = 'empty' | 'loaded' | 'recovered'

export interface ChallengeLoadResult {
  outcomes: ChallengeOutcomes
  status: LoadStatus
}

/** The seam a backend-backed store could implement later. */
export interface ChallengeStore {
  load(): ChallengeLoadResult
  save(outcomes: ChallengeOutcomes): boolean
  probe(): boolean
}

type RawRecord = Record<string, unknown>
type Migration = (data: RawRecord) => RawRecord

/** `MIGRATIONS[n]` upgrades a version-n blob to version n+1. Empty while version 1 is the only version that exists. */
export const MIGRATIONS: Record<number, Migration> = {}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null
}

function readTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : null
}

function readRecord(value: unknown): ChallengeRecord | null {
  if (!isRecord(value)) return null
  const attempts = readCount(value.attempts)
  const hintsRevealed = readCount(value.hintsRevealed)
  if (attempts === null || hintsRevealed === null || typeof value.solved !== 'boolean') return null
  // A solved challenge has at least one attempt: the two facts cannot disagree.
  if (value.solved && attempts < 1) return null
  return {
    attempts,
    solved: value.solved,
    hintsRevealed,
    lastAttemptId: isId(value.lastAttemptId) ? value.lastAttemptId : null,
    lastPassed: typeof value.lastPassed === 'boolean' ? value.lastPassed : null,
    lastAt: readTimestamp(value.lastAt),
    solvedAt: value.solved ? readTimestamp(value.solvedAt) : null,
  }
}

function readEvent(value: unknown): ChallengeEvent | null {
  if (!isRecord(value)) return null
  const at = readTimestamp(value.at)
  if (!isId(value.challengeId) || !isId(value.attemptId) || typeof value.passed !== 'boolean' || at === null) return null
  return { challengeId: value.challengeId, attemptId: value.attemptId, passed: value.passed, at }
}

/** Raw stored text -> outcomes, or `null` when the blob as a whole is unreadable. Bad individual entries are dropped. */
export function parseOutcomes(
  raw: string,
  migrations: Record<number, Migration> = MIGRATIONS,
  currentVersion: number = CHALLENGE_SCHEMA_VERSION,
): ChallengeOutcomes | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  let version = parsed.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > currentVersion) return null

  let data: RawRecord = parsed
  while (version < currentVersion) {
    const step = migrations[version]
    if (!step) return null
    try {
      data = step(data)
    } catch {
      return null
    }
    version += 1
  }

  if (!isRecord(data.records)) return null
  const records: Record<string, ChallengeRecord> = {}
  for (const [id, rawRecordValue] of Object.entries(data.records).slice(0, MAX_CHALLENGES)) {
    const record = isId(id) ? readRecord(rawRecordValue) : null
    if (record) records[id] = record
  }
  const recent = (Array.isArray(data.recent) ? data.recent : [])
    .slice(-MAX_RECENT)
    .map(readEvent)
    .filter((event): event is ChallengeEvent => event !== null)
  return { records, recent }
}

/** Outcomes -> stored text. Sorted, so equal outcomes always serialise identically. */
export function serializeOutcomes(outcomes: ChallengeOutcomes): string {
  const records: Record<string, ChallengeRecord> = {}
  for (const id of Object.keys(outcomes.records).sort()) {
    const r = outcomes.records[id]!
    records[id] = {
      attempts: r.attempts,
      solved: r.solved,
      hintsRevealed: r.hintsRevealed,
      lastAttemptId: r.lastAttemptId,
      lastPassed: r.lastPassed,
      lastAt: r.lastAt,
      solvedAt: r.solvedAt,
    }
  }
  return JSON.stringify({ version: CHALLENGE_SCHEMA_VERSION, records, recent: outcomes.recent.slice(-MAX_RECENT) })
}

/**
 * Check stored outcomes against the real challenge catalog (call after it has loaded). Pure.
 * - records and events for challenges that no longer exist are dropped;
 * - `hintsRevealed` is clamped to the challenge's real hint count.
 */
export function reconcileOutcomes(
  challenges: readonly { id: string; hints: readonly string[] }[],
  outcomes: ChallengeOutcomes,
): ChallengeOutcomes {
  const known = new Map(challenges.map((c) => [c.id, c]))
  const records: Record<string, ChallengeRecord> = {}
  for (const [id, record] of Object.entries(outcomes.records)) {
    const challenge = known.get(id)
    if (!challenge) continue
    records[id] = { ...record, hintsRevealed: Math.min(record.hintsRevealed, challenge.hints.length) }
  }
  return { records, recent: outcomes.recent.filter((event) => known.has(event.challengeId)) }
}

/** The localStorage-backed store. `getStorage` is injectable so tests can use a fake (or one that throws). */
export function localStorageChallengeStore(getStorage: () => KeyValueStorage | null = browserStorage): ChallengeStore {
  return {
    load() {
      const storage = getStorage()
      if (!storage) return { outcomes: emptyOutcomes(), status: 'empty' }
      let raw: string | null
      try {
        raw = storage.getItem(CHALLENGE_STORAGE_KEY)
      } catch {
        return { outcomes: emptyOutcomes(), status: 'empty' }
      }
      if (raw === null) return { outcomes: emptyOutcomes(), status: 'empty' }

      const outcomes = parseOutcomes(raw)
      if (outcomes) return { outcomes, status: 'loaded' }

      try {
        storage.setItem(CHALLENGE_UNREADABLE_KEY, raw)
      } catch {
        /* recovery still proceeds */
      }
      return { outcomes: emptyOutcomes(), status: 'recovered' }
    },

    save(outcomes) {
      const storage = getStorage()
      if (!storage) return false
      try {
        storage.setItem(CHALLENGE_STORAGE_KEY, serializeOutcomes(outcomes))
        return true
      } catch {
        return false
      }
    },

    probe() {
      const storage = getStorage()
      if (!storage) return false
      try {
        storage.setItem(PROBE_KEY, '1')
        storage.removeItem(PROBE_KEY)
        return true
      } catch {
        return false
      }
    },
  }
}
