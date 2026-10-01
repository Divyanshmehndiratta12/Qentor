/**
 * axe-core (jsdom, structural rules) over the shared-experiment page and the code-import panel (with a preview and with a refusal).
 * Names, roles, headings, labels, duplicate ids. Colour contrast is covered from the theme (`a11y/contrast.test.ts`) and in the real browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'

const client = vi.hoisted(() => ({
  listLessons: vi.fn(),
  listChallenges: vi.fn(),
  getGenerationStatus: vi.fn(),
  getMyClass: vi.fn(),
  getExperiment: vi.fn(),
  parseCode: vi.fn(),
  regradeConceptChecks: vi.fn(),
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
import { CodeNotSupportedError, type SharedExperiment } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { useBuildStore } from '@/features/build/store'
import { resetClassroomForTests } from '@/features/classroom/store'
import { toQuantumValue } from '@/provenance/QuantumValue'

const INITIAL_BUILD = useBuildStore.getState()

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } },
  })
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)
}

const SHARED: SharedExperiment = {
  experimentId: 'ex_0123456789abcdef',
  createdAt: '2026-10-01T12:00:00Z',
  title: 'Bell pair',
  note: 'A read-only snapshot.',
  circuitHash: 'h',
  circuit: { ...emptyCircuit(2, 0), ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }, { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] }] },
  qasm: 'OPENQASM 3.0;',
  generator: 'g',
  code: { qiskit: 'a', cirq: 'b', pennylane: 'c' },
  backend: 'qiskit-aer',
  mode: 'statevector',
  shots: null,
  lesson: { id: 'l', title: 'A lesson' },
  challenge: null,
  result: toQuantumValue(
    { executionId: 'e', statevector: [[0.7071, 0], [0, 0], [0, 0], [0.7071, 0]] as Array<[number, number]>, theoreticalProbabilities: { '00': 0.5, '11': 0.5 } },
    { resultId: 'r', circuitHash: 'h', backend: 'qiskit-aer', backendVersion: '1', executionMode: 'statevector', provenanceClass: 'SIMULATION', verificationStatus: 'STATE_CHECKED', createdAt: 'c' },
  ),
  resultNote: 'stored',
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  localStorage.setItem('qentor.welcome.dismissed', '1')
  resetClassroomForTests()
  for (const fn of Object.values(client)) fn.mockReset()
  client.listLessons.mockResolvedValue([])
  client.listChallenges.mockResolvedValue([])
  client.regradeConceptChecks.mockResolvedValue([])
  client.getGenerationStatus.mockResolvedValue({ available: false, provider: null, model: null, reason: 'none' })
  useBuildStore.setState(INITIAL_BUILD, true)
})
afterEach(cleanup)

describe('axe: shared experiments and code import', () => {
  it('the shared-experiment page, with a stored run', async () => {
    client.getExperiment.mockResolvedValue(SHARED)
    window.history.replaceState(null, '', '/shared/ex_0123456789abcdef')
    render(<App />)
    await screen.findByTestId('shared-title')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(await violations()).toEqual([])
  })

  it('the shared page when the experiment does not exist', async () => {
    window.history.replaceState(null, '', '/shared/nope')
    render(<App />)
    await screen.findByTestId('shared-missing')
    expect(await violations()).toEqual([])
  })

  it('the Lab with the import panel open: a preview, then a refusal', async () => {
    client.parseCode.mockResolvedValueOnce({
      dialect: 'qiskit',
      label: 'Safe subset parser — Python is not executed.',
      circuit: SHARED.circuit,
      circuitHash: 'h',
      canonicalQasm: 'OPENQASM 3.0;',
      notes: ['a note'],
    })
    window.history.replaceState(null, '', '/')
    render(<App />)
    const summary = (await screen.findByText('Import from code')) as HTMLElement
    ;(summary.closest('details') as HTMLDetailsElement).open = true
    fireEvent.change(screen.getByLabelText('Paste Qiskit code'), { target: { value: 'qc = 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Parse' }))
    await screen.findByTestId('import-preview')
    expect(await violations()).toEqual([])

    client.parseCode.mockRejectedValueOnce(new CodeNotSupportedError('x', [{ line: 2, column: 0, message: 'a for loop is not supported' }], ['qc.h(q)'], 'l'))
    fireEvent.change(screen.getByLabelText('Paste Qiskit code'), { target: { value: 'for i in x: pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Parse' }))
    await screen.findByTestId('import-refused')
    expect(await violations()).toEqual([])
  })
})
