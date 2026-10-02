/**
 * The variational lab: the parameter sweep, the cost curve, the Bloch sphere of a chosen angle and the small optimisation. Every value is
 * the server's (fixtures here stand in for a server response); the lab sends only angles and loop settings, draws what comes back, and shows
 * every number through VerifiedValueInline with the provenance of its own run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { BackendUnavailableError } from '@/api'
import type { VariationalOptimizationResult, VariationalPoint, VariationalSweepResult } from '@/api'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const client = vi.hoisted(() => ({ variationalSweep: vi.fn(), variationalOptimize: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { VariationalLab } from './VariationalLab'
import { useVariationalStore } from './variationalStore'

const INITIAL = useVariationalStore.getState()

const prov = (id: string, backend = 'qiskit-aer'): Provenance => ({
  resultId: id,
  circuitHash: 'h_' + id,
  backend,
  backendVersion: '0.17.2',
  executionMode: backend === 'variational-demo' ? 'variational' : 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
})

function point(id: string, theta: number, z: number): VariationalPoint {
  const p = prov(id)
  return {
    theta: toQuantumValue(theta, p),
    expectationZ: toQuantumValue(z, p),
    bloch: toQuantumValue({ x: 0.25, y: 0, z }, p),
    probabilityZero: toQuantumValue((1 + z) / 2, p),
    probabilityOne: toQuantumValue((1 - z) / 2, p),
    resultId: id,
    executionId: 'aer-local-' + id,
    circuitHash: 'h_' + id,
    provenance: p,
  }
}

const LABEL = 'Educational one-parameter demonstration: not a chemistry calculation, not a scalable VQE, and it uses no quantum hardware.'
const common = { method: 'qentor.variational/1', expectationMethod: 'm', ansatz: 'RY(theta) on one qubit, started in |0>', observable: 'Pauli Z on q[0]', label: LABEL, backend: 'qiskit-aer', backendVersion: '0.17.2', provenance: prov('res_demo', 'variational-demo') }

// angles 0, 1, 2, 3, 4 and the costs the "server" returned for them (fixture values)
const GRID: [number, number][] = [[0, 0.91], [1, 0.52], [2, -0.41], [3, -0.97], [4, -0.65]]
const SWEEP: VariationalSweepResult = {
  ...common,
  points: GRID.map(([theta, z], i) => point(`res_s${i}`, theta, z)),
  minimumIndex: 3,
  maximumIndex: 0,
}

const PATH_GRID: [number, number, number][] = [[0.8, 0.69, -0.72], [1.2, 0.36, -0.93], [1.76, -0.19, -0.98], [2.35, -0.7, -0.71]]
const PATH: VariationalOptimizationResult = {
  ...common,
  steps: PATH_GRID.map(([theta, z, g], i) => ({
    step: i,
    point: point(`res_o${i}`, theta, z),
    gradient: toQuantumValue(g, prov(`res_o${i}`)),
    plus: point(`res_o${i}p`, theta + 1.57, -g),
    minus: point(`res_o${i}m`, theta - 1.57, g),
  })),
  lowestIndex: 3,
  converged: false,
  learningRate: 0.6,
  shift: 1.5707963267948966,
  notes: [],
}

beforeEach(() => {
  client.variationalSweep.mockReset()
  client.variationalOptimize.mockReset()
  useVariationalStore.setState(INITIAL, true)
})
afterEach(() => {
  cleanup()
  useVariationalStore.setState(INITIAL, true)
})

const runSweep = async () => {
  fireEvent.click(screen.getByRole('button', { name: /run the sweep/i }))
  await screen.findByText(/lowest point the server found/i)
}

describe('before anything is run', () => {
  it('says what it is, shows no number and draws no curve', () => {
    render(<VariationalLab />)
    expect(screen.getByTestId('variational-label')).toHaveTextContent(/educational one-parameter demonstration.*not a chemistry calculation.*not a scalable VQE.*no quantum hardware/i)
    expect(screen.getByRole('img', { name: /no sweep has been run yet/i })).toBeInTheDocument()
    expect(screen.getByTestId('variational-selected')).toHaveTextContent(/run the sweep, then pick a point/i)
    expect(document.querySelector('polyline')).toBeNull()
    expect(client.variationalSweep).not.toHaveBeenCalled()
  })
})

describe('the sweep', () => {
  it('asks for an angle range and a point count only, then draws the server’s points', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    await runSweep()
    expect(client.variationalSweep).toHaveBeenCalledWith({ thetaMin: 0, thetaMax: 2 * Math.PI, points: 25 })
    const svg = screen.getByRole('img', { name: /sweep points/i })
    expect(svg.querySelectorAll('circle')).toHaveLength(5) // one per point the server returned: nothing interpolated or added
    expect(svg.querySelectorAll('polyline')).toHaveLength(1)
    expect(svg.getAttribute('aria-label')).toMatch(/5 sweep points/)
    expect(screen.getByTestId('variational-label')).toHaveTextContent(LABEL) // now the server's own words
  })

  it('starts at the point the SERVER named lowest and shows its values with that run’s provenance', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    await runSweep()
    const selected = screen.getByTestId('variational-selected')
    expect(within(selected).getByText('-0.970000')).toBeInTheDocument() // <Z> of point 3
    expect(within(selected).getByText('3.000000')).toBeInTheDocument() // theta of point 3
    expect(selected).toHaveTextContent('run res_s3')
    expect(selected).toHaveTextContent('qiskit-aer')
    expect(within(selected).getByRole('slider')).toHaveValue('3')
  })

  it('shows that run’s Bloch vector in the sphere, from the backend’s own coordinates', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    await runSweep()
    const sphere = within(screen.getByTestId('variational-selected')).getByTestId('bloch-section')
    expect(sphere).toHaveTextContent('z = −0.970') // the sphere's own formatting of the backend's coordinate
    expect(sphere).toHaveTextContent('x = 0.250')
    expect(sphere).toHaveTextContent('res_s3') // the vector names the run it was derived from
  })

  it('moving the slider moves the sphere and the readout to the chosen run', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    await runSweep()
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '0' } })
    const selected = screen.getByTestId('variational-selected')
    expect(within(selected).getByText('0.910000')).toBeInTheDocument()
    expect(selected).toHaveTextContent('run res_s0')
    expect(slider).toHaveAttribute('aria-valuetext', 'point 1 of 5')
    expect(selected).toHaveTextContent('1 / 5')
    expect(within(selected).getByTestId('bloch-section')).toHaveTextContent('z = 0.910')
  })

  it('draws a higher cost higher up and a later angle further right, from the server’s numbers only', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    await runSweep()
    const dots = [...screen.getByRole('img', { name: /sweep points/i }).querySelectorAll('circle')]
    const at = (i: number) => ({ x: Number(dots[i]!.getAttribute('cx')), y: Number(dots[i]!.getAttribute('cy')) })
    // costs fall from point 0 to point 3 and rise a little at point 4; on screen a smaller y is higher up
    expect(at(0).y).toBeLessThan(at(1).y)
    expect(at(1).y).toBeLessThan(at(2).y)
    expect(at(2).y).toBeLessThan(at(3).y) // point 3 has the lowest cost, so it is the lowest on screen (the largest y)
    expect(at(3).y).toBeGreaterThan(at(4).y)
    for (let i = 1; i < dots.length; i += 1) expect(at(i).x).toBeGreaterThan(at(i - 1).x)
  })

  it('clicking a dot on the curve selects its run', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    await runSweep()
    fireEvent.click(screen.getByRole('img', { name: /sweep points/i }).querySelectorAll('circle')[1]!)
    expect(screen.getByTestId('variational-selected')).toHaveTextContent('run res_s1')
  })

  it('every sweep run is in a table with its own number, listed once', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    await runSweep()
    const table = within(screen.getByRole('region', { name: /sweep table/i })).getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(6) // header + 5
    expect(table).toHaveTextContent('-0.970000')
    expect(within(table).getByRole('columnheader', { name: '⟨Z⟩' })).toBeInTheDocument()
  })

  it('the other range is asked for as it is', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    fireEvent.change(screen.getByLabelText(/angle range/i), { target: { value: 'centred' } })
    fireEvent.change(screen.getByLabelText(/^points$/i), { target: { value: '41' } })
    await runSweep()
    expect(client.variationalSweep).toHaveBeenCalledWith({ thetaMin: -Math.PI, thetaMax: Math.PI, points: 41 })
  })

  it('a refusal shows an error and NO curve', async () => {
    client.variationalSweep.mockRejectedValue(new BackendUnavailableError('the backend is unavailable in this environment', 503))
    render(<VariationalLab />)
    fireEvent.click(screen.getByRole('button', { name: /run the sweep/i }))
    expect(await screen.findByText('The sweep could not run')).toBeInTheDocument()
    expect(screen.getByText(/backend is unavailable/)).toBeInTheDocument()
    expect(document.querySelector('polyline')).toBeNull()
    expect(screen.queryByTestId('bloch-section')).toBeNull()
  })

  it('an answer to a superseded request is dropped', async () => {
    let first!: (r: VariationalSweepResult) => void
    client.variationalSweep.mockReturnValueOnce(new Promise<VariationalSweepResult>((r) => (first = r)))
    client.variationalSweep.mockResolvedValueOnce({ ...SWEEP, points: SWEEP.points.slice(0, 3), minimumIndex: 2 })
    render(<VariationalLab />)
    fireEvent.click(screen.getByRole('button', { name: /run the sweep/i }))
    await waitFor(() => expect(client.variationalSweep).toHaveBeenCalledTimes(1))
    await act(async () => void useVariationalStore.getState().runSweep({ thetaMin: 0, thetaMax: 1, points: 3 }))
    await act(async () => first(SWEEP)) // the old answer arrives late
    expect(useVariationalStore.getState().sweep?.points).toHaveLength(3)
    expect(screen.getByRole('img', { name: /3 sweep points/ })).toBeInTheDocument()
  })
})

describe('the classical optimiser', () => {
  it('reads the start angle the way the editor reads one, and sends it with the loop settings', async () => {
    client.variationalOptimize.mockResolvedValue(PATH)
    render(<VariationalLab />)
    fireEvent.change(screen.getByLabelText(/start angle/i), { target: { value: 'pi/4' } })
    fireEvent.change(screen.getByLabelText(/learning rate/i), { target: { value: '0.4' } })
    fireEvent.change(screen.getByLabelText(/^steps$/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /run the classical optimiser/i }))
    await screen.findByTestId('variational-path')
    expect(client.variationalOptimize).toHaveBeenCalledWith({ thetaStart: Math.PI / 4, steps: 10, learningRate: 0.4 })
  })

  it('an angle that cannot be read cannot be sent', () => {
    render(<VariationalLab />)
    fireEvent.change(screen.getByLabelText(/start angle/i), { target: { value: 'pi/' } })
    expect(screen.getByText(/not an angle/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run the classical optimiser/i })).toBeDisabled()
  })

  it('shows the server’s path: every step, its slope, its summary and its verdict on the last slope', async () => {
    client.variationalOptimize.mockResolvedValue(PATH)
    render(<VariationalLab />)
    fireEvent.click(screen.getByRole('button', { name: /run the classical optimiser/i }))
    const path = await screen.findByTestId('variational-path')
    const table = within(path).getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(5)
    expect(table).toHaveTextContent('-0.720000') // the first slope, with a sign
    expect(table).toHaveTextContent('-0.930000')
    expect(within(path).getByTestId('variational-summary')).toHaveTextContent('3 steps. The lowest cost seen was at step 3')
    expect(within(path).getByTestId('variational-summary')).toHaveTextContent('-0.700000')
    expect(within(path).getByTestId('variational-summary')).toHaveTextContent('still moving') // converged: false
  })

  it('draws the path on the same chart and opens on its last step, with the slope row and the sphere', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    client.variationalOptimize.mockResolvedValue(PATH)
    render(<VariationalLab />)
    await runSweep()
    fireEvent.click(screen.getByRole('button', { name: /run the classical optimiser/i }))
    await screen.findByTestId('variational-path')
    const svg = screen.getByRole('img', { name: /sweep points and an optimiser path of 4 steps/i })
    expect(svg.querySelectorAll('polyline')).toHaveLength(2)
    expect(svg.querySelectorAll('circle')).toHaveLength(9) // 5 sweep points + 4 path steps
    const selected = screen.getByTestId('variational-selected')
    expect(selected).toHaveTextContent('run res_o3')
    expect(selected).toHaveTextContent('Slope from the two shifted runs')
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'step 4 of 4')
    // switch back to the sweep: the slope row goes and the sweep's lowest point returns
    fireEvent.click(screen.getByRole('radio', { name: 'The sweep' }))
    expect(screen.getByTestId('variational-selected')).not.toHaveTextContent('Slope from the two shifted runs')
    expect(screen.getByTestId('variational-selected')).toHaveTextContent('run res_s3')
  })

  it('says a settled loop has settled, and shows the server’s notes (a flat start)', async () => {
    client.variationalOptimize.mockResolvedValue({ ...PATH, converged: true, notes: ['the starting angle has a gradient of zero, so the loop cannot tell which way is downhill and does not move'] })
    render(<VariationalLab />)
    fireEvent.click(screen.getByRole('button', { name: /run the classical optimiser/i }))
    const path = await screen.findByTestId('variational-path')
    expect(within(path).getByTestId('variational-summary')).toHaveTextContent('has settled')
    expect(within(path).getByText(/gradient of zero/)).toBeInTheDocument()
  })

  it('a refusal shows an error and no path', async () => {
    client.variationalOptimize.mockRejectedValue(new BackendUnavailableError('the loop takes 1 to 25 steps', 422))
    render(<VariationalLab />)
    fireEvent.click(screen.getByRole('button', { name: /run the classical optimiser/i }))
    expect(await screen.findByText('The loop could not run')).toBeInTheDocument()
    expect(screen.queryByTestId('variational-path')).toBeNull()
  })
})

describe('accessibility and phones', () => {
  it('every table is a focusable, scrollable region and the chart scales to its container', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    client.variationalOptimize.mockResolvedValue(PATH)
    render(<VariationalLab />)
    await runSweep()
    fireEvent.click(screen.getByRole('button', { name: /run the classical optimiser/i }))
    await screen.findByTestId('variational-path')
    for (const region of screen.getAllByRole('region', { name: /scrollable/i })) {
      expect(region).toHaveAttribute('tabindex', '0')
      expect(region.className).toMatch(/overflow-auto/)
    }
    const svg = screen.getByRole('img', { name: /sweep points/i })
    expect(svg.getAttribute('viewBox')).toBe('0 0 360 210')
    expect(svg.getAttribute('class')).toMatch(/w-full/)
    expect(screen.getAllByRole('form').length).toBe(2)
  })

  it('the chart has a text alternative and the same values are in a table', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    render(<VariationalLab />)
    await runSweep()
    expect(screen.getByRole('img', { name: /Vertical axis: the expectation value of Z, from -1 to \+1.*the same values are in the tables/s })).toBeInTheDocument()
    expect(screen.getByText(/The sweep as a table \(5 runs\)/)).toBeInTheDocument()
  })

  it('has no axe violations with a sweep and a path on screen', async () => {
    client.variationalSweep.mockResolvedValue(SWEEP)
    client.variationalOptimize.mockResolvedValue(PATH)
    render(<VariationalLab />)
    await runSweep()
    fireEvent.click(screen.getByRole('button', { name: /run the classical optimiser/i }))
    await screen.findByTestId('variational-path')
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } } })
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
  })
})

describe('trust: the browser draws and never computes', () => {
  const RAW = import.meta.glob(['./VariationalLab.tsx', './variationalChart.ts', './variationalStore.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const src = (name: string) => Object.entries(RAW).find(([k]) => k.endsWith(name))![1]
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('the lab and its store use no Math and do no arithmetic on a value', () => {
    for (const name of ['VariationalLab.tsx', 'variationalStore.ts']) {
      const code = strip(src(name))
      // PI for the two range choices, and max/min/floor only to keep a LIST POSITION (a slider index) inside its list; nothing else
      expect([...code.matchAll(/\bMath\.(\w+)/g)].map((m) => m[1]).filter((fn) => !['PI', 'max', 'min', 'floor'].includes(fn!))).toEqual([])
      expect(code).not.toMatch(/\.value\s*[-+*/]\s*[\w(]/)
      expect(code).not.toMatch(/\.value\s*[<>]=?\s*[\w(]/)
    }
  })

  it('numbers are formatted by two helpers and every value passes through VerifiedValueInline', () => {
    const lab = src('VariationalLab.tsx')
    expect(lab.split('\n').filter((l) => l.includes('toFixed(')).length).toBe(2)
    expect(lab).toMatch(/import \{ VerifiedValueInline \} from '@\/provenance\/VerifiedValue'/)
    expect(lab.match(/<VerifiedValueInline/g)?.length).toBe(1) // inside `Num`, the only place a QuantumValue is rendered
  })

  it('the chart module maps positions only: no cost, gradient or minimum is computed', () => {
    const code = strip(src('variationalChart.ts'))
    expect(code).not.toMatch(/Math\.(min|max)\(\s*\.\.\./)
    expect(code).not.toMatch(/Math\.(cos|sin)|gradient|argmin|reduce/)
    expect(src('variationalChart.ts')).toMatch(/POSITIONS ONLY/) // documented in the header (comments are stripped from `code`)
  })

  it('the lowest point shown is the server’s pick, not one found in the browser', () => {
    const lab = strip(src('VariationalLab.tsx'))
    expect(lab).toContain('minimumIndex')
    expect(lab).not.toMatch(/\.reduce\(|Math\.min\(\.\.\./)
  })
})
