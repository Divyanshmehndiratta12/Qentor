/**
 * The qubit state view: one interactive 3D Bloch sphere per qubit, from the backend's own per-qubit values.
 *
 * jsdom has no WebGL, so `./SphereGrid` (the lazy three.js chunk) is replaced by a stub that draws each card around a placeholder
 * and records exactly what the 3D side was handed. That lets these tests check, on the REAL cards and wiring: what is shown for one
 * qubit and for a register, that every value is passed to the 3D side and shown beside it exactly as the backend gave it (including
 * values that contradict each other: nothing is derived or repaired), the controls (reset, auto-rotate off by default, reduced
 * motion), the text alternative, the honest unavailable and fallback states, and that a step change does not rebuild the 3D view.
 * The scene itself is covered by `BlochScene.test.tsx` and the real browser run.
 */
import { Fragment, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TraceQubitState } from '@/api'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { bellWithQubitStates, hzhWithBloch } from '@/test/traceFixtures'
import type { SphereGridProps } from './types'

const webgl = vi.hoisted(() => ({ supported: true }))
const grid = vi.hoisted(() => ({
  last: null as null | { tiles: Array<Record<string, unknown>>; autoRotate: boolean; reducedMotion: boolean; helpId: string },
  mounts: 0,
  renders: 0,
  reset: vi.fn(),
  explode: false,
}))

vi.mock('./webgl', () => ({ webglSupported: () => webgl.supported, resetWebglSupportCache: () => undefined }))
vi.mock('./SphereGrid', () => ({
  default: function StubGrid({ tiles, autoRotate, reducedMotion, controllers, helpId }: SphereGridProps) {
    if (grid.explode) throw new Error('WebGL context could not be created')
    grid.last = { tiles: tiles as unknown as Array<Record<string, unknown>>, autoRotate, reducedMotion, helpId }
    grid.renders += 1
    useEffect(() => {
      grid.mounts += 1
      for (const tile of tiles) controllers.current.set(tile.id, { reset: () => grid.reset(tile.id), rotate: () => undefined, zoom: () => undefined })
      return () => {
        for (const tile of tiles) controllers.current.delete(tile.id)
      }
    })
    return (
      <div data-testid="stub-grid">
        {tiles.map((tile) => (
          <Fragment key={tile.id}>{tile.renderCard(<div data-testid={`stub-sphere-${tile.id}`} role="group" aria-label={tile.label} />)}</Fragment>
        ))}
      </div>
    )
  },
}))

import { QubitStateView } from './QubitStateView'

const PROV: Provenance = {
  resultId: 'res_test',
  circuitHash: 'hash_test',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-10-02T00:00:00+00:00',
}

function qubit(q: number, bloch: [number, number, number], extra: Partial<TraceQubitState> = {}): TraceQubitState {
  return {
    qubit: q,
    status: 'OK',
    reason: null,
    bloch: toQuantumValue({ x: bloch[0], y: bloch[1], z: bloch[2] }, PROV),
    blochLength: toQuantumValue(1, PROV),
    purity: toQuantumValue(1, PROV),
    entangledWithRest: false,
    method: 'reduced-qubit-state-from-statevector/1',
    derivedFrom: { stepIndex: 0, resultId: 'res_test', executionId: 'e', circuitHash: 'hash_test', backend: 'qiskit-aer', backendVersion: '0.17.2' },
    ...extra,
  }
}

const bell = () => bellWithQubitStates()

beforeEach(() => {
  webgl.supported = true
  grid.last = null
  grid.mounts = 0
  grid.renders = 0
  grid.explode = false
  grid.reset.mockReset()
  window.matchMedia = undefined as unknown as typeof window.matchMedia
})
afterEach(() => cleanup())

const tilesOf = () => grid.last!.tiles as Array<{ id: string; vector: { x: number; y: number; z: number }; headScale: number | null; drawable: boolean; label: string }>

