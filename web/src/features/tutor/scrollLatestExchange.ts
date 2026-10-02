/**
 * Where the Tutor's conversation should rest after a new turn arrives.
 *
 * The Tutor sits in a short footer, so a long answer (a reasoning card with a table) is mostly below the fold of its own scroll box. Leaving
 * the box where it was means the learner sees the old conversation and has to hunt for the answer; scrolling to the end shows only the END of
 * the answer. The useful place is the START of the newest exchange: the question the learner just asked, with the answer's first lines right
 * under it. This puts the newest question (or, with no question, the newest turn) at the top of the scroll box and nothing else.
 *
 * It only sets `scrollTop` of the box it is given. It reads layout, never a result, and never touches the page's own scroll.
 */
export interface TurnLike {
  role: string
}

/** Index of the turn to bring to the top: the newest learner question, otherwise the newest turn; -1 when there are none. */
export function exchangeStartIndex(turns: readonly TurnLike[]): number {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.role === 'learner') return i
  return turns.length - 1
}

/** Bring the newest exchange's first turn to the top of `scroller`. `log` is the element whose children are the turns, in order. */
export function scrollLatestExchangeIntoView(scroller: HTMLElement, log: HTMLElement, turns: readonly TurnLike[], gap = 8): boolean {
  const index = exchangeStartIndex(turns)
  const target = index >= 0 ? (log.children[index] as HTMLElement | undefined) : undefined
  if (!target) return false
  const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  scroller.scrollTop = Math.max(0, offset - gap)
  return true
}
