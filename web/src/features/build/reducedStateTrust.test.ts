/**
 * Static trust guard for the per-qubit spheres and the amplitude/phase chart: the frontend only RENDERS what the backend
 * computed; it never derives a reduced state, a purity, a length, an entanglement verdict, a magnitude or a phase.
 *
 * Scans the source of every new rendering file as raw text (comments stripped) for the primitives and inputs that would
 * make a calculation possible. Like `traceTrust.test.ts` this is a tripwire, not a proof: it is paired with runtime
 * tests that feed the components values that CONTRADICT each other (a length that is not the vector's length, a weight
 * that is not the square of the size, an entanglement flag that disagrees with the length) and require the screen to
 * show exactly what was supplied — which can only pass if nothing is derived.
 */
import { describe, expect, it } from 'vitest'
import spheresSource from './QubitSpheres.tsx?raw'
import chartSource from './AmplitudeChart.tsx?raw'
import formatSource from './reducedFormat.ts?raw'
import viewerSource from './TraceViewer.tsx?raw'

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Identifiers only: string literals and JSX text removed (the UI legitimately SAYS "circuit" and "amplitude"). */
function identifiers(source: string): string {
  return source.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '""').replace(/>[^<>{}]*</g, '><')
}

const FILES: Array<[string, string]> = [
  ['QubitSpheres.tsx', code(spheresSource)],
  ['AmplitudeChart.tsx', code(chartSource)],
  ['reducedFormat.ts', code(formatSource)],
]

