/**
 * The web emitter, parser and hash against the SAME golden fixtures the server is checked against
 * (`fixtures/circuits/`, generated from the server emitter by `backend/scripts/regen_fixtures.py`;
 * `backend/tests/test_golden_fixtures.py` checks the Python side).
 *
 * The rule (CLAUDE.md): the server emitter is authoritative and the web emitter must match it byte for
 * byte, because the circuit hash is SHA-256 of that text — two implementations that print `1e-05`
 * differently would give one circuit two hashes.
 */
import { describe, expect, it } from 'vitest'
import { toQasm3, formatAngle } from './qasmEmitter'
import { parseQasm3, QasmParseError } from './qasmParser'
import { CircuitSchema, GATE_NAMES, gateArityError, type Circuit } from './types'

interface Fixture {
  name: string
  description: string
  circuit: Circuit
  qasm: string
  hash: string
}
interface Pair {
  name: string
  note: string
  expected: 'EQUIVALENT' | 'NOT_EQUIVALENT'
  a: { circuit: Circuit; qasm: string }
  b: { circuit: Circuit; qasm: string }
}
interface InvalidCase {
  name: string
  reason: string
  client_rejects: boolean
  circuit: unknown
}

const RAW = import.meta.glob('../../../fixtures/circuits/*.json', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>
const byFile = Object.fromEntries(Object.entries(RAW).map(([path, text]) => [path.split('/').pop()!, JSON.parse(text)]))
const FIXTURES: Fixture[] = Object.entries(byFile)
  .filter(([file]) => !file.startsWith('_'))
  .map(([, value]) => value as Fixture)
const PAIRS: Pair[] = byFile['_equivalence.json'].pairs
const INVALID: InvalidCase[] = byFile['_invalid.json'].cases

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('the shared fixtures are loaded', () => {
  it('there are at least fourteen circuits, twenty equivalence pairs and fourteen invalid cases', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(14)
    expect(PAIRS.length).toBeGreaterThanOrEqual(20)
    expect(INVALID.length).toBeGreaterThanOrEqual(14)
  })

  it('the fixtures use every gate the web model lists, and no gate the web model does not', () => {
    const used = new Set(FIXTURES.flatMap((f) => f.circuit.ops.map((op) => op.gate)))
    expect([...used].sort()).toEqual([...GATE_NAMES].sort())
  })
})

describe('the web emitter matches the server emitter byte for byte', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(toQasm3(CircuitSchema.parse(fixture.circuit))).toBe(fixture.qasm)
  })

  it('every equivalence-pair circuit is emitted identically too', () => {
    for (const pair of PAIRS) {
      expect(toQasm3(CircuitSchema.parse(pair.a.circuit)), pair.name + ' a').toBe(pair.a.qasm)
      expect(toQasm3(CircuitSchema.parse(pair.b.circuit)), pair.name + ' b').toBe(pair.b.qasm)
    }
  })
})

describe('the circuit hash is stable across the two implementations', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s: SHA-256 of the web emitter’s text is the server’s hash', async (_name, fixture) => {
    expect(await sha256(toQasm3(CircuitSchema.parse(fixture.circuit)))).toBe(fixture.hash)
  })
})

describe('the parser reads the server’s text back into the same circuit', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(parseQasm3(fixture.qasm)).toEqual(CircuitSchema.parse(fixture.circuit))
  })

  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s: emit(parse(text)) is the text', (_name, fixture) => {
    expect(toQasm3(parseQasm3(fixture.qasm))).toBe(fixture.qasm)
  })

  it('equivalence-pair texts parse to their circuits', () => {
    for (const pair of PAIRS) {
      expect(parseQasm3(pair.a.qasm), pair.name).toEqual(CircuitSchema.parse(pair.a.circuit))
      expect(parseQasm3(pair.b.qasm), pair.name).toEqual(CircuitSchema.parse(pair.b.circuit))
    }
  })

  it('operand order survives: swap(2,0) and swap(0,2) stay different circuits', () => {
    const a = parseQasm3('OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[3] q;\nswap q[2], q[0];\n')
    expect(a.ops[0].targets).toEqual([2, 0])
    const c = parseQasm3('OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[3] q;\nccx q[2], q[0], q[1];\n')
    expect(c.ops[0]).toMatchObject({ controls: [2, 0], targets: [1] })
  })
})

describe('the equivalence pairs are distinct circuits with distinct text where they should be', () => {
  it('two equivalent circuits can print differently (they are different circuits with the same operator)', () => {
    const swapOrder = PAIRS.find((p) => p.name === 'swap_operand_order')!
    expect(swapOrder.a.qasm).not.toBe(swapOrder.b.qasm)
    expect(swapOrder.expected).toBe('EQUIVALENT')
  })
})

