import { describe, expect, it, vi } from 'vitest'
import { applySphereKey, sphereKeyAction } from './sphereKeys'
import type { SphereController } from './types'

const controller = (): SphereController => ({ reset: vi.fn(), rotate: vi.fn(), zoom: vi.fn() })

describe('keyboard controls of a focused sphere', () => {
  it('the arrow keys turn it one step each way', () => {
    const c = controller()
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) applySphereKey(c, sphereKeyAction(key)!)
    expect((c.rotate as ReturnType<typeof vi.fn>).mock.calls).toEqual([[-1, 0], [1, 0], [0, -1], [0, 1]])
    expect(c.zoom).not.toHaveBeenCalled()
    expect(c.reset).not.toHaveBeenCalled()
  })

  it('+ (and =) zoom in, − zooms out', () => {
    const c = controller()
    for (const key of ['+', '=', '-']) applySphereKey(c, sphereKeyAction(key)!)
    expect((c.zoom as ReturnType<typeof vi.fn>).mock.calls).toEqual([[-1], [-1], [1]])
  })

  it('0 and Home reset the view', () => {
    const c = controller()
    applySphereKey(c, sphereKeyAction('0')!)
    applySphereKey(c, sphereKeyAction('Home')!)
    expect(c.reset).toHaveBeenCalledTimes(2)
  })

  it('every other key is not ours (Tab, Enter, letters, Escape stay with the page)', () => {
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a', 'PageUp', 'Delete', 'Backspace']) expect(sphereKeyAction(key), key).toBeNull()
  })
})