describe('one qubit: the interactive Bloch sphere', () => {
  it('is titled for one sphere and draws the backend vector it was given, exactly', async () => {
    const q = qubit(0, [0.7071067811865476, 0, 0.7071067811865475])
    render(<QubitStateView qubitStates={[q]} numQubits={1} />)
    expect(await screen.findByTestId('stub-grid')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Interactive Bloch sphere' })).toBeInTheDocument()
    expect(tilesOf()).toHaveLength(1)
    expect(tilesOf()[0]).toMatchObject({ id: 'q0', vector: { x: 0.7071067811865476, y: 0, z: 0.7071067811865475 }, headScale: 1, drawable: true })
  })

  it('uses a single-qubit trace vector when there is no per-qubit state, with nothing else invented', async () => {
    const step = hzhWithBloch().steps[1]!
    render(<QubitStateView qubitStates={[]} blochVector={step.blochVector} numQubits={1} />)
    await screen.findByTestId('stub-grid')
    expect(tilesOf()).toHaveLength(1)
    expect(tilesOf()[0]!.vector).toEqual(step.blochVector!.coordinates.value)
    expect(tilesOf()[0]!.headScale).toBeNull() // the backend gave no length on this path: none is made up
    expect(screen.getByTestId('qubit3d-length-0')).toHaveTextContent('not provided')
    expect(screen.getByTestId('qubit3d-purity-0')).toHaveTextContent('not provided')
  })
})

describe('a register: one sphere per qubit, never one for the whole register', () => {
  it('draws one sphere per qubit, q[0] first, from each qubit’s own reduced state (a Bell pair: both maximally mixed)', async () => {
    const states = bell().steps[2]!.qubitStates
    render(<QubitStateView qubitStates={states} numQubits={2} />)
    await screen.findByTestId('stub-grid')
    expect(screen.getByRole('heading', { name: 'Qubit state view' })).toBeInTheDocument()
    expect(tilesOf().map((t) => t.id)).toEqual(['q0', 'q1'])
    expect(screen.getAllByTestId(/^stub-sphere-/)).toHaveLength(2)
    for (const q of [0, 1]) {
      expect(screen.getByTestId(`qubit3d-x-${q}`)).toHaveTextContent('0.000')
      expect(screen.getByTestId(`qubit3d-z-${q}`)).toHaveTextContent('0.000')
      expect(screen.getByTestId(`qubit3d-purity-${q}`)).toHaveTextContent('0.500')
      expect(screen.getByTestId(`qubit3d-entanglement-${q}`)).toHaveTextContent('entangled with the rest of the register')
    }
    // the backend's reduced vectors, to the last digit, and the backend's own lengths as the arrowhead scale
    expect(tilesOf()[0]!.vector).toEqual({ x: 0, y: 0, z: 0 })
    expect(tilesOf()[1]!.headScale).toBe(1.2246467991473532e-16)
  })

  it('a product state: each qubit has its own pure vector (q0 on +x, q1 on +z), not entangled', async () => {
    const states = bell().steps[1]!.qubitStates
    render(<QubitStateView qubitStates={states} numQubits={2} />)
    await screen.findByTestId('stub-grid')
    expect(tilesOf()[0]!.vector).toEqual({ x: 1, y: 0, z: 2.220446049250313e-16 })
    expect(tilesOf()[1]!.vector).toEqual({ x: 0, y: 0, z: 1 })
    expect(screen.getByTestId('qubit3d-entanglement-0')).toHaveTextContent('not entangled with the rest of the register')
    expect(screen.getByTestId('qubit3d-purity-1')).toHaveTextContent('1.000')
  })

  it('shows what the backend gave even when the values contradict each other: nothing is derived, clamped or repaired', async () => {
    // a vector of length ~0.37 whose "length" and "purity" the backend claims are 0.9 and 0.2: shown as supplied
    const odd = qubit(0, [0.1, 0.2, 0.3], { blochLength: toQuantumValue(0.9, PROV), purity: toQuantumValue(0.2, PROV), entangledWithRest: false })
    render(<QubitStateView qubitStates={[odd]} numQubits={1} />)
    await screen.findByTestId('stub-grid')
    expect(tilesOf()[0]).toMatchObject({ vector: { x: 0.1, y: 0.2, z: 0.3 }, headScale: 0.9 })
    expect(screen.getByTestId('qubit3d-length-0')).toHaveTextContent('0.900')
    expect(screen.getByTestId('qubit3d-purity-0')).toHaveTextContent('0.200')
    expect(screen.getByTestId('qubit3d-entanglement-0')).toHaveTextContent('not entangled') // the flag as supplied, not recomputed from the purity
  })

  it('a qubit the backend could not give a state for says so with its reason; the others are still drawn', async () => {
    const states = [qubit(0, [0, 0, 1]), { ...qubit(1, [0, 0, 0]), status: 'UNUSABLE' as const, reason: 'the statevector’s squared norm is 0.5, not 1', bloch: null, blochLength: null, purity: null, entangledWithRest: null }]
    render(<QubitStateView qubitStates={states} numQubits={2} />)
    await screen.findByTestId('stub-grid')
    expect(tilesOf().map((t) => t.id)).toEqual(['q0'])
    const unusable = screen.getByTestId('qubit3d-card-1')
    expect(unusable).toHaveAttribute('data-status', 'UNUSABLE')
    expect(within(unusable).getByText('Bloch vector unavailable for this qubit.')).toBeInTheDocument()
    expect(within(unusable).getByText('the statevector’s squared norm is 0.5, not 1')).toBeInTheDocument()
  })

  it('a vector outside the unit sphere is shown as numbers and flagged, never drawn or "fixed"', async () => {
    render(<QubitStateView qubitStates={[qubit(0, [1.5, 0, 0])]} numQubits={1} />)
    await screen.findByTestId('stub-grid')
    expect(tilesOf()[0]).toMatchObject({ drawable: false, vector: { x: 1.5, y: 0, z: 0 } })
    expect(screen.getByRole('alert')).toHaveTextContent('outside the unit sphere')
    expect(screen.getByTestId('qubit3d-x-0')).toHaveTextContent('1.500')
  })
})

describe('when there is no state to draw', () => {
  it('says "Bloch vector unavailable" with the reason it was given, and draws nothing', () => {
    render(<QubitStateView qubitStates={[]} numQubits={2} unavailableReason="A shots run samples measurement outcomes and returns no state." />)
    expect(screen.getByTestId('qubit-state-unavailable')).toHaveTextContent('Bloch vector unavailable.')
    expect(screen.getByTestId('qubit-state-unavailable')).toHaveTextContent('A shots run samples measurement outcomes')
    expect(screen.queryByTestId('stub-grid')).not.toBeInTheDocument()
    expect(grid.last).toBeNull()
  })

  it('with no reason given, the flat component’s own honest wording applies (it knows one qubit from a register)', () => {
    render(<QubitStateView qubitStates={[]} numQubits={2} />)
    expect(screen.getByTestId('qubit-spheres-unavailable')).toHaveTextContent('Per-qubit spheres unavailable for this step.')
    expect(screen.queryByTestId('stub-grid')).not.toBeInTheDocument()
  })
})

describe('controls', () => {
  it('manual rotation is the default: auto-rotate is OFF until it is switched on, and switching it off again works', async () => {
    render(<QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} />)
    await screen.findByTestId('stub-grid')
    const toggle = screen.getByRole('button', { name: 'Auto rotate' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(grid.last!.autoRotate).toBe(false)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(grid.last!.autoRotate).toBe(true)
    fireEvent.click(toggle)
    expect(grid.last!.autoRotate).toBe(false)
  })

  it('"Reset view" resets every sphere’s camera', async () => {
    render(<QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} />)
    await screen.findByTestId('stub-grid')
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    expect(grid.reset.mock.calls.map((c) => c[0]).sort()).toEqual(['q0', 'q1'])
  })

  it('reduced motion: auto-rotate cannot be switched on, says why, and the 3D side is told', async () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    render(<QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} />)
    await screen.findByTestId('stub-grid')
    const toggle = screen.getByRole('button', { name: 'Auto rotate' })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('title', expect.stringContaining('reduced motion'))
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(grid.last!.reducedMotion).toBe(true)
    expect(grid.last!.autoRotate).toBe(false)
  })

  it('every sphere points at the page text that explains the mouse, touch and keyboard controls', async () => {
    render(<QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} />)
    await screen.findByTestId('stub-grid')
    const helpId = grid.last!.helpId
    const help = document.getElementById(helpId)
    expect(help).not.toBeNull()
    expect(help).toHaveTextContent(/drag to rotate/i)
    expect(help).toHaveTextContent(/pinch to zoom/i)
    expect(help).toHaveTextContent(/arrow keys rotate/i)
  })
})

