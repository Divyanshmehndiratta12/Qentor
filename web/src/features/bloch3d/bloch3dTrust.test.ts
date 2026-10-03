/**
 * Static trust guard for the 3D Bloch view: the frontend only RENDERS the backend's per-qubit values; it never derives a Bloch
 * coordinate, a length, a purity or an entanglement verdict, and it never draws a number of its own.
 *
 * Like `blochTrust.test.ts` this scans the sources as raw text (comments stripped) for the primitives and inputs that would make a
 * calculation possible. It is a tripwire, not a proof: it is paired with the runtime tests (`BlochScene.test.tsx` draws a vector that
 * is not a valid state exactly as supplied; `QubitStateView.test.tsx` shows values that contradict each other exactly as supplied),
 * which can only pass if nothing is derived. It also enforces the bundle architecture: three.js lives only in the lazy 3D chunk.
 */
import { describe, expect, it } from 'vitest'
import sceneConstants from './sceneConstants.ts?raw'
import blochScene from './BlochScene.tsx?raw'
import sphereGrid from './SphereGrid.tsx?raw'
import labelTexture from './labelTexture.ts?raw'
import sphereKeys from './sphereKeys.ts?raw'
import types from './types.ts?raw'
import vectorAsQubit from './vectorAsQubit.ts?raw'
import webgl from './webgl.ts?raw'
import qubitStateView from './QubitStateView.tsx?raw'
import resultStateView from '../build/ResultStateView.tsx?raw'

/** Source with block and line comments removed, so the rule text in the files' own docstrings is not scanned. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}
/** Identifiers only: string literals and JSX text removed (the UI legitimately SAYS "circuit" and "amplitude"). */
function identifiers(source: string): string {
  return code(source).replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '""').replace(/>[^<>{}]*</g, '><')
}

const SCENE: Array<[string, string]> = [
  ['sceneConstants.ts', sceneConstants],
  ['BlochScene.tsx', blochScene],
  ['SphereGrid.tsx', sphereGrid],
  ['labelTexture.ts', labelTexture],
  ['sphereKeys.ts', sphereKeys],
  ['types.ts', types],
  ['vectorAsQubit.ts', vectorAsQubit],
  ['webgl.ts', webgl],
]
const VIEW: Array<[string, string]> = [
  ['QubitStateView.tsx', qubitStateView],
  ['ResultStateView.tsx', resultStateView],
]
const ALL = [...SCENE, ...VIEW]

