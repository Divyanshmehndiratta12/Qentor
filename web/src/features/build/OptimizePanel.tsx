/**
 * The "Optimize" action for the Build screen (docs/VERIFICATION_ARCHITECTURE.md
 * §4.4). Sends only the canonical circuit — never a probability, amplitude,
 * count, or a client-decided equivalence verdict; see
 * `useBuildStore.runOptimization` and `RealApiClient.optimizeCircuit`. Every
 * field below is rendered exactly as POST /api/optimize returned it: nothing
 * here recomputes an operation count, re-checks equivalence, or upgrades a
 * status. The optimized circuit is applied to the workspace only on an
 * explicit "Apply" click — never automatically, and only once the server has
 * reported VERIFIED_SHORTER (see AI_BOUNDARY.md: a candidate circuit is never
 * auto-applied).
 *
 * Unlike Verify/Tutor, this never gates on an execution `result` existing —
 * optimization operates on the circuit itself, not a result id.
 */
import type { OptimizationEquivalenceCheckResult, OptimizationResult } from '@/api'
import { OptimizationStatusBadge } from '@/provenance/OptimizationStatusBadge'
import { useBuildStore } from './store'

export function OptimizePanel() {
  const circuit = useBuildStore((s) => s.circuit)
  const isOptimizing = useBuildStore((s) => s.isOptimizing)
  const optimization = useBuildStore((s) => s.optimization)
  const optimizationError = useBuildStore((s) => s.optimizationError)
  const runOptimization = useBuildStore((s) => s.runOptimization)
  const applyOptimizedCircuit = useBuildStore((s) => s.applyOptimizedCircuit)

  if (circuit.ops.length === 0) return null

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Optimize</span>
        <button
          type="button"
          onClick={() => void runOptimization()}
          disabled={isOptimizing}
          className="rounded-md border border-violet-glow/40 bg-violet-dim/20 px-2.5 py-1 text-xs font-medium text-violet-glow hover:bg-violet-dim/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isOptimizing ? 'Optimizing…' : 'Optimize'}
        </button>
      </div>

      {isOptimizing && (
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-glow" aria-hidden="true" />
          Searching for a verified-equivalent rewrite…
        </p>
      )}

      {!isOptimizing && optimizationError && (
        <div className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
          <p className="font-semibold text-danger-glow">Optimization unavailable</p>
          <p className="mt-1 font-mono-qasm text-xs text-danger-glow/80">{optimizationError}</p>
          <p className="mt-2.5 text-xs text-slate-400">No candidate is shown. The circuit is unchanged.</p>
        </div>
      )}

      {!isOptimizing && !optimizationError && optimization && (
        <OptimizationReport report={optimization} onApply={applyOptimizedCircuit} />
      )}
    </div>
  )
}

function OptimizationReport({ report, onApply }: { report: OptimizationResult; onApply: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-void-500 bg-void-950/60 p-3.5">
      <div className="flex items-center justify-between">
        <OptimizationStatusBadge status={report.status} />
        <span className="font-mono-qasm text-[11px] text-void-200">
          {report.verifierName}/{report.verifierVersion}
        </span>
      </div>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 font-mono-qasm text-[11px] text-void-200">
        <dt>operations</dt>
        <dd className="text-slate-300">
          {report.originalOpCount} → {report.candidateOpCount}
        </dd>
        <dt>summary</dt>
        <dd className="text-slate-300">{report.reductionSummary}</dd>
      </dl>

      {report.reason && <p className="text-xs text-void-200">{report.reason}</p>}

      {report.rulesApplied.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-void-200">rules applied</span>
          <ul className="flex flex-col gap-1">
            {report.rulesApplied.map((rule, i) => (
              <li key={i} className="text-xs text-slate-300">
                • {rule}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.equivalence && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-void-200">
            equivalence — {report.equivalence.method}
            {report.equivalence.globalPhase !== null &&
              ` (global phase ${report.equivalence.globalPhase.toFixed(6)})`}
          </span>
          <ul className="flex flex-col gap-1">
            {report.equivalence.checks.map((check) => (
              <CheckRow key={check.name} check={check} />
            ))}
          </ul>
        </div>
      )}

      {report.status === 'VERIFIED_SHORTER' && (
        <button
          type="button"
          onClick={onApply}
          className="self-start rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40"
        >
          Apply optimized circuit
        </button>
      )}
    </div>
  )
}

function CheckRow({ check }: { check: OptimizationEquivalenceCheckResult }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
          check.status === 'PASS' ? 'bg-cyan-glow' : 'bg-danger-glow'
        }`}
        aria-hidden="true"
      />
      <span className="text-slate-300">
        <span className="font-mono-qasm text-slate-200">{check.name}</span>
        {' — '}
        {check.detail}
      </span>
    </li>
  )
}
