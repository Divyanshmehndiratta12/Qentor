/**
 * Static trust guard for the Bloch sphere's own source files: the frontend
 * only RENDERS the backend's (x, y, z); it never computes a Bloch coordinate.
 * Scans `BlochSphere.tsx` and `blochProjection.ts` as raw text (comments
 * stripped) for the primitives and inputs that would make that possible.
 *
 * The strongest guarantee is structural and checked here: the component's props
 * are just the backend vector and a qubit count — it is never given an
 * amplitude, statevector, gate or circuit, so there is nothing to derive from.
 * Paired with the runtime tests (no math primitive is called while rendering;
 * a vector that contradicts the statevector/gates is shown as supplied).
 */
import { describe, expect, it } from 'vitest'
import sphereSource from './BlochSphere.tsx?raw'
import projectionSource from './blochProjection.ts?raw'

/** Source with block and line comments removed, so the rule text in the files'
 * own docstrings ("no Math.sqrt, no theta/phi …") isn't scanned. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FILES: Array<[string, string]> = [
  ['BlochSphere.tsx', code(sphereSource)],
  ['blochProjection.ts', code(projectionSource)],
]

describe('Bloch sphere source: no client-side Bloch computation', () => {
  it('actually scanned real source (guards against a vacuous pass)', () => {
    for (const [name, source] of FILES) expect(source.length, name).toBeGreaterThan(300)
    expect(FILES[0]![1]).toContain('projectBloch')
    expect(FILES[1]![1]).toContain('export function projectBloch')
  })

  it.each(FILES)('%s uses no Math function at all', (_name, source) => {
    expect([...source.matchAll(/\bMath\.([A-Za-z0-9_]+)/g)].map((m) => m[1])).toEqual([])
  })

  it.each(FILES)('%s has no exponentiation, random-number calls or crypto', (_name, source) => {
    expect(source).not.toMatch(/\*\*/)
    expect(source).not.toMatch(/\brandom\w*\s*\(/i)
    expect(source).not.toMatch(/\bcrypto\b/i)
  })

  it.each(FILES)('%s never mentions the ingredients of a Bloch calculation', (_name, source) => {
    expect(source).not.toMatch(/\b(sqrt|hypot|atan2?|acos|asin|cbrt)\b/)
    expect(source).not.toMatch(/\b(theta|phi|azimuth|polar|magnitude|modulus)\b/i)
    expect(source).not.toMatch(/probabilit/i)
    expect(source).not.toMatch(/normali[sz]/i)
    expect(source).not.toMatch(/conjugate|conj\(|density|reduced/i)
  })

  it.each(FILES)('%s does not touch amplitudes, the statevector, gates or the circuit', (_name, source) => {
    // Identifiers only: string literals and JSX text are removed first, because
    // the UI legitimately SAYS "source circuit" / "your circuit is correct".
    const identifiers = source
      .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '""')
      .replace(/>[^<>{}]*</g, '><')
    expect(identifiers).not.toMatch(/\b(statevector|amplitude|amplitudes|GateOp|GateName|operation|operations|circuit)\b/)
    expect(identifiers).not.toMatch(/\.gate\b|\.targets\b|\.controls\b|\.params\b/)

    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    expect(imports.filter((specifier) => /circuit|gate|verification|execution/i.test(specifier))).toEqual([])
  })

  it.each(FILES)('%s imports no third-party package except react', (_name, source) => {
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    const packages = imports.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('@/'))
    expect(packages.filter((specifier) => specifier !== 'react')).toEqual([])
  })

  it('the component is given only the backend vector and a qubit count', () => {
    const props = /export interface BlochSphereProps\s*\{([\s\S]*?)\n\}/.exec(sphereSource)![1]!
    const names = [...code(props).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1])
    expect(names).toEqual(['bloch', 'numQubits'])
    expect(props).toContain('TraceBlochVector | null')
  })

  it('does no arithmetic on a coordinate outside the fixed linear projection', () => {
    // The only multiplications/additions of supplied numbers live in
    // projectBloch / facing (fixed constants x coordinates) — the component
    // itself only passes coordinates to those and to the string formatter.
    const componentBody = FILES[0]![1]
    expect(componentBody).not.toMatch(/\b[xyz]\s*[*/]\s*\S/)
    expect(componentBody).not.toMatch(/[xyz]\s*\*\s*[xyz]/)
    expect(componentBody).not.toMatch(/\.toFixed\(/) // formatting lives in traceFormat
  })

  it('the projection is a fixed linear map: only * and + of the supplied numbers and literal constants', () => {
    const body = /export function projectBloch[\s\S]*?\n\}/.exec(FILES[1]![1])![0]
    expect(body).toMatch(/AXIS_X\.sx \* x \+ AXIS_Y\.sx \* y \+ AXIS_Z\.sx \* z/)
    expect(body).toMatch(/AXIS_X\.sy \* x \+ AXIS_Y\.sy \* y \+ AXIS_Z\.sy \* z/)
    // The camera constants are literals, not computed from angles at run time.
    expect(FILES[1]![1]).toMatch(/AXIS_X: ScreenAxis = \{ sx: -0\.5, sy: 0\.268 \}/)
    expect(FILES[1]![1]).toMatch(/AXIS_Y: ScreenAxis = \{ sx: 0\.866, sy: 0\.155 \}/)
    expect(FILES[1]![1]).toMatch(/AXIS_Z: ScreenAxis = \{ sx: 0, sy: -0\.951 \}/)
  })

  it('the out-of-range guard compares each coordinate to a bound (never clamps or rescales)', () => {
    const body = /export function isDrawable[\s\S]*?\n\}/.exec(FILES[1]![1])![0]
    expect(body).toMatch(/Number\.isFinite\(v\) && v <= limit && v >= -limit/)
    expect(body).not.toMatch(/Math\./)
    expect(body.trim().startsWith('export function isDrawable(x: number, y: number, z: number): boolean')).toBe(true)
  })
})
