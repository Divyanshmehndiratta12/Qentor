/**
 * The Guide's roaming schedule — deliberately dull and predictable.
 *
 * The character drifts between a handful of fixed anchor points along a short
 * horizontal slot (an empty spacer in the top bar, so there is nothing to
 * overlap). It moves to the next anchor once every `ROAM_INTERVAL_MS`; each
 * move is a slow ~4 s slide (see `.qentor-guide-roam` in `index.css`), so it
 * spends most of the interval resting. The sequence is a fixed list, not
 * random: the same every time, easy to test, never a surprise position.
 *
 * `roam: false` (panel open, reduced motion, small screen) parks it at the
 * resting anchor. `paused: true` (the learner is hovering or focused on it)
 * stops the schedule where it is without moving it, so it is never a moving
 * target under the pointer. Nothing advances while the tab is hidden.
 */
import { useEffect, useState } from 'react'

/** Positions along the slot, as a percentage of the free width. */
export const ROAM_ANCHORS = [30, 62, 44, 78, 22, 56] as const
export const REST_ANCHOR = 50
export const ROAM_INTERVAL_MS = 10_000

export function useRoaming({ roam, paused }: { roam: boolean; paused: boolean }): number {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (!roam || paused) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setIndex((i) => (i + 1) % ROAM_ANCHORS.length)
    }, ROAM_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [roam, paused])

  return roam ? ROAM_ANCHORS[index]! : REST_ANCHOR
}
