/**
 * "Optimize circuit" as a way of learning what makes a circuit shorter, not only a button that makes it shorter
 * (docs/VERIFICATION_ARCHITECTURE.md §4.4). Sends only the canonical circuit: never a probability, amplitude, count or a
 * client-decided equivalence verdict (see `useBuildStore.runOptimization` and `RealApiClient.optimizeCircuit`).
 *
 * Everything shown is what POST /api/optimize returned, and nothing here recomputes it: the operation counts, which operations were
 * kept, removed or added (the server's own diff), the sentence behind each rewrite rule, the backend's equivalence verdict and the
 * provenance of the supporting run. The proposed circuit is applied only on an explicit click, only once the server has reported
 * VERIFIED_SHORTER, and as one undo step, so the original is always one Ctrl+Z away (AI_BOUNDARY.md: a candidate is never auto-applied).
 *
 * Unlike Verify/Tutor, this never gates on an execution `result` existing: optimization operates on the circuit itself.
 */
import type { OptimizationChange, OptimizationEquivalenceCheckResult, OptimizationResult } from '@/api'
import { OptimizationStatusBadge } from '@/provenance/OptimizationStatusBadge'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { useBuildStore } from './store'

const CHANGE_LABEL: Record<OptimizationChange['kind'], string> = { kept: 'Kept', removed: 'Removed', added: 'Added' }
const CHANGE_MARK: Record<OptimizationChange['kind'], string> = { kept: '=', removed: '−', added: '+' }
const CHANGE_STYLE: Record<OptimizationChange['kind'], string> = {
  kept: 'text-slate-300',
  removed: 'text-danger-glow',
  added: 'text-cyan-glow',
}

export function OptimizePanel() {
  const circuit = useBuildStore((s) => s.circuit)
  const isOptimizing = useBuildStore((s) => s.isOptimizing)
  const optimization = useBuildStore((s) => s.optimization)
  const optimizationError = useBuildStore((s) => s.optimizationError)
  const runOptimization = useBuildStore((s) => s.runOptimization)
  const applyOptimizedCircuit = useBuildStore((s) => s.applyOptimizedCircuit)

  if (circuit.ops.length === 0) return null

  return (
    <section aria-labelledby="optimize-heading" className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4" data-testid="optimize-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 id="optimize-heading" className="text-[13px] font-semibold text-slate-100">
          Optimize circuit
        </h3>
        <button
          type="button"
          onClick={() => void runOptimization()}
          disabled={isOptimizing}
          className="rounded-md border border-violet-glow/40 bg-violet-dim/20 px-2.5 py-1 text-xs font-medium text-violet-glow hover:bg-violet-dim/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isOptimizing ? 'Optimizing…' : optimization || optimizationError ? 'Optimize again' : 'Optimize'}
        </button>
      </div>

      {!optimization && !optimizationError && !isOptimizing && (
        <p className="text-xs text-slate-400">
          Looks for gates that cancel or merge. A shorter circuit is shown as a proposal only after the backend&apos;s equivalence check says it does
          the same thing as yours.
        </p>
      )}

      {isOptimizing && (
        <p role="status" className="flex items-center gap-2 text-sm text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-glow motion-reduce:animate-none" aria-hidden="true" />
          Searching for a verified-equivalent rewrite…
        </p>
      )}

      {!isOptimizing && optimizationError && (
        <div role="alert" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
          <p className="font-semibold text-danger-glow">Optimization unavailable</p>
          <p className="mt-1 font-mono-qasm text-xs text-danger-glow/80">{optimizationError}</p>
          <p className="mt-2.5 text-xs text-slate-400">No candidate is shown. The circuit is unchanged.</p>
        </div>
      )}

      {!isOptimizing && !optimizationError && optimization && <OptimizationReport report={optimization} onApply={applyOptimizedCircuit} />}
    </section>
  )
}

