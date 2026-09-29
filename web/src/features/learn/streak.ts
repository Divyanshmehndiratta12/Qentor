/**
 * Pure, deterministic learning-streak calculation — no storage, no clock, no
 * randomness. Every function takes the activity history and (where "today"
 * matters) an explicit `todayKey`, so behaviour is fully reproducible in
 * tests. `useLearnStore` is what reads the browser clock and persists.
 *
 * Dates are LOCAL CALENDAR DATES of the browser, as `YYYY-MM-DD` strings
 * (`DateKey`). This is a per-browser convenience, not a globally
 * authoritative streak: no server time is involved and nothing here is
 * synchronised across devices or users.
 *
 * What is stored is only the set of days on which the learner did something
 * meaningful (see `useLearnStore` for the exact rule). Current streak,
 * longest streak and last activity are always *derived* from that set by
 * `getActivitySummary`, never stored, so they can't drift from the dates.
 *
 * Day arithmetic goes through UTC day numbers (days since 1970-01-01), never
 * through local `Date` maths, so DST shifts can't add or drop a day.
 */

/** A local calendar date, `YYYY-MM-DD`. */
export type DateKey = string

/** Sorted ascending, no duplicates, every entry a real calendar date. Only
 * `normalizeActivityDates`/`recordActivity` construct these. */
export interface ActivityHistory {
  readonly activityDates: readonly DateKey[]
}

export const EMPTY_ACTIVITY_HISTORY: ActivityHistory = Object.freeze({ activityDates: [] })

export const RECENT_DAYS_WINDOW = 7

const MS_PER_DAY = 86_400_000
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** The browser-local calendar date of `date` as a `DateKey`. */
export function toLocalDateKey(date: Date): DateKey {
  const y = String(date.getFullYear()).padStart(4, '0')
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Days since 1970-01-01 for a valid `YYYY-MM-DD` key, else `null`. Rejects
 * non-existent dates (2026-02-30) and years outside 1970–9999. */
function toDayNumber(key: unknown): number | null {
  if (typeof key !== 'string') return null
  const match = DATE_KEY_PATTERN.exec(key)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1970) return null

  const ms = Date.UTC(year, month - 1, day)
  const roundTrip = new Date(ms)
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) {
    return null
  }
  return ms / MS_PER_DAY
}

function fromDayNumber(dayNumber: number): DateKey {
  const date = new Date(dayNumber * MS_PER_DAY)
  const y = String(date.getUTCFullYear()).padStart(4, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isValidDateKey(key: unknown): key is DateKey {
  return toDayNumber(key) !== null
}

/** `key` shifted by `days` calendar days (negative goes back). Throws on an
 * invalid key — callers pass keys they already validated. */
export function addDays(key: DateKey, days: number): DateKey {
  const n = toDayNumber(key)
  if (n === null) throw new Error(`Invalid date key: ${String(key)}`)
  return fromDayNumber(n + days)
}

/** Any input -> a clean date list: non-strings and invalid/non-existent dates
 * are dropped, duplicates collapsed, result sorted ascending. Never throws. */
export function normalizeActivityDates(input: unknown): DateKey[] {
  if (!Array.isArray(input)) return []
  const unique = new Set<DateKey>()
  for (const entry of input) {
    if (isValidDateKey(entry)) unique.add(entry)
  }
  return [...unique].sort()
}

/**
 * Record activity on `dateKey`. Idempotent: a date already present returns
 * the SAME `history` object (so callers can detect "nothing changed" by
 * reference and skip persisting); an invalid key is ignored the same way.
 * Multiple actions on one calendar day therefore stay one activity day.
 */
export function recordActivity(history: ActivityHistory, dateKey: DateKey): ActivityHistory {
  if (!isValidDateKey(dateKey)) return history
  if (history.activityDates.includes(dateKey)) return history
  return { activityDates: [...history.activityDates, dateKey].sort() }
}

/**
 * Current streak = the number of consecutive active days ending at an
 * "anchor" day:
 * - if `todayKey` is active, the anchor is today;
 * - else if yesterday is active, the anchor is yesterday (the streak is still
 *   alive — the learner just hasn't done anything yet today);
 * - else the streak is 0.
 * From the anchor it counts backwards one calendar day at a time until the
 * first inactive day. Dates after `todayKey` are never counted.
 */
export function getCurrentStreak(history: ActivityHistory, todayKey: DateKey): number {
  const today = toDayNumber(todayKey)
  if (today === null) return 0

  const active = new Set<number>()
  for (const key of history.activityDates) {
    const n = toDayNumber(key)
    if (n !== null && n <= today) active.add(n)
  }

  let cursor: number
  if (active.has(today)) cursor = today
  else if (active.has(today - 1)) cursor = today - 1
  else return 0

  let streak = 0
  while (active.has(cursor)) {
    streak += 1
    cursor -= 1
  }
  return streak
}

/** Longest streak = the maximum run of consecutive calendar days present in
 * the history, anywhere in it (independent of today). 0 for no activity. */
export function getLongestStreak(history: ActivityHistory): number {
  const days = [...new Set(history.activityDates.map(toDayNumber).filter((n): n is number => n !== null))].sort(
    (a, b) => a - b,
  )

  let longest = 0
  let run = 0
  let previous: number | null = null
  for (const day of days) {
    run = previous !== null && day === previous + 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = day
  }
  return longest
}

export interface RecentDay {
  date: DateKey
  active: boolean
}

export interface ActivitySummary {
  currentStreak: number
  longestStreak: number
  /** Most recent activity date on record, or `null` if there is none. */
  lastActivityDate: DateKey | null
  totalActiveDays: number
  activeToday: boolean
  /** The last `RECENT_DAYS_WINDOW` calendar days ending at today, oldest
   * first, each flagged active/inactive. */
  recentDays: RecentDay[]
}

export function getActivitySummary(history: ActivityHistory, todayKey: DateKey): ActivitySummary {
  const dates = history.activityDates.filter(isValidDateKey)
  const dateSet = new Set(dates)

  const recentDays: RecentDay[] = []
  if (isValidDateKey(todayKey)) {
    for (let offset = RECENT_DAYS_WINDOW - 1; offset >= 0; offset -= 1) {
      const date = addDays(todayKey, -offset)
      recentDays.push({ date, active: dateSet.has(date) })
    }
  }

  return {
    currentStreak: getCurrentStreak(history, todayKey),
    longestStreak: getLongestStreak(history),
    lastActivityDate: dates.length === 0 ? null : [...dates].sort()[dates.length - 1]!,
    totalActiveDays: dateSet.size,
    activeToday: dateSet.has(todayKey),
    recentDays,
  }
}
