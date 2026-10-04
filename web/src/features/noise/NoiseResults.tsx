/**
 * The Noise Lab's results: what the server returned for the ideal run, the noisy run and their comparison, and nothing else.
 *
 * Every number is rendered through `VerifiedValueInline` with the provenance of the stored record it came from (the ideal run's, the noisy run's, or
 * the comparison's), so a count of the noisy run can never wear the ideal run's badge. The explanation sentences are the server's, written
 * deterministically from the comparison record: no language model is involved and the browser adds no number to them. If the server returns no noisy
 * run, no noisy number is shown; there is no code path here that fills one in.
 *
 * States: running (a live status), failed (the server's own message and code, no result, "nothing was substituted"), stale (the circuit changed after the
 * run: its results are hidden because they belong to a different circuit), nothing run yet, and the result. A changed setting does not hide a result (it
 * names the noise it was made under); it says the settings have moved on.
 */
import type { NoiseCompareResult, NoiseRun } from '@/api'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { StateNotice } from '@/features/shell/StateNotice'
import { NoiseComparisonChart } from './NoiseComparisonChart'
import { circuitKey, useNoiseStore } from './store'
import type { Circuit } from '@/circuit/types'

const IDEAL_COLOR = 'oklch(0.8 0.12 215)'
const NOISY_COLOR = 'oklch(0.8 0.15 75)'

const freq = (v: number) => v.toFixed(4)
/** A difference with its sign written out (a text transformation of the server's number; nothing is computed). */
const signed = (v: number) => {
  const text = v.toFixed(4)
  return text.startsWith('-') ? `−${text.slice(1)}` : `+${text}`
}
const whole = (v: number) => String(v)
const share = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)

