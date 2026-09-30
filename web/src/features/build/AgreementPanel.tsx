/**
 * "Do the simulators agree?" — the server runs the circuit's statevector on Qiskit Aer, Cirq and PennyLane and compares
 * the states (`POST /api/compare/backends`, `qentor.verification.agreement`). This panel only renders that report: the
 * browser never compares two quantum values. Every number carries the comparison's own provenance record, and each
 * backend that ran carries its own.
 */
import type { AgreementBackendResult, AgreementResult } from '@/api'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { toQuantumValue } from '@/provenance/QuantumValue'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { BACKEND_LABELS } from './BackendSelector'
import { useBuildStore } from './store'

const STATUS_TEXT: Record<AgreementBackendResult['status'], string> = {
  RAN: 'ran',
  REFUSED: 'refused',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
}

const label = (name: string) => BACKEND_LABELS[name as keyof typeof BACKEND_LABELS] ?? name

export function AgreementPanel() {
  const circuit = useBuildStore((s) => s.circuit)
  const agreement = useBuildStore((s) => s.agreement)
  const error = useBuildStore((s) => s.agreementError)
  const isComparing = useBuildStore((s) => s.isComparingBackends)
  const runAgreement = useBuildStore((s) => s.runAgreement)

  // A report answers one circuit; once the circuit on screen is another one it is stale and is not shown as current.
  const current = agreement && agreement.circuit === circuit ? agreement.result : null
  const stale = agreement !== null && current === null

  return (
    <section aria-label="Cross-backend check" className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Cross-check backends</span>
        <button
          type="button"
          onClick={() => void runAgreement()}
          disabled={isComparing || circuit.ops.length === 0}
          className="rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isComparing ? 'Comparing…' : 'Compare backends'}
        </button>
      </div>

      {!current && !isComparing && !error && (
        <p className="text-xs text-void-200">
          {stale
            ? 'The circuit changed since the last comparison. Compare again.'
            : circuit.ops.length === 0
              ? 'Add gates to compare the simulators.'
              : 'Runs the circuit on Qiskit Aer, Cirq and PennyLane and compares their states on the server.'}
        </p>
      )}

      {isComparing && (
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-glow" aria-hidden="true" />
          Running on each backend…
        </p>
      )}

      {!isComparing && error && (
        <div role="alert" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
          <p className="font-semibold text-danger-glow">Comparison unavailable</p>
          <p className="mt-1 font-mono-qasm text-xs text-danger-glow/80">{error}</p>
          <p className="mt-2.5 text-xs text-slate-400">No substitute comparison is shown.</p>
          <button
            type="button"
            onClick={() => void runAgreement()}
            className="mt-2 rounded-md border border-void-400 px-2.5 py-1 text-xs text-slate-200 hover:border-void-300"
          >
            Try again
          </button>
        </div>
      )}

      {!isComparing && !error && current && <AgreementReport report={current} />}
    </section>
  )
}

function verdict(report: AgreementResult): { text: string; tone: string } {
  if (report.status === 'AGREE') {
    const ran = report.backends.filter((b) => b.status === 'RAN').length
    return { text: `${ran} backends agree (within ${report.threshold.toExponential()})`, tone: 'text-cyan-glow' }
  }
  if (report.status === 'DISAGREE') return { text: 'Backends disagree', tone: 'text-danger-glow' }
  return { text: 'Incomplete: fewer than two backends produced a result', tone: 'text-amber-glow' }
}

function AgreementReport({ report }: { report: AgreementResult }) {
  const { text, tone } = verdict(report)
  const provenance = report.provenance
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-void-500 bg-void-950/60 p-3.5" data-testid="agreement-report">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${tone}`}>{text}</span>
        <ProvenanceBadge provenance={provenance} />
      </div>

      <ul className="flex flex-col gap-1.5" aria-label="Backends">
        {report.backends.map((b) => (
          <li key={b.backend} className="flex flex-col gap-0.5 text-xs">
            <span className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-slate-200">{label(b.backend)}</span>
              <span
                className={
                  b.status === 'RAN' ? 'text-cyan-glow' : b.status === 'FAILED' ? 'text-danger-glow' : 'text-amber-glow'
                }
              >
                {STATUS_TEXT[b.status]}
              </span>
              {b.provenance && (
                <span className="font-mono-qasm text-[11px] text-void-200">
                  {b.provenance.backend} {b.provenance.backendVersion}
                </span>
              )}
            </span>
            {b.message && <span className="pl-[5.5rem] text-void-200">{b.message}</span>}
          </li>
        ))}
      </ul>

      {report.pairs.length > 0 && (
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Pairwise agreement</caption>
          <thead>
            <tr className="text-void-200">
              <th className="pb-1.5 font-medium">pair</th>
              <th className="pb-1.5 font-medium" title="largest difference between the two backends' outcome probabilities">
                Δ probability
              </th>
              <th className="pb-1.5 font-medium" title="|⟨a|b⟩|² — 1 means the same state up to a global phase">
                fidelity
              </th>
              <th className="pb-1.5 font-medium" title="largest difference between amplitudes; a global phase changes it and nothing physical">
                Δ amplitude
              </th>
            </tr>
          </thead>
          <tbody>
            {report.pairs.map((pair) => (
              <tr key={`${pair.backendA}-${pair.backendB}`} className="border-t border-void-600">
                <td className="py-1.5 text-slate-300">
                  {label(pair.backendA)} · {label(pair.backendB)}
                  <span className={`ml-1.5 ${pair.agrees ? 'text-cyan-glow' : 'text-danger-glow'}`}>
                    {pair.agrees ? 'agree' : 'differ'}
                  </span>
                </td>
                <td className="py-1.5">
                  <VerifiedValueInline
                    quantum={toQuantumValue(pair.maxProbabilityDifference, provenance)}
                    render={(v) => v.toExponential(2)}
                  />
                </td>
                <td className="py-1.5">
                  <VerifiedValueInline quantum={toQuantumValue(pair.fidelity, provenance)} render={(v) => v.toFixed(9)} />
                </td>
                <td className="py-1.5">
                  <VerifiedValueInline
                    quantum={toQuantumValue(pair.maxAmplitudeDifference, provenance)}
                    render={(v) => v.toExponential(2)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-[11px] leading-snug text-void-200">
        Compared on the server from each backend&rsquo;s own statevector.
        {report.terminalMeasurementsStripped > 0 &&
          ` ${report.terminalMeasurementsStripped} final measurement${report.terminalMeasurementsStripped === 1 ? ' was' : 's were'} left out (a measured statevector collapses at random).`}{' '}
        Agreeing simulators say the SDKs implement the circuit the same way, not that the circuit is correct.
      </p>
    </div>
  )
}
