/**
 * Import a circuit from code: paste OpenQASM 3, Qiskit, Cirq or PennyLane text -> Parse -> Preview -> Insert into Lab.
 *
 * The server does the reading (`POST /api/circuit/parse-code`) and it NEVER executes anything: Python is parsed into a syntax tree and
 * checked against a short allow-list, and anything outside it is refused with the construct and its line named. This component only
 * sends the text and shows the answer: the preview is the circuit the server read (nothing is run to show it, and it carries no
 * result), and nothing reaches the Lab until the learner chooses to insert it.
 */
import { useState } from 'react'
import { BackendUnavailableError, ClassroomRejectedError, CodeNotSupportedError, getApiClient, type ParsedCode, type SdkDialect } from '@/api'
import { ReadOnlyCircuit } from '@/features/share/ReadOnlyCircuit'
import { useBuildStore } from './store'

export const PARSER_LABEL = 'Safe subset parser — Python is not executed.'

const DIALECTS: ReadonlyArray<{ id: SdkDialect; label: string; placeholder: string }> = [
  { id: 'openqasm', label: 'OpenQASM', placeholder: 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];' },
  { id: 'qiskit', label: 'Qiskit', placeholder: 'from qiskit import QuantumCircuit\n\nqc = QuantumCircuit(2)\nqc.h(0)\nqc.cx(0, 1)\nqc.measure_all()' },
  {
    id: 'cirq',
    label: 'Cirq',
    placeholder: 'import cirq\n\nq = cirq.LineQubit.range(2)\ncircuit = cirq.Circuit(\n    cirq.H(q[0]),\n    cirq.CNOT(q[0], q[1]),\n)',
  },
  {
    id: 'pennylane',
    label: 'PennyLane',
    placeholder:
      'import pennylane as qml\n\ndev = qml.device("default.qubit", wires=2)\n\n@qml.qnode(dev)\ndef circuit():\n    qml.Hadamard(wires=0)\n    qml.CNOT(wires=[0, 1])\n    return qml.state()',
  },
]

type Outcome =
  | { kind: 'idle' }
  | { kind: 'parsing' }
  | { kind: 'parsed'; parsed: ParsedCode; text: string; dialect: SdkDialect }
  | { kind: 'refused'; error: CodeNotSupportedError }
  | { kind: 'failed'; message: string }

const BTN =
  'min-h-9 rounded-md border border-void-400 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-void-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-50'

