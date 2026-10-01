import { describe, expect, it } from 'vitest'
import { challengeCanvasRem, labColumnRem, WIRE_PITCH_REM } from './canvasHeight'

describe('the phone workspace height follows the register', () => {
  it('keeps the existing heights for small registers', () => {
    for (const n of [1, 2, 3]) expect(challengeCanvasRem(n)).toBe(30)
    expect(challengeCanvasRem(4)).toBeGreaterThanOrEqual(30)
    for (const n of [1, 2]) expect(labColumnRem(n)).toBe(40)
  })

  it('the five-qubit challenge canvas is the height measured to fit it (about 34.4rem with a rem of margin)', () => {
    expect(challengeCanvasRem(5)).toBeCloseTo(34.4, 1)
  })

  it('grows by one wire pitch for each qubit beyond what fits, so the last wire is never behind the scrollbar', () => {
    expect(challengeCanvasRem(6) - challengeCanvasRem(5)).toBeCloseTo(WIRE_PITCH_REM, 5)
    expect(challengeCanvasRem(8)).toBeGreaterThan(challengeCanvasRem(5))
    // the Lab's canvas gets five sevenths of the column from four qubits: its extra height per qubit is a full wire pitch
    expect(((labColumnRem(7) - labColumnRem(6)) * 5) / 7).toBeCloseTo(WIRE_PITCH_REM, 5)
  })

  it('never shrinks as qubits are added (including at the step from three to four, where the canvas gets a bigger share)', () => {
    for (let n = 1; n < 32; n++) {
      expect(challengeCanvasRem(n + 1)).toBeGreaterThanOrEqual(challengeCanvasRem(n))
      expect(labColumnRem(n + 1)).toBeGreaterThanOrEqual(labColumnRem(n))
    }
  })

  it('the default three-qubit Lab and a five-qubit one both fit their wires', () => {
    // content + scrollbar must fit in the canvas share of the column, after the ~170px of toolbar and palette
    const fits = (n: number, share: number) => labColumnRem(n) * 16 * share - 170 >= 351 + 60 * (n - 5) + 15
    expect(fits(3, 3 / 5)).toBe(true)
    for (const n of [4, 5, 6, 8]) expect(fits(n, 5 / 7)).toBe(true)
  })
})
