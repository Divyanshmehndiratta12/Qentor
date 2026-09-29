import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_ACTIVITY_HISTORY } from './streak'
import {
  ACTIVITY_STORAGE_KEY,
  loadActivityHistory,
  parseActivityHistory,
  saveActivityHistory,
  serializeActivityHistory,
  type ActivityStorage,
} from './streakStorage'

/** An in-memory `Storage` stand-in, so these tests never touch the real one. */
function fakeStorage(initial: Record<string, string> = {}): ActivityStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('streak storage format', () => {
  it('stores under a versioned, namespaced key', () => {
    expect(ACTIVITY_STORAGE_KEY).toBe('qentor.learn.activity.v1')
  })

  it('serialises to a versioned JSON object of sorted date strings', () => {
    expect(serializeActivityHistory({ activityDates: ['2026-09-27', '2026-09-29'] })).toBe(
      '{"version":1,"activityDates":["2026-09-27","2026-09-29"]}',
    )
  })
})

describe('parseActivityHistory', () => {
  it('round-trips a saved history', () => {
    const history = { activityDates: ['2026-09-27', '2026-09-29'] }
    expect(parseActivityHistory(serializeActivityHistory(history))).toEqual(history)
  })

  it('returns an empty history for missing data', () => {
    expect(parseActivityHistory(null)).toEqual(EMPTY_ACTIVITY_HISTORY)
  })

  it.each([
    ['not JSON', '{oops'],
    ['empty string', ''],
    ['a JSON string', '"2026-09-29"'],
    ['a JSON number', '42'],
    ['JSON null', 'null'],
    ['a JSON array', '["2026-09-29"]'],
    ['an object without activityDates', '{"version":1}'],
    ['activityDates not an array', '{"version":1,"activityDates":"2026-09-29"}'],
    ['an unknown version', '{"version":2,"activityDates":["2026-09-29"]}'],
    ['a missing version', '{"activityDates":["2026-09-29"]}'],
  ])('falls back to an empty history for %s', (_label, raw) => {
    expect(parseActivityHistory(raw)).toEqual(EMPTY_ACTIVITY_HISTORY)
  })

  it('drops invalid entries but keeps valid ones, deduplicated and sorted', () => {
    const raw = JSON.stringify({
      version: 1,
      activityDates: ['2026-09-29', 'garbage', 7, null, '2026-02-30', '2026-09-27', '2026-09-29'],
    })
    expect(parseActivityHistory(raw)).toEqual({ activityDates: ['2026-09-27', '2026-09-29'] })
  })
})

describe('loadActivityHistory / saveActivityHistory', () => {
  let storage: ReturnType<typeof fakeStorage>

  beforeEach(() => {
    storage = fakeStorage()
  })

  it('loads an empty history from empty storage', () => {
    expect(loadActivityHistory(storage)).toEqual(EMPTY_ACTIVITY_HISTORY)
  })

  it('saves and reloads the same history', () => {
    const history = { activityDates: ['2026-09-28', '2026-09-29'] }
    expect(saveActivityHistory(history, storage)).toBe(true)
    expect(storage.data[ACTIVITY_STORAGE_KEY]).toBe(serializeActivityHistory(history))
    expect(loadActivityHistory(storage)).toEqual(history)
  })

  it('recovers from corrupted stored data instead of throwing', () => {
    storage.data[ACTIVITY_STORAGE_KEY] = '{{{{ not json'
    expect(loadActivityHistory(storage)).toEqual(EMPTY_ACTIVITY_HISTORY)
  })

  it('treats a throwing getItem as an empty history', () => {
    const throwing: ActivityStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
    }
    expect(loadActivityHistory(throwing)).toEqual(EMPTY_ACTIVITY_HISTORY)
  })

  it('reports (rather than throws) a failed write, e.g. quota exceeded', () => {
    const full: ActivityStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(saveActivityHistory({ activityDates: ['2026-09-29'] }, full)).toBe(false)
  })

  it('degrades gracefully when there is no storage at all', () => {
    expect(loadActivityHistory(null)).toEqual(EMPTY_ACTIVITY_HISTORY)
    expect(saveActivityHistory({ activityDates: ['2026-09-29'] }, null)).toBe(false)
  })
})
