/**
 * Challenge outcomes persistence: shape checks on the way back in, versioning, recovery of unreadable data, reconciliation with
 * the real catalog. Stored data is untrusted, exactly like a network response.
 */
import { describe, expect, it } from 'vitest'
import {
  CHALLENGE_SCHEMA_VERSION,
  CHALLENGE_STORAGE_KEY,
  CHALLENGE_UNREADABLE_KEY,
  emptyOutcomes,
  emptyRecord,
  localStorageChallengeStore,
  parseOutcomes,
  reconcileOutcomes,
  serializeOutcomes,
  type ChallengeOutcomes,
} from './challengeStorage'

const AT = '2026-05-01T10:00:00.000Z'

const SOLVED = { ...emptyRecord(), attempts: 3, solved: true, hintsRevealed: 2, lastAttemptId: 'att_3', lastPassed: true, lastAt: AT, solvedAt: AT }

const OUTCOMES: ChallengeOutcomes = {
  records: { 'create-one': SOLVED, 'create-bell': { ...emptyRecord(), attempts: 1, lastAttemptId: 'att_9', lastPassed: false, lastAt: AT } },
  recent: [
    { challengeId: 'create-one', attemptId: 'att_3', passed: true, at: AT },
    { challengeId: 'create-bell', attemptId: 'att_9', passed: false, at: AT },
  ],
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
  }
}

describe('serialize / parse round trip', () => {
  it('reads back exactly what was written', () => {
    expect(parseOutcomes(serializeOutcomes(OUTCOMES))).toEqual(OUTCOMES)
  })

  it('serialises equal outcomes identically (sorted), so change detection is cheap', () => {
    const shuffled: ChallengeOutcomes = { ...OUTCOMES, records: { 'create-bell': OUTCOMES.records['create-bell']!, 'create-one': SOLVED } }
    expect(serializeOutcomes(shuffled)).toBe(serializeOutcomes(OUTCOMES))
  })

  it('writes the version', () => {
    expect(JSON.parse(serializeOutcomes(emptyOutcomes())).version).toBe(CHALLENGE_SCHEMA_VERSION)
  })
})

describe('untrusted input', () => {
  const blob = (over: Record<string, unknown>) => JSON.stringify({ version: 1, records: {}, recent: [], ...over })

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['no version', JSON.stringify({ records: {} })],
    ['a newer version this build does not know', blob({ version: 99 })],
    ['version 0', blob({ version: 0 })],
    ['a fractional version', blob({ version: 1.5 })],
    ['records that are not an object', blob({ records: [] })],
  ])('an unreadable blob is rejected as a whole: %s', (_name, raw) => {
    expect(parseOutcomes(raw)).toBeNull()
  })

  it('drops individual bad records but keeps the good ones', () => {
    const parsed = parseOutcomes(
      blob({
        records: {
          good: { attempts: 1, solved: false, hintsRevealed: 0 },
          negative: { attempts: -1, solved: false, hintsRevealed: 0 },
          fractional: { attempts: 1.5, solved: false, hintsRevealed: 0 },
          huge: { attempts: 1e12, solved: false, hintsRevealed: 0 },
          noSolved: { attempts: 1, hintsRevealed: 0 },
          str: 'x',
        },
      }),
    )
    expect(Object.keys(parsed!.records)).toEqual(['good'])
  })

  it('refuses a "solved" record with no attempts: the two facts cannot disagree', () => {
    const parsed = parseOutcomes(blob({ records: { c: { attempts: 0, solved: true, hintsRevealed: 0 } } }))
    expect(parsed!.records).toEqual({})
  })

  it('ignores a solvedAt on an unsolved record and any junk timestamp', () => {
    const parsed = parseOutcomes(
      blob({ records: { c: { attempts: 1, solved: false, hintsRevealed: 0, solvedAt: AT, lastAt: 'yesterday-ish' } } }),
    )
    expect(parsed!.records.c!.solvedAt).toBeNull()
    expect(parsed!.records.c!.lastAt).toBeNull()
  })

  it('drops bad recent events, and keeps only the newest 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ challengeId: 'c', attemptId: `att_${i}`, passed: false, at: AT }))
    const parsed = parseOutcomes(blob({ recent: [{ challengeId: '', attemptId: 'x', passed: true, at: AT }, { nope: 1 }, ...many] }))
    expect(parsed!.recent).toHaveLength(50)
    expect(parsed!.recent.at(-1)!.attemptId).toBe('att_79')
  })

  it('does not accept ids that are empty or absurdly long', () => {
    const parsed = parseOutcomes(blob({ records: { '': { attempts: 1, solved: false, hintsRevealed: 0 }, ['x'.repeat(300)]: { attempts: 1, solved: false, hintsRevealed: 0 } } }))
    expect(parsed!.records).toEqual({})
  })
})

