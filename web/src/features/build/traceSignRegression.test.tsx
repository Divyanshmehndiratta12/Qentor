/**
 * Regression: H -> Z -> H, Step 2 (Z on q0).
 *
 * The backend returns, for Step 2,
 *     [[0.7071067811865476, 0.0], [-0.7071067811865475, 0.0]]
 * so the |1> amplitude is NEGATIVE. A browser once displayed it as
 * "0.707 + 0.000i" (sign lost). The cause was a stale dev-server module that
 * took the real part through Math.sqrt(re * re) (i.e. |re|) — not a defect in
 * the committed source — but a sign-losing viewer is exactly the kind of quiet
 * wrong-answer that must never pass, so this pins the behaviour end to end.
 *
 * The numbers below are the backend's ACTUAL output for this circuit (incl.
 * the 1-ulp asymmetry between 0.7071067811865476 / ...475 and the ~1e-16
 * residue on the last step), delivered as JSON TEXT through a stubbed `fetch`
 * into the REAL RealApiClient -> zod -> QuantumValue -> Build store ->
 * TracePanel/TraceViewer -> formatting chain. The expected strings are derived
 * independently (test-side, from the raw numbers), never from the formatter
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { emptyCircuit } from '@/circuit/types'
import { RealApiClient } from '@/api/realClient'
import { H0, Z0, wireTrace } from '@/test/traceFixtures'
import { useBuildStore } from './store'
import { TracePanel } from './TracePanel'
import { formatAmplitude } from './traceFormat'

const MINUS = '−'

/** The backend's real H -> Z -> H trace states, verbatim. */
const BACKEND_STATES: number[][][] = [
  [[1.0, 0.0], [0.0, 0.0]],
  [[0.7071067811865476, 0.0], [0.7071067811865475, 0.0]],
  [[0.7071067811865476, 0.0], [-0.7071067811865475, 0.0]],
  [[2.220446049250313e-16, 6.123233995736765e-17], [1.0, -6.123233995736766e-17]],
]

/** What the network delivers: JSON TEXT, parsed by the browser's own JSON. */
const RESPONSE_TEXT = JSON.stringify(wireTrace({ numQubits: 1, ops: [H0, Z0, H0], states: BACKEND_STATES as never }))
const CIRCUIT = { ...emptyCircuit(1), ops: [H0, Z0, H0] }

const INITIAL_STATE = useBuildStore.getState()

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(RESPONSE_TEXT, { status: 200 })))
  useBuildStore.setState(INITIAL_STATE, true)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useBuildStore.setState(INITIAL_STATE, true)
})

/** Test-side oracle for one component, from the raw number only. */
function expectedComponent(value: number): { negative: boolean; magnitude: string } {
  const magnitude = Math.abs(value).toFixed(3)
  return { magnitude, negative: value < 0 && magnitude !== '0.000' } // "-0.000" is shown as plain 0.000
}

