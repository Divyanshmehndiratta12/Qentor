/**
 * BlochSphere component tests. Every vector here is a value a (fixture)
 * BACKEND supplied; the component is only ever given that vector (never a
 * statevector or gate), so each test asserts "the UI shows exactly what it was
 * handed" — the position of the drawn vector included.
 *
 * Expected on-screen positions are written out from the documented fixed
 * camera in `blochProjection.ts` (centre 120, radius 84; +z up, +y right, +x
 * toward the viewer down-left), as plain literals rather than by calling the
 * projection under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { BlochSphere } from './BlochSphere'
import { singleBloch } from '@/test/traceFixtures'
import type { TraceBlochVector } from '@/api'

const MINUS = '−'

/** The BlochVector a fixture backend "returned" for (x, y, z). */
const bloch = (vector: [number, number, number], tag = 'a'): TraceBlochVector =>
  singleBloch(vector, tag).steps[0]!.blochVector!

const renderSphere = (b: TraceBlochVector | null, numQubits = 1) => render(<BlochSphere bloch={b} numQubits={numQubits} />)

const readout = () =>
  [...screen.getByTestId('bloch-readout').querySelectorAll('dd')].map((dd) => dd.textContent ?? '')

const endpoint = () => {
  const el = screen.getByTestId('bloch-endpoint')
  return { cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')) }
}

afterEach(() => cleanup())

describe('the named states, as supplied by the backend', () => {
  it.each([
    ['A  |0⟩  → +z', [0, 0, 1], ['0.000', '0.000', '1.000']],
    ['B  |1⟩  → −z', [0, 0, -1], ['0.000', '0.000', `${MINUS}1.000`]],
    ['C  |+⟩  → +x', [1, 0, 0], ['1.000', '0.000', '0.000']],
    ['D  |−⟩  → −x', [-1, 0, 0], [`${MINUS}1.000`, '0.000', '0.000']],
    ['E  |+i⟩ → +y', [0, 1, 0], ['0.000', '1.000', '0.000']],
    ['F  |−i⟩ → −y', [0, -1, 0], ['0.000', `${MINUS}1.000`, '0.000']],
  ] as Array<[string, [number, number, number], string[]]>)('%s: sphere, vector and x/y/z readout', (_name, vector, expected) => {
    renderSphere(bloch(vector))

    expect(screen.getByTestId('bloch-svg')).toBeInTheDocument()
    expect(screen.getByTestId('bloch-vector')).toBeInTheDocument()
    expect(screen.getByTestId('bloch-endpoint')).toBeInTheDocument()
    expect(readout()).toEqual(expected)
    expect(screen.getByTestId('bloch-readout')).toHaveAccessibleName('Bloch vector coordinates')
  })

  it('shows "x =", "y =", "z =" labels for the readout', () => {
    renderSphere(bloch([1, 0, 0]))
    const labels = [...screen.getByTestId('bloch-readout').querySelectorAll('dt')].map((dt) => dt.textContent)
    expect(labels).toEqual(['x =', 'y =', 'z ='])
  })
})

describe('the drawn vector visibly corresponds to the supplied coordinates', () => {
  // Centre (120, 120), radius 84; per-axis screen offsets from blochProjection.ts.
  it('+z points up the screen, −z down, both straight along the vertical', () => {
    renderSphere(bloch([0, 0, 1]))
    const up = endpoint()
    expect(up.cx).toBeCloseTo(120, 6)
    expect(up.cy).toBeCloseTo(120 - 84 * 0.951, 6) // ≈ 40.116

    cleanup()
    renderSphere(bloch([0, 0, -1]))
    const down = endpoint()
    expect(down.cx).toBeCloseTo(120, 6)
    expect(down.cy).toBeCloseTo(120 + 84 * 0.951, 6) // ≈ 199.884
  })

  it('+x and −x are opposite through the centre (x toward the viewer: down-left)', () => {
    renderSphere(bloch([1, 0, 0]))
    const plusX = endpoint()
    expect(plusX.cx).toBeCloseTo(120 - 84 * 0.5, 6) // 78
    expect(plusX.cy).toBeCloseTo(120 + 84 * 0.268, 6) // ≈ 142.512

    cleanup()
    renderSphere(bloch([-1, 0, 0]))
    const minusX = endpoint()
    expect(minusX.cx).toBeCloseTo(240 - plusX.cx, 6)
    expect(minusX.cy).toBeCloseTo(240 - plusX.cy, 6)
  })

  it('+y is to the right of the centre and −y to the left', () => {
    renderSphere(bloch([0, 1, 0]))
    const plusY = endpoint()
    expect(plusY.cx).toBeCloseTo(120 + 84 * 0.866, 6)
    expect(plusY.cx).toBeGreaterThan(120)

    cleanup()
    renderSphere(bloch([0, -1, 0]))
    expect(endpoint().cx).toBeCloseTo(240 - plusY.cx, 6)
    expect(endpoint().cx).toBeLessThan(120)
  })

  it('the vector line runs from the centre to the same point as the endpoint marker', () => {
    renderSphere(bloch([0.6, 0, -0.8]))
    const line = screen.getByTestId('bloch-vector').querySelector('line')!
    expect(Number(line.getAttribute('x1'))).toBe(120)
    expect(Number(line.getAttribute('y1'))).toBe(120)
    expect(Number(line.getAttribute('x2'))).toBeCloseTo(endpoint().cx, 9)
    expect(Number(line.getAttribute('y2'))).toBeCloseTo(endpoint().cy, 9)
  })

  it('a mixed vector lands where the linear projection of exactly those numbers says', () => {
    renderSphere(bloch([0.6, 0, -0.8]))
    const { cx, cy } = endpoint()
    expect(cx).toBeCloseTo(120 + 84 * (-0.5 * 0.6), 6) // 94.8
    expect(cy).toBeCloseTo(120 + 84 * (0.268 * 0.6 + -0.951 * -0.8), 6) // ≈ 197.3
  })
})

describe('the sphere follows the supplied vector, not the state or any gate', () => {
  it('shows a vector that contradicts what |0> would suggest, exactly as supplied', () => {
    // singleBloch's statevector is |0> (textbook +z); the supplied vector is elsewhere.
    renderSphere(bloch([0.6, 0, -0.8]))
    expect(readout()).toEqual(['0.600', '0.000', `${MINUS}0.800`])
  })

  it('is handed nothing from which a coordinate could be derived (props are just the vector and a qubit count)', () => {
    const view = renderSphere(bloch([1, 0, 0]))
    // Same vector, different (irrelevant) qubit count → same drawing.
    const first = { ...endpoint(), values: readout() }
    view.unmount()
    renderSphere(bloch([1, 0, 0]), 1)
    expect({ ...endpoint(), values: readout() }).toEqual(first)
  })
})

describe('global-phase-equivalent backend vectors render identically', () => {
  it('two states differing only by a global phase arrive with the same vector and produce the same picture', () => {
    // Different tags → different result ids etc., but the SAME backend vector (0, 1, 0).
    const a = bloch([0, 1, 0], 'a')
    const b = bloch([0, 1, 0], 'b')

    const first = renderSphere(a)
    const one = { readout: readout(), endpoint: endpoint(), facing: screen.getByTestId('bloch-vector').getAttribute('data-facing') }
    first.unmount()
    renderSphere(b)
    const two = { readout: readout(), endpoint: endpoint(), facing: screen.getByTestId('bloch-vector').getAttribute('data-facing') }

    expect(two).toEqual(one)
  })
})

describe('depth cue and labels (not colour alone)', () => {
  it('draws a vector on the near side solid and on the far side dashed, and says which', () => {
    renderSphere(bloch([1, 0, 0]))
    const near = screen.getByTestId('bloch-vector')
    expect(near).toHaveAttribute('data-facing', 'near')
    expect(near.querySelector('line')).not.toHaveAttribute('stroke-dasharray')

    cleanup()
    renderSphere(bloch([0, 0, -1])) // points away from the viewer in this camera
    const far = screen.getByTestId('bloch-vector')
    expect(far).toHaveAttribute('data-facing', 'far')
    expect(far.querySelector('line')).toHaveAttribute('stroke-dasharray')
  })

  it('labels all six poles with their standard states', () => {
    renderSphere(bloch([0, 0, 1]))
    const pole = (name: string) => screen.getByTestId(`bloch-pole-${name}`).textContent
    expect(pole('+z')).toBe('|0⟩+z')
    expect(pole(`${MINUS}z`)).toBe(`|1⟩${MINUS}z`)
    expect(pole('+x')).toBe('|+⟩+x')
    expect(pole(`${MINUS}x`)).toBe(`|${MINUS}⟩${MINUS}x`)
    expect(pole('+y')).toBe('|+i⟩+y')
    expect(pole(`${MINUS}y`)).toBe(`|${MINUS}i⟩${MINUS}y`)
  })

  it('draws the pole labels large enough to read, with a halo so the vector or an axis cannot hide them', () => {
    renderSphere(bloch([1, 0, 0])) // the vector ends right beside |+⟩
    const group = screen.getByTestId('bloch-pole-+x').parentElement!
    expect(Number(group.getAttribute('font-size'))).toBeGreaterThanOrEqual(11) // the ket
    expect(group.getAttribute('paint-order')).toBe('stroke') // dark outline behind the glyphs
    expect(Number(group.getAttribute('stroke-width'))).toBeGreaterThan(0)
    for (const label of group.querySelectorAll('tspan[font-size]')) {
      expect(Number(label.getAttribute('font-size'))).toBeGreaterThanOrEqual(9) // the axis name (was 8)
    }
  })

  it('keeps every pole label inside the drawing, so larger text cannot be clipped', () => {
    renderSphere(bloch([0, 0, 1]))
    const box = screen.getByTestId('bloch-svg').getAttribute('viewBox')!.split(' ').map(Number)
    const [, , width, height] = box as [number, number, number, number]
    for (const name of ['+z', `${MINUS}z`, '+x', `${MINUS}x`, '+y', `${MINUS}y`]) {
      const text = screen.getByTestId(`bloch-pole-${name}`)
      const x = Number(text.getAttribute('x'))
      const y = Number(text.getAttribute('y'))
      const half = 14 // half of the widest label ("|−i⟩" at 11px) in drawing units
      expect(x - half).toBeGreaterThanOrEqual(0)
      expect(x + half).toBeLessThanOrEqual(width)
      expect(y - 9).toBeGreaterThanOrEqual(0) // the ket's ascent above its baseline
      expect(y + 10 + 2).toBeLessThanOrEqual(height) // the axis name one line below, plus its descent
    }
  })

  it('has an arrowhead and an endpoint marker in addition to any colour', () => {
    const { container } = renderSphere(bloch([1, 0, 0]))
    expect(container.querySelector('marker')).not.toBeNull()
    expect(screen.getByTestId('bloch-vector').querySelector('line')!.getAttribute('marker-end')).toMatch(/^url\(#bloch-arrow-/)
    expect(screen.getByTestId('bloch-endpoint')).toBeInTheDocument()
  })
})

describe('accessibility: a screen reader gets the coordinates without the graphic', () => {
  it('the SVG is an image whose accessible name states the backend-provided x, y, z', () => {
    renderSphere(bloch([0, 0, -1]))

    const img = screen.getByRole('img', { name: /Bloch sphere/ })
    expect(img).toHaveAccessibleName(`Bloch sphere. Backend-provided vector: x = 0.000, y = 0.000, z = ${MINUS}1.000.`)
    expect(img.querySelector('title')?.textContent).toBe(img.getAttribute('aria-label'))
  })

  it('the same coordinates are in a visible text readout, and the caption says where they come from', () => {
    renderSphere(bloch([1, 0, 0]))
    expect(within(screen.getByTestId('bloch-readout')).getByText('1.000')).toBeVisible()
    expect(screen.getByText('Bloch vector for this backend-produced state.')).toBeInTheDocument()
  })

  it('the section is a labelled region with a heading', () => {
    renderSphere(bloch([1, 0, 0]))
    expect(screen.getByRole('region', { name: 'Bloch sphere' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Bloch sphere' })).toBeInTheDocument()
  })

  it('availability is stated in text when there IS a vector and when there is NOT', () => {
    renderSphere(bloch([1, 0, 0]))
    expect(screen.queryByText('Bloch sphere unavailable for this state.')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toBeInTheDocument()

    cleanup()
    renderSphere(null, 2)
    expect(screen.getByText('Bloch sphere unavailable for this state.')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('multi-qubit / no vector: nothing is fabricated', () => {
  it('a null vector on a multi-qubit state shows an explanation — no sphere, vector, marker or readout', () => {
    renderSphere(null, 2)

    expect(screen.getByTestId('bloch-unavailable')).toBeInTheDocument()
    expect(screen.getByText('Bloch sphere unavailable for this state.')).toBeInTheDocument()
    expect(screen.getByText('Single-qubit Bloch vector unavailable for this multi-qubit state.')).toBeInTheDocument()
    expect(screen.getByText(/only provides one for single-qubit trace states/)).toBeInTheDocument()
    expect(screen.getByText(/entangled state such as a Bell state/)).toBeInTheDocument()

    for (const id of ['bloch-svg', 'bloch-vector', 'bloch-endpoint', 'bloch-readout']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(document.querySelector('svg')).toBeNull()
  })

  it('does not show a zero vector or any coordinates in place of the missing one', () => {
    renderSphere(null, 3)
    expect(screen.queryByText(/x =/)).not.toBeInTheDocument()
    expect(screen.queryByText('0.000')).not.toBeInTheDocument()
  })

  it('a single-qubit step the backend sent no vector for says so plainly, with different wording', () => {
    renderSphere(null, 1)
    expect(screen.getByText('Bloch sphere unavailable for this state.')).toBeInTheDocument()
    expect(screen.getByText(/backend did not provide a Bloch vector for this step/)).toBeInTheDocument()
    expect(screen.queryByText(/multi-qubit/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('bloch-svg')).not.toBeInTheDocument()
  })
})

describe('malformed / out-of-range values are shown as received, never corrected', () => {
  it('a coordinate beyond the unit ball: readout shows it as received, an alert explains, the vector is NOT drawn', () => {
    renderSphere(bloch([1.5, 0, 0]))

    expect(readout()).toEqual(['1.500', '0.000', '0.000'])
    expect(screen.getByRole('alert')).toHaveTextContent('outside the unit sphere')
    expect(screen.getByRole('alert')).toHaveTextContent('Qentor does not correct it')
    expect(screen.queryByTestId('bloch-vector')).not.toBeInTheDocument()
    expect(screen.queryByTestId('bloch-endpoint')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAccessibleName(/Outside the unit sphere, so not drawn\./)
  })

  it.each([[[0, -1.0001, 0]], [[0, 0, 7]], [[-3, 0, 0]]] as Array<[[number, number, number]]>)(
    '%j is not drawn',
    (vector) => {
      renderSphere(bloch(vector))
      expect(screen.queryByTestId('bloch-vector')).not.toBeInTheDocument()
    },
  )

  it('a value a hair over 1 (legitimate: the backend’s state is normalised only to 1e-9) IS drawn, unclamped', () => {
    renderSphere(bloch([1.0000000002, 0, 0]))

    expect(screen.getByTestId('bloch-vector')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Not snapped to the sphere surface: the marker is 84 * 0.5 * 2e-10 past where exactly 1 lands (78).
    const cx = screen.getByTestId('bloch-endpoint').getAttribute('cx')
    expect(cx).not.toBe('78')
    expect(Number(cx)).toBeLessThan(78)
    expect(Number(cx)).toBeGreaterThan(77.99999)
  })

  it('a non-finite coordinate is not drawn', () => {
    const b = bloch([0, 0, 1])
    const broken: TraceBlochVector = {
      ...b,
      coordinates: { ...b.coordinates, value: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 } },
    }
    renderSphere(broken)
    expect(screen.queryByTestId('bloch-vector')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})

describe('display formatting never changes the underlying numbers', () => {
  it('~1e-16 residues display as clean zeros, with no "−0.000"', () => {
    renderSphere(bloch([4.440892098500626e-16, -1.2246467991473532e-16, -1]))

    expect(readout()).toEqual(['0.000', '0.000', `${MINUS}1.000`])
    expect(screen.getByTestId('bloch-readout').textContent).not.toContain(`${MINUS}0.000`)
  })

  it('a meaningful coordinate keeps its precision for reading (3 decimals)', () => {
    renderSphere(bloch([0.7071067811865475, 0.1234567, -0.5]))
    expect(readout()).toEqual(['0.707', '0.123', `${MINUS}0.500`])
  })

  it('the exact backend value stays available on each readout (title), unrounded', () => {
    renderSphere(bloch([4.440892098500626e-16, -1.2246467991473532e-16, 0.7071067811865475]))

    expect(screen.getByTitle('exact value from the backend: 4.440892098500626e-16')).toBeInTheDocument()
    expect(screen.getByTitle('exact value from the backend: -1.2246467991473532e-16')).toBeInTheDocument()
    expect(screen.getByTitle('exact value from the backend: 0.7071067811865475')).toBeInTheDocument()
  })

  it('rendering does not mutate the vector it was given (a frozen vector renders fine and is unchanged)', () => {
    const b = bloch([4.440892098500626e-16, -1.2246467991473532e-16, -1])
    Object.freeze(b.coordinates.value)
    Object.freeze(b.coordinates)
    Object.freeze(b)

    renderSphere(b)

    expect(b.coordinates.value).toEqual({ x: 4.440892098500626e-16, y: -1.2246467991473532e-16, z: -1 })
    expect(b.coordinates.value.x).toBe(4.440892098500626e-16)
  })
})

describe('provenance of the vector', () => {
  it('names the exact source step, result, execution, prefix circuit and backend', () => {
    renderSphere(bloch([1, 0, 0], 'src'))

    const dl = screen.getByText('Derived from').closest('div')!.parentElement!
    const field = (label: string) => within(dl).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent
    expect(field('source step')).toBe('trace step 1')
    expect(field('source result')).toBe('res_src0')
    expect(field('source execution')).toBe('aer-local-src0')
    expect(field('source circuit')).toBe('hash_prefix_src0')
    expect(field('source backend')).toBe('qiskit-aer 0.17.2')
    expect(field('method')).toBe('bloch-from-statevector/1')
  })

  it('shows the existing provenance badge, and each coordinate carries the provenance tooltip', () => {
    renderSphere(bloch([1, 0, 0], 'src'))

    expect(screen.getByText('Simulated')).toBeInTheDocument()
    expect(screen.getAllByTitle(/SIMULATION · qiskit-aer · res_src0/).length).toBeGreaterThanOrEqual(3)
  })

  it('calls it backend-derived state data — explicitly not a correctness verdict', () => {
    renderSphere(bloch([1, 0, 0]))

    expect(screen.getByText(/Backend-derived state data/)).toBeInTheDocument()
    expect(screen.getByText(/not a statement about whether your circuit is correct/)).toBeInTheDocument()
    expect(screen.queryByText(/^verified$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/circuit verified|correct circuit|passed/i)).not.toBeInTheDocument()
  })
})

describe('no quantum calculation happens while rendering', () => {
  it('never calls a math primitive', () => {
    const spies = (['sqrt', 'hypot', 'pow', 'random', 'atan2', 'atan', 'cos', 'sin', 'acos', 'asin', 'exp', 'log'] as const).map(
      (fn) => vi.spyOn(Math, fn),
    )

    renderSphere(bloch([0.6, 0.3, -0.8]))
    cleanup()
    renderSphere(null, 2)

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    spies.forEach((spy) => spy.mockRestore())
  })

  it('renders deterministically: the same vector always gives the same picture', () => {
    const first = renderSphere(bloch([0.6, 0.3, -0.8]))
    const a = { readout: readout(), endpoint: endpoint() }
    first.unmount()
    renderSphere(bloch([0.6, 0.3, -0.8]))
    expect({ readout: readout(), endpoint: endpoint() }).toEqual(a)
  })
})
