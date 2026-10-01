/**
 * Angle expressions: the same grammar as the server's `read_angle`, the same doubles, and nothing evaluated that the grammar does not
 * name (no identifiers, no calls, no `**`, no code).
 */
import { describe, expect, it } from 'vitest'
import { describeAngle, parseAngle } from './angle'
import { parseQasm3 } from './qasmParser'

describe('parseAngle', () => {
  it('reads plain numbers exactly as Number() does', () => {
    for (const text of ['0', '1', '0.5', '.5', '2.', '1e-3', '1.5707963267948966', '3E2', '  0.25  ']) {
      expect(parseAngle(text)).toBe(Number(text.trim()))
    }
  })

  it('reads pi, the Greek letter, and fractions and multiples of it, to the same doubles the server computes', () => {
    expect(parseAngle('pi')).toBe(Math.PI)
    expect(parseAngle('π')).toBe(Math.PI)
    expect(parseAngle('pi/2')).toBe(Math.PI / 2)
    expect(parseAngle('pi/4')).toBe(Math.PI / 4)
    expect(parseAngle('π/8')).toBe(Math.PI / 8)
    expect(parseAngle('-pi/2')).toBe(-Math.PI / 2)
    expect(parseAngle('-3*pi/4')).toBe((-3 * Math.PI) / 4)
    expect(parseAngle('2*pi')).toBe(2 * Math.PI)
    expect(parseAngle('pi*2')).toBe(Math.PI * 2)
    expect(parseAngle('(pi)/2')).toBe(Math.PI / 2)
    expect(parseAngle('pi/2+pi/4')).toBe(Math.PI / 2 + Math.PI / 4)
    expect(parseAngle('pi - pi/2')).toBe(Math.PI - Math.PI / 2)
    expect(parseAngle('--pi')).toBe(Math.PI)
    expect(parseAngle('+pi')).toBe(Math.PI)
  })

  it('the exact angles of the QFT and QPE challenges are exact doubles, so a fixed gate matches by equality', () => {
    // these are the values the backend writes in its challenge definitions (math.pi / 2, math.pi / 4, math.pi)
    expect(parseAngle('pi/2')).toBe(1.5707963267948966)
    expect(parseAngle('pi/4')).toBe(0.7853981633974483)
    expect(parseAngle('pi')).toBe(3.141592653589793)
    expect(parseAngle('-pi/4')).toBe(-0.7853981633974483)
  })

  it('refuses everything the grammar does not name, as null and never as a guess', () => {
    for (const text of ['', '   ', 'pi/', '/2', 'pi pi', 'tau', 'pix', 'pi2', '1/0', 'pi/0', '2**3', '(pi', 'pi)', '1,5', 'abs(1)', 'Math.PI', '1+', '0x10', 'NaN', 'Infinity', '1e999', 'alert(1)', 'pi;']) {
      expect(parseAngle(text), JSON.stringify(text)).toBeNull()
    }
  })

  it('never executes anything: an expression that looks like code is simply not an angle', () => {
    const g = globalThis as unknown as { __angleProbe?: number }
    g.__angleProbe = 0
    expect(parseAngle('(g.__angleProbe=1)')).toBeNull()
    expect(parseAngle('globalThis.__angleProbe = 1')).toBeNull()
    expect(g.__angleProbe).toBe(0)
  })

  it('is deterministic and keeps the sign of zero out of the way', () => {
    expect(parseAngle('pi/4')).toBe(parseAngle('pi/4'))
    expect(parseAngle('0')).toBe(0)
  })
})

describe('the QASM editor reads the same expressions', () => {
  const header = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\n'

  it('cp and the rotations accept pi expressions and give the same angles as typing the number', () => {
    const circuit = parseQasm3(header + 'cp(pi/2) q[0], q[1];\ncp(-pi/4) q[0], q[1];\nrz(pi) q[1];\nrx(2*pi/3) q[0];\nry(0.5) q[0];\n')
    expect(circuit.ops.map((o) => o.params[0])).toEqual([Math.PI / 2, -Math.PI / 4, Math.PI, (2 * Math.PI) / 3, 0.5])
  })

  it('an angle that is not an expression is still an error with its line, and nothing is partly applied', () => {
    expect(() => parseQasm3(header + 'cp(tau) q[0], q[1];\n')).toThrow(/unparsable angle "tau"/)
    expect(() => parseQasm3(header + 'rz(1/0) q[0];\n')).toThrow(/unparsable angle/)
    expect(() => parseQasm3(header + 'cp( ) q[0], q[1];\n')).toThrow(/unparsable angle/)
  })
})

describe('describeAngle: how an angle reads on the canvas', () => {
  it('names simple fractions of pi the way a textbook does', () => {
    const cases: Array<[number, string]> = [
      [Math.PI, 'π'], [-Math.PI, '-π'], [Math.PI / 2, 'π/2'], [-Math.PI / 2, '-π/2'], [Math.PI / 4, 'π/4'], [-Math.PI / 4, '-π/4'],
      [Math.PI / 8, 'π/8'], [(3 * Math.PI) / 4, '3π/4'], [(2 * Math.PI) / 3, '2π/3'], [2 * Math.PI, '2π'], [Math.PI / 3, 'π/3'], [(5 * Math.PI) / 8, '5π/8'],
    ]
    for (const [angle, text] of cases) expect(describeAngle(angle), text).toBe(text)
  })

  it('reduces fractions, and writes zero as 0', () => {
    expect(describeAngle((2 * Math.PI) / 4)).toBe('π/2')
    expect(describeAngle((4 * Math.PI) / 8)).toBe('π/2')
    expect(describeAngle(0)).toBe('0')
  })

  it('falls back to two decimals for any other angle, and never rounds the angle itself', () => {
    expect(describeAngle(0.5)).toBe('0.50')
    expect(describeAngle(1)).toBe('1.00')
    expect(describeAngle(-0.123)).toBe('-0.12')
    expect(describeAngle(Math.PI / 4 + 1e-3)).toBe('0.79')
    expect(parseAngle('pi/4')).toBe(Math.PI / 4) // the stored angle is the exact double
  })

  it('reads back: whatever describeAngle names as a fraction of pi parses to the same double', () => {
    for (const text of ['pi', '-pi', 'pi/2', '-pi/4', '3*pi/4', '2*pi/3', 'pi/8']) {
      const value = parseAngle(text)!
      const label = describeAngle(value).replace('π', 'pi').replace(/^(-?)(\d)pi/, '$1$2*pi')
      expect(parseAngle(label)).toBe(value)
    }
  })
})
