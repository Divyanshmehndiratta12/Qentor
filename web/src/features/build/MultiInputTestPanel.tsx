/**
 * The "Test" action for the Build screen (docs/VERIFICATION_ARCHITECTURE.md
 * §4.2, "basis-sweep"). Sends only the canonical circuit, the declared
 * input/output qubit subsets, an explicit list of caller-authored
 * (inputBits, expectedOutput) cases, and an optional backend choice — never
 * an observed distribution, a pass/fail verdict, or a counterexample computed
 * client-side; see `useBuildStore.runMultiInputTest` and
 * `RealApiClient.runMultiInputTest`. Every number, status and counterexample
 * below is rendered exactly as POST /api/test/multi-input returned it:
 * nothing here re-derives a distribution or upgrades/downgrades a status.
 *
 * This is a generic multi-input testing feature — no Deutsch-Jozsa or other
 * algorithm-specific logic lives here. The qubit pickers and case editor are
 * local, ephemeral UI state (not global store state): only the *result* of a
 * run is shared/persisted state, exactly like Verify/Optimize.
 *
 * Like OptimizePanel, this never gates on an execution `result` existing —
 * the harness runs the circuit itself in statevector mode, it doesn't need a
 * prior execution's result id.
 */
import { useEffect, useState } from 'react'
import type {
  Backend,
  MultiInputCaseResult,
  MultiInputCounterexampleResult,
  MultiInputTestCase,
  MultiInputTestResult,
} from '@/api'
import { MultiInputTestStatusBadge } from '@/provenance/MultiInputTestStatusBadge'
import { useBuildStore } from './store'

const BACKENDS: Backend[] = ['qiskit-aer', 'cirq', 'pennylane']

function emptyCase(): MultiInputTestCase {
  return { inputBits: '', expectedOutput: '' }
}

export function MultiInputTestPanel() {
  const circuit = useBuildStore((s) => s.circuit)
  const isTesting = useBuildStore((s) => s.isMultiInputTesting)
  const testResult = useBuildStore((s) => s.multiInputTest)
  const testError = useBuildStore((s) => s.multiInputTestError)
  const runMultiInputTest = useBuildStore((s) => s.runMultiInputTest)

  const [inputQubits, setInputQubits] = useState<number[]>([])
  const [outputQubits, setOutputQubits] = useState<number[]>([])
  const [cases, setCases] = useState<MultiInputTestCase[]>([emptyCase()])
  const [backend, setBackend] = useState<Backend>('qiskit-aer')

  // Drop any qubit selection that's no longer valid if the circuit shrinks —
  // this is a local-config safety net, not a server-side validation bypass;
  // the backend still validates and rejects an out-of-range request itself.
  useEffect(() => {
    setInputQubits((qs) => qs.filter((q) => q < circuit.num_qubits))
    setOutputQubits((qs) => qs.filter((q) => q < circuit.num_qubits))
  }, [circuit.num_qubits])

  if (circuit.ops.length === 0) return null

  const qubitIndices = Array.from({ length: circuit.num_qubits }, (_, i) => i)

  function toggleQubit(list: number[], setList: (qs: number[]) => void, qubit: number) {
    setList(list.includes(qubit) ? list.filter((q) => q !== qubit) : [...list, qubit].sort((a, b) => a - b))
  }

  function updateCase(index: number, patch: Partial<MultiInputTestCase>) {
    setCases((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  function removeCase(index: number) {
    setCases((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))
  }

  const canRun =
    !isTesting &&
    inputQubits.length > 0 &&
    outputQubits.length > 0 &&
    cases.every((c) => c.inputBits.length === inputQubits.length && c.expectedOutput.length === outputQubits.length)

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Test</span>
        <button
          type="button"
          onClick={() => void runMultiInputTest(inputQubits, outputQubits, cases, backend)}
          disabled={!canRun}
          className="rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isTesting ? 'Testing…' : 'Run test'}
        </button>
      </div>

      <QubitPicker label="input qubits" qubits={qubitIndices} selected={inputQubits} onToggle={(q) => toggleQubit(inputQubits, setInputQubits, q)} />
      <QubitPicker
        label="output qubits"
        qubits={qubitIndices}
        selected={outputQubits}
        onToggle={(q) => toggleQubit(outputQubits, setOutputQubits, q)}
      />

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-void-200">
            cases (input → expected output, {inputQubits.length || '?'} → {outputQubits.length || '?'} bits)
          </span>
          <button
            type="button"
            onClick={() => setCases((prev) => [...prev, emptyCase()])}
            className="text-[11px] font-medium text-cyan-glow hover:text-cyan-glow/80"
          >
            + add case
          </button>
        </div>
        {cases.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={c.inputBits}
              onChange={(e) => updateCase(i, { inputBits: e.target.value.replace(/[^01]/g, '') })}
              maxLength={inputQubits.length || undefined}
              placeholder={inputQubits.length ? '0'.repeat(inputQubits.length) : 'input bits'}
              className="w-24 rounded border border-void-400 bg-void-800 px-2 py-1 font-mono-qasm text-xs text-slate-200 placeholder:text-void-300 focus:border-cyan-glow focus:outline-none"
            />
            <span className="text-void-200">→</span>
            <input
              value={c.expectedOutput}
              onChange={(e) => updateCase(i, { expectedOutput: e.target.value.replace(/[^01]/g, '') })}
              maxLength={outputQubits.length || undefined}
              placeholder={outputQubits.length ? '0'.repeat(outputQubits.length) : 'expected output'}
              className="w-24 rounded border border-void-400 bg-void-800 px-2 py-1 font-mono-qasm text-xs text-slate-200 placeholder:text-void-300 focus:border-cyan-glow focus:outline-none"
            />
            <button
              type="button"
              onClick={() => removeCase(i)}
              disabled={cases.length === 1}
              className="text-xs text-void-200 hover:text-danger-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              remove
            </button>
          </div>
        ))}
      </div>

      <label className="flex items-center gap-1.5 text-xs text-void-200">
        backend
        <select
          value={backend}
          onChange={(e) => setBackend(e.target.value as Backend)}
          className="rounded border border-void-400 bg-void-800 px-2 py-1 font-mono-qasm text-xs text-slate-200 focus:border-cyan-glow focus:outline-none"
        >
          {BACKENDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>

      {isTesting && (
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-glow" aria-hidden="true" />
          Running every case, statevector-exact…
        </p>
      )}

      {!isTesting && testError && (
        <div className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
          <p className="font-semibold text-danger-glow">Test unavailable</p>
          <p className="mt-1 font-mono-qasm text-xs text-danger-glow/80">{testError}</p>
          <p className="mt-2.5 text-xs text-slate-400">No results are shown. Nothing here was tested.</p>
        </div>
      )}

      {!isTesting && !testError && testResult && <TestReport report={testResult} />}
    </div>
  )
}

function QubitPicker({
  label,
  qubits,
  selected,
  onToggle,
}: {
  label: string
  qubits: number[]
  selected: number[]
  onToggle: (qubit: number) => void
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 text-void-200">{label}</span>
      <div className="flex flex-wrap gap-1">
        {qubits.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onToggle(q)}
            aria-pressed={selected.includes(q)}
            className={`rounded border px-2 py-0.5 font-mono-qasm ${
              selected.includes(q)
                ? 'border-cyan-glow/60 bg-cyan-dim/40 text-cyan-glow'
                : 'border-void-400 bg-void-800 text-void-200 hover:text-slate-200'
            }`}
          >
            q{q}
          </button>
        ))}
      </div>
    </div>
  )
}

