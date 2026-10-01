/**
 * What this browser remembers about the classroom, in one `localStorage` key (`qentor.classroom.v1`), read defensively.
 *
 * - the anonymous learner token the server issued (a random bearer secret: it identifies no one) and, while in a class, which class;
 * - the instructor keys of classes this browser created, so the instructor can come back to the dashboard. A key is a capability:
 *   whoever holds it can read that class's aggregate numbers and delete it, which is why it lives only here and is shown once.
 *
 * Stored text is untrusted. Every field is shape-checked on load and anything that does not fit is dropped (the rest is kept), so
 * a hand-edited or corrupted value cannot reach the UI or a request header. Reading or writing can fail (blocked storage): callers
 * then run session-only.
 */
import { browserStorage, type KeyValueStorage } from '@/features/learn/browserStorage'

export const CLASSROOM_STORAGE_KEY = 'qentor.classroom.v1'

const LEARNER_TOKEN = /^ql_[A-Za-z0-9_-]{20,64}$/
const INSTRUCTOR_KEY = /^qi_[A-Za-z0-9_-]{20,64}$/
const CLASS_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/
const MAX_TEACHING = 20

export interface Membership {
  classCode: string
  classTitle: string
  alias: string
}

export interface TeachingClass {
  classCode: string
  title: string
  instructorKey: string
  createdAt: string
}

export interface StoredClassroom {
  /** Kept after leaving a class too, so rejoining in this browser is the same anonymous learner. */
  learnerToken: string | null
  membership: Membership | null
  teaching: TeachingClass[]
}

export function emptyClassroom(): StoredClassroom {
  return { learnerToken: null, membership: null, teaching: [] }
}

export function isLearnerToken(value: unknown): value is string {
  return typeof value === 'string' && LEARNER_TOKEN.test(value)
}

export function isInstructorKey(value: unknown): value is string {
  return typeof value === 'string' && INSTRUCTOR_KEY.test(value)
}

export function isClassCode(value: unknown): value is string {
  return typeof value === 'string' && CLASS_CODE.test(value)
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

/** Parse stored text into a valid state, dropping whatever does not fit. Never throws. */
export function parseClassroom(raw: string | null): StoredClassroom {
  if (!raw) return emptyClassroom()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return emptyClassroom()
  }
  if (typeof data !== 'object' || data === null || (data as { version?: unknown }).version !== 1) return emptyClassroom()
  const record = data as Record<string, unknown>

  const learnerToken = isLearnerToken(record.learnerToken) ? record.learnerToken : null
  let membership: Membership | null = null
  const m = record.membership as Record<string, unknown> | null | undefined
  if (learnerToken && m && typeof m === 'object') {
    const classTitle = text(m.classTitle, 120)
    const alias = text(m.alias, 40)
    if (isClassCode(m.classCode) && classTitle !== null && alias !== null) membership = { classCode: m.classCode, classTitle, alias }
  }

  const teaching: TeachingClass[] = []
  if (Array.isArray(record.teaching)) {
    for (const item of record.teaching.slice(0, MAX_TEACHING)) {
      if (typeof item !== 'object' || item === null) continue
      const t = item as Record<string, unknown>
      const title = text(t.title, 120)
      const createdAt = text(t.createdAt, 64)
      if (isClassCode(t.classCode) && isInstructorKey(t.instructorKey) && title !== null && createdAt !== null) {
        if (!teaching.some((x) => x.classCode === t.classCode)) teaching.push({ classCode: t.classCode, title, instructorKey: t.instructorKey, createdAt })
      }
    }
  }
  return { learnerToken, membership, teaching }
}

export function serializeClassroom(state: StoredClassroom): string {
  return JSON.stringify({ version: 1, learnerToken: state.learnerToken, membership: state.membership, teaching: state.teaching })
}

export function loadClassroom(storage: KeyValueStorage | null = browserStorage()): StoredClassroom {
  if (!storage) return emptyClassroom()
  try {
    return parseClassroom(storage.getItem(CLASSROOM_STORAGE_KEY))
  } catch {
    return emptyClassroom()
  }
}

/** Save; `false` when the browser would not (the caller then says this device is not remembering). */
export function saveClassroom(state: StoredClassroom, storage: KeyValueStorage | null = browserStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(CLASSROOM_STORAGE_KEY, serializeClassroom(state))
    return true
  } catch {
    return false
  }
}
