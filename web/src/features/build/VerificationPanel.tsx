/**
 * The "Verify" action for the Build screen's Results panel
 * (docs/PRODUCT_CONTRACT.md's TEST stage, narrowed here to the one verifier
 * that exists server-side today: bell_state/1). Sends only the result id and
 * the canonical circuit already known to the client — never a probability,
 * count, amplitude or verdict; see `useBuildStore.runVerification` and
 * `RealApiClient.verifyBellState`. The report below is rendered exactly as
 * POST /api/verify/bell-state returned it; nothing here recomputes, guesses,
 * or upgrades a status.
 */
import type { VerificationCheckResult, VerifyBellStateResult } from '@/api'
import { bellVerdictScope } from '@/provenance/executionStatus'
import { VerificationStatusBadge } from '@/provenance/VerificationStatusBadge'
import { useBuildStore } from './store'

export function VerificationPanel() {
  const result = useBuildStore((s) => s.result)
  const isExecuting = useBuildStore((s) => s.isExecuting)
  const isVerifying = useBuildStore((s) => s.isVerifying)
  const verification = useBuildStore((s) => s.verification)
  const verificationError = useBuildStore((s) => s.verificationError)
  const runVerification = useBuildStore((s) => s.runVerification)

  // No real execution result yet (or it's mid-run) — there is nothing to verify.
  if (!result || isExecuting) return null

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Bell-state check</span>
        <button
          type="button"
          onClick={() => void runVerification()}
          disabled={isVerifying}
          className="rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isVerifying ? 'Verifying…' : 'Verify'}
        </button>
      </div>

      {isVerifying && (
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-glow" aria-hidden="true" />
          Checking against the ideal Bell state…
        </p>
      )}

      {!isVerifying && verificationError && (
        <div className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
          <p className="font-semibold text-danger-glow">Verification unavailable</p>
          <p className="mt-1 font-mono-qasm text-xs text-danger-glow/80">{verificationError}</p>
          <p className="mt-2.5 text-xs text-slate-400">No verdict is shown. Nothing here was verified.</p>
        </div>
      )}

      {!isVerifying && !verificationError && verification && <VerificationReport report={verification} />}
    </div>
  )
}

function VerificationReport({ report }: { report: VerifyBellStateResult }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-void-500 bg-void-950/60 p-3.5">
      <div className="flex items-center justify-between">
        <VerificationStatusBadge status={report.verificationStatus} />
        <span className="font-mono-qasm text-[11px] text-void-200">{report.verifier}</span>
      </div>
      <p className="text-xs leading-snug text-slate-400" data-testid="verdict-scope">
        {bellVerdictScope(report.verificationStatus)}
      </p>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 font-mono-qasm text-[11px] text-void-200">
        <dt>result</dt>
        <dd className="truncate text-slate-300" title={report.resultId}>
          {report.resultId}
        </dd>
        <dt>circuit</dt>
        <dd className="truncate text-slate-300" title={report.circuitHash}>
          {report.circuitHash}
        </dd>
      </dl>

      <SupportRow label="expected support" bitstrings={report.expectedSupport} />
      <SupportRow label="observed support" bitstrings={report.observedSupport} />

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-void-200">checks</span>
        <ul className="flex flex-col gap-1">
          {report.checks.map((check) => (
            <CheckRow key={check.name} check={check} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function CheckRow({ check }: { check: VerificationCheckResult }) {
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

function SupportRow({ label, bitstrings }: { label: string; bitstrings: string[] }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 text-void-200">{label}</span>
      <div className="flex flex-wrap gap-1">
        {bitstrings.length === 0 ? (
          <span className="text-void-200">—</span>
        ) : (
          bitstrings.map((b) => (
            <span
              key={b}
              className="rounded border border-void-400 bg-void-800 px-1.5 py-0.5 font-mono-qasm text-slate-200"
            >
              {b}
            </span>
          ))
        )}
      </div>
    </div>
  )
}
