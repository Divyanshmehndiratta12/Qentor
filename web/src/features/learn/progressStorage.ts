/**
 * Browser-local persistence for lesson progress — what the learner explicitly did, and nothing derived.
 *
 * Scope: this is LOCAL to one browser on one device. It reads and writes `localStorage` and never touches the network or a
 * backend. There is no account, no sync and no identity; clearing site data, another browser or a private window starts empty.
 * The rest of Learn talks to a small `ProgressStore` interface (`load` / `save` / `probe`), so a backend-backed store can replace
 * the localStorage one later without touching the store, the screens or the derivation rules.
 *
 * What is stored (`qentor.learn.progress.v1`):
 *   { version: 1, startedLessonIds: [...], lessons: { <lessonId>: {
 *       activeSectionIndex, completedSectionIds: [...],
 *       conceptCheckAttempts: { <sectionId>: { selectedOptionId, isCorrect, attemptCount } } } } }
 * Completion, mastery, accuracy and misconception signals are NOT stored: they are re-derived from these facts by the same pure
 * functions as before (`lessonState.ts`, `learnerInsights.ts`), so reload reconstructs them exactly and there is no second copy
 * to drift.
 *
 * Trust on the way back in — stored data is untrusted input, exactly like a network response:
 *  - `parseProgress` validates shape and drops individual bad entries; a structurally unreadable blob is reported as
 *    "recovered" (the raw text is kept under `qentor.learn.progress.unreadable` rather than silently destroyed).
 *  - `reconcileProgress` checks it against the real lesson catalog: unknown lessons/sections/options are dropped, and
 *    `isCorrect` is RECOMPUTED from the catalog's current answer key, never taken on trust from storage. A lesson whose content
 *    changed can therefore lose a stale attempt, but can never keep a stale verdict.
 *
 * Versioning: the version is an integer. Older versions upgrade through `MIGRATIONS` (a chain, one step per version); a version
 * this build does not know — newer, or with a missing step — is treated as unreadable, never guessed at.
 */
import type { Lesson } from '@/api'
import { browserStorage, type KeyValueStorage } from './browserStorage'
import { isFullConceptCheck, type ConceptCheckAttempt, type LessonProgress } from './lessonState'

export const PROGRESS_STORAGE_KEY = 'qentor.learn.progress.v1'
export const PROGRESS_UNREADABLE_KEY = 'qentor.learn.progress.unreadable'
const PROBE_KEY = 'qentor.learn.probe'
export const PROGRESS_SCHEMA_VERSION = 1

// Bounds on untrusted input: a tampered or runaway blob cannot make the app build unbounded state.
const MAX_LESSONS = 500
const MAX_SECTIONS_PER_LESSON = 200
const MAX_ID_LENGTH = 200
const MAX_ATTEMPTS = 1_000_000

export interface LearnerProgress {
  startedLessonIds: Set<string>
  lessonProgress: Record<string, LessonProgress>
}

export function emptyLearnerProgress(): LearnerProgress {
  return { startedLessonIds: new Set(), lessonProgress: {} }
}

/** `empty`: nothing was stored. `loaded`: stored data was read. `recovered`: something was stored but unreadable and was set aside. */
export type LoadStatus = 'empty' | 'loaded' | 'recovered'

export interface LoadResult {
  progress: LearnerProgress
  status: LoadStatus
}

/** The seam a backend-backed store would implement. */
export interface ProgressStore {
  load(): LoadResult
  /** Whether the write succeeded. A failure is not an error for the learner: progress still works for this page load. */
  save(progress: LearnerProgress): boolean
  /** Whether saving can work at all here (storage present and writable). */
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

function readIdList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (isId(item)) seen.add(item)
    if (seen.size >= max) break
  }
  return [...seen]
}

function readAttempt(value: unknown): ConceptCheckAttempt | null {
  if (!isRecord(value)) return null
  const { selectedOptionId, isCorrect, attemptCount } = value
  if (!isId(selectedOptionId) || typeof isCorrect !== 'boolean') return null
  if (typeof attemptCount !== 'number' || !Number.isInteger(attemptCount) || attemptCount < 1 || attemptCount > MAX_ATTEMPTS) return null
  return { selectedOptionId, isCorrect, attemptCount }
}

function readLessonProgress(value: unknown): LessonProgress | null {
  if (!isRecord(value)) return null
  const index = value.activeSectionIndex
  const activeSectionIndex = typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < MAX_SECTIONS_PER_LESSON ? index : 0
  const completedSectionIds = new Set(readIdList(value.completedSectionIds, MAX_SECTIONS_PER_LESSON))

  const conceptCheckAttempts: Record<string, ConceptCheckAttempt> = {}
  if (isRecord(value.conceptCheckAttempts)) {
    for (const [sectionId, rawAttempt] of Object.entries(value.conceptCheckAttempts).slice(0, MAX_SECTIONS_PER_LESSON)) {
      const attempt = isId(sectionId) ? readAttempt(rawAttempt) : null
      if (attempt) conceptCheckAttempts[sectionId] = attempt
    }
  }
  return { activeSectionIndex, completedSectionIds, conceptCheckAttempts }
}

