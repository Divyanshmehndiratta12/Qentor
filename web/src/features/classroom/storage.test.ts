/** What the browser remembers about the classroom is untrusted text: shape-checked, never partly trusted, and free of personal data. */
import { describe, expect, it } from 'vitest'
import {
  CLASSROOM_STORAGE_KEY,
  emptyClassroom,
  isClassCode,
  isInstructorKey,
  isLearnerToken,
  loadClassroom,
  parseClassroom,
  saveClassroom,
  serializeClassroom,
  type StoredClassroom,
} from './storage'

const TOKEN = 'ql_' + 'a'.repeat(32)
const KEY = 'qi_' + 'b'.repeat(32)
const GOOD: StoredClassroom = {
  learnerToken: TOKEN,
  membership: { classCode: 'ABCD-2345', classTitle: 'Period 3', alias: 'Learner 4F2A' },
  teaching: [{ classCode: 'WXYZ-6789', title: 'Mine', instructorKey: KEY, createdAt: '2026-10-01T00:00:00Z' }],
}

class FakeStorage {
  data = new Map<string, string>()
  getItem = (k: string) => this.data.get(k) ?? null
  setItem = (k: string, v: string) => void this.data.set(k, v)
  removeItem = (k: string) => void this.data.delete(k)
}

describe('shapes', () => {
  it('recognises the server’s token, key and code shapes and nothing else', () => {
    expect(isLearnerToken(TOKEN)).toBe(true)
    expect(isInstructorKey(KEY)).toBe(true)
    expect(isClassCode('ABCD-2345')).toBe(true)
    for (const bad of ['', 'ql_', 'ql_short', TOKEN + '\n', ' ' + TOKEN, KEY, 'qi_' + 'b'.repeat(200), null, 5, undefined, {}]) expect(isLearnerToken(bad)).toBe(false)
    for (const bad of ['', 'qi_', TOKEN, KEY + '!', null, 5]) expect(isInstructorKey(bad)).toBe(false)
    for (const bad of ['abcd-2345', 'ABCD2345', 'ABC-2345', 'ABCD-23456', 'ABCD-234!', '', null, 5]) expect(isClassCode(bad)).toBe(false)
  })
})

describe('round trip', () => {
  it('stores and reads back exactly', () => {
    expect(parseClassroom(serializeClassroom(GOOD))).toEqual(GOOD)
  })

  it('stores nothing but the capability tokens, the class and the alias: no name, no email, no identity', () => {
    const stored = JSON.parse(serializeClassroom(GOOD))
    expect(Object.keys(stored).sort()).toEqual(['learnerToken', 'membership', 'teaching', 'version'])
    expect(Object.keys(stored.membership).sort()).toEqual(['alias', 'classCode', 'classTitle'])
    expect(Object.keys(stored.teaching[0]).sort()).toEqual(['classCode', 'createdAt', 'instructorKey', 'title'])
  })
})

describe('untrusted stored data', () => {
  it.each([
    ['nothing', null],
    ['empty text', ''],
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['the wrong version', JSON.stringify({ version: 2, learnerToken: TOKEN })],
    ['no version', JSON.stringify({ learnerToken: TOKEN })],
    ['null', 'null'],
  ])('reads %s as an empty classroom', (_name, raw) => {
    expect(parseClassroom(raw as string | null)).toEqual(emptyClassroom())
  })

  it('drops a learner token of the wrong shape, and with it the membership that depended on it', () => {
    const raw = JSON.stringify({ version: 1, learnerToken: 'hello', membership: GOOD.membership, teaching: [] })
    expect(parseClassroom(raw)).toEqual(emptyClassroom())
  })

  it('a membership without a token is dropped', () => {
    expect(parseClassroom(JSON.stringify({ version: 1, learnerToken: null, membership: GOOD.membership, teaching: [] })).membership).toBeNull()
  })

  it('a malformed membership is dropped but the token is kept (so rejoining is the same learner)', () => {
    for (const membership of [{ classCode: 'bad', classTitle: 't', alias: 'a' }, { classCode: 'ABCD-2345', classTitle: 5, alias: 'a' }, { classCode: 'ABCD-2345', classTitle: 't', alias: 'x'.repeat(100) }, 'str', 5, []]) {
      const parsed = parseClassroom(JSON.stringify({ version: 1, learnerToken: TOKEN, membership, teaching: [] }))
      expect(parsed.membership).toBeNull()
      expect(parsed.learnerToken).toBe(TOKEN)
    }
  })

  it('keeps the valid classes and drops only the malformed or duplicate ones', () => {
    const good = GOOD.teaching[0]!
    const raw = JSON.stringify({
      version: 1,
      learnerToken: null,
      membership: null,
      teaching: [
        good,
        { ...good, classCode: 'bad' },
        { ...good, classCode: 'MNPQ-2345', instructorKey: TOKEN },
        { ...good, classCode: 'MNPQ-2345', title: 5 },
        { ...good, title: 'duplicate code' },
        'string',
        null,
        { ...good, classCode: 'KKKK-2222', title: 'Second' },
      ],
    })
    expect(parseClassroom(raw).teaching.map((t) => t.classCode)).toEqual(['WXYZ-6789', 'KKKK-2222'])
  })

  it('reads at most 20 classes', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...GOOD.teaching[0]!, classCode: `ABCD-${String(1000 + i)}` }))
    expect(parseClassroom(JSON.stringify({ version: 1, learnerToken: null, membership: null, teaching: many })).teaching.length).toBeLessThanOrEqual(20)
  })

  it('ignores fields it does not know, so nothing extra can ride in', () => {
    const raw = JSON.stringify({ version: 1, learnerToken: TOKEN, membership: null, teaching: [], role: 'instructor', name: 'Ada' })
    const parsed = parseClassroom(raw)
    expect(parsed).toEqual({ learnerToken: TOKEN, membership: null, teaching: [] })
    expect(JSON.stringify(parsed)).not.toContain('Ada')
  })

  it('a title or alias longer than allowed is dropped rather than rendered', () => {
    const raw = JSON.stringify({ version: 1, learnerToken: TOKEN, membership: { classCode: 'ABCD-2345', classTitle: 'x'.repeat(500), alias: 'a' }, teaching: [] })
    expect(parseClassroom(raw).membership).toBeNull()
  })
})

describe('the browser’s storage', () => {
  it('saves under one key and loads it back', () => {
    const storage = new FakeStorage()
    expect(saveClassroom(GOOD, storage)).toBe(true)
    expect([...storage.data.keys()]).toEqual([CLASSROOM_STORAGE_KEY])
    expect(loadClassroom(storage)).toEqual(GOOD)
  })

  it('with no storage it is session-only: load is empty and save says it did not save', () => {
    expect(loadClassroom(null)).toEqual(emptyClassroom())
    expect(saveClassroom(GOOD, null)).toBe(false)
  })

  it('a storage that throws (blocked site data) neither crashes nor pretends', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => undefined,
    }
    expect(loadClassroom(blocked)).toEqual(emptyClassroom())
    expect(saveClassroom(GOOD, blocked)).toBe(false)
  })
})
