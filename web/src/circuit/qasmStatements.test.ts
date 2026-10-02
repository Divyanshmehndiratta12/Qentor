/**
 * The code editor's reader takes a program the way OpenQASM writes one: a statement ends at ";", so it can run over several lines,
 * several can share a line, and comments are ignored. (It used to read one statement per line, so a perfectly good `cp(pi/4)` split over
 * three lines, or a `// note`, was refused in the editor although the server's own parser accepts both.) A reported line is the editor's
 * own line number, blank lines and comments included.
 */
import { describe, expect, it } from 'vitest'
import { QasmParseError, parseQasm3, splitStatements } from './qasmParser'
import { toQasm3 } from './qasmEmitter'

const HEAD = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nbit[2] c;\n'
const ops = (src: string) => parseQasm3(src).ops.map((o) => [o.gate, o.targets, o.controls, o.params])

describe('statements may span lines and share lines', () => {
  it('a controlled phase split over three lines is one cp', () => {
    expect(ops(`${HEAD}cp(pi/4)\n  q[0],\n  q[1];\n`)).toEqual([['cp', [1], [0], [Math.PI / 4]]])
  })

  it('an angle opened on one line and closed on the next', () => {
    expect(ops(`${HEAD}rx(\n -pi/2) q[0];\n`)).toEqual([['rx', [0], [], [-Math.PI / 2]]])
  })

  it('two statements on one line', () => {
    expect(ops(`${HEAD}h q[0]; h q[1];\n`)).toEqual([['h', [0], [], []], ['h', [1], [], []]])
  })

  it('a space before the semicolon, tabs and Windows line endings', () => {
    expect(ops(`${HEAD}h q[0] ;\r\n\tcx q[0],\tq[1] ;\r\n`)).toEqual([['h', [0], [], []], ['cx', [1], [0], []]])
  })

  it('a measurement split at its equals sign', () => {
    expect(ops(`${HEAD}c[0]\n  = measure q[0];\n`)).toEqual([['measure', [0], [], []]])
  })
})

describe('comments are ignored', () => {
  it('a line comment, alone and after a statement', () => {
    expect(ops(`${HEAD}// prepare\nh q[0]; // superposition\n`)).toEqual([['h', [0], [], []]])
  })

  it('a block comment, even one that spans lines or sits inside a statement', () => {
    expect(ops(`${HEAD}/* first\n   second */\nh /* the gate */ q[0];\n`)).toEqual([['h', [0], [], []]])
  })

  it('a semicolon inside a comment does not end a statement', () => {
    expect(ops(`${HEAD}h q[0]; // one; two; three;\ncx q[0], q[1];\n`)).toEqual([['h', [0], [], []], ['cx', [1], [0], []]])
  })

  it('a comment that never closes swallows the rest, and nothing after it runs', () => {
    expect(ops(`${HEAD}h q[0];\n/* never closed\nx q[1];\n`)).toEqual([['h', [0], [], []]])
  })
})

describe('an error names the editor line the statement starts on', () => {
  const failing = (src: string) => {
    try {
      parseQasm3(src)
    } catch (err) {
      return err as QasmParseError
    }
    throw new Error('expected a refusal')
  }

  it('counts blank lines and comments', () => {
    const err = failing(`${HEAD}\n// note\n\nfoo q[0];\n`)
    expect(err).toBeInstanceOf(QasmParseError)
    expect(err.line).toBe(8)
    expect(err.message).toContain('foo')
  })

  it('a multi-line statement is reported on its first line', () => {
    expect(failing(`${HEAD}wobble(\n  1)\n q[0];\n`).line).toBe(5)
  })

  it('text after the last semicolon is refused, not dropped', () => {
    const err = failing(`${HEAD}h q[0];\nx q[1]`)
    expect(err.line).toBe(6)
    expect(err.message).toContain('unrecognised statement')
  })

  it('a program with no qubit declaration is still refused', () => {
    expect(() => parseQasm3('OPENQASM 3.0;\nh q[0];\n')).toThrow(QasmParseError)
  })
})

describe('what the app writes still reads back, and splitting is exact', () => {
  it('the emitter output round-trips', () => {
    const circuit = parseQasm3(`${HEAD}h q[0];\ncp(pi/2) q[0], q[1];\nrz(0.25) q[1];\nc[0] = measure q[0];\n`)
    expect(parseQasm3(toQasm3(circuit))).toEqual(circuit)
  })

  it('splitStatements gives one trimmed single-line statement per ";" with its starting line', () => {
    expect(splitStatements('a  b\n c ;\n\n  d;')).toEqual([
      { text: 'a b c;', line: 1 },
      { text: 'd;', line: 4 },
    ])
  })
})
