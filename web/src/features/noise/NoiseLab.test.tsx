/**
 * The Noise Lab screen, driven the way a learner uses it: with the API mocked at the `getApiClient` boundary, so what the screen shows is exactly
 * what the (fake) server returned. The numbers in the fixture are hand-computed in `test/noiseFixtures.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'

const client = vi.hoisted(() => ({ listNoiseModels: vi.fn(), compareNoise: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import { BackendUnavailableError, NoiseRejectedError } from '@/api'
import { useBuildStore } from '@/features/build/store'
import { emptyCircuit } from '@/circuit/types'
import { BELL_MEASURED, IDEAL_ONLY_WIRE, NOISE_WIRE, parseCatalog, parseNoiseResult } from '@/test/noiseFixtures'
import { NoiseLabScreen } from './NoiseLabScreen'
import { useNoiseStore } from './store'

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_NOISE = useNoiseStore.getState()

beforeEach(() => {
  localStorage.clear()
  client.listNoiseModels.mockReset().mockResolvedValue(parseCatalog())
  client.compareNoise.mockReset().mockResolvedValue(parseNoiseResult())
  useBuildStore.setState(INITIAL_BUILD, true)
  useNoiseStore.setState(INITIAL_NOISE, true)
  useBuildStore.getState().loadCircuit(BELL_MEASURED)
})
afterEach(cleanup)

const ready = async () => {
  render(<NoiseLabScreen />)
  await screen.findByLabelText('Noise model')
}
const run = () => fireEvent.click(screen.getByRole('button', { name: /^Run ideal/ }))
const ran = async () => {
  await ready()
  act(() => useNoiseStore.getState().setShots(1000)) // the fixture's server answers 1000 shots, so the settings match the result
  run()
  await screen.findByTestId('noise-result')
}
const text = (testId: string) => screen.getByTestId(testId).textContent
const title = (el: HTMLElement) => el.querySelector('[title]')?.getAttribute('title') ?? ''

describe('the entry', () => {
  it('opens with one level-one heading, the introduction and an honest scope line', async () => {
    await ready()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Noise Lab' })).toBeInTheDocument()
    expect(screen.getByText('Explore how noise affects quantum circuits.')).toBeInTheDocument()
    const scope = text('noise-scope')!
    expect(scope).toMatch(/Simulated noise/)
    expect(scope).toMatch(/Qiskit Aer simulation only/)
    expect(scope).toMatch(/Not real hardware/)
  })

  it('shows the Lab’s own circuit editor and palette (one circuit representation) and offers example circuits', async () => {
    await ready()
    expect(screen.getByRole('group', { name: 'Circuit editor' })).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Gate palette' })).toBeInTheDocument()
    expect(screen.getByTestId('noise-editor')).toContainElement(screen.getByRole('group', { name: 'Circuit editor' }))
    const examples = within(screen.getByRole('group', { name: 'Example circuits' })).getAllByRole('button')
    expect(examples.map((b) => b.textContent)).toEqual(['Bell pair', 'One flipped qubit', 'Three-qubit GHZ state', 'No gates, just measure'])
  })

  it('loading an example puts that circuit on the Lab’s canvas and nowhere else', async () => {
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Three-qubit GHZ state' }))
    const circuit = useBuildStore.getState().circuit
    expect(circuit.num_qubits).toBe(3)
    expect(circuit.ops.map((o) => o.gate)).toEqual(['h', 'cx', 'cx', 'measure', 'measure', 'measure'])
    expect(client.compareNoise).not.toHaveBeenCalled() // loading a circuit runs nothing
  })

  it('has a "What should I expect?" section with the model’s notes from the server and the general ones', async () => {
    await ready()
    const section = screen.getByRole('region', { name: 'What should I expect?' })
    expect(section).toBeInTheDocument()
    expect(within(screen.getByTestId('expect-model')).getByText(/moves probability onto outcomes the ideal circuit never produces/)).toBeInTheDocument()
    expect(within(screen.getByTestId('expect-general')).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3)
    expect(text('expect-general')).toMatch(/finite sample/)
    expect(text('expect-general')).toMatch(/not a model of any real device/)
    fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: 'readout_error' } })
    expect(within(screen.getByTestId('expect-model')).getByText('It acts only on measurement.')).toBeInTheDocument()
  })

  it('says nothing about hardware beyond saying it is not', async () => {
    await ready()
    const all = document.body.textContent!.toLowerCase()
    expect(all).not.toMatch(/real qpu|ibm|fidelity|calibrat/)
  })
})

describe('the controls', () => {
  it('draws its models, ranges and defaults from the server’s catalog', async () => {
    await ready()
    const select = screen.getByLabelText('Noise model') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'None (ideal only)',
      'Depolarizing gate noise',
      'Bit-flip gate noise',
      'Phase-flip gate noise',
      'Amplitude-damping gate noise',
      'Readout error',
    ])
    expect(select.value).toBe('depolarizing')
    const slider = screen.getByLabelText('Noise strength, slider') as HTMLInputElement
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['0', '0.3', '0.005', '0.05'])
    expect((screen.getByLabelText('Noise strength, value') as HTMLInputElement).value).toBe('0.05')
    expect((screen.getByLabelText('Shots') as HTMLInputElement).value).toBe('1024')
    expect((screen.getByLabelText('Seed (optional)') as HTMLInputElement).placeholder).toBe('random')
  })

  it('every control has an accessible name and the current value is exposed', async () => {
    await ready()
    for (const name of ['Noise model', 'Noise strength, slider', 'Noise strength, value', 'Shots', 'Seed (optional)']) expect(screen.getByLabelText(name)).toBeInTheDocument()
    expect(screen.getByLabelText('Noise strength, slider')).toHaveAttribute('aria-valuetext', '0.05')
    expect(screen.getByRole('group', { name: /Noise strength \(error probability p\)/ })).toBeInTheDocument()
  })

  it('the controls are native form elements, so they work from the keyboard', async () => {
    await ready()
    expect(screen.getByLabelText('Noise model').tagName).toBe('SELECT')
    expect(screen.getByLabelText('Noise strength, slider')).toHaveAttribute('type', 'range')
    expect(screen.getByLabelText('Noise strength, value')).toHaveAttribute('type', 'number')
    expect(screen.getByLabelText('Shots')).toHaveAttribute('type', 'number')
    for (const el of [screen.getByLabelText('Noise model'), screen.getByLabelText('Noise strength, slider'), screen.getByLabelText('Shots'), screen.getByRole('button', { name: /^Run ideal/ })]) {
      expect(el.tabIndex).toBeGreaterThanOrEqual(0)
    }
  })

  it('choosing a model resets the strength to that model’s default and range', async () => {
    await ready()
    fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: 'amplitude_damping' } })
    const slider = screen.getByLabelText('Noise strength, slider') as HTMLInputElement
    expect([slider.max, slider.value]).toEqual(['0.5', '0.1'])
    expect(screen.getByRole('group', { name: /decay probability gamma/ })).toBeInTheDocument()
  })

  it('shows where the model acts: after gates, or at measurement', async () => {
    await ready()
    expect(screen.getByTestId('noise-where')).toHaveAttribute('data-applies-to', 'gates')
    expect(within(screen.getByTestId('noise-where')).getByText(/noise acts right after each gate: noise here/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: 'readout_error' } })
    expect(screen.getByTestId('noise-where')).toHaveAttribute('data-applies-to', 'measurement')
    expect(within(screen.getByTestId('noise-where')).getByText(/noise acts on what is read out: noise here/)).toBeInTheDocument()
  })

  it('the slider and the number box show the same value, whichever one moves', async () => {
    await ready()
    fireEvent.change(screen.getByLabelText('Noise strength, slider'), { target: { value: '0.2' } })
    expect((screen.getByLabelText('Noise strength, value') as HTMLInputElement).value).toBe('0.2')
    expect(screen.getByLabelText('Noise strength, slider')).toHaveAttribute('aria-valuetext', '0.2')
    fireEvent.change(screen.getByLabelText('Noise strength, value'), { target: { value: '0.12' } })
    expect((screen.getByLabelText('Noise strength, slider') as HTMLInputElement).value).toBe('0.12')
    expect(useNoiseStore.getState().strength).toBe(0.12)
  })

  it('with no noise model there is no strength to set, and the button says it runs the ideal simulation only', async () => {
    await ready()
    fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: 'none' } })
    expect(screen.queryByLabelText('Noise strength, slider')).not.toBeInTheDocument()
    expect(screen.getByText('Choose a noise model to set its strength.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run ideal simulation' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: 'depolarizing' } })
    expect(screen.getByRole('button', { name: 'Run ideal vs noisy' })).toBeInTheDocument()
  })

  it('a value the server would refuse is flagged and cannot be run', async () => {
    await ready()
    const runButton = () => screen.getByRole('button', { name: /^Run ideal/ })
    fireEvent.change(screen.getByLabelText('Noise strength, value'), { target: { value: '0.9' } })
    expect(screen.getByText('Use a value from 0 to 0.3 for this model.')).toBeInTheDocument()
    expect(screen.getByLabelText('Noise strength, value')).toHaveAttribute('aria-invalid', 'true')
    expect(runButton()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Noise strength, value'), { target: { value: '0.1' } })
    expect(runButton()).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Shots'), { target: { value: '0' } })
    expect(screen.getByText('Use a whole number of shots from 1 to 20000.')).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Shots'), { target: { value: '20001' } })
    expect(runButton()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Shots'), { target: { value: '500' } })
    fireEvent.change(screen.getByLabelText('Seed (optional)'), { target: { value: 'abc' } })
    expect(screen.getByText('Use a whole number (or leave it empty).')).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Seed (optional)'), { target: { value: '' } })
    expect(runButton()).toBeEnabled()
    expect(client.compareNoise).not.toHaveBeenCalled()
  })

  it('warns, without blocking, about a circuit the server will refuse (no measurement, too many qubits)', async () => {
    useBuildStore.getState().loadCircuit({ ...emptyCircuit(2, 0), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }] })
    await ready()
    expect(text('noise-circuit-hint')).toMatch(/no measurement/)
    expect(screen.getByRole('button', { name: /^Run ideal/ })).toBeEnabled() // the server is the authority
    useBuildStore.getState().loadCircuit({ ...emptyCircuit(9, 9), ops: [{ gate: 'measure', targets: [0], controls: [], params: [], clbits: [0] }] })
    await waitFor(() => expect(text('noise-circuit-hint')).toMatch(/limited to 8 qubits and this circuit has 9/))
  })

  it('a catalog that cannot be loaded says so, substitutes nothing, and can be retried', async () => {
    client.listNoiseModels.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend: down'))
    render(<NoiseLabScreen />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The noise models could not be loaded.')
    expect(alert).toHaveTextContent('Nothing was substituted')
    expect(screen.queryByLabelText('Noise model')).not.toBeInTheDocument()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('Noise model')).toBeInTheDocument()
  })
})

describe('running', () => {
  it('sends exactly what was chosen, for the circuit on the canvas', async () => {
    await ready()
    fireEvent.change(screen.getByLabelText('Noise strength, value'), { target: { value: '0.2' } })
    fireEvent.change(screen.getByLabelText('Shots'), { target: { value: '2000' } })
    fireEvent.change(screen.getByLabelText('Seed (optional)'), { target: { value: '12' } })
    run()
    await screen.findByTestId('noise-result')
    expect(client.compareNoise).toHaveBeenCalledTimes(1)
    expect(client.compareNoise).toHaveBeenCalledWith({ circuit: BELL_MEASURED, noiseModel: 'depolarizing', noiseStrength: 0.2, shots: 2000, seed: 12 })
  })

  it('asks for the model’s default seed handling when the seed box is empty, and sends no strength for "none"', async () => {
    await ready()
    run()
    await screen.findByTestId('noise-result')
    expect(client.compareNoise.mock.calls[0]![0]).toMatchObject({ noiseModel: 'depolarizing', noiseStrength: 0.05, shots: 1024, seed: null })
    client.compareNoise.mockResolvedValueOnce(parseNoiseResult(IDEAL_ONLY_WIRE))
    fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: 'none' } })
    run()
    await waitFor(() => expect(client.compareNoise).toHaveBeenCalledTimes(2))
    expect(client.compareNoise.mock.calls[1]![0]).toMatchObject({ noiseModel: 'none', noiseStrength: null })
  })

  it('shows a live "running" status and disables the button while the server works', async () => {
    let finish!: (v: unknown) => void
    client.compareNoise.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    await ready()
    run()
    expect(await screen.findByRole('status')).toHaveTextContent('Running the ideal and noisy simulations on the backend…')
    const busy = screen.getByRole('button', { name: 'Running…' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByTestId('noise-result')).not.toBeInTheDocument()
    await act(async () => finish(parseNoiseResult()))
    expect(await screen.findByTestId('noise-result')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Run ideal/ })).toBeEnabled()
  })

  it('before anything is run it says what to do and shows no number', async () => {
    await ready()
    expect(screen.getByText('Run the circuit to compare an ideal simulation with a noisy one.')).toBeInTheDocument()
    expect(screen.queryByTestId('noise-result')).not.toBeInTheDocument()
  })
})

describe('the result', () => {
  it('labels both runs as simulations and the noisy one as simulated noise, never as hardware', async () => {
    await ran()
    expect(within(screen.getByTestId('run-ideal')).getByText(/^Simulated/)).toHaveTextContent(/^Simulated\s*·\s*qiskit-aer$/)
    expect(within(screen.getByTestId('run-noisy')).getByText(/Simulated noise/)).toHaveTextContent(/^Simulated noise\s*·\s*qiskit-aer$/)
    expect(text('noise-label')).toMatch(/Not a real device/)
    expect(document.body.textContent).not.toMatch(/Real hardware|Recorded hardware|REAL_HARDWARE/)
  })

  it('names, for each run, the backend, execution mode, noise model, parameter, shots, seed and result', async () => {
    await ran()
    expect(text('ideal-backend')).toBe('qiskit-aer 0.17.2')
    expect(text('noisy-backend')).toBe('qiskit-aer 0.17.2')
    expect(text('ideal-mode')).toBe('shots')
    expect(text('noisy-mode')).toBe('noisy_shots')
    expect(text('ideal-noise')).toBe('none (ideal)')
    expect(text('noisy-noise')).toBe('Depolarizing gate noise')
    expect(text('noisy-strength')).toBe('0.05')
    expect(within(screen.getByTestId('run-noisy')).getByText('error probability p')).toBeInTheDocument()
    expect(within(screen.getByTestId('run-noisy')).getByText('density_matrix')).toBeInTheDocument()
    expect([text('ideal-shots'), text('noisy-shots')]).toEqual(['1000', '1000'])
    expect([text('ideal-seed'), text('noisy-seed')]).toEqual(['4242', '4242'])
    expect(screen.getByTestId('ideal-result-id')).toHaveAttribute('title', 'res_ideal_0001')
    expect(screen.getByTestId('noisy-result-id')).toHaveAttribute('title', 'res_noisy_0002')
  })

  it('each number carries the provenance of the run it came from (a noisy count never wears the ideal run’s id)', async () => {
    await ran()
    const row = screen.getByTestId('noise-row-01')
    const cells = within(row).getAllByRole('cell')
    expect(cells.map((c) => c.textContent)).toEqual(['0', '0.0000', '70', '0.0700', '+0.0700'])
    expect(title(cells[0]!)).toBe('SIMULATION · qiskit-aer · res_ideal_0001')
    expect(title(cells[1]!)).toBe('SIMULATION · qiskit-aer · res_ideal_0001')
    expect(title(cells[2]!)).toBe('SIMULATION · qiskit-aer · res_noisy_0002')
    expect(title(cells[3]!)).toBe('SIMULATION · qiskit-aer · res_noisy_0002')
    expect(title(cells[4]!)).toBe('SIMULATION · noise-comparison · res_cmp_0003')
  })

  it('shows the server’s counts for both runs in one table, outcome by outcome', async () => {
    await ran()
    const table = screen.getByTestId('noise-table')
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell', { hidden: true }).map((c) => c.textContent))).toEqual([
      ['507', '0.5070', '441', '0.4410', '−0.0660'],
      ['0', '0.0000', '70', '0.0700', '+0.0700'],
      ['0', '0.0000', '59', '0.0590', '+0.0590'],
      ['493', '0.4930', '430', '0.4300', '−0.0630'],
    ])
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['00', '01', '10', '11'])
  })

  it('states the bitstring order and that these are sampled frequencies', async () => {
    await ran()
    expect(document.body.textContent).toMatch(/Bitstrings are written q\[n-1\] … q\[0\]/)
    expect(document.body.textContent).toMatch(/Frequencies are count ÷ shots from one finite sample, not probabilities/)
  })

  it('draws one chart with a text alternative that points at the table', async () => {
    await ran()
    const chart = screen.getByTestId('noise-chart')
    expect(chart).toHaveAttribute('role', 'img')
    expect(chart.getAttribute('aria-label')).toMatch(/Grouped bar chart of the sampled frequency of each of 4 measurement outcomes, for the Ideal and Noisy runs/)
    expect(chart.getAttribute('aria-label')).toMatch(/listed in the table that follows/)
  })

  it('shows the server’s metrics with the comparison’s provenance, and names no "fidelity" or "success"', async () => {
    await ran()
    expect(text('metric-tvd')).toBe('0.1290')
    expect(text('metric-share')).toBe('0.8710')
    expect(text('metric-new-shots')).toBe('129')
    expect(title(screen.getByTestId('metric-tvd'))).toBe('SIMULATION · noise-comparison · res_cmp_0003')
    expect(text('new-outcomes')).toMatch(/01, 10/)
    expect(screen.getByTestId('noise-metrics').textContent!.toLowerCase()).not.toMatch(/fidelity|success/)
  })

  it('shows the server’s explanation as written, says no model wrote it, and adds nothing', async () => {
    await ran()
    const lines = within(screen.getByTestId('noise-explanation')).getAllByRole('listitem').map((l) => l.textContent)
    expect(lines).toEqual(NOISE_WIRE.comparison.explanation.map((l) => l.text))
    expect(text('noise-explanation')).toMatch(/Written by the server from comparison record/)
    expect(text('noise-explanation')).toMatch(/No language model was involved/)
  })

  it('with no noise model, only the ideal run is shown and the page says so', async () => {
    client.compareNoise.mockResolvedValueOnce(parseNoiseResult(IDEAL_ONLY_WIRE))
    await ready()
    fireEvent.change(screen.getByLabelText('Noise model'), { target: { value: 'none' } })
    run()
    await screen.findByTestId('ideal-only-note')
    expect(screen.queryByTestId('run-noisy')).not.toBeInTheDocument()
    expect(screen.queryByTestId('noise-metrics')).not.toBeInTheDocument()
    expect(screen.queryByTestId('noise-explanation')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('noise-table')).queryByText('noisy count')).not.toBeInTheDocument()
  })

  it('changing a setting after a run keeps the result and says the settings have moved on', async () => {
    await ran()
    expect(screen.queryByTestId('noise-settings-moved')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Noise strength, value'), { target: { value: '0.2' } })
    expect(text('noise-settings-moved')).toMatch(/The settings have changed since this run\. The result below is for Depolarizing gate noise at 0\.05 with 1000 shots/)
    expect(screen.getByTestId('noise-result')).toBeInTheDocument()
  })

  it('running again with a different strength replaces the result with the server’s new one', async () => {
    await ran()
    const second = structuredClone(NOISE_WIRE)
    second.noise.strength = 0.2
    second.noisy.noise = { ...second.noisy.noise, strength: 0.2 }
    second.noisy.provenance.result_id = 'res_noisy_0009'
    second.noisy.counts = { '00': 300, '11': 290, '01': 220, '10': 190 }
    second.noisy.probabilities = { '00': 0.3, '11': 0.29, '01': 0.22, '10': 0.19 }
    second.comparison.rows = second.comparison.rows.map((r) => ({ ...r, noisy_count: second.noisy.counts[r.outcome as '00'] ?? 0, noisy_probability: second.noisy.probabilities[r.outcome as '00'] ?? 0 }))
    client.compareNoise.mockResolvedValueOnce(parseNoiseResult(second))
    fireEvent.change(screen.getByLabelText('Noise strength, value'), { target: { value: '0.2' } })
    run()
    await waitFor(() => expect(text('noisy-strength')).toBe('0.2'))
    expect(screen.getByTestId('noisy-result-id')).toHaveAttribute('title', 'res_noisy_0009')
    expect(within(screen.getByTestId('noise-row-01')).getAllByRole('cell')[2]!.textContent).toBe('220')
    expect(screen.queryByTestId('noise-settings-moved')).not.toBeInTheDocument()
  })

  it('a result is hidden once the circuit changes, because it belongs to a different circuit', async () => {
    await ran()
    act(() => useBuildStore.getState().loadCircuit({ ...BELL_MEASURED, ops: BELL_MEASURED.ops.slice(0, 3) }))
    expect(screen.queryByTestId('noise-result')).not.toBeInTheDocument()
    expect(text('noise-stale')).toMatch(/The circuit changed after this result was made/)
  })
})

describe('errors', () => {
  it('shows the server’s refusal with its code, shows no result, and says nothing was substituted', async () => {
    client.compareNoise.mockRejectedValueOnce(new NoiseRejectedError('a noisy simulation is limited to 8 qubits (it keeps a 2**n x 2**n density matrix); this circuit has 9', 'NOISE_TOO_MANY_QUBITS', 422))
    await ready()
    run()
    const alert = await screen.findByRole('alert', { name: '' }).catch(() => screen.getAllByRole('alert').at(-1)!)
    expect(alert).toHaveTextContent('The noise run did not complete')
    expect(alert).toHaveTextContent('limited to 8 qubits')
    expect(alert).toHaveTextContent('(NOISE_TOO_MANY_QUBITS)')
    expect(alert).toHaveTextContent('Nothing was substituted')
    expect(screen.queryByTestId('noise-result')).not.toBeInTheDocument()
  })

  it('an unreachable server is an error too, and "Try again" asks the server again', async () => {
    client.compareNoise.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend: down'))
    await ready()
    run()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('could not reach the Qentor backend')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('noise-result')).toBeInTheDocument()
    expect(client.compareNoise).toHaveBeenCalledTimes(2)
  })

  it('a failed run removes the previous result: it answered a different request', async () => {
    await ran()
    client.compareNoise.mockRejectedValueOnce(new NoiseRejectedError('refused', 'NOISE_STRENGTH_OUT_OF_RANGE', 422))
    run()
    await screen.findByText('The noise run did not complete')
    expect(screen.queryByTestId('noise-result')).not.toBeInTheDocument()
  })

  it('a late answer to an older run does not overwrite a newer one', async () => {
    let late!: (v: unknown) => void
    client.compareNoise.mockReturnValueOnce(new Promise((resolve) => (late = resolve)))
    await ready()
    run()
    const stale = structuredClone(NOISE_WIRE)
    stale.noisy.provenance.result_id = 'res_noisy_STALE'
    useNoiseStore.getState().clearResult() // the learner moved on
    await act(async () => late(parseNoiseResult(stale)))
    expect(screen.queryByTestId('noise-result')).not.toBeInTheDocument()
  })
})

describe('structure and accessibility', () => {
  it('has no structural accessibility violations with a result on screen (names, labels, roles, headings, ids)', async () => {
    await ran()
    const result = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } },
    })
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })

  it('has no structural violations before a run, with an error, and for a catalog that failed to load', async () => {
    const check = async () =>
      (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } } })).violations.map((v) => v.id)
    await ready()
    expect(await check()).toEqual([])
    client.compareNoise.mockRejectedValueOnce(new NoiseRejectedError('refused', 'X', 422))
    run()
    await screen.findByText('The noise run did not complete')
    expect(await check()).toEqual([])
  })

  it('heading levels never skip: one h1, then sections', async () => {
    await ran()
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName[1]))
    for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
  })
})
