/**
 * Static guard for the trace viewer's absolute trust rule: the browser never
 * calculates a quantum value. Scans the SOURCE of every trace-viewer file (as
 * raw text, comments stripped) for the primitives that would do so, so an
 * accidental `Math.sqrt(re*re + im*im)` — a "harmless" probability, say —
 * fails the build instead of shipping.
 *
 * This is a practical tripwire, not a proof: it cannot show arbitrary code
 * computes nothing. It is paired with the runtime tests in
 * `TraceViewer.test.tsx` (no math primitive is ever called while rendering,
 * every rendered amplitude equals the formatted response value) and the
 * client test that values pass through `RealApiClient.traceCircuit` untouched.
 */
import { describe, expect, it } from 'vitest'
import formatSource from './traceFormat.ts?raw'
import viewerSource from './TraceViewer.tsx?raw'
import panelSource from './TracePanel.tsx?raw'

/** Source with block and line comments removed, so the rule text in the
 * files' own docstrings ("no probabilities, no Math.sqrt…") isn't scanned. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FILES: Array<[string, string]> = [
  ['traceFormat.ts', code(formatSource)],
  ['TraceViewer.tsx', code(viewerSource)],
  ['TracePanel.tsx', code(panelSource)],
]

describe('trace viewer source: no client-side quantum computation', () => {
  it('actually scanned real source (guards against a vacuous pass)', () => {
    for (const [name, source] of FILES) {
      expect(source.length, name).toBeGreaterThan(200)
    }
    expect(FILES[1]![1]).toContain('VerifiedValueInline')
    expect(FILES[0]![1]).toContain('formatAmplitude')
  })

  it.each(FILES)('%s uses no Math function beyond index clamping (min/max)', (_name, source) => {
    const uses = [...source.matchAll(/\bMath\.([A-Za-z0-9_]+)/g)].map((m) => m[1])
    expect(uses.filter((fn) => fn !== 'min' && fn !== 'max')).toEqual([])
  })

  it.each(FILES)('%s has no exponentiation, random-number calls or crypto', (_name, source) => {
    expect(source).not.toMatch(/\*\*/)
    // A call like random() / getRandomValues() / randomUUID() — not the word
    // "random" in user-facing copy (the viewer explains that a measurement
    // outcome is random; it never generates one).
    expect(source).not.toMatch(/\brandom\w*\s*\(/i)
    expect(source).not.toMatch(/\bgetRandomValues\b/)
    expect(source).not.toMatch(/\bcrypto\b/i)
  })

  it.each(FILES)('%s does not derive probabilities, normalise, or compute Bloch/phase values', (name, source) => {
    // TraceViewer.tsx may MOUNT the Bloch sphere (three tokens: the component,
    // its `bloch=` prop, and the backend-provided `blochVector` field it hands
    // over); any other "bloch" in these files would be Bloch logic and still
    // fails. The sphere's own files are guarded by `blochTrust.test.ts`.
    const scanned = name === 'TraceViewer.tsx' ? source.replace(/BlochSphere|blochVector|\bbloch=/g, '') : source
    expect(scanned).not.toMatch(/probabilit/i)
    expect(scanned).not.toMatch(/normali[sz]/i)
    expect(scanned).not.toMatch(/bloch/i)
    expect(scanned).not.toMatch(/\b(magnitude|modulus|phase)\b/i)
  })

  it('TraceViewer hands the Bloch sphere only the selected step’s backend vector and the qubit count', () => {
    expect(FILES[1]![1]).toContain('<BlochSphere bloch={step.blochVector} numQubits={trace.numQubits} />')
    expect(FILES[1]![1].match(/<BlochSphere\b/g)).toHaveLength(1)
  })

  it.each(FILES)('%s imports no third-party package except react (so no numeric/complex/simulator library)', (_name, source) => {
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    expect(imports.length).toBeGreaterThan(0)
    // Project imports are relative ('./x') or aliased ('@/x'); anything else is
    // a package. An allowlist, so a newly added maths/simulator dependency
    // can't slip past a ban-list that didn't think to name it.
    const packages = imports.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('@/'))
    expect(packages.filter((specifier) => specifier !== 'react')).toEqual([])
  })

  it('amplitudes are only ever rendered through VerifiedValueInline', () => {
    // The one place amplitude values reach the DOM is the statevector table,
    // and it goes through the provenance-carrying component.
    expect(FILES[1]![1]).toMatch(/<VerifiedValueInline\s+quantum=\{toQuantumValue\(amplitude, provenance\)\}/)
    expect(FILES[1]![1]).not.toMatch(/\.toFixed\(/) // formatting lives in traceFormat, not inline
  })

  it('formatting helpers take numbers and return strings — no other return of a derived number', () => {
    // Every exported function in traceFormat returns string | boolean.
    const signatures = [...FILES[0]![1].matchAll(/export function (\w+)\([^)]*\):\s*([^{\n]+)\{/g)].map(
      (m) => [m[1], m[2]!.trim()] as const,
    )
    expect(signatures.length).toBeGreaterThanOrEqual(6)
    for (const [name, returnType] of signatures) {
      expect(['string', 'boolean'], `${name} returns ${returnType}`).toContain(returnType)
    }
  })
})