function RunCard({ title, run, seed, kind }: { title: string; run: NoiseRun; seed: number; kind: 'ideal' | 'noisy' }) {
  const noise = run.noise
  return (
    <section aria-label={`${title} run`} data-testid={`run-${kind}`} className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border p-2.5 ${kind === 'noisy' ? 'border-amber-glow/40 bg-amber-dim/10' : 'border-void-500 bg-void-900/60'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">{title}</h3>
        <ProvenanceBadge provenance={run.provenance} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <dt className="text-void-200">backend</dt>
        <dd className="font-mono-qasm text-slate-200" data-testid={`${kind}-backend`}>{`${run.provenance.backend} ${run.provenance.backendVersion}`}</dd>
        <dt className="text-void-200">execution mode</dt>
        <dd className="font-mono-qasm text-slate-200" data-testid={`${kind}-mode`}>{run.provenance.executionMode}</dd>
        <dt className="text-void-200">noise model</dt>
        <dd className="text-slate-200" data-testid={`${kind}-noise`}>{noise ? noise.label : 'none (ideal)'}</dd>
        {noise && (
          <>
            <dt className="text-void-200">{noise.parameter}</dt>
            <dd className="font-mono-qasm text-slate-200" data-testid={`${kind}-strength`}>{noise.strength}</dd>
            <dt className="text-void-200">simulator</dt>
            <dd className="font-mono-qasm text-slate-200">{noise.simulationMethod}</dd>
          </>
        )}
        <dt className="text-void-200">shots</dt>
        <dd className="font-mono-qasm text-slate-200" data-testid={`${kind}-shots`}>{run.shots}</dd>
        <dt className="text-void-200">seed</dt>
        <dd className="font-mono-qasm text-slate-200" data-testid={`${kind}-seed`}>{seed}</dd>
        <dt className="text-void-200">result</dt>
        <dd className="font-mono-qasm text-slate-200" title={run.provenance.resultId} data-testid={`${kind}-result-id`}>
          {share(run.provenance.resultId)}
        </dd>
      </dl>
    </section>
  )
}

function Results({ result }: { result: NoiseCompareResult }) {
  const { ideal, noisy, comparison } = result
  const outcomes = comparison ? comparison.rows.map((r) => r.outcome) : Object.keys(ideal.counts).sort()
  return (
    <div className="flex flex-col gap-3" data-testid="noise-result">
      <p role="note" className="rounded border border-amber-glow/40 bg-amber-dim/20 p-2 text-[11px] leading-snug text-amber-glow" data-testid="noise-label">
        {result.label}
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <RunCard title="Ideal" run={ideal} seed={result.noise.seed} kind="ideal" />
        {noisy && <RunCard title="Noisy" run={noisy} seed={result.noise.seed} kind="noisy" />}
      </div>

      {!noisy && (
        <p className="text-xs text-slate-300" data-testid="ideal-only-note">
          Only the ideal simulation ran. Choose a noise model and run again to see a noisy run beside it.
        </p>
      )}

      <NoiseComparisonChart
        series={[
          { name: 'Ideal', color: IDEAL_COLOR, frequencies: ideal.frequencies },
          ...(noisy ? [{ name: 'Noisy', color: NOISY_COLOR, frequencies: noisy.frequencies }] : []),
        ]}
      />

      <table className="w-full text-left text-xs" data-testid="noise-table">
        <caption className="sr-only">
          Counts and sampled frequencies of each measurement outcome for the ideal{noisy ? ' and the noisy' : ''} run, with the difference between them. Bitstrings are q[n-1] … q[0].
        </caption>
        <thead>
          <tr className="text-void-200">
            <th scope="col" className="pb-1.5 font-medium">
              outcome
            </th>
            <th scope="col" className="pb-1.5 font-medium">
              ideal count
            </th>
            <th scope="col" className="pb-1.5 font-medium">
              ideal freq.
            </th>
            {noisy && (
              <>
                <th scope="col" className="pb-1.5 font-medium">
                  noisy count
                </th>
                <th scope="col" className="pb-1.5 font-medium">
                  noisy freq.
                </th>
                <th scope="col" className="pb-1.5 font-medium">
                  change
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {comparison
            ? comparison.rows.map((row) => (
                <tr key={row.outcome} className="border-t border-void-600" data-testid={`noise-row-${row.outcome}`}>
                  <th scope="row" className="py-1.5 font-mono-qasm font-normal text-slate-300">
                    {row.outcome}
                  </th>
                  <td className="py-1.5"><VerifiedValueInline quantum={row.idealCount} render={whole} /></td>
                  <td className="py-1.5"><VerifiedValueInline quantum={row.idealFrequency} render={freq} /></td>
                  <td className="py-1.5"><VerifiedValueInline quantum={row.noisyCount} render={whole} /></td>
                  <td className="py-1.5"><VerifiedValueInline quantum={row.noisyFrequency} render={freq} /></td>
                  <td className="py-1.5"><VerifiedValueInline quantum={row.delta} render={signed} /></td>
                </tr>
              ))
            : outcomes.map((outcome) => (
                <tr key={outcome} className="border-t border-void-600" data-testid={`noise-row-${outcome}`}>
                  <th scope="row" className="py-1.5 font-mono-qasm font-normal text-slate-300">
                    {outcome}
                  </th>
                  <td className="py-1.5"><VerifiedValueInline quantum={ideal.counts[outcome]!} render={whole} /></td>
                  <td className="py-1.5"><VerifiedValueInline quantum={ideal.frequencies[outcome]!} render={freq} /></td>
                </tr>
              ))}
        </tbody>
      </table>
      <p className="text-[11px] text-void-200">Bitstrings are written q[n-1] … q[0]. Frequencies are count ÷ shots from one finite sample, not probabilities.</p>

      {comparison && (
        <>
          <section aria-label="Comparison metrics" data-testid="noise-metrics" className="flex flex-col gap-1.5 rounded-lg border border-void-500 bg-void-900/60 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">Difference</h3>
              <ProvenanceBadge provenance={comparison.provenance} />
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-void-200">total variation distance (0 identical, 1 nothing in common)</dt>
              <dd data-testid="metric-tvd"><VerifiedValueInline quantum={comparison.metrics.totalVariationDistance} render={freq} /></dd>
              <dt className="text-void-200">share of noisy shots on outcomes the ideal run produced</dt>
              <dd data-testid="metric-share"><VerifiedValueInline quantum={comparison.metrics.noisyShareOnIdealOutcomes} render={freq} /></dd>
              <dt className="text-void-200">noisy shots on outcomes the ideal run never produced</dt>
              <dd data-testid="metric-new-shots"><VerifiedValueInline quantum={comparison.metrics.newOutcomeShots} render={whole} /></dd>
              <dt className="text-void-200">distinct outcomes, ideal and noisy</dt>
              <dd className="flex gap-2">
                <VerifiedValueInline quantum={comparison.metrics.idealDistinctOutcomes} render={whole} />
                <span aria-hidden="true">/</span>
                <VerifiedValueInline quantum={comparison.metrics.noisyDistinctOutcomes} render={whole} />
              </dd>
            </dl>
            {comparison.metrics.newOutcomes.length > 0 && (
              <p className="text-[11px] text-slate-300" data-testid="new-outcomes">
                Outcomes only the noisy run produced: <span className="font-mono-qasm">{comparison.metrics.newOutcomes.join(', ')}</span>
              </p>
            )}
          </section>

          <section aria-label="What the backend result shows" data-testid="noise-explanation" className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">What the backend result shows</h3>
            <ul className="flex flex-col gap-1 text-[12px] leading-snug text-slate-300">
              {comparison.explanation.map((line) => (
                <li key={line.id} data-testid={`explanation-${line.id}`}>
                  {line.text}
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-snug text-void-200">
              Written by the server from comparison record <span className="font-mono-qasm" title={comparison.provenance.resultId}>{share(comparison.provenance.resultId)}</span>, using only the numbers above. No language model was involved. {comparison.note}
            </p>
          </section>
        </>
      )}
    </div>
  )
}

export function NoiseResults({ circuit }: { circuit: Circuit }) {
  const result = useNoiseStore((s) => s.result)
  const resultKey = useNoiseStore((s) => s.resultCircuitKey)
  const isRunning = useNoiseStore((s) => s.isRunning)
  const error = useNoiseStore((s) => s.error)
  const model = useNoiseStore((s) => s.model)
  const strength = useNoiseStore((s) => s.strength)
  const shots = useNoiseStore((s) => s.shots)
  const run = useNoiseStore((s) => s.run)

  if (isRunning) return <StateNotice kind="loading" title="Running the ideal and noisy simulations on the backend…" compact />
  if (error) {
    return (
      <StateNotice
        kind="error"
        title="The noise run did not complete"
        detail={error.code ? `${error.message} (${error.code})` : error.message}
        hint="Nothing was substituted: no result is shown for this request."
        onRetry={() => void run(circuit)}
        compact
      />
    )
  }
  if (!result) {
    return <StateNotice kind="empty" title="Run the circuit to compare an ideal simulation with a noisy one." compact />
  }
  if (resultKey !== circuitKey(circuit)) {
    return (
      <p role="status" data-testid="noise-stale" className="rounded border border-void-400 bg-void-800 p-2 text-xs text-slate-300">
        The circuit changed after this result was made, so the result is hidden: it belongs to a different circuit. Run again to compare.
      </p>
    )
  }
  const moved =
    result.noise.model !== model || (model !== 'none' && result.noise.strength !== strength) || result.ideal.shots !== shots
  return (
    <div className="flex flex-col gap-3">
      {moved && (
        <p role="status" data-testid="noise-settings-moved" className="rounded border border-void-400 bg-void-800 p-2 text-xs text-slate-300">
          The settings have changed since this run. The result below is for {result.noise.label}
          {result.noise.model === 'none' ? '' : ` at ${result.noise.strength}`} with {result.ideal.shots} shots. Run again to update it.
        </p>
      )}
      <Results result={result} />
    </div>
  )
}
