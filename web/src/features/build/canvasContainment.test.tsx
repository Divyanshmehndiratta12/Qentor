/**
 * A long circuit must never widen the page. The canvas scrolls inside its own box (`overflow-auto`); an absolutely positioned
 * descendant whose containing block is OUTSIDE that box is not clipped by it, keeps its static position far to the right in a long
 * circuit, and stretches the whole document (found in real Chrome: a 29-operation circuit made the page 1481 px wide on every screen).
 * jsdom does no layout, so this pins the structural rule that prevents it: every absolutely positioned or screen-reader-only element in
 * the canvas has a positioned ancestor at or below the scroller.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { emptyCircuit, type GateOp } from '@/circuit/types'
import { CircuitCanvas } from './CircuitCanvas'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const op = (gate: GateOp['gate'], targets: number[], controls: number[] = []): GateOp => ({ gate, targets, controls, params: [], clbits: [] })
const POSITIONED = ['relative', 'absolute', 'fixed', 'sticky']

afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL, true)
})

function mountLong(columns: number) {
  const ops: GateOp[] = []
  for (let i = 0; i < columns; i++) ops.push(i % 2 ? op('cx', [1], [0]) : op('h', [0]))
  act(() => {
    useBuildStore.getState().loadCircuit({ ...emptyCircuit(2, 0), ops })
    useBuildStore.setState({ past: [], future: [] })
  })
  return render(<CircuitCanvas />)
}

describe('the canvas keeps its positioned descendants inside its own scroll box', () => {
  it('the scroller is itself positioned, so it is the containing block of anything absolute below it', () => {
    const { container } = mountLong(29)
    const scroller = container.querySelector('.circuit-grid-bg')!
    expect(scroller).toBeTruthy()
    expect(scroller.classList.contains('overflow-auto')).toBe(true)
    expect(POSITIONED.some((c) => scroller.classList.contains(c))).toBe(true)
  })

  it('every absolute or screen-reader-only element has a positioned ancestor at or below the scroller (a 29-operation circuit)', () => {
    const { container } = mountLong(29)
    const scroller = container.querySelector('.circuit-grid-bg')!
    const risky = [...scroller.querySelectorAll('.sr-only, .absolute')]
    expect(risky.length).toBeGreaterThan(0) // the insertion markers' sr-only text and the wires: the rule is not vacuous
    for (const el of risky) {
      let anchored = false
      for (let p: Element | null = el.parentElement; p; p = p.parentElement) {
        if (POSITIONED.some((c) => p!.classList.contains(c))) anchored = true
        if (p === scroller) break
      }
      expect(anchored, `${el.tagName}.${el.className} is not anchored inside the scroller`).toBe(true)
    }
  })
})
