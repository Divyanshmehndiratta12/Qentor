/**
 * Angle expressions such as `1.5707963`, `pi/2` or `-3*pi/4`, for the palette's angle box and for QASM typed in the editor.
 *
 * The grammar is the server's own (`qentor.circuit.qasm_parse.read_angle`) and nothing else exists, so nothing else can be
 * evaluated:
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := ('+' | '-') factor | atom
 *   atom   := number | pi | π | '(' expr ')'
 *
 * This is how a learner writes "a quarter of a turn" without typing sixteen digits; it is not a quantum quantity, it is the angle
 * a person asked for. An angle that does not parse is `null` (the caller says so), never a guess. The same expression gives the same
 * double here and on the server (π divided by a power of two is exact in both).
 */

const NUMBER = /^(?:\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/

class AngleError extends Error {}

class Reader {
  private pos = 0
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  read(): number {
    const value = this.expr()
    if (this.peek() !== '') throw new AngleError(`unexpected ${this.text.slice(this.pos, this.pos + 8)}`)
    if (!Number.isFinite(value)) throw new AngleError('the angle is not a finite number')
    return value
  }

  private peek(): string {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos += 1
    return this.pos < this.text.length ? this.text[this.pos]! : ''
  }

  private expr(): number {
    let value = this.term()
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.peek()
      this.pos += 1
      const rhs = this.term()
      value = op === '+' ? value + rhs : value - rhs
    }
    return value
  }

  private term(): number {
    let value = this.factor()
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.peek()
      if (op === '*' && this.text.slice(this.pos, this.pos + 2) === '**') throw new AngleError('powers (**) are not supported')
      this.pos += 1
      const rhs = this.factor()
      if (op === '/' && rhs === 0) throw new AngleError('division by zero')
      value = op === '*' ? value * rhs : value / rhs
    }
    return value
  }

  private factor(): number {
    const ch = this.peek()
    if (ch === '+' || ch === '-') {
      this.pos += 1
      const inner = this.factor()
      return ch === '+' ? inner : -inner
    }
    return this.atom()
  }

  private atom(): number {
    const ch = this.peek()
    if (ch === '(') {
      this.pos += 1
      const value = this.expr()
      if (this.peek() !== ')') throw new AngleError("a '(' is never closed")
      this.pos += 1
      return value
    }
    const match = NUMBER.exec(this.text.slice(this.pos))
    if (match) {
      this.pos += match[0].length
      return Number(match[0])
    }
    for (const name of ['pi', 'π']) {
      if (this.text.startsWith(name, this.pos)) {
        const end = this.pos + name.length
        const next = end < this.text.length ? this.text[end]! : ''
        if (next !== '' && /[A-Za-z0-9_]/.test(next)) break
        this.pos = end
        return Math.PI
      }
    }
    throw new AngleError(`cannot read ${this.text.slice(this.pos, this.pos + 10)} as a number`)
  }
}

/** The value of an angle expression in radians, or `null` when it is empty or not one. */
export function parseAngle(text: string): number | null {
  if (text.trim() === '') return null
  try {
    return new Reader(text).read()
  } catch (err) {
    if (err instanceof AngleError) return null
    throw err
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b)
}

/**
 * How an angle reads on the canvas: `π/4`, `-π/2`, `3π/4` when it is a simple fraction of π (the angles of the QFT and phase
 * estimation), otherwise two decimals. A label for a person; the angle itself is never rounded.
 */
export function describeAngle(angle: number): string {
  if (angle === 0) return '0'
  const ratio = angle / Math.PI
  for (const d of [1, 2, 3, 4, 6, 8, 12, 16]) {
    const n = Math.round(ratio * d)
    if (n !== 0 && Math.abs(ratio * d - n) < 1e-9 && Math.abs(n) <= 4 * d) {
      const g = gcd(n, d)
      const num = n / g
      const den = d / g
      const sign = num < 0 ? '-' : ''
      const mag = Math.abs(num)
      const top = mag === 1 ? 'π' : `${mag}π`
      return den === 1 ? `${sign}${top}` : `${sign}${top}/${den}`
    }
  }
  return angle.toFixed(2)
}
