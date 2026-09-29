/**
 * Browser-local persistence for the learning-activity history — and nothing
 * else. This is explicitly LOCAL-ONLY: it reads/writes this browser's
 * `localStorage` and never touches the network, a backend endpoint or any
 * database. Clearing site data, using another browser/device or a private
 * window gives an empty history; there is no sync and no account.
 *
 * Storage location: `localStorage["qentor.learn.activity.v1"]`
 * Storage format:   `{"version":1,"activityDates":["2026-09-27","2026-09-29"]}`
 *                   (local calendar dates, sorted ascending, unique)
 *
 * Every read is defensive: missing, unparseable, wrong-shaped or
 * wrong-version data yields an empty history rather than an error, and
 * individual invalid dates inside otherwise-valid data are dropped. Every
 * access to `localStorage` is guarded, since it can throw (blocked site data,
 * private mode, quota).
 */
import { EMPTY_ACTIVITY_HISTORY, normalizeActivityDates, type ActivityHistory } from './streak'

export const ACTIVITY_STORAGE_KEY = 'qentor.learn.activity.v1'
const STORAGE_VERSION = 1

/** The subset of `Storage` this module needs — lets tests pass a fake. */
export type ActivityStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): ActivityStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // accessing localStorage itself can throw
  }
}

/** Raw persisted string -> history. Anything malformed -> empty history. */
export function parseActivityHistory(raw: string | null): ActivityHistory {
  if (raw === null) return EMPTY_ACTIVITY_HISTORY
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_ACTIVITY_HISTORY
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_ACTIVITY_HISTORY

  const record = parsed as Record<string, unknown>
  if (record.version !== STORAGE_VERSION || !Array.isArray(record.activityDates)) return EMPTY_ACTIVITY_HISTORY

  return { activityDates: normalizeActivityDates(record.activityDates) }
}

export function serializeActivityHistory(history: ActivityHistory): string {
  return JSON.stringify({ version: STORAGE_VERSION, activityDates: history.activityDates })
}

export function loadActivityHistory(storage: ActivityStorage | null = browserStorage()): ActivityHistory {
  if (!storage) return EMPTY_ACTIVITY_HISTORY
  try {
    return parseActivityHistory(storage.getItem(ACTIVITY_STORAGE_KEY))
  } catch {
    return EMPTY_ACTIVITY_HISTORY
  }
}

/** Returns whether the write succeeded. A failure (storage unavailable/full)
 * is not an error for the learner — the in-memory history still works for
 * this page load; it just won't survive a reload. */
export function saveActivityHistory(
  history: ActivityHistory,
  storage: ActivityStorage | null = browserStorage(),
): boolean {
  if (!storage) return false
  try {
    storage.setItem(ACTIVITY_STORAGE_KEY, serializeActivityHistory(history))
    return true
  } catch {
    return false
  }
}
