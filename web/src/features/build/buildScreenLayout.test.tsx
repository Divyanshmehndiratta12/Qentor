/**
 * The Lab gives a register of four or more qubits (phase estimation, error correction) more of the column, so its wires are not all
 * behind a scrollbar; three or fewer keep the layout they had. A class contract: jsdom has no layout, and the real-browser journey
 * looks at the result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { emptyCircuit } from '@/circuit/types'

vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import { BuildScreen } from './BuildScreen'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
beforeEach(() => useBuildStore.setState(INITIAL, true))
afterEach(cleanup)

describe('the Lab column for a larger register', () => {
  for (const [qubits, expected, other] of [[1, 'flex-[3]', 'flex-[5]'], [3, 'flex-[3]', 'flex-[5]'], [4, 'flex-[5]', 'flex-[3]'], [5, 'flex-[5]', 'flex-[3]']] as const) {
    it(`${qubits} qubit${qubits === 1 ? '' : 's'}: the canvas region is ${expected}`, () => {
      useBuildStore.getState().loadCircuit(emptyCircuit(qubits, 0))
      render(<BuildScreen />)
      const region = screen.getByTestId('canvas-region')
      expect(region.className).toContain(expected)
      expect(region.className).not.toContain(other)
    })
  }

  it('follows the register as qubits are added and removed', () => {
    useBuildStore.getState().loadCircuit(emptyCircuit(3, 0))
    render(<BuildScreen />)
    expect(screen.getByTestId('canvas-region').className).toContain('flex-[3]')
    act(() => useBuildStore.getState().loadCircuit(emptyCircuit(5, 0)))
    expect(screen.getByTestId('canvas-region').className).toContain('flex-[5]')
    act(() => useBuildStore.getState().loadCircuit(emptyCircuit(2, 0)))
    expect(screen.getByTestId('canvas-region').className).toContain('flex-[3]')
  })

  it('keeps the palette under the canvas in either case, never over it', () => {
    useBuildStore.getState().loadCircuit(emptyCircuit(5, 0))
    render(<BuildScreen />)
    const region = screen.getByTestId('canvas-region')
    const palette = screen.getByRole('toolbar', { name: 'Gate palette' })
    expect(region.contains(palette)).toBe(true)
    expect(palette.closest('[class*="absolute"]')).toBeNull()
  })
})