function TestReport({ report }: { report: MultiInputTestResult }) {
  const counterexampleByInput = new Map(report.counterexamples.map((c) => [c.inputBits, c]))

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-void-500 bg-void-950/60 p-3.5">
      <div className="flex items-center justify-between">
        <MultiInputTestStatusBadge status={report.overallStatus} />
        <span className="font-mono-qasm text-[11px] text-void-200">
          {report.backend}
          {report.backendVersion ? ` ${report.backendVersion}` : ''}
        </span>
      </div>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 font-mono-qasm text-[11px] text-void-200">
        <dt>test</dt>
        <dd className="truncate text-slate-300" title={report.testId}>
          {report.testId}
        </dd>
        <dt>circuit</dt>
        <dd className="truncate text-slate-300" title={report.circuitHash}>
          {report.circuitHash}
        </dd>
        <dt>qubits</dt>
        <dd className="text-slate-300">
          in [{report.inputQubits.join(', ')}] → out [{report.outputQubits.join(', ')}]
        </dd>
      </dl>

      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-void-200">
            <th className="pb-1.5 font-medium">input</th>
            <th className="pb-1.5 font-medium">expected</th>
            <th className="pb-1.5 font-medium">status</th>
            <th className="pb-1.5 font-medium">observed distribution</th>
            <th className="pb-1.5 font-medium">result</th>
            <th className="pb-1.5 font-medium">circuit</th>
          </tr>
        </thead>
        <tbody>
          {report.cases.map((c, i) => (
            <CaseRow key={i} caseResult={c} counterexample={counterexampleByInput.get(c.inputBits)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

const CASE_STATUS_STYLE: Record<MultiInputCaseResult['status'], string> = {
  PASS: 'bg-cyan-glow',
  FAIL: 'bg-danger-glow',
  EXECUTION_ERROR: 'bg-amber-glow',
}

function CaseRow({
  caseResult,
  counterexample,
}: {
  caseResult: MultiInputCaseResult
  counterexample: MultiInputCounterexampleResult | undefined
}) {
  return (
    <>
      <tr className="border-t border-void-600 align-top">
        <td className="py-1.5 font-mono-qasm text-slate-300">{caseResult.inputBits}</td>
        <td className="py-1.5 font-mono-qasm text-slate-300">{caseResult.expectedOutput}</td>
        <td className="py-1.5">
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${CASE_STATUS_STYLE[caseResult.status]}`} aria-hidden="true" />
            {caseResult.status}
          </span>
        </td>
        <td className="py-1.5 font-mono-qasm text-slate-300">
          {caseResult.observedDistribution
            ? Object.entries(caseResult.observedDistribution)
                .map(([bits, p]) => `${bits}: ${p.toFixed(6)}`)
                .join(', ')
            : caseResult.error
              ? caseResult.error
              : '—'}
        </td>
        <td className="py-1.5 font-mono-qasm text-slate-300 truncate" title={caseResult.resultId ?? undefined}>
          {caseResult.resultId ?? '—'}
        </td>
        <td className="py-1.5 font-mono-qasm text-slate-300 truncate" title={caseResult.circuitHash}>
          {caseResult.circuitHash}
        </td>
      </tr>
      {caseResult.status === 'FAIL' && counterexample && (
        <tr>
          <td colSpan={6} className="pb-1.5">
            <div className="rounded border border-danger-glow/40 bg-danger-dim/20 p-2 text-[11px] text-danger-glow">
              <span className="font-semibold">counterexample</span> — input {counterexample.inputBits}: expected{' '}
              {counterexample.expectedOutput}, backend observed{' '}
              {Object.entries(counterexample.observedDistribution)
                .map(([bits, p]) => `${bits}: ${p.toFixed(6)}`)
                .join(', ')}{' '}
              (result {counterexample.resultId ?? '—'})
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
