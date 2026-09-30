/**
 * Which URL path shows which screen. There is no router dependency: the screen is app state, and this module only keeps the
 * address bar in step with it, so a direct visit to /learn or /progress lands on that screen and the browser's Back/Forward
 * work. The server answers every page path with the same app shell (`qentor.api.static_site`), so any of these can be
 * opened, bookmarked or reloaded.
 */
import type { Screen } from './TopBar'

const PATHS: Record<Screen, string> = { lab: '/', learn: '/learn', progress: '/progress' }

/** The screen a path shows. Unknown paths show the Lab (the app's home). A trailing slash is ignored. */
export function screenFromPath(pathname: string): Screen {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const match = (Object.entries(PATHS) as Array<[Screen, string]>).find(([, p]) => p === path)
  return match ? match[0] : 'lab'
}

export function pathForScreen(screen: Screen): string {
  return PATHS[screen]
}
