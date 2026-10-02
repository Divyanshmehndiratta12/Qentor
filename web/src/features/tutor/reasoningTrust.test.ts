/**
 * Source-level trust checks for the reasoning UI: the browser asks and shows, it never computes a quantum quantity, never evaluates
 * code, and every number a card shows passes through `VerifiedValueInline` with its provenance.
 */
import { describe, expect, it } from 'vitest'

const RAW = import.meta.glob(['./Reasoning*.tsx', '../build/store.ts', '../../api/client.ts', '../../api/realClient.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const source = (suffix: string): string => {
  const hit = Object.entries(RAW).find(([key]) => key.endsWith(suffix))
  if (!hit) throw new Error(`source not found: ${suffix}`)
  return hit[1]
}

const CARD = source('ReasoningCard.tsx')
const ACTIONS = source('ReasoningActions.tsx')
const STORE = source('build/store.ts')
const CLIENT = source('api/client.ts')
const REAL = source('api/realClient.ts')

/** The store's reasoning section: from the what-if preview to the end of runReasoning. */
const STORE_REASONING = STORE.slice(STORE.indexOf('previewWhatIf: async'), STORE.indexOf('// A pure learner preference'))
/** The client's reasoning section. */
const REAL_REASONING = REAL.slice(REAL.indexOf('async analyzeReasoning'), REAL.indexOf('async compareExperiments'))

describe('the reasoning UI computes no quantum quantity', () => {
  it('the sections exist (the checks below are not vacuous)', () => {
    expect(STORE_REASONING.length).toBeGreaterThan(500)
    expect(REAL_REASONING.length).toBeGreaterThan(500)
    expect(CARD.length).toBeGreaterThan(1000)
    expect(ACTIONS.length).toBeGreaterThan(1000)
  })

  it('no arithmetic on a value: no Math, no operators between a .value and a number', () => {
    for (const [name, text] of [['card', CARD], ['actions', ACTIONS], ['store', STORE_REASONING], ['client', REAL_REASONING]] as const) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      // the form clamps an operation POSITION with Math.min (a list index, not a quantum value); nothing else may use Math
      const math = [...code.matchAll(/\bMath\.(\w+)/g)].map((m) => m[1])
      expect(math.filter((fn) => !(name === 'actions' && fn === 'min')), `${name} uses Math`).toEqual([])
      expect(code, `${name} computes with a value`).not.toMatch(/\.value\s*[-+*/]\s*[\w(]/)
      expect(code, `${name} computes with a theoretical/sampled/difference`).not.toMatch(/\b(theoretical|sampled|difference|fidelity|purity)\b\.value\s*[-+*/<>]/)
    }
  })

  it('numbers are formatted in exactly two helpers of the card and nowhere else', () => {
    const lines = CARD.split('\n').filter((l) => l.includes('toFixed('))
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('const f6')
    expect(lines[1]).toContain('const signed6')
    expect(ACTIONS).not.toMatch(/toFixed\(/)
    expect(STORE_REASONING).not.toMatch(/toFixed\(/)
  })

  it('every number the card renders passes through VerifiedValueInline', () => {
    expect(CARD).toMatch(/import \{ VerifiedValueInline \} from '@\/provenance\/VerifiedValue'/)
    // `Num` and the Bloch cell are the only places a QuantumValue is unwrapped, and both render through VerifiedValueInline
    const unwrapped = CARD.split('\n').filter((l) => /\.value\b/.test(l) && !/^\s*(\/\/|\*)/.test(l))
    expect(unwrapped).toEqual([])
    expect(CARD.match(/<VerifiedValueInline/g)?.length).toBe(2)
  })

  it('no number reaches the page as a bare field: results are rendered from QuantumValue props only', () => {
    // as a child (text on the page) a QuantumValue field would print "[object Object]" or a bare number; as a `value=` prop it is fine
    expect(CARD).not.toMatch(/>\s*\{[^}]*\.(theoretical|sampled|difference|before|after|fidelity|purity|totalVariationDistance)\s*\}\s*</)
  })

  it('there is no dynamic code execution and no injected HTML in the reasoning UI, store or client', () => {
    for (const [name, text] of [['card', CARD], ['actions', ACTIONS], ['store', STORE_REASONING], ['client', REAL_REASONING]] as const) {
      expect(text, name).not.toMatch(/\beval\s*\(/)
      expect(text, name).not.toMatch(/new\s+Function\s*\(/)
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML/)
      expect(text, name).not.toMatch(/innerHTML/)
      expect(text, name).not.toMatch(/document\.write/)
    }
  })
})

describe('what the browser may send', () => {
  const REQUEST_TYPE = CLIENT.slice(CLIENT.indexOf('export type ReasoningRequestInput'), CLIENT.indexOf('export interface ReasoningSource'))
  const TARGET_TYPE = CLIENT.slice(CLIENT.indexOf('export type ProbabilityTargetInput'), CLIENT.indexOf('/** ONE explicit modification'))
  const MODIFICATION_TYPE = CLIENT.slice(CLIENT.indexOf('export type ModificationInput'), CLIENT.indexOf('export type ReasoningRequestInput'))

  it('the request types have no field for a result, an expected value or a counterfactual circuit', () => {
    for (const [name, text] of [['request', REQUEST_TYPE], ['target', TARGET_TYPE], ['modification', MODIFICATION_TYPE]] as const) {
      const fields = [...text.matchAll(/\b([a-zA-Z]+)\??:/g)].map((m) => m[1]!)
      expect(fields.length, name).toBeGreaterThan(3)
      for (const field of fields) {
        expect(field, `${name}.${field}`).not.toMatch(/probabilit|expected(?!CircuitHash)|result(?!Id)|verdict|equivalent|fidelity|statevector|amplitude|counts?$|counterfactualCircuit(?!Hash)|candidate/i)
      }
    }
  })

  it('the angle in a modification is a number the learner chose, and the only number the browser sends', () => {
    expect(MODIFICATION_TYPE.match(/angle\??: number/g)?.length).toBeGreaterThanOrEqual(3)
    expect(TARGET_TYPE).not.toMatch(/: number\b(?!.*(qubit|value))/)
  })

  it('the request body is built field by field, never by spreading the input', () => {
    const body = REAL_REASONING.slice(0, REAL_REASONING.indexOf('const response = await this.postParsed'))
    expect(body).not.toMatch(/\.\.\.input/)
    expect(body).toContain('CircuitSchema.parse(input.circuit)')
  })
})
