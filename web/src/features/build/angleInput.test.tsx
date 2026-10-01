/**
 * The palette's angle box reads angles the way a textbook writes them (`pi/4`, `-pi/2`), through the same grammar as the server's QASM
 * reader. The QFT and QPE challenges need exactly these: a controlled phase of an eighth of a turn, and the negated angles of an
 * inverse QFT. The store only ever receives a number; text that is not an angle changes nothing and says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GatePalette } from './GatePalette'
import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const store = () => useBuildStore.getState()
const angleBox = () => screen.getByLabelText(/angle \(rad\)/) as HTMLInputElement

beforeEach(() => {
  useBuildStore.setState(INITIAL, true)
  render(<GatePalette />)
  fireEvent.click(screen.getByRole('button', { name: 'CP' }))
})
afterEach(cleanup)

const place = () => {
  act(() => store().onWireClick(0))
  act(() => store().onWireClick(1))
}

describe('the angle box', () => {
  it('starts at a quarter of a turn and says what number that is', () => {
    expect(angleBox().value).toBe('pi/2')
    expect(store().pendingAngle).toBe(Math.PI / 2)
    expect(screen.getByText(`= ${Math.PI / 2} rad`)).toBeInTheDocument()
  })

  it('reads pi expressions, and a CP placed afterwards carries exactly that double', () => {
    for (const [text, value] of [['pi/4', Math.PI / 4], ['-pi/2', -Math.PI / 2], ['π/8', Math.PI / 8], ['3*pi/4', (3 * Math.PI) / 4], ['0.5', 0.5], ['pi', Math.PI]] as const) {
      fireEvent.change(angleBox(), { target: { value: text } })
      expect(store().pendingAngle).toBe(value)
      place()
      expect(store().circuit.ops.at(-1)).toMatchObject({ gate: 'cp', controls: [0], targets: [1], params: [value] })
    }
  })

  it('the common-angle buttons set the box and the store', () => {
    const group = screen.getByRole('group', { name: 'Common angles' })
    for (const [name, value] of [['pi/4', Math.PI / 4], ['-pi/4', -Math.PI / 4], ['-pi/2', -Math.PI / 2], ['pi', Math.PI], ['pi/2', Math.PI / 2]] as const) {
      fireEvent.click(within(group).getByRole('button', { name: `Set the angle to ${name}` }))
      expect(angleBox().value).toBe(name)
      expect(store().pendingAngle).toBe(value)
    }
  })

  it('text that is not an angle leaves the angle as it was, marks the box invalid and says what to try', () => {
    fireEvent.change(angleBox(), { target: { value: 'pi/4' } })
    for (const bad of ['tau', 'pi/', '', '1/0', 'alert(1)', '2**3']) {
      fireEvent.change(angleBox(), { target: { value: bad } })
      expect(store().pendingAngle, JSON.stringify(bad)).toBe(Math.PI / 4)
      expect(angleBox()).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('alert')).toHaveTextContent('not an angle')
    }
    fireEvent.change(angleBox(), { target: { value: 'pi/8' } })
    expect(angleBox()).toHaveAttribute('aria-invalid', 'false')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(store().pendingAngle).toBe(Math.PI / 8)
  })

  it('a placed gate is not changed by a later bad entry', () => {
    fireEvent.change(angleBox(), { target: { value: 'pi/4' } })
    place()
    fireEvent.change(angleBox(), { target: { value: 'nonsense' } })
    expect(store().circuit.ops[0]?.params).toEqual([Math.PI / 4])
  })

  it('is shown for rotations too, and not for gates without an angle', () => {
    fireEvent.click(screen.getByRole('button', { name: 'CP' })) // deselect
    expect(screen.queryByLabelText(/angle \(rad\)/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'RZ' }))
    expect(angleBox()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'H' }))
    expect(screen.queryByLabelText(/angle \(rad\)/)).toBeNull()
  })

  it('is a text field a screen reader can name, with its hint tied to it', () => {
    expect(angleBox().type).toBe('text')
    expect(angleBox().getAttribute('aria-describedby')).toBe('angle-hint')
    expect(document.getElementById('angle-hint')).not.toBeNull()
  })

  it('the QASM text the circuit prints for a placed pi/4 reads back to the same angle', () => {
    fireEvent.change(angleBox(), { target: { value: 'pi/4' } })
    place()
    const text = store().qasmText
    expect(text).toContain('cp(0.7853981633974483) q[0], q[1];')
    const result = store().applyQasmEdit(text.replace('cp(0.7853981633974483)', 'cp(pi/4)'))
    expect(result.ok).toBe(true)
    expect(store().circuit.ops[0]?.params).toEqual([Math.PI / 4])
  })
})
