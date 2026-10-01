/**
 * Importing a circuit from pasted code: Paste -> Parse -> Preview -> Insert into Lab. The server reads the text (it never runs it); the
 * browser sends the text, shows the circuit the server read, and puts it in the Lab only when asked. Unsupported code is shown as
 * refused, with each construct and its line, and nothing is guessed, translated or inserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ParsedCode } from '@/api'

const client = vi.hoisted(() => ({ parseCode: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { BackendUnavailableError, ClassroomRejectedError, CodeNotSupportedError } from '@/api'
import { emptyCircuit, type Circuit } from '@/circuit/types'
import { CodeImport, PARSER_LABEL } from './CodeImport'
import { useBuildStore } from './store'

const op = (gate: string, t: number, c: number[] = []) => ({ gate, targets: [t], controls: c, params: [], clbits: [] }) as Circuit['ops'][number]
const BELL: Circuit = { ...emptyCircuit(2, 0), ops: [op('h', 0), op('cx', 1, [0])] }
const PARSED: ParsedCode = { dialect: 'qiskit', label: PARSER_LABEL, circuit: BELL, circuitHash: 'h', canonicalQasm: 'OPENQASM 3.0;\nh q[0];\ncx q[0], q[1];', notes: ['measure_all adds 2 classical bits.'] }
const QISKIT = 'from qiskit import QuantumCircuit\nqc = QuantumCircuit(2)\nqc.h(0)\nqc.cx(0, 1)\n'

beforeEach(() => {
  cleanup()
  client.parseCode.mockReset()
  useBuildStore.getState().loadCircuit(emptyCircuit(2, 0))
})
afterEach(cleanup)

const paste = (text: string) => fireEvent.change(screen.getByLabelText(/Paste .* code/), { target: { value: text } })
const parse = () => fireEvent.click(screen.getByRole('button', { name: 'Parse' }))

describe('the import panel', () => {
  it('says the parser is a safe subset and that Python is not executed', () => {
    render(<CodeImport />)
    expect(PARSER_LABEL).toBe('Safe subset parser — Python is not executed.')
    expect(screen.getByTestId('parser-label')).toHaveTextContent(PARSER_LABEL)
    expect(screen.getByTestId('parser-label')).toHaveTextContent('Only a small documented subset is read; anything else is refused, never guessed.')
  })

  it('offers the four languages, Qiskit first, and a placeholder that shows the supported shape', () => {
    render(<CodeImport />)
    const group = screen.getByRole('group', { name: 'Language to import' })
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['OpenQASM', 'Qiskit', 'Cirq', 'PennyLane'])
    expect(within(group).getByRole('radio', { name: 'Qiskit' })).toBeChecked()
    expect(screen.getByLabelText('Paste Qiskit code')).toHaveAttribute('placeholder', expect.stringContaining('qc.cx(0, 1)'))
    fireEvent.click(within(group).getByRole('radio', { name: 'PennyLane' }))
    expect(screen.getByLabelText('Paste PennyLane code')).toHaveAttribute('placeholder', expect.stringContaining('qml.CNOT'))
    fireEvent.click(within(group).getByRole('radio', { name: 'Cirq' }))
    expect(screen.getByLabelText('Paste Cirq code')).toHaveAttribute('placeholder', expect.stringContaining('cirq.CNOT'))
  })

  it('Parse is disabled until there is text', () => {
    render(<CodeImport />)
    expect(screen.getByRole('button', { name: 'Parse' })).toBeDisabled()
    paste('   ')
    expect(screen.getByRole('button', { name: 'Parse' })).toBeDisabled()
    paste(QISKIT)
    expect(screen.getByRole('button', { name: 'Parse' })).toBeEnabled()
  })
})

describe('paste, parse, preview, insert', () => {
  it('sends the dialect and the exact text, then previews the circuit without touching the Lab', async () => {
    client.parseCode.mockResolvedValue(PARSED)
    render(<CodeImport />)
    paste(QISKIT)
    parse()
    const preview = await screen.findByTestId('import-preview')
    expect(client.parseCode).toHaveBeenCalledWith('qiskit', QISKIT)
    expect(preview).toHaveTextContent('Read as a 2-qubit circuit with 2 operations. Preview only: it is not in your Lab yet.')
    expect(within(preview).getByTestId('readonly-circuit')).toBeInTheDocument()
    expect(within(preview).getByTestId('import-notes')).toHaveTextContent('measure_all adds 2 classical bits.')
    expect(within(preview).getByText('Canonical OpenQASM 3 the server wrote for it')).toBeInTheDocument()
    expect(useBuildStore.getState().circuit.ops).toHaveLength(0) // nothing inserted yet
  })

  it('Insert into Lab puts a copy of the previewed circuit in the Lab, with no result', async () => {
    client.parseCode.mockResolvedValue(PARSED)
    render(<CodeImport />)
    paste(QISKIT)
    parse()
    fireEvent.click(await screen.findByRole('button', { name: 'Insert into Lab' }))
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['h', 'cx'])
    expect(useBuildStore.getState().circuit).not.toBe(PARSED.circuit)
    expect(useBuildStore.getState().result).toBeNull()
    expect(screen.getByTestId('import-inserted')).toHaveTextContent('Run it to see what the backend computes.')
  })

  it('replacing an existing circuit needs a confirmation, and “Keep my circuit” leaves it alone', async () => {
    useBuildStore.getState().loadCircuit({ ...emptyCircuit(2, 0), ops: [op('x', 1)] })
    client.parseCode.mockResolvedValue(PARSED)
    render(<CodeImport />)
    paste(QISKIT)
    parse()
    fireEvent.click(await screen.findByRole('button', { name: 'Insert into Lab' }))
    const confirm = screen.getByRole('group', { name: 'Confirm replacing the circuit' })
    expect(confirm).toHaveTextContent('This replaces the circuit in your Lab (1 operation).')
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['x'])
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep my circuit' }))
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['x'])
    fireEvent.click(screen.getByRole('button', { name: 'Insert into Lab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace and insert' }))
    expect(useBuildStore.getState().circuit.ops.map((o) => o.gate)).toEqual(['h', 'cx'])
  })

  it('editing the text withdraws the preview: nothing parsed from the old text stays on offer', async () => {
    client.parseCode.mockResolvedValue(PARSED)
    render(<CodeImport />)
    paste(QISKIT)
    parse()
    await screen.findByTestId('import-preview')
    paste(QISKIT + 'qc.x(1)\n')
    expect(screen.queryByTestId('import-preview')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Insert into Lab' })).toBeNull()
  })

  it('changing the language withdraws the preview too', async () => {
    client.parseCode.mockResolvedValue(PARSED)
    render(<CodeImport />)
    paste(QISKIT)
    parse()
    await screen.findByTestId('import-preview')
    fireEvent.click(screen.getByRole('radio', { name: 'Cirq' }))
    expect(screen.queryByTestId('import-preview')).toBeNull()
  })

  it.each(['openqasm', 'qiskit', 'cirq', 'pennylane'] as const)('%s: the chosen dialect is what is sent', async (dialect) => {
    client.parseCode.mockResolvedValue({ ...PARSED, dialect })
    render(<CodeImport />)
    const labelFor = { openqasm: 'OpenQASM', qiskit: 'Qiskit', cirq: 'Cirq', pennylane: 'PennyLane' }[dialect]
    fireEvent.click(screen.getByRole('radio', { name: labelFor }))
    paste('x')
    parse()
    await screen.findByTestId('import-preview')
    expect(client.parseCode).toHaveBeenCalledWith(dialect, 'x')
  })
})

describe('unsupported code', () => {
  const refusal = () =>
    new CodeNotSupportedError(
      'a for loop is not supported',
      [
        { line: 3, column: 0, message: 'a for loop is not supported: Qentor reads only QuantumCircuit(...) and the gate calls on it, and never runs Python' },
        { line: 5, column: 0, message: 'qc.draw is not a supported gate or method' },
      ],
      ['qc.h/x/y/z/s/sdg/t/tdg(q)', 'qc.cx/cz(control, target)'],
      PARSER_LABEL,
    )

  it('is shown as refused: each construct with its line, and that nothing was translated, run or inserted', async () => {
    client.parseCode.mockRejectedValue(refusal())
    render(<CodeImport />)
    paste('for i in range(2):\n    qc.h(i)\n')
    parse()
    const alert = await screen.findByTestId('import-refused')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent('This code was not read.')
    expect(alert).toHaveTextContent('line 3: a for loop is not supported')
    expect(alert).toHaveTextContent('line 5: qc.draw is not a supported gate or method')
    expect(alert).toHaveTextContent('Nothing was translated, run or inserted.')
    expect(alert).toHaveTextContent(PARSER_LABEL)
    expect(within(alert).getByText('qc.cx/cz(control, target)')).toBeInTheDocument() // “What can be read”
    expect(screen.queryByRole('button', { name: 'Insert into Lab' })).toBeNull()
    expect(screen.queryByTestId('import-preview')).toBeNull()
    expect(useBuildStore.getState().circuit.ops).toHaveLength(0)
  })

  it('a refusal after a good parse replaces the preview, so a stale circuit cannot be inserted', async () => {
    client.parseCode.mockResolvedValueOnce(PARSED)
    render(<CodeImport />)
    paste(QISKIT)
    parse()
    await screen.findByTestId('import-preview')
    client.parseCode.mockRejectedValueOnce(refusal())
    paste('while True: pass')
    parse()
    await screen.findByTestId('import-refused')
    expect(screen.queryByRole('button', { name: 'Insert into Lab' })).toBeNull()
  })

  it('a rate limit or an unreachable server is “could not be checked”, not “unsupported”', async () => {
    client.parseCode.mockRejectedValueOnce(new ClassroomRejectedError('RATE_LIMITED', 'Too many requests.', 429))
    render(<CodeImport />)
    paste(QISKIT)
    parse()
    const failed = await screen.findByTestId('import-failed')
    expect(failed).toHaveTextContent('The code could not be checked: Too many requests. Nothing was inserted.')
    expect(screen.queryByTestId('import-refused')).toBeNull()
    client.parseCode.mockRejectedValueOnce(new BackendUnavailableError('could not reach the Qentor backend'))
    parse()
    await waitFor(() => expect(screen.getByTestId('import-failed')).toHaveTextContent('could not reach the Qentor backend'))
  })
})

describe('Python is not executed in the browser either', () => {
  it('hostile text is only ever sent to the server as text: no eval, Function or import is touched', async () => {
    const hostile = "__import__('os').system('echo hi')\nexec(\"print(1)\")\nopen('/etc/passwd')\n"
    const evalSpy = vi.spyOn(globalThis, 'eval')
    const fnSpy = vi.spyOn(globalThis as unknown as { Function: FunctionConstructor }, 'Function')
    client.parseCode.mockRejectedValue(new CodeNotSupportedError('x', [{ line: 1, column: 0, message: 'only calls on the circuit' }], [], PARSER_LABEL))
    try {
      render(<CodeImport />)
      paste(hostile)
      parse()
      await screen.findByTestId('import-refused')
      expect(client.parseCode).toHaveBeenCalledWith('qiskit', hostile)
      expect(evalSpy).not.toHaveBeenCalled()
      expect(fnSpy).not.toHaveBeenCalled()
    } finally {
      evalSpy.mockRestore()
      fnSpy.mockRestore()
    }
  })

  it('the pasted text is shown only inside a textarea, never as markup', async () => {
    client.parseCode.mockRejectedValue(new CodeNotSupportedError('x', [{ line: 1, column: 0, message: '<img src=x onerror=alert(1)>' }], [], PARSER_LABEL))
    render(<CodeImport />)
    paste('<img src=x onerror=alert(1)>')
    parse()
    const alert = await screen.findByTestId('import-refused')
    expect(alert.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img')).toBeNull()
  })
})
