/**
 * Which URL path shows which screen. There is no router dependency: the screen is app state, and this module only keeps the
 * address bar in step with it, so a direct visit to /learn, /challenges or /progress lands on that screen and the browser's
 * Back/Forward work. The server answers every page path with the same app shell (`qentor.api.static_site`), so any of these can
 * be opened, bookmarked or reloaded. `/challenges/<id>` opens that challenge.
 */
import type { Screen } from './TopBar'

const PATHS: Record<Screen, string> = { lab: '/', learn: '/learn', challenges: '/challenges', progress: '/progress', classroom: '/classroom' }

function normalise(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}

/** The screen a path shows. Unknown paths show the Lab (the app's home). A trailing slash is ignored. */
export function screenFromPath(pathname: string): Screen {
  const path = normalise(pathname)
  if (path.startsWith(`${PATHS.challenges}/`)) return 'challenges'
  const match = (Object.entries(PATHS) as Array<[Screen, string]>).find(([, p]) => p === path)
  return match ? match[0] : 'lab'
}

export function pathForScreen(screen: Screen): string {
  return PATHS[screen]
}

/** The challenge id in `/challenges/<id>`, or `null` for any other path (or an id with unexpected characters). */
export function challengeIdFromPath(pathname: string): string | null {
  const path = normalise(pathname)
  const prefix = `${PATHS.challenges}/`
  if (!path.startsWith(prefix)) return null
  const id = path.slice(prefix.length)
  return /^[a-z0-9-]{1,80}$/.test(id) ? id : null
}

export function pathForChallenge(challengeId: string | null): string {
  return challengeId ? `${PATHS.challenges}/${challengeId}` : PATHS.challenges
}