async function renderTraceAndOpenStep(step: number) {
  act(() => useBuildStore.getState().loadCircuit(CIRCUIT))
  render(<TracePanel />)
  fireEvent.click(screen.getByRole('button', { name: 'Run trace' }))
  await screen.findByRole('group', { name: 'Trace steps' })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Step ${step}:`) }))
}

function displayedRows(): Array<[string, string]> {
  return screen
    .getAllByRole('row')
    .slice(1) // header
    .map((row) => {
      const cells = row.querySelectorAll('td')
      return [cells[0]!.textContent ?? '', cells[1]!.textContent ?? '']
    })
}

describe('H -> Z -> H trace: signs survive from the backend to the screen', () => {
  it('Step 2 (Z on q0) shows |0⟩ +0.707 and |1⟩ −0.707 — the backend’s negative amplitude', async () => {
    await renderTraceAndOpenStep(2)

    expect(screen.getByText('Z on q0')).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()
    expect(displayedRows()).toEqual([
      ['|0⟩', '0.707 + 0.000i'],
      ['|1⟩', `${MINUS}0.707 + 0.000i`], // <- the one that was shown as 0.707
    ])
  })

  it('the |1⟩ row of Step 2 begins with a minus sign (U+2212) and differs from Step 1’s +0.707', async () => {
    await renderTraceAndOpenStep(2)
    const step2 = displayedRows()[1]![1]
    expect(step2.codePointAt(0)).toBe(0x2212)

    fireEvent.click(screen.getByRole('button', { name: /^Step 1:/ }))
    const step1 = displayedRows()[1]![1]
    expect(step1).toBe('0.707 + 0.000i')
    expect(step1).not.toBe(step2)
  })

  it('every step displays exactly the sign and 3-decimal magnitude the backend sent, for every component', async () => {
    await renderTraceAndOpenStep(0)

    for (let step = 0; step < BACKEND_STATES.length; step++) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Step ${step}:`) }))
      const shown = displayedRows().map(([, amplitude]) => amplitude)

      BACKEND_STATES[step]!.forEach(([re, im], basisIndex) => {
        const reWant = expectedComponent(re)
        const imWant = expectedComponent(im)
        const expected =
          `${reWant.negative ? MINUS : ''}${reWant.magnitude} ` +
          `${imWant.negative ? MINUS : '+'} ${imWant.magnitude}i`
        expect(shown[basisIndex], `step ${step}, basis index ${basisIndex}`).toBe(expected)
      })
    }
  })

  it('the ~1e-16 residue on the final step displays as plain zeros — never "−0.000"', async () => {
    await renderTraceAndOpenStep(3)

    expect(displayedRows()).toEqual([
      ['|0⟩', '0.000 + 0.000i'], // [2.2e-16, 6.1e-17]
      ['|1⟩', '1.000 + 0.000i'], // [1.0, -6.1e-17]
    ])
    expect(screen.getByRole('table').textContent).not.toContain(`${MINUS}0.000`)
  })

  it('the values are exactly the JSON numbers at every stage — no rounding, abs, or rescaling anywhere', async () => {
    const wire = JSON.parse(RESPONSE_TEXT) as { steps: Array<{ statevector: number[][] }> }

    // Stage: RealApiClient (zod parse + camelCase mapping).
    const viaClient = await new RealApiClient().traceCircuit(CIRCUIT)
    viaClient.steps.forEach((step, i) => expect(step.state.value).toEqual(wire.steps[i]!.statevector))
    expect(viaClient.steps[2]!.state.value[1]![0]).toBe(-0.7071067811865475)

    // Stage: Build store.
    await renderTraceAndOpenStep(2)
    const stored = useBuildStore.getState().trace!
    stored.steps.forEach((step, i) => expect(step.state.value).toEqual(wire.steps[i]!.statevector))
    expect(stored.steps[2]!.state.value[1]![0]).toBe(-0.7071067811865475)
  })
})

describe('formatAmplitude keeps the sign of the real and imaginary components', () => {
  it.each([
    [[0.7071067811865476, 0], '0.707 + 0.000i'],
    [[-0.7071067811865475, 0], `${MINUS}0.707 + 0.000i`],
    [[0, -0.7071067811865475], `0.000 ${MINUS} 0.707i`],
    [[-0.5, -0.5], `${MINUS}0.500 ${MINUS} 0.500i`],
    [[-1, 0], `${MINUS}1.000 + 0.000i`],
    [[2.220446049250313e-16, 6.123233995736765e-17], '0.000 + 0.000i'],
    [[1, -6.123233995736766e-17], '1.000 + 0.000i'],
    [[-2.220446049250313e-16, -6.123233995736766e-17], '0.000 + 0.000i'],
  ] as Array<[[number, number], string]>)('%j -> %s', (amplitude, expected) => {
    expect(formatAmplitude(amplitude)).toBe(expected)
  })

  it('a value and its negation never format the same unless they round to zero', () => {
    for (const v of [0.001, 0.25, 0.7071067811865475, 1, 3.5]) {
      expect(formatAmplitude([v, 0])).not.toBe(formatAmplitude([-v, 0]))
    }
  })
})
