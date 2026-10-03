/**
 * The 3D part of the qubit state view: ONE WebGL canvas that draws a separate, independently rotatable Bloch sphere in each
 * qubit's tile. Loaded on demand (`QubitStateView` imports this module lazily), so three.js is not part of the app's first
 * download.
 *
 * One canvas for the whole register, not one per qubit: a browser keeps only a handful of WebGL contexts alive, and the
 * backend allows up to 16 qubits. Each sphere has its own scene and its own camera, and is drawn into its own tile of the
 * page (a scissored viewport); each sphere's orbit controls listen on that tile only, so dragging one never turns another.
 * (drei's `View` does the same job but through a module-wide tunnel, which breaks when two grids are on one page, as the Lab's
 * result view and trace view are, so the small amount of viewport code lives here.)
 *
 * The canvas ignores the pointer (`pointer-events: none`): drags, wheel and touch go to the tile underneath, which also holds
 * the keyboard shortcuts. Everything the learner reads (the numbers, provenance) is ordinary page text in the card around the
 * tile, not part of the canvas.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Canvas, createPortal, useFrame, useThree } from '@react-three/fiber'
import { PerspectiveCamera, Scene } from 'three'
import { BlochScene } from './BlochScene'
import { CAMERA_FOV, CAMERA_START } from './sceneConstants'
import { applySphereKey, sphereKeyAction } from './sphereKeys'
import type { SphereController, SphereGridProps, SphereTile } from './types'

interface Entry {
  scene: Scene
  camera: PerspectiveCamera
}

export default function SphereGrid({ tiles, helpId, autoRotate, reducedMotion, controllers, onReady }: SphereGridProps) {
  const [elements, setElements] = useState<Record<string, HTMLElement | null>>({})
  const attach = useCallback((id: string, el: HTMLElement | null) => {
    setElements((prev) => (prev[id] === el ? prev : { ...prev, [id]: el }))
  }, [])

  return (
    <div className="relative" data-testid="sphere-grid">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2" data-testid="qubit3d-card-grid">
        {tiles.map((tile) => (
          <TileSlot key={tile.id} tile={tile} helpId={helpId} controllers={controllers} attach={attach} />
        ))}
      </div>
      {/* The one canvas. It covers the grid, draws only inside the tiles, and lets every pointer event through. */}
      <Canvas
        flat
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        onCreated={() => onReady?.()}
      >
        <Viewports tiles={tiles} elements={elements} autoRotate={autoRotate} reducedMotion={reducedMotion} controllers={controllers} />
      </Canvas>
    </div>
  )
}

/** One tile of the page: the card around it, and inside it the focusable box that the sphere is drawn into and rotated through. */
function TileSlot({
  tile,
  helpId,
  controllers,
  attach,
}: {
  tile: SphereTile
  helpId: string
  controllers: { current: Map<string, SphereController> }
  attach: (id: string, el: HTMLElement | null) => void
}) {
  const ref = useCallback((el: HTMLDivElement | null) => attach(tile.id, el), [attach, tile.id])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return // browser and app shortcuts are not ours
    const controller = controllers.current.get(tile.id)
    const action = sphereKeyAction(event.key)
    if (!controller || !action) return
    event.preventDefault()
    applySphereKey(controller, action)
  }

  return (
    <>
      {tile.renderCard(
        <div
          ref={ref}
          role="group"
          tabIndex={0}
          aria-label={tile.label}
          aria-describedby={helpId}
          data-testid={`sphere-3d-${tile.id}`}
          onKeyDown={onKeyDown}
          className="mx-auto aspect-square w-full max-w-[15rem] cursor-grab touch-none rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow active:cursor-grabbing"
        />,
      )}
    </>
  )
}

/**
 * Inside the canvas: one virtual scene and camera per tile, each drawn into the rectangle of its tile on the page. Taking a
 * positive-priority frame callback makes this the renderer (react-three-fiber then skips its own single-camera render).
 */
function Viewports({
  tiles,
  elements,
  autoRotate,
  reducedMotion,
  controllers,
}: {
  tiles: SphereTile[]
  elements: Record<string, HTMLElement | null>
  autoRotate: boolean
  reducedMotion: boolean
  controllers: { current: Map<string, SphereController> }
}) {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const entries = useMemo(() => new Map<string, Entry>(), [])

  const entryFor = (id: string): Entry => {
    let entry = entries.get(id)
    if (!entry) {
      const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 60)
      camera.position.set(CAMERA_START[0], CAMERA_START[1], CAMERA_START[2])
      camera.lookAt(0, 0, 0)
      entry = { scene: new Scene(), camera }
      entries.set(id, entry)
    }
    return entry
  }

  // Forget tiles that are gone.
  useEffect(() => {
    const live = new Set(tiles.map((t) => t.id))
    for (const id of [...entries.keys()]) if (!live.has(id)) entries.delete(id)
    invalidate()
  }, [tiles, entries, invalidate])

  // The page moved or resized under the canvas: draw again.
  useEffect(() => {
    const canvas = gl.domElement
    const target = canvas.parentElement?.parentElement ?? canvas
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => invalidate()) : null
    observer?.observe(target)
    const redraw = () => invalidate()
    window.addEventListener('resize', redraw)
    const first = requestAnimationFrame(redraw)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', redraw)
      cancelAnimationFrame(first)
    }
  }, [gl, invalidate])

  useFrame(() => {
    const canvasRect = gl.domElement.getBoundingClientRect()
    gl.setScissorTest(false)
    gl.autoClear = false
    gl.setViewport(0, 0, canvasRect.width, canvasRect.height)
    gl.clear(true, true)
    for (const tile of tiles) {
      const el = elements[tile.id]
      const entry = entries.get(tile.id)
      if (!el || !entry) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      if (r.bottom < canvasRect.top || r.top > canvasRect.bottom) continue
      const x = r.left - canvasRect.left
      const y = canvasRect.bottom - r.bottom
      const aspect = r.width / r.height
      if (entry.camera.aspect !== aspect) {
        entry.camera.aspect = aspect
        entry.camera.updateProjectionMatrix()
      }
      gl.setViewport(x, y, r.width, r.height)
      gl.setScissor(x, y, r.width, r.height)
      gl.setScissorTest(true)
      gl.render(entry.scene, entry.camera)
    }
    gl.setScissorTest(false)
  }, 1)

  return (
    <>
      {tiles.map((tile) => {
        const entry = entryFor(tile.id)
        return createPortal(
          <BlochScene
            key={tile.id}
            id={tile.id}
            camera={entry.camera}
            vector={tile.vector}
            headScale={tile.headScale}
            drawable={tile.drawable}
            autoRotate={autoRotate}
            reducedMotion={reducedMotion}
            domElement={elements[tile.id] ?? null}
            controllers={controllers}
          />,
          entry.scene,
        )
      })}
    </>
  )
}