describe('3D Bloch view source: no client-side quantum computation', () => {
  it('actually scanned real source (guards against a vacuous pass)', () => {
    for (const [name, source] of ALL) expect(code(source).length, name).toBeGreaterThan(150)
    expect(code(blochScene)).toContain('toScene(vector.x, vector.y, vector.z)')
    expect(code(qubitStateView)).toContain('VerifiedValueInline')
  })

  it.each(ALL)('%s uses no Math function or constant at all', (_name, source) => {
    expect([...code(source).matchAll(/\bMath\.([A-Za-z0-9_]+)/g)].map((m) => m[1])).toEqual([])
  })

  it.each(ALL)('%s has no exponentiation, random-number calls or crypto', (_name, source) => {
    const src = code(source)
    expect(src).not.toMatch(/\*\*/)
    expect(src).not.toMatch(/\brandom\w*\s*\(/i)
    expect(src).not.toMatch(/\bcrypto\b/i)
  })

  it.each(ALL)('%s never mentions the ingredients of a Bloch or reduced-state calculation', (_name, source) => {
    const ids = identifiers(source)
    expect(ids).not.toMatch(/\b(sqrt|hypot|atan2?|acos|asin|cbrt|sin|cos|tan|exp|log|pow)\b/)
    expect(ids).not.toMatch(/\b(conjugate|conj|density|rho|partial|tensor|kron|eigen|theta|phi|azimuth|polar)\b/i)
    expect(ids).not.toMatch(/\b(normali[sz]e\w*|modulus|magnitude|probabilit\w*)\b/i)
    expect(ids).not.toMatch(/\.(length|normalize|normalise|angleTo|dot|cross|applyQuaternion|applyMatrix4|setFromUnitVectors)\s*\(/)
  })

  it.each(SCENE)('%s is never handed, and never touches, an amplitude, the statevector, a gate or the circuit', (_name, source) => {
    const ids = identifiers(source)
    expect(ids).not.toMatch(/\b(statevector|amplitude|amplitudes|GateOp|GateName|operation|operations|circuit|Circuit)\b/)
    expect(ids).not.toMatch(/\.gate\b|\.targets\b|\.controls\b|\.params\b|\.state\b|\.steps\b/)
    const imports = [...code(source).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    expect(imports.filter((s) => /circuit|gate|verification|execution|qasm|store|api\//i.test(s))).toEqual([])
  })

  it('the state view takes only per-qubit backend states (never an amplitude or the statevector); the result view reads the circuit only for its size and measurements', () => {
    const viewIds = identifiers(qubitStateView)
    expect(viewIds).not.toMatch(/\b(statevector|amplitude|amplitudes|GateOp|GateName|operation|operations|circuit|Circuit)\b/)
    // the result view: `statevector` appears once, only as the yes/no "did this run return a state"
    const result = code(resultStateView).replace(/'[^'\n]*'|"[^"\n]*"/g, '""')
    expect([...result.matchAll(/\bstatevector\b/g)]).toHaveLength(1)
    expect(result).toContain('Boolean(result.value.statevector)')
    expect(result).not.toMatch(/\b(amplitude|amplitudes|GateOp)\b/)
  })

  it('three.js and react-three-fiber are imported only by the lazy 3D chunk, never by the shell', () => {
    const importsOf = (source: string) => [...code(source).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    const heavy = (s: string) => s === 'three' || s.startsWith('three/') || s.startsWith('@react-three/')
    for (const [name, source] of SCENE.filter(([n]) => !['BlochScene.tsx', 'SphereGrid.tsx', 'labelTexture.ts'].includes(n))) {
      expect(importsOf(source).filter(heavy), name).toEqual([])
    }
    for (const [name, source] of VIEW) expect(importsOf(source).filter(heavy), name).toEqual([])
    // and the shell reaches the scene only through a dynamic import, which is what makes it a separate chunk
    expect(code(qubitStateView)).toMatch(/lazy\(\(\) => import\('\.\/SphereGrid'\)\)/)
    expect(importsOf(qubitStateView).filter((s) => s.includes('SphereGrid') || s.includes('BlochScene'))).toEqual([])
  })

  it('no file outside the lazy 3D chunk (and tests) imports three.js anywhere in the app', () => {
    const files = import.meta.glob('../../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const offenders = Object.entries(files)
      .filter(([path]) => !path.includes('.test.') && !/(?:^|\/)(BlochScene|SphereGrid|labelTexture)\.tsx?$/.test(path)) // (keys are relative to this folder)
      .filter(([, text]) => /from\s+['"](three|three\/[^'"]*|@react-three\/[^'"]+)['"]/.test(code(text)))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  it('the arrow code does arithmetic only on time (easing), never on a backend component', () => {
    const src = code(blochScene)
    expect(src).not.toMatch(/\.(x|y|z)\s*[-+*/%]\s*[\w(]/) // no p.x * 2, vector.x + …
    expect(src).not.toMatch(/\b(vector|target|now|p)\.(x|y|z)\s*(<|>|<=|>=)/) // and no test on a component against a threshold
    // the eased point is moved with the three.js `lerp`, the time step is the only number computed, and it lands with `copy`
    expect(src).toMatch(/now\.lerp\(target, delta > LONGEST_STEP \? 1 : delta \* EASE_RATE\)/)
    expect(src).toMatch(/now\.copy\(target\)/)
  })

  it('toScene is a fixed axis permutation: the supplied numbers are only reordered, one negated', () => {
    const body = /export function toScene\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code(sceneConstants))![1]!
    expect(body.trim()).toBe('return [x, z, -y]')
    // and the camera, the limits and every guide circle are written-out literals
    expect(code(sceneConstants)).toMatch(/CAMERA_START: Triple = \[[-\d.]+, [-\d.]+, [-\d.]+\]/)
  })

  it('draws no number of its own: the labels in the scene are the six fixed state names and the axis names', () => {
    const src = code(blochScene)
    expect(src).not.toMatch(/\.toFixed\(|formatComponent|VerifiedValue|\.textContent|\.innerText|fillText/)
    const titles = [...src.matchAll(/(?<![A-Za-z])title: '([^']+)'/g)].map((m) => m[1])
    expect(titles).toEqual(['|0⟩', '|1⟩', '|+⟩', '|−⟩', '|+i⟩', '|−i⟩'])
    const subtitles = [...src.matchAll(/subtitle: '([^']+)'/g)].map((m) => m[1])
    expect(subtitles).toEqual(['+Z', '−Z', '+X', '−X', '+Y', '−Y'])
    // the label texture helper draws exactly the text it is handed (no value of its own)
    const texture = code(labelTexture)
    expect([...texture.matchAll(/fillText\(([^)]*)\)/g)].map((m) => m[1]!.split(',')[0])).toEqual(['title', 'subtitle'])
  })

  it('the scene is handed only the vector, the backend’s length, flags and handles — nothing a calculation could use', () => {
    const props = /export interface BlochSceneProps\s*\{([\s\S]*?)\n\}/.exec(blochScene)![1]!
    const names = [...code(props).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1])
    expect(names).toEqual(['id', 'camera', 'vector', 'headScale', 'drawable', 'autoRotate', 'reducedMotion', 'domElement', 'controllers'])
    const tile = /export interface SphereTile\s*\{([\s\S]*?)\n\}/.exec(types)![1]!
    expect([...code(tile).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1])).toEqual(['id', 'vector', 'headScale', 'drawable', 'label', 'renderCard'])
    const vec = /export interface SphereVector\s*\{([\s\S]*?)\n\}/.exec(types)![1]!
    expect([...code(vec).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1])).toEqual(['x', 'y', 'z'])
  })

  it('the state view passes the backend’s own numbers to the 3D side as they are (the vector and its length), and rounds nothing', () => {
    const src = code(qubitStateView)
    expect(src).toContain('vector: { x, y, z }')
    expect(src).toContain('headScale: state.blochLength ? state.blochLength.value : null')
    expect(src).not.toMatch(/\.toPrecision\(|\.round\(|\bparseFloat\b|\bNumber\(/)
    // out-of-range detection is the existing per-coordinate bound check, not a computed length
    expect(src).toContain('isDrawable(x, y, z)')
  })

  it('every number element in the 3D cards goes through VerifiedValueInline with a provenance object', () => {
    const src = code(qubitStateView)
    expect([...src.matchAll(/<VerifiedValueInline\b/g)]).toHaveLength(3) // x/y/z, length, purity
    expect(src).toContain('toQuantumValue(bloch.value[axis], bloch.provenance)')
  })
})