describe('migration chain', () => {
  it('upgrades an older version step by step', () => {
    const migrated = parseOutcomes(
      JSON.stringify({ version: 1, records: { c: { attempts: 1, solved: false, hintsRevealed: 0 } }, legacy: true }),
      { 1: (d) => ({ ...d, version: 2, recent: [] }) },
      2,
    )
    expect(Object.keys(migrated!.records)).toEqual(['c'])
  })

  it('a gap in the chain is unreadable, never guessed', () => {
    expect(parseOutcomes(JSON.stringify({ version: 1, records: {} }), {}, 2)).toBeNull()
  })

  it('a migration that throws is unreadable', () => {
    expect(
      parseOutcomes(JSON.stringify({ version: 1, records: {} }), { 1: () => { throw new Error('boom') } }, 2),
    ).toBeNull()
  })
})

describe('reconcile with the real catalog', () => {
  const catalog = [
    { id: 'create-one', hints: ['a', 'b', 'c'] },
    { id: 'create-bell', hints: ['a'] },
  ]

  it('drops records and events for challenges that no longer exist', () => {
    const outcomes: ChallengeOutcomes = {
      records: { ...OUTCOMES.records, gone: SOLVED },
      recent: [...OUTCOMES.recent, { challengeId: 'gone', attemptId: 'att_x', passed: true, at: AT }],
    }
    const reconciled = reconcileOutcomes(catalog, outcomes)
    expect(Object.keys(reconciled.records).sort()).toEqual(['create-bell', 'create-one'])
    expect(reconciled.recent.map((e) => e.challengeId)).not.toContain('gone')
  })

  it('clamps hints shown to the challenge’s real hint count', () => {
    const reconciled = reconcileOutcomes(catalog, { records: { 'create-bell': { ...emptyRecord(), attempts: 1, hintsRevealed: 5 } }, recent: [] })
    expect(reconciled.records['create-bell']!.hintsRevealed).toBe(1)
  })

  it('keeps a solved record intact', () => {
    expect(reconcileOutcomes(catalog, OUTCOMES).records['create-one']).toEqual(SOLVED)
  })
})

describe('the localStorage-backed store', () => {
  it('is empty when nothing is stored', () => {
    expect(localStorageChallengeStore(() => fakeStorage()).load()).toEqual({ outcomes: emptyOutcomes(), status: 'empty' })
  })

  it('saves and loads', () => {
    const storage = fakeStorage()
    const store = localStorageChallengeStore(() => storage)
    expect(store.save(OUTCOMES)).toBe(true)
    expect(store.load()).toEqual({ outcomes: OUTCOMES, status: 'loaded' })
    expect(storage.data[CHALLENGE_STORAGE_KEY]).toBeTruthy()
  })

  it('sets unreadable data aside instead of destroying it, and starts clean', () => {
    const storage = fakeStorage({ [CHALLENGE_STORAGE_KEY]: '{corrupt' })
    const loaded = localStorageChallengeStore(() => storage).load()
    expect(loaded).toEqual({ outcomes: emptyOutcomes(), status: 'recovered' })
    expect(storage.data[CHALLENGE_UNREADABLE_KEY]).toBe('{corrupt')
  })

  it('reports a failed save instead of throwing', () => {
    const storage = { ...fakeStorage(), setItem: () => { throw new Error('quota') } }
    const store = localStorageChallengeStore(() => storage)
    expect(store.save(OUTCOMES)).toBe(false)
    expect(store.probe()).toBe(false)
  })

  it('survives storage that throws on read', () => {
    const storage = { ...fakeStorage(), getItem: () => { throw new Error('blocked') } }
    expect(localStorageChallengeStore(() => storage).load().status).toBe('empty')
  })

  it('works (session-only) with no storage at all', () => {
    const store = localStorageChallengeStore(() => null)
    expect(store.load().status).toBe('empty')
    expect(store.save(OUTCOMES)).toBe(false)
    expect(store.probe()).toBe(false)
  })
})
