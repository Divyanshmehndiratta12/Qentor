/**
 * The 3D scene of ONE Bloch sphere: the sphere, its guide circles, the X/Y/Z axes and pole labels, and the backend's state
 * vector drawn as an arrow with a point at its tip.
 *
 * TRUST RULE (absolute): this scene draws the (x, y, z) the backend returned and nothing else. It is handed a plain vector
 * and the backend's Bloch length (used only to size the arrowhead) — never an amplitude, a statevector, a gate or a circuit —
 * so there is nothing here from which a coordinate could be computed, and none is. The only thing done to the supplied
 * numbers is `toScene`, a fixed axis permutation. Nothing in this file is a quantum number shown to the learner: the numbers
 * are listed beside the view through `VerifiedValueInline` with their provenance.
 *
 * Animation is presentation only. When the backend's vector for the selected step changes, the DRAWN arrow eases from where
 * it was to the new backend point over a fraction of a second, and lands on it exactly. The positions in between are screen
 * positions of a drawing, not physical states, and no number is shown for them. With reduced motion requested it jumps.
 *
 * Rendering is on demand: a frame is drawn only when something changed (a drag, a zoom, a new vector, an easing step, or the
 * auto-rotate loop), so an idle sphere costs nothing.
 */
import { useEffect, useMemo, useRef, type ComponentRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Line, OrbitControls } from '@react-three/drei'
import { Vector3, type Group, type Mesh, type PerspectiveCamera } from 'three'
import { LABEL_SCALE, makeLabelTexture, type LabelSpec } from './labelTexture'
import {
  AXIS_LENGTH,
  COLORS,
  KEY_ROTATE_STEP,
  KEY_ZOOM_IN,
  KEY_ZOOM_OUT,
  LATITUDES,
  MAX_DISTANCE,
  MIN_DISTANCE,
  QUARTER_TURN,
  toScene,
} from './sceneConstants'
import type { SphereController, SphereVector } from './types'

type Controls = ComponentRef<typeof OrbitControls>
type FatLine = ComponentRef<typeof Line>

export interface BlochSceneProps {
  /** The tile's id (e.g. `q0`): the key the parent drives this sphere by. */
  id: string
  /** This sphere's own camera (every sphere on a canvas has one); the controls move it. */
  camera: PerspectiveCamera
  /** The backend's Bloch vector. */
  vector: SphereVector
  /** The backend's Bloch length for this qubit; sizes the arrowhead only. `null` -> a full-size head. */
  headScale: number | null
  /** False when the backend's vector lies outside the unit sphere: the sphere is drawn but the arrow is not. */
  drawable: boolean
  autoRotate: boolean
  reducedMotion: boolean
  /** The element the controls listen on (the sphere's own tile), so several spheres on one canvas rotate independently. */
  domElement: HTMLElement | null
  controllers: { current: Map<string, SphereController> }
}

/** How fast the drawn arrow eases to a new backend vector (per second), and how close counts as arrived. */
const EASE_RATE = 14
const ARRIVED = 1e-6
const LONGEST_STEP = 0.05

