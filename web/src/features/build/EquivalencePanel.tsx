/**
 * "Is this still the same circuit?" — pin a circuit as the reference, keep editing, and ask the server's equivalence checker
 * (`POST /api/verify/equivalence`, the same one the optimizer uses). The verdict, the checks and the global phase all come
 * from the server; nothing is decided here. "Equivalent" means the same operator up to a global phase — the same behaviour
 * on every input — and says nothing about whether either circuit is the right one.
 */
import type { EquivalenceResult } from '@/api'
import { useBuildStore } from './store'

const STATUS: Record<EquivalenceResult['status'], { label: string; tone: string }> = {
  EQUIVALENT: { label: 'Equivalent', tone: 'border-cyan-glow/40 bg-cyan-dim/40 text-cyan-glow' },
  NOT_EQUIVALENT: { label: 'Not equivalent', tone: 'border-danger-glow/40 bg-danger-dim/40 text-danger-glow' },
  UNVERIFIABLE: { label: 'Unverifiable', tone: 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow' },
}

export function EquivalencePanel() {
  const circuit = useBuildStore((s) => s.circuit)
  const reference = useBuildStore((s) => s.referenceCircuit)
  const equivalence = useBuildStore((s) => s.equivalence)
  const error = useBuildStore((s) => s.equivalenceError)
  const isChecking = useBuildStore((s) => s.isCheckingEquivalence)
  const pinReference = useBuildStore((s) => s.pinReference)
  const clearReference = useBuildStore((s) => s.clearReference)
  const runEquivalence = useBuildStore((s) => s.runEquivalence)

  // A verdict answers one pair; once either circuit is another it is stale and is not shown as current.
  const current = equivalence && equivalence.a === reference && equivalence.b === circuit ? equivalence.result : null
  const stale = equivalence !== null && current === null

  return (
    <section aria-label="Equivalence check" className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Compare with a reference</span>
        <button
          type="button"
          onClick={pinReference}
          disabled={circuit.ops.length === 0}
          className="rounded-md border border-void-400 px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-void-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reference ? 'Pin this circuit instead' : 'Pin this circuit'}
        </button>
      </div>

      {!reference && (
        <p className="text-xs text-void-200">
          Pin the circuit you have now, change it, then check whether the two are still the same operator.
        </p>
      )}

      {reference && (
        <div className="flex flex-col gap-2 rounded-lg border border-void-500 bg-void-950/60 p-3">
          <p className="text-xs text-slate-300">
            Reference: {reference.num_qubits} qubit{reference.num_qubits === 1 ? '' : 's'}, {reference.ops.length} operation
            {reference.ops.length === 1 ? '' : 's'} · current: {circuit.ops.length} operation{circuit.ops.length === 1 ? '' : 's'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runEquivalence()}
              disabled={isChecking}
              className="rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isChecking ? 'Checking…' : 'Check equivalence'}
            </button>
            <button type="button" onClick={clearReference} className="text-xs text-void-200 underline hover:text-slate-200">
              Clear reference
            </button>
          </div>
          {stale && !isChecking && !error && (
            <p className="text-xs text-void-200">A circuit changed since the last check. Check again.</p>
          )}
        </div>
      )}

      {!isChecking && error && (
        <div role="alert" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
          <p className="font-semibold text-danger-glow">Equivalence check unavailable</p>
          <p className="mt-1 font-mono-qasm text-xs text-danger-glow/80">{error}</p>
          <p className="mt-2.5 text-xs text-slate-400">No verdict is shown.</p>
        </div>
      )}

      {!isChecking && !error && current && <EquivalenceReport report={current} />}
    </section>
  )
}

function EquivalenceReport({ report }: { report: EquivalenceResult }) {
  const status = STATUS[report.status]
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-void-500 bg-void-950/60 p-3.5" data-testid="equivalence-report">
      <div className="flex items-center justify-between">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.tone}`}
        >
          {status.label}
        </span>
        <span className="font-mono-qasm text-[11px] text-void-200">
          {report.method} · qiskit {report.checkerVersion}
        </span>
      </div>
      {report.reason && <p className="text-xs text-void-200">{report.reason}</p>}
      {report.globalPhase !== null && (
        <p className="font-mono-qasm text-[11px] text-void-200">global phase (rad, from the checker): {report.globalPhase.toFixed(6)}</p>
      )}
      <ul className="flex flex-col gap-1" aria-label="Checks">
        {report.checks.map((check) => (
          <li key={check.name} className="flex items-start gap-2 text-xs">
            <span
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${check.status === 'PASS' ? 'bg-cyan-glow' : 'bg-danger-glow'}`}
              aria-hidden="true"
            />
            <span className="text-slate-300">
              <span className="font-mono-qasm text-slate-200">{check.name}</span>
              {' — '}
              {check.detail}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-snug text-void-200">
        Equivalent means the same operator up to a global phase: the same behaviour on every input. It does not say either
        circuit is the one you want.
      </p>
    </div>
  )
}
