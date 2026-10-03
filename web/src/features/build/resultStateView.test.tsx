/**
 * "Execution -> 3D view" and "trace step -> 3D state", through the REAL Lab stores and components. The 3D scene itself is a stub here
 * (jsdom has no WebGL; `BlochScene.test.tsx` and the browser run cover it), which records exactly what the 3D side was handed.
 *
 * What is pinned: a statevector run shows one sphere per qubit of its final state from the SERVER's per-qubit values; a shots run, and
 * a server that sent none, say so instead of drawing; a circuit with measurements says it is one collapsed state; the selected trace
 * step drives its own view (without rebuilding it, so the camera keeps its place) while the result view stays on the final state;
 * selecting a gate on the canvas selects its trace step, and the same selection reaches the Tutor's context unchanged.
 */
import { Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ExecutePayload, TraceQubitState } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import type { Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { bellWithQubitStates } from '@/test/traceFixtures'
import type { SphereGridProps } from '@/features/bloch3d/types'

const grids = vi.hoisted(() => ({ byView: new Map<string, { tiles: Array<Record<string, unknown>>; mounts: number }>() }))

vi.mock('@/features/bloch3d/webgl', () => ({ webglSupported: () => true, resetWebglSupportCache: () => undefined }))
vi.mock('@/features/bloch3d/SphereGrid', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    default: function StubGrid({ tiles, controllers, helpId }: SphereGridProps) {
      const mounts = useRef(0)
      useEffect(() => {
        mounts.current += 1
        const entry = grids.byView.get(helpId) ?? { tiles: [], mounts: 0 }
        entry.mounts = mounts.current
        grids.byView.set(helpId, entry)
        for (const t of tiles) controllers.current.set(t.id, { reset: () => undefined, rotate: () => undefined, zoom: () => undefined })
      }, [])
      const entry = grids.byView.get(helpId) ?? { tiles: [], mounts: 0 }
      entry.tiles = tiles as unknown as Array<Record<string, unknown>>
      grids.byView.set(helpId, entry)
      return <div data-testid="stub-grid">{tiles.map((t) => <Fragment key={t.id}>{t.renderCard(<div data-testid={`stub-sphere-${t.id}`} />)}</Fragment>)}</div>
    },
  }
})

import { useBuildStore } from './store'
import { ResultStateView } from './ResultStateView'
import { TracePanel } from './TracePanel'
import { CircuitCanvas } from './CircuitCanvas'
import { selectedTraceStepContext } from './traceStepContext'

const PROV: Provenance = {
  resultId: 'res_run',
  circuitHash: 'hash_run',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-10-02T00:00:00+00:00',
}

const BELL: Circuit = {
  ...emptyCircuit(2, 0),
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

function state(q: number, b: [number, number, number], length: number, purity: number, entangled: boolean): TraceQubitState {
  return {
    qubit: q,
    status: 'OK',
    reason: null,
    bloch: toQuantumValue({ x: b[0], y: b[1], z: b[2] }, PROV),
    blochLength: toQuantumValue(length, PROV),
    purity: toQuantumValue(purity, PROV),
    entangledWithRest: entangled,
    method: 'reduced-qubit-state-from-statevector/1',
    derivedFrom: { stepIndex: 2, resultId: 'res_run', executionId: 'e', circuitHash: 'hash_run', backend: 'qiskit-aer', backendVersion: '0.17.2' },
  }
}

const BELL_RUN: ExecutePayload = {
  executionId: 'aer-1',
  statevector: [[0.7071067811865476, 0], [0, 0], [0, 0], [0.7071067811865476, 0]],
  qubitStates: [state(0, [0, 0, 0], 0, 0.5, true), state(1, [0, 0, 0], 1.2246467991473532e-16, 0.5000000000000001, true)],
}

const INITIAL = useBuildStore.getState()
beforeEach(() => {
  grids.byView.clear()
  useBuildStore.setState({ ...INITIAL, circuit: BELL }, true)
})
afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL, true)
})

const setResult = (value: ExecutePayload, mode: 'statevector' | 'shots' = 'statevector') =>
  act(() => useBuildStore.setState({ result: toQuantumValue(value, { ...PROV, executionMode: mode }), mode }))

const gridTiles = () => [...grids.byView.values()].flatMap((g) => g.tiles) as Array<{ id: string; vector: { x: number; y: number; z: number }; headScale: number | null }>

