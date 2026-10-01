/**
 * How tall the circuit workspace is on a phone, where it is a fixed-height box in a scrolling page (from `lg` up it fills the column and this is
 * not used). The wires are drawn 3.75rem (60 px) apart, so a fixed height that fits three wires hides the last of five behind the box's own
 * scrollbar: the error-correction register measured 351 px of content in a 312 px box. The height therefore follows the register.
 * The figures were measured in real Chrome at 390 and 320 px: the canvas box needs its content plus 15 px for a horizontal scrollbar, and the
 * toolbar, selected-gate bar and palette strip around it take about 168 px (challenge screen) or 170 px (Lab); in the Lab the canvas gets 3/5
 * of the column, or 5/7 from four qubits (`BuildScreen`). One extra rem of margin on top.
 */
export const WIRE_PITCH_REM = 3.75

const PX_PER_REM = 16
const CONTENT_FIVE_WIRES_PX = 351
const SCROLLBAR_PX = 15
const MARGIN_PX = 16
const WIRE_PITCH_PX = WIRE_PITCH_REM * PX_PER_REM

/** Challenge screen: the canvas and its palette strip as one box. 30rem is enough up to four qubits. */
export function challengeCanvasRem(numQubits: number): number {
  const box = CONTENT_FIVE_WIRES_PX + WIRE_PITCH_PX * (numQubits - 5) + SCROLLBAR_PX
  return Math.max(30, (box + 168 + MARGIN_PX) / PX_PER_REM)
}

function labNeedRem(numQubits: number, share: number): number {
  const box = CONTENT_FIVE_WIRES_PX + WIRE_PITCH_PX * (numQubits - 5) + SCROLLBAR_PX
  return (box + 170 + MARGIN_PX) / share / PX_PER_REM
}

/** Lab: the whole canvas column on a phone. 40rem is enough for two qubits. Never shrinks as qubits are added. */
export function labColumnRem(numQubits: number): number {
  const own = labNeedRem(numQubits, numQubits >= 4 ? 5 / 7 : 3 / 5)
  const fromThree = numQubits >= 4 ? labNeedRem(3, 3 / 5) : 0 // the step to the taller share must not make a bigger register shorter
  return Math.max(40, own, fromThree)
}
