/** Share links and exports: what goes in a link, how an untrusted link is read, and what the export panel sends and produces. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CircuitExport } from '@/api'
import { BackendUnavailableError } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { decodeShareFragment, encodeShareFragment, MAX_ENCODED_LENGTH, MAX_SHARED_OPS, shareUrl, SHARE_PREFIX } from './shareLink'

const client = vi.hoisted(() => ({
  exportCircuit: vi.fn(),
  listLessons: vi.fn(),
  executeCircuit: vi.fn(),
  verifyBellState: vi.fn(),
  askTutor: vi.fn(),
  optimizeCircuit: vi.fn(),
  runMultiInputTest: vi.fn(),
  traceCircuit: vi.fn(),
}))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.mock('plotly.js-basic-dist-min', () => ({ default: {} }))

import App from '@/App'
import { useBuildStore } from '@/features/build/store'

const op = (gate: string, t: number, c: number[] = []) => ({ gate, targets: [t], controls: c, params: [], clbits: [] }) as Circuit['ops'][number]
const BELL: Circuit = { ...emptyCircuit(2, 0), ops: [op('h', 0), op('cx', 1, [0])] }

describe('the share fragment', () => {
  it('round-trips a circuit exactly', () => {
    const fragment = encodeShareFragment(BELL)!
    expect(fragment.startsWith(SHARE_PREFIX)).toBe(true)
    expect(decodeShareFragment(fragment)).toEqual({ ok: true, circuit: BELL })
  })

  it('contains the circuit and nothing else', () => {
    const json = atob(encodeShareFragment(BELL)!.slice(SHARE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'))
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(['num_clbits', 'num_qubits', 'ops', 'schema'])
  })

  it('is URL-safe (no + / = characters)', () => {
    expect(encodeShareFragment(BELL)).toMatch(/^#c=[A-Za-z0-9_-]+$/)
  })

  it('builds a full URL that opens the Lab', () => {
    expect(shareUrl(BELL, { origin: 'https://qentor.example' })).toMatch(/^https:\/\/qentor\.example\/#c=/)
  })

  it('a circuit too large for a link yields no link (use the file)', () => {
    const big = { ...emptyCircuit(2, 0), ops: Array.from({ length: 400 }, () => op('h', 0)) }
    expect(encodeShareFragment(big)).toBeNull()
    expect(shareUrl(big, { origin: 'x' })).toBeNull()
  })

  it('is not a share link unless it starts with #c=', () => {
    for (const f of ['', '#', '#section', '#C=abc', '#x=abc']) expect(decodeShareFragment(f)).toBeNull()
  })

  it.each([
    ['empty payload', '#c='],
    ['characters a link never has', '#c=abc$%^'],
    ['not base64', '#c=!!!!'],
    ['not JSON', '#c=' + btoa('hello')],
    ['JSON that is not a circuit', '#c=' + btoa(JSON.stringify({ hello: 1 }))],
    ['a circuit with an unknown gate', '#c=' + btoa(JSON.stringify({ schema: 'qentor.circuit/1', num_qubits: 1, num_clbits: 0, ops: [{ gate: 'exec', targets: [0] }] }))],
    ['a circuit with an extra field (a smuggled result)', '#c=' + btoa(JSON.stringify({ ...BELL, probabilities: { '00': 1 } }))],
    ['too many qubits', '#c=' + btoa(JSON.stringify({ schema: 'qentor.circuit/1', num_qubits: 99, num_clbits: 0, ops: [] }))],
    ['too long', '#c=' + 'A'.repeat(MAX_ENCODED_LENGTH + 1)],
  ])('refuses %s, with a reason and no circuit', (_name, fragment) => {
    const r = decodeShareFragment(fragment === '#c=' ? fragment : fragment.replace(/=+$/, ''))
    expect(r).not.toBeNull()
    expect(r!.ok).toBe(false)
    expect((r as { reason: string }).reason.length).toBeGreaterThan(5)
  })

  it('refuses more operations than the cap', () => {
    const many = { ...emptyCircuit(1, 0), ops: Array.from({ length: MAX_SHARED_OPS + 1 }, () => op('x', 0)) }
    const frag = '#c=' + btoa(JSON.stringify(many)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const r = decodeShareFragment(frag)
    expect(r).toMatchObject({ ok: false })
  })

  it('reads non-ASCII safely (UTF-8) and never throws on garbage bytes', () => {
    expect(() => decodeShareFragment('#c=' + btoa(String.fromCharCode(0xff, 0xfe, 0xfd)).replace(/=+$/, ''))).not.toThrow()
  })
})

const PROV: Provenance = {
  resultId: 'res_lab_1',
  circuitHash: 'qc_lab',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
}
const BUNDLE = (execution: Provenance | null): CircuitExport => ({
  format: 'qentor.export/1',
  circuitHash: 'abcdef0123456789',
  circuit: BELL,
  qasm: 'OPENQASM 3.0;\n',
  generator: 'qentor.codegen/1',
  code: { qiskit: 'q', cirq: 'c', pennylane: 'p' },
  execution,
  note: 'no results',
})

describe('the export panel', () => {
  let downloads: { name: string; text: string }[]
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    localStorage.clear()
    for (const fn of Object.values(client)) fn.mockReset()
    client.listLessons.mockResolvedValue([])
    client.executeCircuit.mockReturnValue(new Promise(() => {}))
    client.exportCircuit.mockResolvedValue(BUNDLE(null))
    useBuildStore.setState(useBuildStore.getInitialState(), true)
    downloads = []
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, text: '' })
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const region = () => screen.getByTestId('export-panel')
  const withCircuit = () => act(() => void useBuildStore.setState({ circuit: BELL }))

  it('is disabled with an empty circuit, and says why', () => {
    render(<App />)
    act(() => void useBuildStore.setState({ circuit: emptyCircuit(2, 0) }))
    expect(within(region()).getByRole('button', { name: /Download bundle/ })).toBeDisabled()
    expect(within(region()).getByRole('button', { name: 'Copy share link' })).toBeDisabled()
    expect(within(region()).getByText('Add gates to the circuit to export or share it.')).toBeInTheDocument()
  })

  it('asks the server for the bundle with the circuit and (if there is one) the result id — nothing else', async () => {
    render(<App />)
    withCircuit()
    act(() => void useBuildStore.setState({ result: toQuantumValue({ executionId: 'e', probabilities: { '00': 1 } }, PROV) }))
    client.exportCircuit.mockResolvedValueOnce(BUNDLE(PROV))
    fireEvent.click(within(region()).getByRole('button', { name: /Download bundle/ }))
    await waitFor(() => expect(client.exportCircuit).toHaveBeenCalledWith(BELL, 'res_lab_1'))
    expect(client.exportCircuit.mock.calls[0]).toHaveLength(2)
  })

  it('downloads the bundle as a .json named after the circuit hash, and says what is in it', async () => {
    render(<App />)
    withCircuit()
    fireEvent.click(within(region()).getByRole('button', { name: /Download bundle/ }))
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]!.name).toBe('qentor-abcdef01.json')
    expect((await screen.findByTestId('export-status')).textContent).toMatch(/no results/)
  })

  it('downloads OpenQASM as a .qasm', async () => {
    render(<App />)
    withCircuit()
    fireEvent.click(within(region()).getByRole('button', { name: /Download OpenQASM/ }))
    await waitFor(() => expect(downloads.map((d) => d.name)).toEqual(['qentor-abcdef01.qasm']))
  })

  it('an export failure is an alert, and nothing is downloaded', async () => {
    client.exportCircuit.mockRejectedValueOnce(new BackendUnavailableError('server down'))
    render(<App />)
    withCircuit()
    fireEvent.click(within(region()).getByRole('button', { name: /Download bundle/ }))
    const alert = await within(region()).findByRole('alert')
    expect(alert.textContent).toMatch(/server down/)
    expect(alert.textContent).toMatch(/Nothing was exported/)
    expect(downloads).toEqual([])
  })

  it('copies a share link that carries the circuit only, and shows it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<App />)
    withCircuit()
    fireEvent.click(within(region()).getByRole('button', { name: 'Copy share link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const url = writeText.mock.calls[0]![0] as string
    expect(url).toMatch(/\/#c=[A-Za-z0-9_-]+$/)
    expect(decodeShareFragment(url.slice(url.indexOf('#')))).toEqual({ ok: true, circuit: BELL })
    expect((within(region()).getByLabelText('Share link') as HTMLInputElement).value).toBe(url)
    expect(client.exportCircuit).not.toHaveBeenCalled() // a link needs no server round trip
  })

  it('if the clipboard is unavailable the link is still there to copy by hand', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    render(<App />)
    withCircuit()
    fireEvent.click(within(region()).getByRole('button', { name: 'Copy share link' }))
    expect((await screen.findByTestId('export-status')).textContent).toMatch(/Copy the link below/)
  })

  it('a circuit too large for a link says so and points to the bundle', async () => {
    render(<App />)
    act(() => void useBuildStore.setState({ circuit: { ...emptyCircuit(2, 0), ops: Array.from({ length: 400 }, () => op('h', 0)) } }))
    fireEvent.click(within(region()).getByRole('button', { name: 'Copy share link' }))
    expect((await within(region()).findByRole('alert')).textContent).toMatch(/too large for a link/)
  })

  it('states what bundles and links do not contain', () => {
    render(<App />)
    expect(region().textContent).toMatch(/never results, keys or anything private/)
  })
})

describe('opening a share link', () => {
  beforeEach(() => {
    localStorage.clear()
    for (const fn of Object.values(client)) fn.mockReset()
    client.listLessons.mockResolvedValue([])
    client.executeCircuit.mockReturnValue(new Promise(() => {}))
    useBuildStore.setState(useBuildStore.getInitialState(), true)
  })
  afterEach(cleanup)

  it('loads the circuit onto the canvas with NO result, tells the learner, and removes the fragment', () => {
    window.history.replaceState(null, '', '/' + encodeShareFragment(BELL))
    render(<App />)
    expect(useBuildStore.getState().circuit).toEqual(BELL)
    expect(useBuildStore.getState().result).toBeNull()
    expect(screen.getByTestId('shared-notice').textContent).toMatch(/Loaded a circuit from a shared link\. It came without results/)
    expect(window.location.hash).toBe('')
  })

  it('a bad link loads nothing, says why, and is an alert', () => {
    const before = useBuildStore.getState().circuit
    window.history.replaceState(null, '', '/#c=' + btoa(JSON.stringify({ ...BELL, probabilities: { '00': 1 } })).replace(/=+$/, ''))
    render(<App />)
    expect(useBuildStore.getState().circuit).toBe(before)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/could not be opened/)
    expect(alert.textContent).toMatch(/Nothing was loaded/)
  })

  it('an ordinary fragment (an in-page anchor) is left alone', () => {
    window.history.replaceState(null, '', '/#main-content')
    render(<App />)
    expect(screen.queryByTestId('shared-notice')).toBeNull()
    expect(window.location.hash).toBe('#main-content')
  })

  it('the notice can be dismissed', () => {
    window.history.replaceState(null, '', '/' + encodeShareFragment(BELL))
    render(<App />)
    fireEvent.click(within(screen.getByTestId('shared-notice')).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('shared-notice')).toBeNull()
  })

  it('opening the link runs nothing by itself beyond the Lab’s normal auto-run of the circuit on screen', async () => {
    window.history.replaceState(null, '', '/' + encodeShareFragment(BELL))
    render(<App />)
    await waitFor(() => expect(client.executeCircuit).toHaveBeenCalled())
    // the numbers the learner then sees are the backend's, computed for THIS browser's run
    expect(client.executeCircuit.mock.calls[0]![0]).toEqual(BELL)
  })
})
