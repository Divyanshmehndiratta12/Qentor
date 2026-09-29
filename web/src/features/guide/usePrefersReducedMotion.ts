/**
 * Tracks the user's `prefers-reduced-motion: reduce` setting, live (it updates
 * if they change it while the app is open). Guards for environments with no
 * `matchMedia` (jsdom, some test setups): there, motion is treated as allowed.
 * The Guide uses this to switch off roaming and idle animation in JS; the same
 * media query also disables the CSS animations in `index.css`, so the two
 * layers agree.
 */
import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function readPreference(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readPreference)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(QUERY)
    const onChange = () => setReduced(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}
