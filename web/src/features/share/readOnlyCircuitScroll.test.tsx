/**
 * The shared page's circuit diagram scrolls sideways when it is wider than the screen (a phone). A scroll box a keyboard cannot reach is a
 * WCAG 2.1.1 failure and axe's `scrollable-region-focusable`, found at 320 px in real Chrome: the box must be a focusable, named region.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { ReadOnlyCircuit } from './ReadOnlyCircuit'

afterEach(cleanup)

const circuit = (ops: Circuit['ops']): Circuit => ({ ...emptyCircuit(2, 0), ops })
const op = (gate: Circuit['ops'][number]['gate'], targets: number[], controls: number[] = []) => ({ gate, targets, controls, params: [], clbits: [] })

describe('the read-only circuit diagram', () => {
  it('is a named, keyboard-focusable region, so its sideways scrolling is reachable without a mouse', () => {
    render(<ReadOnlyCircuit circuit={circuit([op('h', [0]), op('cx', [1], [0])])} />)
    const region = screen.getByRole('region', { name: /circuit diagram, scrolls sideways/i })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region.className).toMatch(/overflow-x-auto/)
    expect(region.className).toMatch(/focus-visible:outline/)
  })

  it('still describes the circuit in words for a screen reader (the image keeps its own text alternative)', () => {
    render(<ReadOnlyCircuit circuit={circuit([op('h', [0]), op('cx', [1], [0])])} />)
    expect(screen.getByRole('img', { name: /A circuit on 2 qubits with 2 operations/ })).toBeInTheDocument()
  })

  it('an empty circuit is the same region with an honest description', () => {
    render(<ReadOnlyCircuit circuit={circuit([])} />)
    expect(screen.getByRole('region', { name: /circuit diagram/i })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('img', { name: /An empty circuit on 2 qubits/ })).toBeInTheDocument()
  })
})