function OptimizationReport({ report, onApply }: { report: OptimizationResult; onApply: () => void }) {
  const verified = report.status === 'VERIFIED_SHORTER'
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-void-500 bg-void-950/60 p-3.5" data-testid="optimization-report">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <OptimizationStatusBadge status={report.status} />
        <span className="font-mono-qasm text-[11px] text-void-200">
          {report.verifierName}/{report.verifierVersion}
        </span>
      </div>

      <p className="text-sm text-slate-200" data-testid="optimization-headline">
        {verified
          ? `The backend verified a shorter circuit that does the same thing: ${report.originalOpCount} operations became ${report.candidateOpCount}.`
          : report.status === 'NO_OPTIMIZATION_FOUND'
            ? 'No rewrite rule matched this circuit, so there is nothing to propose. It is unchanged.'
            : report.status === 'UNVERIFIABLE'
              ? 'The backend could not check a rewrite of this circuit, so none is proposed.'
              : 'A rewrite was found but the backend did not verify it as equivalent, so it was discarded.'}
      </p>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 font-mono-qasm text-[11px] text-void-200" data-testid="optimization-counts">
        <dt>original</dt>
        <dd className="text-slate-300">{report.originalOpCount} operations</dd>
        <dt>{verified ? 'proposed' : 'candidate'}</dt>
        <dd className="text-slate-300">{verified ? `${report.candidateOpCount} operations` : 'none shown'}</dd>
        {verified && (
          <>
            <dt>removed</dt>
            <dd className="text-slate-300">{report.operationsRemoved} fewer</dd>
          </>
        )}
      </dl>

      {report.reason && <p className="text-xs text-void-200">{report.reason}</p>}

      {report.changes.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-[11px] font-medium text-void-200">What changed, in circuit order</h4>
          <ol className="flex flex-col gap-0.5 font-mono-qasm text-xs" data-testid="optimization-changes">
            {report.changes.map((change, i) => (
              <li key={i} className={`flex gap-2 ${CHANGE_STYLE[change.kind]}`} data-change={change.kind}>
                <span aria-hidden="true" className="w-3 shrink-0 text-center">
                  {CHANGE_MARK[change.kind]}
                </span>
                <span className="w-16 shrink-0">
                  {CHANGE_LABEL[change.kind]}{' '}
                </span>
                <span className={change.kind === 'removed' ? 'line-through decoration-danger-glow/60' : ''}>{change.description}</span>
              </li>
            ))}
          </ol>
          <p className="text-[11px] text-void-200">
            A rotation merge shows as the two rotations removed and one added. Kept operations are the same in both circuits.
          </p>
        </div>
      )}

      {report.ruleNotes.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-[11px] font-medium text-void-200">Why each rewrite is safe</h4>
          <ul className="flex flex-col gap-1.5" data-testid="optimization-rules">
            {report.ruleNotes.map((note, i) => (
              <li key={i} className="text-xs text-slate-300">
                <span className="font-mono-qasm text-slate-200">{note.rule}</span>
                {note.explanation && <span className="block text-slate-400">{note.explanation}</span>}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-void-200">These explain the idea. Whether this rewrite really is equivalent is decided by the check below, not by the rule.</p>
        </div>
      )}

      {report.equivalence && (
        <div className="flex flex-col gap-1" data-testid="optimization-equivalence">
          <h4 className="text-[11px] font-medium text-void-200">
            Equivalence: {report.equivalence.status.replace('_', ' ').toLowerCase()} · {report.equivalence.method}
            {report.equivalence.globalPhase !== null && ` (global phase ${report.equivalence.globalPhase.toFixed(6)})`}
          </h4>
          <ul className="flex flex-col gap-1">
            {report.equivalence.checks.map((check) => (
              <CheckRow key={check.name} check={check} />
            ))}
          </ul>
        </div>
      )}

      {verified && report.candidateProvenance && (
        <div className="flex flex-col gap-1" data-testid="optimization-provenance">
          <h4 className="text-[11px] font-medium text-void-200">Supporting run of the proposed circuit</h4>
          <div className="flex flex-wrap items-center gap-2">
            <ProvenanceBadge provenance={report.candidateProvenance} />
            <span className="font-mono-qasm text-[11px] text-void-200">
              {report.candidateProvenance.resultId} · {report.candidateProvenance.circuitHash}
            </span>
          </div>
          <p className="text-[11px] text-void-200">
            A statevector run recorded for the proposed circuit. It is evidence you can inspect, not the equivalence proof.
          </p>
        </div>
      )}

      {verified && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={onApply}
            className="self-start rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
          >
            Apply optimized circuit
          </button>
          <p className="text-[11px] text-void-200">Replaces your circuit with the proposed one as a single step. Undo (Ctrl+Z) brings the original back.</p>
        </div>
      )}
    </div>
  )
}

function CheckRow({ check }: { check: OptimizationEquivalenceCheckResult }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${check.status === 'PASS' ? 'bg-cyan-glow' : 'bg-danger-glow'}`} aria-hidden="true" />
      <span className="text-slate-300">
        <span className="font-mono-qasm text-slate-200">{check.name}</span>
        <span className="sr-only">{check.status === 'PASS' ? ' passed' : ' failed'}</span>
        {' — '}
        {check.detail}
      </span>
    </li>
  )
}