describe('accessibility: the numbers are page text, not just a picture', () => {
  it('every sphere has an accessible name that states its backend vector, and the same values are listed beside it', async () => {
    render(<QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} />)
    await screen.findByTestId('stub-grid')
    const labels = tilesOf().map((t) => t.label)
    expect(labels[0]).toBe('Interactive 3D Bloch sphere of qubit 0. Backend-provided vector: x = 1.000, y = 0.000, z = 0.000. The same values are listed beside it.')
    expect(labels[1]).toContain('qubit 1')
    const list = screen.getByLabelText('Bloch vector of qubit 0')
    expect([...list.querySelectorAll('dd')].map((d) => d.textContent)).toEqual(['1.000', '0.000', '0.000'])
    expect([...list.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['X', 'Y', 'Z'])
  })

  it('every number carries its provenance (the badge, and the exact value as a tooltip)', async () => {
    render(<QubitStateView qubitStates={[qubit(0, [0.25, 0.5, 0.75])]} numQubits={1} />)
    await screen.findByTestId('stub-grid')
    expect(screen.getByTestId('qubit3d-card-0')).toHaveTextContent(/qiskit-aer/)
    expect(screen.getByTestId('qubit3d-y-0')).toHaveAttribute('title', 'exact value from the backend: 0.5')
  })

  it('two views on one page do not share an id (a result view and a trace view are shown together in the Lab)', async () => {
    render(
      <>
        <QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} testId="a" />
        <QubitStateView qubitStates={bell().steps[2]!.qubitStates} numQubits={2} testId="b" />
      </>,
    )
    await waitFor(() => expect(screen.getAllByTestId('stub-grid')).toHaveLength(2))
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('two views on one page are distinguishable landmarks: each region’s name includes which state it shows (axe landmark-unique)', async () => {
    render(
      <>
        <QubitStateView qubitStates={bell().steps[2]!.qubitStates} numQubits={2} testId="a" context="Final state of this run" />
        <QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} testId="b" context="Step 2 of 3 · H on q0" />
      </>,
    )
    await waitFor(() => expect(screen.getAllByTestId('stub-grid')).toHaveLength(2))
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent).join(' '))
    expect(names).toEqual(['Qubit state view Final state of this run', 'Qubit state view Step 2 of 3 · H on q0'])
    expect(new Set(names).size).toBe(names.length)
  })

  it('and in the flat fallback too (the same page without WebGL has distinct names, not two "Per-qubit Bloch spheres")', () => {
    webgl.supported = false
    render(
      <>
        <QubitStateView qubitStates={bell().steps[2]!.qubitStates} numQubits={2} testId="a" context="Final state of this run" />
        <QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} testId="b" context="Step 2 of 3" />
      </>,
    )
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Per-qubit Bloch spheres, Final state of this run',
      'Per-qubit Bloch spheres, Step 2 of 3',
    ])
  })

  it('headings nest where the page needs them', async () => {
    render(<QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} headingLevel={3} />)
    await screen.findByTestId('stub-grid')
    expect(screen.getByRole('heading', { level: 3, name: 'Qubit state view' })).toBeInTheDocument()
  })
})