export function BlochScene({ id, camera, vector, headScale, drawable, autoRotate, reducedMotion, domElement, controllers }: BlochSceneProps) {
  const controls = useRef<Controls>(null)
  const invalidate = useThree((s) => s.invalidate)

  // Hand the parent a way to reset, rotate and zoom this sphere (toolbar buttons and keyboard shortcuts).
  useEffect(() => {
    const c = controls.current
    if (!c) return
    c.saveState()
    // Damping makes a drag coast to a stop, leaving a little pending motion after the learner lets go. A keyboard step or a reset
    // must not inherit it (a reset would otherwise drift off the starting view), so these run with the pending motion applied at once.
    const crisp = (act: () => void) => {
      const damping = c.enableDamping
      c.enableDamping = false
      c.update() // finish any coasting first
      act()
      c.update()
      c.enableDamping = damping
      invalidate()
    }
    const controller: SphereController = {
      reset: () => crisp(() => c.reset()),
      rotate: (dx, dy) =>
        crisp(() => {
          c.setAzimuthalAngle(c.getAzimuthalAngle() + dx * KEY_ROTATE_STEP)
          c.setPolarAngle(c.getPolarAngle() + dy * KEY_ROTATE_STEP)
        }),
      zoom: (direction) => crisp(() => c.object.position.multiplyScalar(direction < 0 ? KEY_ZOOM_IN : KEY_ZOOM_OUT)),
    }
    controllers.current.set(id, controller)
    return () => {
      controllers.current.delete(id)
    }
  }, [id, controllers, invalidate, domElement])

  // Auto-rotate needs a frame every frame while it is on; with it off nothing is drawn until something changes.
  useEffect(() => {
    if (!autoRotate || reducedMotion) return
    let handle = 0
    const tick = () => {
      invalidate()
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [autoRotate, reducedMotion, invalidate])

  return (
    <>
      <OrbitControls
        ref={controls}
        camera={camera}
        domElement={domElement ?? undefined}
        enablePan={false}
        enableDamping={!reducedMotion}
        dampingFactor={0.12}
        rotateSpeed={0.85}
        zoomSpeed={0.7}
        minDistance={MIN_DISTANCE}
        maxDistance={MAX_DISTANCE}
        autoRotate={autoRotate && !reducedMotion}
        autoRotateSpeed={1.6}
      />
      <SphereShell />
      <Axes />
      <PoleLabels />
      {drawable && <StateArrow vector={vector} headScale={headScale} reducedMotion={reducedMotion} />}
    </>
  )
}

function SphereShell() {
  return (
    <group>
      <mesh name="bloch-sphere">
        <sphereGeometry args={[1, 40, 28]} />
        <meshBasicMaterial color={COLORS.body} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      {/* Equator (the xy plane) and the two meridians (xz, yz): thin rings, the equator the strongest. */}
      <mesh name="equator" rotation-x={QUARTER_TURN}>
        <torusGeometry args={[1, 0.009, 6, 128]} />
        <meshBasicMaterial color={COLORS.shell} transparent opacity={0.9} />
      </mesh>
      <mesh>
        <torusGeometry args={[1, 0.005, 6, 128]} />
        <meshBasicMaterial color={COLORS.shell} transparent opacity={0.45} />
      </mesh>
      <mesh rotation-y={QUARTER_TURN}>
        <torusGeometry args={[1, 0.005, 6, 128]} />
        <meshBasicMaterial color={COLORS.shell} transparent opacity={0.45} />
      </mesh>
      {/* Latitude guides at +/-30 and +/-60 degrees. */}
      {LATITUDES.map(({ height, radius }) => (
        <mesh key={height} position={[0, height, 0]} rotation-x={QUARTER_TURN}>
          <torusGeometry args={[radius, 0.0035, 6, 96]} />
          <meshBasicMaterial color={COLORS.guide} transparent opacity={0.7} />
        </mesh>
      ))}
    </group>
  )
}

/** The three axes through the centre, a little beyond the sphere (scene coordinates: Bloch x -> X, y -> -Z, z -> Y). */
function Axes() {
  return (
    <group>
      <Line name="axis-x" points={[[-AXIS_LENGTH, 0, 0], [AXIS_LENGTH, 0, 0]]} color={COLORS.axis} lineWidth={1.2} />
      <Line name="axis-y" points={[[0, 0, AXIS_LENGTH], [0, 0, -AXIS_LENGTH]]} color={COLORS.axis} lineWidth={1.2} />
      <Line name="axis-z" points={[[0, -AXIS_LENGTH, 0], [0, AXIS_LENGTH, 0]]} color={COLORS.axis} lineWidth={1.2} />
    </group>
  )
}

/** The six standard states at the ends of the axes: fixed labels (the geometry of the picture, not a lookup from any gate or state). */
const POLES: ReadonlyArray<{ at: readonly [number, number, number]; spec: LabelSpec }> = [
  { at: [0, 1.3, 0], spec: { title: '|0⟩', subtitle: '+Z' } },
  { at: [0, -1.3, 0], spec: { title: '|1⟩', subtitle: '−Z' } },
  { at: [1.3, 0, 0], spec: { title: '|+⟩', subtitle: '+X' } },
  { at: [-1.3, 0, 0], spec: { title: '|−⟩', subtitle: '−X' } },
  { at: [0, 0, -1.3], spec: { title: '|+i⟩', subtitle: '+Y' } },
  { at: [0, 0, 1.3], spec: { title: '|−i⟩', subtitle: '−Y' } },
]

function PoleLabels() {
  return (
    <>
      {POLES.map((pole) => (
        <LabelSprite key={pole.spec.subtitle} at={pole.at} spec={pole.spec} />
      ))}
    </>
  )
}

function LabelSprite({ at, spec }: { at: readonly [number, number, number]; spec: LabelSpec }) {
  const texture = useMemo(() => makeLabelTexture(spec), [spec])
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    invalidate()
    return () => texture?.dispose()
  }, [texture, invalidate])
  if (!texture) return null
  return (
    <sprite name={`pole-${spec.title}`} position={[...at]} scale={[...LABEL_SCALE]}>
      <spriteMaterial map={texture} transparent depthWrite={false} depthTest={false} sizeAttenuation={false} />
    </sprite>
  )
}