describe('circuits the model must refuse', () => {
  it.each(INVALID.filter((c) => c.client_rejects).map((c) => [c.name, c] as const))(
    '%s is refused by the web model too',
    (_name, invalid) => {
      const parsed = CircuitSchema.safeParse(invalid.circuit)
      if (!parsed.success) return // an unknown gate name never gets as far as arity
      expect(parsed.data.ops.some((op) => gateArityError(op) !== null)).toBe(true)
    },
  )

  it('the rules only the server checks are marked so (qubit and classical-bit index range)', () => {
    expect(INVALID.filter((c) => !c.client_rejects).map((c) => c.name).sort()).toEqual(['clbit_out_of_range', 'qubit_out_of_range'])
  })

  it('the arity messages name the problem', () => {
    const message = (op: Partial<Circuit['ops'][number]>) => gateArityError({ targets: [], controls: [], params: [], clbits: [], ...op } as Circuit['ops'][number])
    expect(message({ gate: 'ccx', controls: [0], targets: [2] })).toContain('2 control')
    expect(message({ gate: 'swap', targets: [1, 1] })).toContain('different')
    expect(message({ gate: 'cz', controls: [0, 1], targets: [2] })).toContain('1 control')
    expect(message({ gate: 'sdg', targets: [0], params: [1] })).toContain('no parameters')
    expect(message({ gate: 'ccx', controls: [0, 1], targets: [1] })).toContain('three different')
  })

  it('valid new-gate shapes have no arity error', () => {
    const ok = (op: Partial<Circuit['ops'][number]>) => gateArityError({ targets: [], controls: [], params: [], clbits: [], ...op } as Circuit['ops'][number])
    expect(ok({ gate: 'sdg', targets: [0] })).toBeNull()
    expect(ok({ gate: 'tdg', targets: [0] })).toBeNull()
    expect(ok({ gate: 'cz', controls: [0], targets: [1] })).toBeNull()
    expect(ok({ gate: 'swap', targets: [2, 0] })).toBeNull()
    expect(ok({ gate: 'ccx', controls: [2, 0], targets: [1] })).toBeNull()
  })
})

describe('formatAngle reproduces Python’s repr(float)', () => {
  // Each pair is (the double, what CPython's repr prints for it); produced by `repr()` on the server
  // and copied here, not derived from the implementation under test.
  const CASES: Array<[number, string]> = [
    [0.5, '0.5'],
    [1, '1.0'],
    [3, '3.0'],
    [-3, '-3.0'],
    [0, '0.0'],
    [-0, '-0.0'],
    [1.5707963267948966, '1.5707963267948966'],
    [-3.141592653589793, '-3.141592653589793'],
    [0.1, '0.1'],
    [0.30000000000000004, '0.30000000000000004'],
    [123456789.125, '123456789.125'],
    [0.0001, '0.0001'],
    [0.00012345, '0.00012345'],
    [0.00001, '1e-05'],
    [1e-7, '1e-07'],
    [2.5e-10, '2.5e-10'],
    [1e-100, '1e-100'],
    [1e15, '1000000000000000.0'],
    [1e16, '1e+16'],
    [1.5e16, '1.5e+16'],
    [123456789012345680, '1.2345678901234568e+17'],
    [1e22, '1e+22'],
    [1.5e300, '1.5e+300'],
    [-2.5e-5, '-2.5e-05'],
  ]
  it.each(CASES)('%s prints as %s', (value, expected) => {
    expect(formatAngle(value)).toBe(expected)
  })

  it('agrees with the server for every angle in the fixtures (they are in angle_formatting.json)', () => {
    const fixture = FIXTURES.find((f) => f.name === 'angle_formatting')!
    const printed = fixture.qasm.split('\n').filter((l) => l.startsWith('rz('))
    expect(printed).toHaveLength(fixture.circuit.ops.length)
    fixture.circuit.ops.forEach((op, i) => expect(`rz(${formatAngle(op.params[0])}) q[0];`).toBe(printed[i]))
  })

  it('refuses a non-finite angle instead of printing text the server would reject', () => {
    expect(() => formatAngle(Number.NaN)).toThrow()
    expect(() => formatAngle(Number.POSITIVE_INFINITY)).toThrow()
  })

  it('a formatted angle reads back as the same number', () => {
    for (const [value] of CASES) {
      expect(Object.is(Number(formatAngle(value)), value)).toBe(true)
    }
  })
})

describe('the parser refuses what it does not understand, with the line', () => {
  const HEADER = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[3] q;\n'
  const parse = (body: string) => parseQasm3(HEADER + body)

  it.each([
    ['ccx q[0], q[1];', 'takes 3 qubit operands'],
    ['ccx q[0], q[1], q[2], q[0];', 'takes 3 qubit operands'],
    ['swap q[0], q[1], q[2];', 'takes 2 qubit operands'],
    ['cz q[0];', 'takes 2 qubit operands'],
    ['ccx q[0], q[0], q[1];', 'three different qubits'],
    ['swap q[1], q[1];', 'two different'],
    ['cz q[2], q[2];', 'control and target must differ'],
    ['cx q[1], q[1];', 'control and target must differ'],
    ['cy q[0], q[1];', 'unrecognised statement'],
    ['sxdg q[0];', 'unknown or unsupported gate'],
  ])('%s', (line, message) => {
    expect(() => parse(line + '\n')).toThrow(QasmParseError)
    expect(() => parse(line + '\n')).toThrow(message)
  })

  it('a missing qubit declaration is refused', () => {
    expect(() => parseQasm3('OPENQASM 3.0;\nh q[0];\n')).toThrow('missing qubit declaration')
  })
})