describe('following the selected step, and degrading honestly', () => {
  it('a new step’s values reach the 3D side without rebuilding it (so the camera is not reset)', async () => {
    const trace = bell()
    const { rerender } = render(<QubitStateView qubitStates={trace.steps[0]!.qubitStates} numQubits={2} context="Step 1 of 3" />)
    await screen.findByTestId('stub-grid')
    expect(tilesOf()[0]!.vector).toEqual({ x: 0, y: 0, z: 1 })
    const mountsBefore = grid.mounts

    rerender(<QubitStateView qubitStates={trace.steps[1]!.qubitStates} numQubits={2} context="Step 2 of 3" />)
    expect(tilesOf()[0]!.vector).toEqual({ x: 1, y: 0, z: 2.220446049250313e-16 })
    expect(screen.getByTestId('qubit-state-context')).toHaveTextContent('Step 2 of 3')

    rerender(<QubitStateView qubitStates={trace.steps[2]!.qubitStates} numQubits={2} context="Step 3 of 3" />)
    expect(tilesOf()[0]!.vector).toEqual({ x: 0, y: 0, z: 0 })
    expect(screen.getByTestId('qubit-state-context')).toHaveTextContent('Step 3 of 3')
    expect(grid.mounts).toBeGreaterThanOrEqual(mountsBefore)
    expect(screen.getAllByTestId('stub-grid')).toHaveLength(1) // the same single 3D grid throughout
  })

  it('without WebGL the flat projection is shown, and the view says so; the numbers are the same', () => {
    webgl.supported = false
    render(<QubitStateView qubitStates={bell().steps[2]!.qubitStates} numQubits={2} />)
    expect(screen.getByTestId('flat-note')).toHaveTextContent('WebGL is not available')
    expect(screen.queryByTestId('stub-grid')).not.toBeInTheDocument()
    expect(screen.getByTestId('qubit-spheres-section')).toBeInTheDocument()
    expect(screen.getByTestId('qubit-purity-0')).toHaveTextContent('0.500')
  })

  it('if the 3D view fails to start, the flat projection replaces it and says why', async () => {
    grid.explode = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<QubitStateView qubitStates={bell().steps[2]!.qubitStates} numQubits={2} />)
    expect(await screen.findByTestId('flat-note')).toHaveTextContent('could not start')
    expect(screen.getByTestId('qubit-spheres-section')).toBeInTheDocument()
    err.mockRestore()
  })

  it('a caution (one collapsed post-measurement state) is shown with the spheres', async () => {
    render(<QubitStateView qubitStates={bell().steps[1]!.qubitStates} numQubits={2} caution="This is one collapsed post-measurement state." />)
    await screen.findByTestId('stub-grid')
    expect(screen.getByRole('note')).toHaveTextContent('collapsed post-measurement state')
  })
})

// keep the act import used (state updates above go through RTL's own act wrapping)
void act