export function CodeImport() {
  const [dialect, setDialect] = useState<SdkDialect>('qiskit')
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })
  const [confirming, setConfirming] = useState(false)
  const [inserted, setInserted] = useState(false)
  const currentOps = useBuildStore((s) => s.circuit.ops.length)
  const loadCircuit = useBuildStore((s) => s.loadCircuit)
  const active = DIALECTS.find((d) => d.id === dialect) ?? DIALECTS[1]

  function edit(next: string) {
    setText(next)
    // the preview belongs to the text that was parsed: once it changes, nothing from the old parse stays on offer
    if (outcome.kind !== 'idle' && outcome.kind !== 'parsing') setOutcome({ kind: 'idle' })
    setConfirming(false)
    setInserted(false)
  }

  async function parse() {
    setOutcome({ kind: 'parsing' })
    setConfirming(false)
    setInserted(false)
    const sent = text
    const language = dialect
    try {
      const parsed = await getApiClient().parseCode(language, sent)
      setOutcome({ kind: 'parsed', parsed, text: sent, dialect: language })
    } catch (err) {
      if (err instanceof CodeNotSupportedError) setOutcome({ kind: 'refused', error: err })
      else
        setOutcome({
          kind: 'failed',
          message:
            err instanceof ClassroomRejectedError || err instanceof BackendUnavailableError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err),
        })
    }
  }

  function insert(parsed: ParsedCode) {
    loadCircuit(structuredClone(parsed.circuit))
    setConfirming(false)
    setInserted(true)
  }

  return (
    <details className="shrink-0 border-t border-void-500 bg-void-900" data-testid="code-import">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-300 hover:text-slate-100">Import from code</summary>
      <div className="max-h-[22rem] overflow-auto px-3 pb-3">
        <p className="text-[11px] text-slate-400" data-testid="parser-label">
          {PARSER_LABEL} Only a small documented subset is read; anything else is refused, never guessed.
        </p>

        <fieldset className="mt-2 flex flex-wrap gap-1 border-0 border-b border-void-500 p-0">
          <legend className="sr-only">Language to import</legend>
          {DIALECTS.map((d) => (
            <label key={d.id} className="relative">
              <input
                type="radio"
                name="import-dialect"
                value={d.id}
                checked={dialect === d.id}
                onChange={() => {
                  setDialect(d.id)
                  setOutcome({ kind: 'idle' })
                  setInserted(false)
                }}
                className="peer sr-only"
              />
              <span
                className={`flex min-h-9 cursor-pointer items-center rounded-t-md border-b-2 px-3 py-1 text-xs font-semibold tracking-wide peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-cyan-glow ${
                  dialect === d.id ? 'border-cyan-glow text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {d.label}
              </span>
            </label>
          ))}
        </fieldset>

        <div id="import-panel" className="mt-2 flex flex-col gap-2">
          <label htmlFor="import-code" className="text-[11px] text-slate-400">
            Paste {active.label} code
          </label>
          <textarea
            id="import-code"
            value={text}
            onChange={(e) => edit(e.target.value)}
            placeholder={active.placeholder}
            spellCheck={false}
            rows={6}
            maxLength={40_000}
            className="w-full rounded-md border border-void-400 bg-void-950 p-2 font-mono-qasm text-xs text-slate-100 placeholder:text-void-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN} disabled={text.trim() === '' || outcome.kind === 'parsing'} onClick={() => void parse()}>
              {outcome.kind === 'parsing' ? 'Parsing…' : 'Parse'}
            </button>
            {dialect !== 'openqasm' && <span className="text-[11px] text-slate-400">Nothing is run: the text is read, not executed.</span>}
          </div>

          {outcome.kind === 'refused' && (
            <div role="alert" data-testid="import-refused" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3 text-xs text-danger-glow">
              <p className="font-semibold">This code was not read.</p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {outcome.error.problems.map((p, i) => (
                  <li key={i}>
                    {p.line !== null ? <span className="font-mono-qasm">line {p.line}: </span> : null}
                    {p.message}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-slate-300">Nothing was translated, run or inserted. {outcome.error.label}</p>
              <details className="mt-1.5 text-slate-300">
                <summary className="cursor-pointer">What can be read</summary>
                <ul className="mt-1 list-disc pl-5 font-mono-qasm text-[11px]">
                  {outcome.error.supported.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </details>
            </div>
          )}

          {outcome.kind === 'failed' && (
            <p role="alert" data-testid="import-failed" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3 text-xs text-danger-glow">
              The code could not be checked: {outcome.message} Nothing was inserted.
            </p>
          )}

          {outcome.kind === 'parsed' && (
            <div className="flex flex-col gap-2" data-testid="import-preview">
              <p role="status" className="text-xs font-semibold text-cyan-glow">
                Read as a {outcome.parsed.circuit.num_qubits}-qubit circuit with {outcome.parsed.circuit.ops.length} operation
                {outcome.parsed.circuit.ops.length === 1 ? '' : 's'}. Preview only: it is not in your Lab yet.
              </p>
              <ReadOnlyCircuit circuit={outcome.parsed.circuit} />
              {outcome.parsed.notes.length > 0 && (
                <ul className="list-disc pl-5 text-[11px] text-slate-300" data-testid="import-notes">
                  {outcome.parsed.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <details className="text-[11px] text-slate-300">
                <summary className="cursor-pointer">Canonical OpenQASM 3 the server wrote for it</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded border border-void-500 bg-void-950 p-2 font-mono-qasm text-[11px] whitespace-pre">{outcome.parsed.canonicalQasm}</pre>
              </details>
              {confirming ? (
                <div role="group" aria-label="Confirm replacing the circuit" className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                  <span>This replaces the circuit in your Lab ({currentOps} operation{currentOps === 1 ? '' : 's'}).</span>
                  <button type="button" className={`${BTN} border-cyan-glow/60 text-cyan-glow`} onClick={() => insert(outcome.parsed)}>
                    Replace and insert
                  </button>
                  <button type="button" className={BTN} onClick={() => setConfirming(false)}>
                    Keep my circuit
                  </button>
                </div>
              ) : (
                <div>
                  <button type="button" className={BTN} onClick={() => (currentOps > 0 ? setConfirming(true) : insert(outcome.parsed))}>
                    Insert into Lab
                  </button>
                </div>
              )}
            </div>
          )}

          {inserted && (
            <p role="status" data-testid="import-inserted" className="text-xs text-cyan-glow">
              Inserted into the Lab. Run it to see what the backend computes.
            </p>
          )}
        </div>
      </div>
    </details>
  )
}