/** Raw stored text -> progress, or `null` when the blob as a whole is unreadable. Bad individual entries are dropped, not fatal. */
export function parseProgress(
  raw: string,
  migrations: Record<number, Migration> = MIGRATIONS,
  currentVersion: number = PROGRESS_SCHEMA_VERSION, // a parameter only so the migration chain can be tested before a second version exists
): LearnerProgress | null {
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
    if (!step) return null // a gap in the chain: do not guess
    try {
      data = step(data)
    } catch {
      return null
    }
    version += 1
  }

  if (!isRecord(data.lessons)) return null

  const lessonProgress: Record<string, LessonProgress> = {}
  for (const [lessonId, rawLesson] of Object.entries(data.lessons).slice(0, MAX_LESSONS)) {
    const lesson = isId(lessonId) ? readLessonProgress(rawLesson) : null
    if (lesson) lessonProgress[lessonId] = lesson
  }
  return { startedLessonIds: new Set(readIdList(data.startedLessonIds, MAX_LESSONS)), lessonProgress }
}

/** Progress -> stored text. Sorted, so equal progress always serialises identically (cheap change detection, stable diffs). */
export function serializeProgress(progress: LearnerProgress): string {
  const lessons: Record<string, unknown> = {}
  for (const lessonId of Object.keys(progress.lessonProgress).sort()) {
    const lesson = progress.lessonProgress[lessonId]!
    const attempts: Record<string, ConceptCheckAttempt> = {}
    for (const sectionId of Object.keys(lesson.conceptCheckAttempts).sort()) {
      const { selectedOptionId, isCorrect, attemptCount } = lesson.conceptCheckAttempts[sectionId]!
      attempts[sectionId] = { selectedOptionId, isCorrect, attemptCount }
    }
    lessons[lessonId] = {
      activeSectionIndex: lesson.activeSectionIndex,
      completedSectionIds: [...lesson.completedSectionIds].sort(),
      conceptCheckAttempts: attempts,
    }
  }
  return JSON.stringify({
    version: PROGRESS_SCHEMA_VERSION,
    startedLessonIds: [...progress.startedLessonIds].sort(),
    lessons,
  })
}

/**
 * Check stored progress against the real catalog (call after the catalog has loaded). Pure; returns new objects.
 * - lessons/sections not in the catalog are dropped;
 * - an attempt is kept only for a concept check that still has a question AND still offers the option that was chosen;
 * - `isCorrect` is recomputed from the catalog's current `correctOptionId`;
 * - `activeSectionIndex` is clamped into the lesson;
 * - a lesson with recorded progress counts as started.
 */
export function reconcileProgress(lessons: readonly Lesson[], progress: LearnerProgress): LearnerProgress {
  const result = emptyLearnerProgress()
  for (const lesson of lessons) {
    const stored = progress.lessonProgress[lesson.id]
    if (stored) {
      const sectionIds = new Set(lesson.sections.map((section) => section.id))
      const completedSectionIds = new Set([...stored.completedSectionIds].filter((id) => sectionIds.has(id)))
      const conceptCheckAttempts: Record<string, ConceptCheckAttempt> = {}
      for (const section of lesson.sections) {
        const attempt = stored.conceptCheckAttempts[section.id]
        if (!attempt || !isFullConceptCheck(section)) continue
        if (!section.options.some((option) => option.id === attempt.selectedOptionId)) continue
        conceptCheckAttempts[section.id] = {
          selectedOptionId: attempt.selectedOptionId,
          isCorrect: attempt.selectedOptionId === section.correctOptionId,
          attemptCount: attempt.attemptCount,
        }
      }
      const last = Math.max(0, lesson.sections.length - 1)
      result.lessonProgress[lesson.id] = {
        activeSectionIndex: Math.min(stored.activeSectionIndex, last),
        completedSectionIds,
        conceptCheckAttempts,
      }
    }
    if (progress.startedLessonIds.has(lesson.id) || stored) result.startedLessonIds.add(lesson.id)
  }
  return result
}

/** The localStorage-backed store. `storage` is injectable so tests can use a fake (or one that throws). */
export function localStorageProgressStore(getStorage: () => KeyValueStorage | null = browserStorage): ProgressStore {
  return {
    load() {
      const storage = getStorage()
      if (!storage) return { progress: emptyLearnerProgress(), status: 'empty' }
      let raw: string | null
      try {
        raw = storage.getItem(PROGRESS_STORAGE_KEY)
      } catch {
        return { progress: emptyLearnerProgress(), status: 'empty' }
      }
      if (raw === null) return { progress: emptyLearnerProgress(), status: 'empty' }

      const progress = parseProgress(raw)
      if (progress) return { progress, status: 'loaded' }

      // Unreadable: set the raw text aside instead of letting the next save silently destroy it, then start clean.
      try {
        storage.setItem(PROGRESS_UNREADABLE_KEY, raw)
      } catch {
        /* nothing more to do; recovery still proceeds */
      }
      return { progress: emptyLearnerProgress(), status: 'recovered' }
    },

    save(progress) {
      const storage = getStorage()
      if (!storage) return false
      try {
        storage.setItem(PROGRESS_STORAGE_KEY, serializeProgress(progress))
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