describe('reduced-state and amplitude rendering: no client-side quantum computation', () => {
  it('actually scanned real source (guards against a vacuous pass)', () => {
    for (const [name, source] of FILES) expect(source.length, name).toBeGreaterThan(300)
    expect(FILES[0]![1]).toContain('VerifiedValueInline')
    expect(FILES[1]![1]).toContain('VerifiedValueInline')
    expect(FILES[2]![1]).toContain('export function formatAngle')
  })

  it.each(FILES)('%s uses no Math function at all', (_name, source) => {
    expect([...source.matchAll(/\bMath\.([A-Za-z0-9_]+)/g)].map((m) => m[1])).toEqual([])
  })

  it.each(FILES)('%s has no exponentiation, random-number calls or crypto', (_name, source) => {
    expect(source).not.toMatch(/\*\*/)
    expect(source).not.toMatch(/\brandom\w*\s*\(/i)
    expect(source).not.toMatch(/\bcrypto\b/i)
  })

  it.each(FILES)('%s never mentions the ingredients of a reduced-state or polar-form calculation', (_name, source) => {
    const ids = identifiers(source)
    expect(ids).not.toMatch(/\b(sqrt|hypot|atan2?|acos|asin|cbrt|cos|sin|tan|exp|log|abs|pow)\b/)
    expect(ids).not.toMatch(/\b(conjugate|conj|density|rho|partial|tensor|kron|eigen)\b/i)
    expect(ids).not.toMatch(/\btrace\s*\(/) // (the word "trace" is UI copy: "from trace step …"; a CALL to trace() is not)
    expect(ids).not.toMatch(/\b(normali[sz]e\w*|modulus|theta|phi|azimuth|polar)\b/i)
  })

  it.each(FILES)('%s does not touch the statevector, a gate or the circuit', (_name, source) => {
    const ids = identifiers(source)
    expect(ids).not.toMatch(/\b(statevector|GateOp|GateName|operation|operations|circuit|Circuit)\b/)
    expect(ids).not.toMatch(/\.gate\b|\.targets\b|\.controls\b|\.params\b|\.state\b|\.steps\b/)
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    expect(imports.filter((specifier) => /circuit|gate|verification|execution|qasm/i.test(specifier))).toEqual([])
  })

  it.each(FILES)('%s imports no third-party package except react', (_name, source) => {
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    const packages = imports.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('@/'))
    expect(packages.filter((specifier) => specifier !== 'react')).toEqual([])
  })

  it.each(FILES)('%s does no arithmetic on a supplied value', (_name, source) => {
    const ids = identifiers(source)
    // a backend number followed or preceded by a (spaced, as written) arithmetic operator. Hyphenated attribute names
    // such as data-has-phase are not arithmetic, hence the required spaces.
    expect(ids).not.toMatch(/\b(magnitude|probability|phase|purity|blochLength|angle|value|x|y|z)\s[-+*/%]\s[\w(]/)
    expect(ids).not.toMatch(/[\w)]\s[-+*/%]\s\b(magnitude|probability|phase|purity|blochLength)\b/)
    // nothing is rounded, clamped, or compared to a threshold here
    expect(ids).not.toMatch(/\.toFixed\(|\.toPrecision\(|\.round\(|\bparseFloat\b|\bNumber\(/)
    expect(ids).not.toMatch(/\b(magnitude|probability|phase|purity|blochLength)\s*(<|>|<=|>=)\s*[\d.]/)
  })

  it('a bar or an arrow is drawn by setting a CSS variable to the supplied number, nothing else', () => {
    const chart = FILES[1]![1]
    expect(chart).toMatch(/\{ '--amp': row\.magnitude \} as CSSProperties/)
    expect(chart).toMatch(/\{ '--phase': row\.phase \} as CSSProperties/)
    // the only tests made on a phase are "is it null" (the backend's own "no phase" marker): the row's data attribute,
    // its dimming, and whether an arrow is drawn
    const tests = [...chart.matchAll(/row\.phase\s*(===|!==|==|!=)\s*(\w+)/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(tests.length).toBeGreaterThanOrEqual(2)
    expect(new Set(tests)).toEqual(new Set(['=== null']))
  })

  it('the per-qubit component is given only the backend’s per-qubit states and a qubit count', () => {
    const props = /export interface QubitSpheresProps\s*\{([\s\S]*?)\n\}/.exec(spheresSource)![1]!
    expect([...code(props).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1])).toEqual(['qubitStates', 'numQubits'])
    expect(props).toContain('TraceQubitState[]')
  })

  it('the chart is given only the backend’s polar amplitudes, the qubit count, and a labelling flag', () => {
    const props = /export interface AmplitudeChartProps\s*\{([\s\S]*?)\n\}/.exec(chartSource)![1]!
    expect([...code(props).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1])).toEqual(['view', 'numQubits', 'labelled'])
    expect(props).toContain('QuantumValue<TraceAmplitude[]> | null')
  })

  it('the trace viewer hands them only backend values from the selected step', () => {
    const viewer = code(viewerSource)
    expect(viewer).toContain('<QubitSpheres qubitStates={step.qubitStates} numQubits={trace.numQubits} />')
    expect(viewer).toContain('<AmplitudeChart view={step.amplitudeView}')
    expect(viewer.match(/<QubitSpheres\b/g)).toHaveLength(1)
    expect(viewer.match(/<AmplitudeChart\b/g)).toHaveLength(1)
  })

  it('formatting helpers take values and return strings', () => {
    const signatures = [...FILES[2]![1].matchAll(/export function (\w+)\([^)]*\):\s*([^{\n]+)\{/g)].map((m) => [m[1], m[2]!.trim()] as const)
    expect(signatures.length).toBeGreaterThanOrEqual(3)
    for (const [name, returnType] of signatures) expect(returnType, name).toBe('string')
  })

  it('every number element is wrapped in VerifiedValueInline with a provenance object', () => {
    const spheres = FILES[0]![1]
    const chart = FILES[1]![1]
    // every value rendered in a cell or readout goes through the provenance wrapper
    expect([...spheres.matchAll(/<VerifiedValueInline\b/g)]).toHaveLength(3) // x/y/z, length, purity
    expect([...chart.matchAll(/<VerifiedValueInline\b/g)]).toHaveLength(3) // size, angle, weight
    expect(chart).toMatch(/toQuantumValue\(row\.magnitude, view\.provenance\)/)
    expect(chart).toMatch(/toQuantumValue\(row\.phase, view\.provenance\)/)
    expect(chart).toMatch(/toQuantumValue\(row\.probability, view\.provenance\)/)
  })
})
