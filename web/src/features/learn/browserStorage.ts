/**
 * The one guarded way Learn code reaches `localStorage`. Reading the `localStorage` global can itself throw (blocked site data,
 * some private modes, sandboxed frames), so it is accessed in one place, inside try/catch. Returns `null` when unavailable —
 * callers then simply run session-only.
 */

/** The subset of `Storage` the Learn persistence modules use — lets tests pass a fake. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