describe('execution -> the 3D view of the final state', () => {
  it('a statevector run draws one sphere per qubit from the server’s per-qubit values, exactly', async () => {
    render(<ResultStateView />)
    expect(screen.queryByTestId('result-state-view')).not.toBeInTheDocument() // nothing before a run
    setResult(BELL_RUN)
    expect(await screen.findByRole('heading', { name: 'Qubit state view' })).toBeInTheDocument()
    expect(screen.getByTestId('qubit-state-context')).toHaveTextContent('Final state of this run')
    expect(gridTiles().map((t) => t.id)).toEqual(['q0', 'q1'])
    expect(gridTiles()[1]).toMatchObject({ vector: { x: 0, y: 0, z: 0 }, headScale: 1.2246467991473532e-16 })
    expect(await screen.findByTestId('qubit3d-purity-1')).toHaveTextContent('0.500') // (the lazy 3D chunk has loaded)
    expect(screen.getByTestId('qubit3d-entanglement-0')).toHaveTextContent('entangled with the rest of the register')
  })

  it('a one-qubit run is titled for one sphere', async () => {
    useBuildStore.setState({ circuit: { ...emptyCircuit(1, 0), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] } })
    render(<ResultStateView />)
    setResult({ executionId: 'e', statevector: [[0.7071067811865476, 0], [0.7071067811865476, 0]], qubitStates: [state(0, [1, 0, 2.2e-16], 1, 1, false)] })
    expect(await screen.findByRole('heading', { name: 'Interactive Bloch sphere' })).toBeInTheDocument()
    expect(gridTiles()).toHaveLength(1)
  })

  it('a shots run has no state, and says so instead of drawing one', async () => {
    render(<ResultStateView />)
    setResult({ executionId: 'e', counts: { '00': 5, '11': 3 }, probabilities: { '00': 0.625, '11': 0.375 }, shots: 8 }, 'shots')
    const card = await screen.findByTestId('qubit-state-unavailable')
    expect(card).toHaveTextContent('Bloch vector unavailable.')
    expect(card).toHaveTextContent('A shots run samples measurement outcomes and returns no state')
    expect(screen.queryByTestId('stub-grid')).not.toBeInTheDocument()
  })

  it('a server that sent no per-qubit states says so, and does not work them out from the statevector it did send', async () => {
    render(<ResultStateView />)
    setResult({ executionId: 'e', statevector: BELL_RUN.statevector })
    const card = await screen.findByTestId('qubit-state-unavailable')
    expect(card).toHaveTextContent('did not send a state for each qubit')
    expect(screen.queryByTestId('stub-grid')).not.toBeInTheDocument()
  })

  it('a circuit WITHOUT measurements carries no collapsed-state caution (the note is only for a measured circuit)', async () => {
    render(<ResultStateView />)
    setResult(BELL_RUN)
    await screen.findByTestId('qubit3d-card-0')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it('a circuit with measurements is described as one collapsed post-measurement state', async () => {
    useBuildStore.setState({ circuit: { ...BELL, num_clbits: 2, ops: [...BELL.ops, { gate: 'measure', targets: [0], controls: [], params: [], clbits: [0] }] } })
    render(<ResultStateView />)
    setResult(BELL_RUN)
    expect(await screen.findByRole('note')).toHaveTextContent('collapsed post-measurement state')
  })
})

describe('trace step -> the step’s own 3D state, and the matching gate', () => {
  const loadTrace = () => act(() => useBuildStore.setState({ trace: bellWithQubitStates(), selectedTraceStep: 0 }))

  it('the selected step’s per-qubit values are what the view draws, and a step change does not rebuild the 3D view', async () => {
    render(<TracePanel />)
    loadTrace()
    expect(await screen.findByTestId('trace-state-view')).toBeInTheDocument()
    const view = () => gridTiles()
    expect(view().map((t) => t.vector)).toEqual([{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }]) // step 1: the initial state
    const entry = [...grids.byView.values()][0]!
    const mounts = entry.mounts

    fireEvent.click(screen.getByRole('button', { name: /^Step 2:/ }))
    expect(view()[0]!.vector).toEqual({ x: 1, y: 0, z: 2.220446049250313e-16 }) // after H on q0
    expect(view()[1]!.vector).toEqual({ x: 0, y: 0, z: 1 })
    expect(screen.getByTestId('qubit-state-context')).toHaveTextContent('Step 2 of 3')

    fireEvent.click(screen.getByRole('button', { name: /^Step 3:/ }))
    expect(view().map((t) => t.vector)).toEqual([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]) // the Bell pair: both mixed
    expect(screen.getByTestId('qubit-state-context')).toHaveTextContent('Step 3 of 3')
    expect(screen.getAllByTestId('stub-grid')).toHaveLength(1)
    expect(entry.mounts).toBe(mounts) // the same 3D view throughout: the camera is not reset by a step change
  })

  it('the result view stays on the final state while the trace view follows the selected step', async () => {
    render(
      <>
        <ResultStateView />
        <TracePanel />
      </>,
    )
    setResult(BELL_RUN)
    loadTrace()
    await screen.findByTestId('trace-state-view')
    fireEvent.click(screen.getByRole('button', { name: /^Step 2:/ }))
    expect(screen.getByTestId('result-state-view')).toHaveTextContent('Final state of this run')
    expect(screen.getByTestId('trace-state-view')).toHaveTextContent('Step 2 of 3')
    // two views on one page, and no id shared between them
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('selecting a gate on the canvas selects its trace step and marks it; the Tutor’s step context says the same thing', async () => {
    render(
      <>
        <CircuitCanvas />
        <TracePanel />
      </>,
    )
    loadTrace()
    await screen.findByTestId('trace-state-view')
    fireEvent.click(screen.getByRole('button', { name: /^CX — control q0, target q1, step 2 of 2/ }))
    expect(useBuildStore.getState().selectedTraceStep).toBe(2)
    expect(screen.getByTestId('selected-op-trace')).toHaveTextContent('trace step 3 of 3')
    expect(screen.getByTestId('qubit-state-context')).toHaveTextContent('Step 3 of 3')
    expect(screen.getByTestId('traced-marker')).toBeInTheDocument()
    const context = selectedTraceStepContext(useBuildStore.getState())
    expect(context).toMatchObject({ stepIndex: 2 })
  })

  it('stepping the trace marks the gate that made the step on the canvas (and only that gate)', async () => {
    render(
      <>
        <CircuitCanvas />
        <TracePanel />
      </>,
    )
    loadTrace()
    await screen.findByTestId('trace-state-view')
    expect(screen.queryByTestId('traced-marker')).not.toBeInTheDocument() // step 1 is the initial state: no gate
    fireEvent.click(screen.getByRole('button', { name: /^Step 2:/ }))
    const marked = screen.getAllByTestId('traced-marker').map((m) => m.closest('button')!.getAttribute('aria-label'))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toMatch(/^H on q0, step 1 of 2, shown in the trace/)
  })
})