/**
 * The backend's vector as an arrow from the centre, a point at its tip, and a dashed line down to the equatorial plane (a
 * faint foot point) so the depth of the tip can be read. The arrowhead is oriented with `lookAt` the centre: the cone's apex
 * points away from the origin, which is the vector's own direction, so no direction or length is computed here.
 */
function StateArrow({ vector, headScale, reducedMotion }: { vector: SphereVector; headScale: number | null; reducedMotion: boolean }) {
  const invalidate = useThree((s) => s.invalidate)
  const [sx, sy, sz] = toScene(vector.x, vector.y, vector.z)
  const target = useMemo(() => new Vector3(sx, sy, sz), [sx, sy, sz])
  const shown = useRef<Vector3>(target.clone()) // first draw: the vector is simply there, no easing from nowhere

  const shaft = useRef<FatLine>(null)
  const drop = useRef<FatLine>(null)
  const head = useRef<Group>(null)
  const tip = useRef<Mesh>(null)
  const foot = useRef<Mesh>(null)

  const place = (p: Vector3) => {
    shaft.current?.geometry.setPositions([0, 0, 0, p.x, p.y, p.z])
    if (drop.current) {
      drop.current.geometry.setPositions([p.x, p.y, p.z, p.x, 0, p.z])
      drop.current.computeLineDistances()
    }
    tip.current?.position.copy(p)
    foot.current?.position.set(p.x, 0, p.z)
    if (head.current) {
      head.current.position.copy(p)
      head.current.lookAt(0, 0, 0)
    }
  }

  // A new backend vector: draw a frame so the easing starts.
  useEffect(() => {
    invalidate()
  }, [target, invalidate])

  useFrame((_, delta) => {
    const now = shown.current
    if (reducedMotion || now.distanceToSquared(target) < ARRIVED) now.copy(target)
    else now.lerp(target, delta > LONGEST_STEP ? 1 : delta * EASE_RATE)
    place(now)
    if (!now.equals(target)) invalidate() // still easing: ask for the next frame
  })

  const size = headScale ?? 1
  return (
    <group>
      <Line ref={shaft} name="state-shaft" points={[[0, 0, 0], [sx, sy, sz]]} color={COLORS.vector} lineWidth={3.2} />
      <Line
        ref={drop}
        name="state-drop"
        points={[[sx, sy, sz], [sx, 0, sz]]}
        color={COLORS.tip}
        lineWidth={1}
        dashed
        dashSize={0.05}
        gapSize={0.04}
        transparent
        opacity={0.6}
      />
      <group ref={head} name="state-head" scale={[size, size, size]} position={[sx, sy, sz]}>
        {/* apex along -Z; after `lookAt` the centre the apex points outward along the vector */}
        <mesh rotation-x={-QUARTER_TURN} position={[0, 0, 0.1]}>
          <coneGeometry args={[0.055, 0.2, 20]} />
          <meshBasicMaterial color={COLORS.vector} />
        </mesh>
      </group>
      <mesh ref={tip} name="state-tip" position={[sx, sy, sz]}>
        <sphereGeometry args={[0.05, 20, 14]} />
        <meshBasicMaterial color={COLORS.tip} />
      </mesh>
      <mesh ref={foot} name="state-foot" position={[sx, 0, sz]}>
        <sphereGeometry args={[0.022, 12, 8]} />
        <meshBasicMaterial color={COLORS.tip} transparent opacity={0.55} />
      </mesh>
    </group>
  )
}
