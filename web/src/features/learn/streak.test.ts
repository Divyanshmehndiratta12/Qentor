import { describe, expect, it } from 'vitest'
import {
  EMPTY_ACTIVITY_HISTORY,
  RECENT_DAYS_WINDOW,
  addDays,
  getActivitySummary,
  getCurrentStreak,
  getLongestStreak,
  isValidDateKey,
  normalizeActivityDates,
  recordActivity,
  toLocalDateKey,
  type ActivityHistory,
} from './streak'

/** A history from keys, via the real constructor path (sorted, unique). */
function history(...dates: string[]): ActivityHistory {
  return { activityDates: normalizeActivityDates(dates) }
}

describe('toLocalDateKey', () => {
  it('formats the LOCAL calendar date with zero padding', () => {
    expect(toLocalDateKey(new Date(2026, 0, 5, 23, 59, 59))).toBe('2026-01-05')
    expect(toLocalDateKey(new Date(2026, 11, 31, 0, 0, 0))).toBe('2026-12-31')
  })
})

describe('isValidDateKey', () => {
  it('accepts real calendar dates, including a leap day', () => {
    expect(isValidDateKey('2026-09-29')).toBe(true)
    expect(isValidDateKey('2024-02-29')).toBe(true)
  })

  it('rejects malformed strings, non-dates and non-strings', () => {
    for (const bad of ['2026-9-29', '2026/09/29', 'yesterday', '', '2026-13-01', '2026-02-30', '2025-02-29']) {
      expect(isValidDateKey(bad)).toBe(false)
    }
    for (const bad of [null, undefined, 20260929, {}, []]) {
      expect(isValidDateKey(bad)).toBe(false)
    }
  })
})

describe('addDays', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01')
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01') // 2025 is not a leap year
  })

  it('is unaffected by DST (pure calendar arithmetic)', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09') // US spring-forward date
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02') // US fall-back date
  })

  it('throws on an invalid key rather than returning a wrong date', () => {
    expect(() => addDays('nope', 1)).toThrow()
  })
})

describe('normalizeActivityDates', () => {
  it('sorts ascending and removes duplicates', () => {
    expect(normalizeActivityDates(['2026-09-29', '2026-09-27', '2026-09-29'])).toEqual(['2026-09-27', '2026-09-29'])
  })

  it('drops invalid entries and returns [] for non-arrays', () => {
    expect(normalizeActivityDates(['2026-09-29', 'garbage', 5, null, '2026-02-30'])).toEqual(['2026-09-29'])
    expect(normalizeActivityDates('2026-09-29')).toEqual([])
    expect(normalizeActivityDates(null)).toEqual([])
    expect(normalizeActivityDates({})).toEqual([])
  })
})

describe('recordActivity', () => {
  it('adds a date to an empty history', () => {
    expect(recordActivity(EMPTY_ACTIVITY_HISTORY, '2026-09-29').activityDates).toEqual(['2026-09-29'])
  })

  it('keeps dates sorted even when recorded out of order', () => {
    const h = recordActivity(history('2026-09-29'), '2026-09-27')
    expect(h.activityDates).toEqual(['2026-09-27', '2026-09-29'])
  })

  it('does not create a duplicate for the same date and returns the same object', () => {
    const once = recordActivity(EMPTY_ACTIVITY_HISTORY, '2026-09-29')
    const twice = recordActivity(once, '2026-09-29')
    expect(twice).toBe(once)
    expect(twice.activityDates).toEqual(['2026-09-29'])
  })

  it('ignores an invalid date key', () => {
    const h = history('2026-09-29')
    expect(recordActivity(h, 'not-a-date')).toBe(h)
  })

  it('never mutates the history it was given', () => {
    const before = history('2026-09-27')
    recordActivity(before, '2026-09-29')
    expect(before.activityDates).toEqual(['2026-09-27'])
    expect(EMPTY_ACTIVITY_HISTORY.activityDates).toEqual([])
  })
})

describe('getCurrentStreak', () => {
  const TODAY = '2026-09-29'

  it('is 0 with no activity', () => {
    expect(getCurrentStreak(EMPTY_ACTIVITY_HISTORY, TODAY)).toBe(0)
  })

  it('is 1 for activity today only', () => {
    expect(getCurrentStreak(history(TODAY), TODAY)).toBe(1)
  })

  it('counts consecutive days back from today', () => {
    expect(getCurrentStreak(history('2026-09-27', '2026-09-28', TODAY), TODAY)).toBe(3)
  })

  it('stops at the first gap', () => {
    // 09-26 is missing, so only 27, 28, 29 count.
    expect(getCurrentStreak(history('2026-09-24', '2026-09-25', '2026-09-27', '2026-09-28', TODAY), TODAY)).toBe(3)
  })

  it('stays alive from yesterday when today has no activity yet', () => {
    expect(getCurrentStreak(history('2026-09-27', '2026-09-28'), TODAY)).toBe(2)
    expect(getCurrentStreak(history('2026-09-28'), TODAY)).toBe(1)
  })

  it('is 0 when the most recent activity is two or more days ago', () => {
    expect(getCurrentStreak(history('2026-09-26', '2026-09-27'), TODAY)).toBe(0)
  })

  it('is 0 when only today is missing AND yesterday is missing, even with older runs', () => {
    expect(getCurrentStreak(history('2026-09-20', '2026-09-21', '2026-09-22'), TODAY)).toBe(0)
  })

  it('ignores dates after today', () => {
    expect(getCurrentStreak(history('2026-09-30', '2026-10-01'), TODAY)).toBe(0)
    expect(getCurrentStreak(history('2026-09-28', TODAY, '2026-09-30'), TODAY)).toBe(2)
  })

  it('counts across a month boundary', () => {
    expect(getCurrentStreak(history('2026-08-30', '2026-08-31', '2026-09-01'), '2026-09-01')).toBe(3)
  })

  it('counts across a year boundary', () => {
    expect(getCurrentStreak(history('2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'), '2026-01-02')).toBe(4)
  })

  it('counts across a leap day, and not across a missing one', () => {
    expect(getCurrentStreak(history('2024-02-28', '2024-02-29', '2024-03-01'), '2024-03-01')).toBe(3)
    // 2025 has no Feb 29: Feb 28 -> Mar 1 are consecutive.
    expect(getCurrentStreak(history('2025-02-28', '2025-03-01'), '2025-03-01')).toBe(2)
  })

  it('is 0 for an invalid "today"', () => {
    expect(getCurrentStreak(history(TODAY), 'bad')).toBe(0)
  })
})

