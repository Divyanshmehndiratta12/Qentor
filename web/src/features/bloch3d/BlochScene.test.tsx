/**
 * The 3D scene of one Bloch sphere, run for real (three.js objects, react-three-fiber's reconciler and its frame loop) through
 * `@react-three/test-renderer`, which needs no GPU. What these tests pin: the sphere, its guides, its axes and its six pole labels
 * exist; the backend's vector is where the arrow and its tip are drawn (the supplied numbers, only re-ordered by the fixed axis
 * permutation); a changed vector is EASED toward and lands on the new backend point exactly (never past it, never near it), and
 * jumps at once when reduced motion is asked for; a vector the backend gave outside the unit sphere draws no arrow; the arrowhead
 * is sized by the backend's own length; and the parent can reset, rotate and zoom the camera.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Euler, PerspectiveCamera, Texture } from 'three'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import type { ReactNode } from 'react'
import { CAMERA_FOV, CAMERA_START, MAX_DISTANCE, MIN_DISTANCE, toScene } from './sceneConstants'
import type { SphereController } from './types'

// jsdom has no 2D canvas, so the label texture is stood in for by a plain texture: the six labels are then really created.
vi.mock('./labelTexture', () => ({
  makeLabelTexture: () => new Texture(),
  LABEL_SCALE: [0.15, 0.075, 1],
}))

import { BlochScene } from './BlochScene'

// react-three-fiber's test renderer drives React through act(); tell React this environment supports it.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function camera() {
  const c = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 60)
  c.position.set(CAMERA_START[0], CAMERA_START[1], CAMERA_START[2])
  c.lookAt(0, 0, 0)
  return c
}

function scene(props: Partial<React.ComponentProps<typeof BlochScene>> = {}, cam = camera(), controllers = { current: new Map<string, SphereController>() }): { node: ReactNode; cam: PerspectiveCamera; controllers: typeof controllers } {
  const node = (
    <BlochScene
      id="q0"
      camera={cam}
      vector={{ x: 0.6, y: -0.3, z: 0.5 }}
      headScale={1}
      drawable
      autoRotate={false}
      reducedMotion={false}
      domElement={document.createElement('div')}
      controllers={controllers}
      {...props}
    />
  )
  return { node, cam, controllers }
}

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>
const find = (r: Renderer, name: string) => r.scene.findByProps({ name }).instance
// by the three.js object's own name: a drei <Line> is a component AND the object it makes, which both carry the name prop
const findAll = (r: Renderer, name: string) => r.scene.findAll((n) => n.instance.name === name)
const pos = (r: Renderer, name: string): [number, number, number] => {
  const p = find(r, name).position
  return [p.x, p.y, p.z]
}

let live: Renderer | null = null
afterEach(async () => {
  await live?.unmount()
  live = null
})
async function mount(props?: Partial<React.ComponentProps<typeof BlochScene>>, cam?: PerspectiveCamera, controllers?: { current: Map<string, SphereController> }) {
  const { node } = scene(props, cam, controllers)
  live = await ReactThreeTestRenderer.create(node)
  return live
}

describe('what is in the scene', () => {
  it('has the sphere, its equator, three axes and the six standard pole labels', async () => {
    const r = await mount()
    expect(findAll(r, 'bloch-sphere')).toHaveLength(1)
    expect(findAll(r, 'equator')).toHaveLength(1)
    // (a drei <Line> is a wrapper and the line object it makes, and both carry the name, so "at least one", not exactly one)
    for (const axis of ['axis-x', 'axis-y', 'axis-z']) expect(findAll(r, axis).length, axis).toBeGreaterThanOrEqual(1)
    const poles = ['|0⟩', '|1⟩', '|+⟩', '|−⟩', '|+i⟩', '|−i⟩']
    for (const kets of poles) expect(findAll(r, `pole-${kets}`), kets).toHaveLength(1)
  })

  it('puts each pole label at its end of the right axis (+z up, +x and −x on the x axis, ±y on the depth axis)', async () => {
    const r = await mount()
    const at = (n: string) => pos(r, `pole-${n}`)
    expect(at('|0⟩')[1]).toBeGreaterThan(1) // +z is the scene's up
    expect(at('|1⟩')[1]).toBeLessThan(-1)
    expect(at('|+⟩')[0]).toBeGreaterThan(1)
    expect(at('|−⟩')[0]).toBeLessThan(-1)
    expect(Math.abs(at('|+i⟩')[2])).toBeGreaterThan(1) // Bloch y is the scene's depth axis
    expect(at('|+i⟩')[2]).toBe(-at('|−i⟩')[2])
  })

  it('draws labels at a constant on-screen size (no perspective shrinking)', async () => {
    const r = await mount()
    const sprite = find(r, 'pole-|0⟩') as unknown as { material: { sizeAttenuation: boolean } }
    expect(sprite.material.sizeAttenuation).toBe(false)
  })
})

describe('the backend vector, drawn exactly where the backend put it', () => {
  it('places the tip, the arrowhead and the foot at the supplied (x, y, z) through the fixed axis permutation, nothing else', async () => {
    const r = await mount({ vector: { x: 0.6, y: -0.3, z: 0.5 } })
    const expected = toScene(0.6, -0.3, 0.5)
    expect(pos(r, 'state-tip')).toEqual(expected)
    expect(pos(r, 'state-head')).toEqual(expected)
    expect(pos(r, 'state-foot')).toEqual([expected[0], 0, expected[2]]) // straight down onto the equatorial plane
    expect(expected).toEqual([0.6, 0.5, 0.3]) // Bloch (x, y, z) -> scene (x, z, -y)
  })

  it('draws the exact numbers it is given even if they are not a valid state (it never normalises or clamps)', async () => {
    const r = await mount({ vector: { x: 0.123456789012345, y: 0.2, z: 0.3 } })
    expect(pos(r, 'state-tip')).toEqual([0.123456789012345, 0.3, -0.2])
  })

  it('sizes the arrowhead by the backend’s own length, so a zero-length vector (a maximally mixed qubit) has no head', async () => {
    const mixed = await mount({ vector: { x: 0, y: 0, z: 0 }, headScale: 0 })
    const head = find(mixed, 'state-head')
    expect([head.scale.x, head.scale.y, head.scale.z]).toEqual([0, 0, 0])
    expect(pos(mixed, 'state-tip')).toEqual(toScene(0, 0, 0)) // at the centre: the backend's vector has no direction
    await mixed.unmount()
    live = null

    const half = await mount({ vector: { x: 0, y: 0, z: 0.5 }, headScale: 0.5 })
    const head2 = find(half, 'state-head')
    expect(head2.scale.x).toBe(0.5)
  })

  it('without a backend length (a path that gives none) the head is full size', async () => {
    const r = await mount({ headScale: null })
    expect(find(r, 'state-head').scale.x).toBe(1)
  })

  it('points the arrowhead away from the centre: after a frame it faces the origin, its apex (-z) outward', async () => {
    const r = await mount({ vector: { x: 0.8, y: 0, z: 0 } })
    await r.advanceFrames(2, 0.016)
    const head = find(r, 'state-head')
    // an object's +z axis is turned to face the origin; the cone's apex is on -z, so it points away along +x
    const facing = head.getWorldDirection(new (head.position.constructor as new () => typeof head.position)())
    expect(facing.x).toBeLessThan(-0.99)
    expect(Math.abs(facing.y) + Math.abs(facing.z)).toBeLessThan(0.01)
  })

  it('draws no arrow at all for a vector the backend gave outside the unit sphere (it is shown as numbers elsewhere)', async () => {
    const r = await mount({ vector: { x: 1.5, y: 0, z: 0 }, drawable: false })
    for (const n of ['state-tip', 'state-head', 'state-shaft', 'state-foot']) expect(findAll(r, n), n).toHaveLength(0)
    expect(findAll(r, 'bloch-sphere')).toHaveLength(1) // the sphere itself is still there
  })
})

describe('moving between backend states: eased on screen, exact at rest', () => {
  it('eases toward a new backend vector (visibly in between), then lands on it exactly', async () => {
    const r = await mount({ vector: { x: 0, y: 0, z: 1 } })
    await r.advanceFrames(1, 0.016)
    expect(pos(r, 'state-tip')).toEqual(toScene(0, 0, 1))

    await r.update(scene({ vector: { x: 1, y: 0, z: 0 } }).node)
    await r.advanceFrames(1, 0.016)
    const mid = pos(r, 'state-tip')
    const from = toScene(0, 0, 1)
    const to = toScene(1, 0, 0)
    expect(mid).not.toEqual(from) // it has started moving
    expect(mid).not.toEqual(to) // and has not arrived: this is a screen position, not a state
    expect(mid[0]).toBeGreaterThan(from[0])
    expect(mid[0]).toBeLessThan(to[0])

    await r.advanceFrames(240, 0.016)
    expect(pos(r, 'state-tip')).toEqual(to) // exactly the backend's point, to the last bit
    expect(pos(r, 'state-head')).toEqual(to)
  })

  it('with reduced motion it jumps to the new backend vector in one frame', async () => {
    const r = await mount({ vector: { x: 0, y: 0, z: 1 }, reducedMotion: true })
    await r.update(scene({ vector: { x: 0, y: 1, z: 0 }, reducedMotion: true }).node)
    await r.advanceFrames(1, 0.016)
    expect(pos(r, 'state-tip')).toEqual(toScene(0, 1, 0))
  })

  it('never goes through the origin or shortens the path: the drawn point stays on the straight line between the two backend points', async () => {
    const r = await mount({ vector: { x: 1, y: 0, z: 0 } })
    await r.update(scene({ vector: { x: -1, y: 0, z: 0 } }).node)
    const xs: number[] = []
    for (let i = 0; i < 60; i++) {
      await r.advanceFrames(1, 0.016)
      xs.push(pos(r, 'state-tip')[0])
    }
    expect(xs.every((x, i) => i === 0 || x <= xs[i - 1]!)).toBe(true) // monotone toward -1
    expect(xs.at(-1)).toBe(-1)
  })
})

describe('driving the camera from outside (toolbar buttons and keyboard shortcuts)', () => {
  it('registers a controller for the sphere under its id, and removes it on unmount', async () => {
    const controllers = { current: new Map<string, SphereController>() }
    const r = await mount({}, undefined, controllers)
    expect([...controllers.current.keys()]).toEqual(['q0'])
    await r.unmount()
    live = null
    expect(controllers.current.size).toBe(0)
  })

  it('rotate turns the camera round the sphere, zoom moves it in and out within limits, reset puts it back', async () => {
    const cam = camera()
    const controllers = { current: new Map<string, SphereController>() }
    await mount({}, cam, controllers)
    const ctl = controllers.current.get('q0')!
    const start = cam.position.clone()
    const distance = () => cam.position.length()

    ctl.rotate(1, 0)
    expect(cam.position.distanceTo(start)).toBeGreaterThan(0.1)
    expect(distance()).toBeCloseTo(start.length(), 6) // a turn, not a zoom

    ctl.reset()
    expect(cam.position.distanceTo(start)).toBeLessThan(1e-9)

    ctl.zoom(-1)
    expect(distance()).toBeLessThan(start.length())
    ctl.reset()
    ctl.zoom(1)
    expect(distance()).toBeGreaterThan(start.length())
  })

  it('cannot zoom the sphere out of reach: the distance stays between the limits however far it is pushed', async () => {
    const cam = camera()
    const controllers = { current: new Map<string, SphereController>() }
    await mount({}, cam, controllers)
    const ctl = controllers.current.get('q0')!
    for (let i = 0; i < 80; i++) ctl.zoom(-1)
    expect(cam.position.length()).toBeGreaterThanOrEqual(MIN_DISTANCE - 1e-6)
    for (let i = 0; i < 200; i++) ctl.zoom(1)
    expect(cam.position.length()).toBeLessThanOrEqual(MAX_DISTANCE + 1e-6)
  })

  it('the camera always looks at the sphere (the target is never panned away)', async () => {
    const cam = camera()
    const controllers = { current: new Map<string, SphereController>() }
    await mount({}, cam, controllers)
    const ctl = controllers.current.get('q0')!
    ctl.rotate(1, 1)
    ctl.zoom(-1)
    const looking = cam.getWorldDirection(cam.position.clone())
    const toOrigin = cam.position.clone().negate().normalize()
    expect(looking.distanceTo(toOrigin)).toBeLessThan(1e-6)
  })
})

describe('the starting view', () => {
  it('is the same view the flat projection uses: +x toward the viewer’s left, +y to the right, +z up', () => {
    const cam = camera()
    cam.updateMatrixWorld()
    // project the three axis tips (scene coordinates) into the camera's screen space
    const screen = (x: number, y: number, z: number) => {
      const [sx, sy, sz] = toScene(x, y, z)
      const v = cam.worldToLocal(cam.position.clone().set(sx, sy, sz))
      return { right: v.x, up: v.y }
    }
    expect(screen(1, 0, 0).right).toBeLessThan(0) // +x leans left
    expect(screen(0, 1, 0).right).toBeGreaterThan(0) // +y leans right
    expect(screen(0, 0, 1).up).toBeGreaterThan(screen(0, 0, -1).up) // +z is up
  })

  it('the axis permutation is a proper rotation (it keeps the Bloch frame right-handed)', () => {
    const e = new Euler()
    expect(e).toBeDefined()
    // (x, y, z) -> (x, z, -y): det of [[1,0,0],[0,0,1],[0,-1,0]] = +1
    const [a, b, c] = [toScene(1, 0, 0), toScene(0, 1, 0), toScene(0, 0, 1)]
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
    expect(det).toBe(1)
  })
})