describe('getLongestStreak', () => {
  it('is 0 with no activity', () => {
    expect(getLongestStreak(EMPTY_ACTIVITY_HISTORY)).toBe(0)
  })

  it('is 1 for a single day', () => {
    expect(getLongestStreak(history('2026-09-29'))).toBe(1)
  })

  it('finds the longest run, not the most recent one', () => {
    const h = history(
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', // run of 4
      '2026-09-10', '2026-09-11', // run of 2
      '2026-09-28', '2026-09-29', // run of 2 (current)
    )
    expect(getLongestStreak(h)).toBe(4)
  })

  it('treats non-adjacent days as separate runs', () => {
    expect(getLongestStreak(history('2026-09-01', '2026-09-03', '2026-09-05'))).toBe(1)
  })

  it('is independent of today', () => {
    const h = history('2026-01-01', '2026-01-02', '2026-01-03')
    expect(getLongestStreak(h)).toBe(3)
    expect(getCurrentStreak(h, '2026-09-29')).toBe(0)
  })

  it('counts a run across a month boundary', () => {
    expect(getLongestStreak(history('2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'))).toBe(4)
  })

  it('counts a run across a year boundary', () => {
    expect(getLongestStreak(history('2025-12-30', '2025-12-31', '2026-01-01'))).toBe(3)
  })

  it('counts a run across a leap day', () => {
    expect(getLongestStreak(history('2024-02-28', '2024-02-29', '2024-03-01'))).toBe(3)
  })

  it('is not inflated by duplicate dates', () => {
    const duplicated: ActivityHistory = { activityDates: ['2026-09-28', '2026-09-28', '2026-09-29'] }
    expect(getLongestStreak(duplicated)).toBe(2)
  })
})

describe('getActivitySummary', () => {
  const TODAY = '2026-09-29'

  it('summarises an empty history', () => {
    const summary = getActivitySummary(EMPTY_ACTIVITY_HISTORY, TODAY)
    expect(summary).toMatchObject({
      currentStreak: 0,
      longestStreak: 0,
      lastActivityDate: null,
      totalActiveDays: 0,
      activeToday: false,
    })
    expect(summary.recentDays).toHaveLength(RECENT_DAYS_WINDOW)
    expect(summary.recentDays.every((day) => !day.active)).toBe(true)
  })

  it('reports current/longest streak, last activity, totals and activeToday together', () => {
    const summary = getActivitySummary(history('2026-09-10', '2026-09-11', '2026-09-12', '2026-09-28', TODAY), TODAY)
    expect(summary.currentStreak).toBe(2)
    expect(summary.longestStreak).toBe(3)
    expect(summary.lastActivityDate).toBe(TODAY)
    expect(summary.totalActiveDays).toBe(5)
    expect(summary.activeToday).toBe(true)
  })

  it('reports yesterday as the last activity, still-alive streak and activeToday false', () => {
    const summary = getActivitySummary(history('2026-09-27', '2026-09-28'), TODAY)
    expect(summary.currentStreak).toBe(2)
    expect(summary.lastActivityDate).toBe('2026-09-28')
    expect(summary.activeToday).toBe(false)
  })

  it('builds the 7-day window oldest-first, ending today, flagging active days', () => {
    const summary = getActivitySummary(history('2026-09-23', '2026-09-26', TODAY), TODAY)
    expect(summary.recentDays.map((d) => d.date)).toEqual([
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
    ])
    expect(summary.recentDays.map((d) => d.active)).toEqual([true, false, false, true, false, false, true])
  })

  it('builds the 7-day window across a year boundary', () => {
    const summary = getActivitySummary(history('2025-12-31', '2026-01-02'), '2026-01-02')
    expect(summary.recentDays[0]!.date).toBe('2025-12-27')
    expect(summary.recentDays[6]!.date).toBe('2026-01-02')
    expect(summary.recentDays.filter((d) => d.active).map((d) => d.date)).toEqual(['2025-12-31', '2026-01-02'])
  })

  it('does not count activity older than the window in recentDays but still counts it in totals', () => {
    const summary = getActivitySummary(history('2026-01-01', TODAY), TODAY)
    expect(summary.recentDays.filter((d) => d.active)).toHaveLength(1)
    expect(summary.totalActiveDays).toBe(2)
  })
})
