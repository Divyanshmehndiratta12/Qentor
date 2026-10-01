/**
 * Renders the latest execution result. Every number here is wrapped through
 * `VerifiedValue`/`VerifiedValueInline` — no raw field from `payload` is ever
 * interpolated directly into JSX. Per docs/ARCHITECTURE.md §3, the frontend
 * never computes a probability, amplitude or fidelity itself: for
 * `statevector` mode this renders the backend's own amplitude components
 * (re, im) as given, with no client-side arithmetic on them.
 */
import createPlotlyComponent from 'react-plotly.js/factory'
import Plotly from 'plotly.js-basic-dist-min'
import { useBuildStore } from './store'
import { VerificationPanel } from './VerificationPanel'
import { OptimizePanel } from './OptimizePanel'
import { MultiInputTestPanel } from './MultiInputTestPanel'
import { TracePanel } from './TracePanel'
import { ComparePanel } from '@/features/compare/ComparePanel'
import { ExportPanel } from '@/features/share/ExportPanel'
import { AgreementPanel } from './AgreementPanel'
import { BackendSelector } from './BackendSelector'
import { EquivalencePanel } from './EquivalencePanel'
import { StateNotice } from '@/features/shell/StateNotice'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { toQuantumValue } from '@/provenance/QuantumValue'

const Plot = createPlotlyComponent(Plotly)

export function ResultsPanel() {
  const isExecuting = useBuildStore((s) => s.isExecuting)
  const executionError = useBuildStore((s) => s.executionError)
  const executionErrorStatus = useBuildStore((s) => s.executionErrorStatus)
  const result = useBuildStore((s) => s.result)
  const mode = useBuildStore((s) => s.mode)
  const setMode = useBuildStore((s) => s.setMode)
  const shots = useBuildStore((s) => s.shots)
  const setShots = useBuildStore((s) => s.setShots)
  const runExecution = useBuildStore((s) => s.runExecution)
  const hasMeasurement = useBuildStore((s) => s.circuit.ops.some((op) => op.gate === 'measure'))
  const hasOps = useBuildStore((s) => s.circuit.ops.length > 0)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-void-500 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-slate-100">Results</span>
        {result && <ProvenanceBadge provenance={result.provenance} />}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-void-500 px-4 py-2.5 text-xs">
        <BackendSelector />
        <div className="flex items-center gap-1 rounded-lg border border-void-400 bg-void-950 p-[3px] font-medium">
          <button
            type="button"
            onClick={() => setMode('statevector')}
            aria-pressed={mode === 'statevector'}
            className={`rounded-md px-2.5 py-1 ${
              mode === 'statevector' ? 'bg-void-500 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            statevector
          </button>
          <button
            type="button"
            onClick={() => setMode('shots')}
            aria-pressed={mode === 'shots'}
            className={`rounded-md px-2.5 py-1 ${
              mode === 'shots' ? 'bg-void-500 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            shots
          </button>
        </div>
        {mode === 'shots' && (
          <label className="flex items-center gap-1.5 text-void-200">
            shots
            <input
              type="number"
              min={1}
              value={shots}
              onChange={(e) => setShots(Number(e.target.value))}
              className="w-20 rounded border border-void-400 bg-void-800 px-2 py-1 font-mono-qasm text-slate-200 focus:border-cyan-glow focus:outline-none"
            />
          </label>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isExecuting && <StateNotice kind="loading" title="Running on backend…" />}

        {!isExecuting && executionError && (
          <StateNotice
            kind="error"
            // A 4xx means the server answered and refused this run (e.g. shots mode with no measurement, or over a limit);
            // no answer at all, or a 5xx, means the backend is unavailable. The real message is shown either way.
            title={executionErrorStatus !== null && executionErrorStatus >= 400 && executionErrorStatus < 500 ? 'The server refused this run' : 'Backend unavailable'}
            detail={executionError}
            hint="No substitute result is shown. This circuit has not been executed."
            onRetry={() => void runExecution()}
          />
        )}

        {!isExecuting && !executionError && !result && (
          <StateNotice kind="empty" title={hasOps ? 'Run the circuit to see its result.' : 'Add gates to the circuit to run it.'} />
        )}

        {!isExecuting && result && result.value.probabilities && (
          <ShotsResult
            frequencies={result.value.probabilities}
            counts={result.value.counts}
            shots={result.value.shots}
            provenance={result.provenance}
          />
        )}

        {!isExecuting && result && result.value.statevector && (
          <StatevectorResult
            amplitudes={result.value.statevector}
            theoretical={result.value.theoreticalProbabilities}
            hasMeasurement={hasMeasurement}
            provenance={result.provenance}
          />
        )}

        <TracePanel />
        <ComparePanel />
        <ExportPanel />
        <VerificationPanel />
        <OptimizePanel />
        <MultiInputTestPanel />
        <AgreementPanel />
        <EquivalencePanel />
      </div>
    </div>
  )
}

/** One bar chart of backend-supplied values keyed by bitstring. The values are plotted as given; nothing is derived here. */
function OutcomeChart({ values, yTitle, color }: { values: Record<string, number>; yTitle: string; color: string }) {
  const bitstrings = Object.keys(values).sort()
  return (
    <Plot
      data={[{ x: bitstrings, y: bitstrings.map((b) => values[b]), type: 'bar', marker: { color } }]}
      layout={{
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: '#a3abb7', size: 11, family: 'JetBrains Mono, monospace' },
        margin: { l: 40, r: 10, t: 10, b: 40 },
        yaxis: { title: { text: yTitle }, gridcolor: '#232830' },
        // The labels are bitstrings: without an explicit category axis Plotly reads "011" as the number 11 and draws a numeric axis.
        xaxis: { type: 'category', gridcolor: '#232830' },
        height: 220,
      }}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%' }}
    />
  )
}

/** What kind of number a chart shows, in words and by colour: a sampled frequency (cyan, dashed) or a theoretical probability (violet, solid). */
function KindBadge({ kind, shots }: { kind: 'sampled' | 'theoretical'; shots?: number }) {
  const sampled = kind === 'sampled'
  return (
    <span
      data-testid="kind-badge"
      data-kind={kind}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase ${
        sampled ? 'border-dashed border-cyan-glow/60 text-cyan-glow' : 'border-violet-glow/60 bg-violet-dim/30 text-violet-glow'
      }`}
    >
      {sampled ? `Sampled${shots !== undefined ? ` · ${shots} shots` : ''}` : 'Theoretical · ideal'}
    </span>
  )
}

function ShotsResult({
  frequencies,
  counts,
  shots,
  provenance,
}: {
  frequencies: Record<string, number>
  counts?: Record<string, number>
  shots?: number
  provenance: import('@/provenance/QuantumValue').Provenance
}) {
  const bitstrings = Object.keys(frequencies).sort()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Sampled measurement outcomes</span>
        <KindBadge kind="sampled" shots={shots} />
      </div>
      <div className="-mt-2 flex justify-end">
        <span className="font-mono-qasm text-[11px] text-void-200">bitstrings shown as q[n-1] … q[0]</span>
      </div>
      <p className="text-[11px] leading-snug text-void-200" data-testid="sampled-note">
        {shots !== undefined ? `Sampled from ${shots} shots. ` : ''}These are sampled frequencies (count ÷ shots), not
        theoretical probabilities — they change from run to run. Run the statevector mode to see the ideal
        probabilities the backend computes.
      </p>
      <OutcomeChart values={frequencies} yTitle="sampled frequency" color="oklch(0.8 0.12 215)" />
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-void-200">
            <th className="pb-1.5 font-medium">bitstring</th>
            <th className="pb-1.5 font-medium">sampled frequency</th>
            {counts && <th className="pb-1.5 font-medium">counts</th>}
          </tr>
        </thead>
        <tbody>
          {bitstrings.map((b) => (
            <tr key={b} className="border-t border-void-600">
              <td className="py-1.5 font-mono-qasm text-slate-300">{b}</td>
              <td className="py-1.5">
                <VerifiedValueInline
                  quantum={toQuantumValue(frequencies[b], provenance)}
                  render={(v) => v.toFixed(6)}
                />
              </td>
              {counts && (
                <td className="py-1.5">
                  <VerifiedValueInline quantum={toQuantumValue(counts[b], provenance)} render={(v) => String(v)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatevectorResult({
  amplitudes,
  theoretical,
  hasMeasurement,
  provenance,
}: {
  amplitudes: Array<[number, number]>
  theoretical?: Record<string, number>
  hasMeasurement: boolean
  provenance: import('@/provenance/QuantumValue').Provenance
}) {
  const n = Math.log2(amplitudes.length)
  const width = Number.isInteger(n) ? n : Math.ceil(Math.log2(amplitudes.length))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Statevector</span>
        <span className="font-mono-qasm text-[11px] text-void-200">q[n-1] … q[0]</span>
      </div>
      <p className="text-[11px] text-void-200">Amplitudes as reported by the backend (real, imaginary).</p>
      {hasMeasurement && (
        <p role="note" className="rounded border border-amber-glow/40 bg-amber-dim/20 p-2 text-[11px] leading-snug text-amber-glow" data-testid="collapsed-note">
          This circuit contains measurements, so this is one collapsed post-measurement state, not the ideal
          distribution — a different run can give a different state. Use shots mode to see sampled outcomes.
        </p>
      )}
      {theoretical && (
        <div className="flex flex-col gap-1.5" data-testid="theoretical-probabilities">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-slate-100">
            Theoretical probabilities <KindBadge kind="theoretical" />
          </span>
          <p className="text-[11px] leading-snug text-void-200">
            What an ideal measurement of this state would give (|amplitude|², computed by the backend) — not a
            sampled frequency. Bitstrings q[n-1] … q[0]; outcomes with zero probability are omitted.
          </p>
          <OutcomeChart values={theoretical} yTitle="theoretical probability" color="oklch(0.75 0.14 300)" />
        </div>
      )}
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-void-200">
            <th className="pb-1.5 font-medium">basis state</th>
            <th className="pb-1.5 font-medium">Re</th>
            <th className="pb-1.5 font-medium">Im</th>
            {theoretical && <th className="pb-1.5 font-medium">theoretical probability</th>}
          </tr>
        </thead>
        <tbody>
          {amplitudes.map(([re, im], i) => (
            <tr key={i} className="border-t border-void-600">
              <td className="py-1.5 font-mono-qasm text-slate-300">|{i.toString(2).padStart(width, '0')}⟩</td>
              <td className="py-1.5">
                <VerifiedValueInline quantum={toQuantumValue(re, provenance)} render={(v) => v.toFixed(6)} />
              </td>
              <td className="py-1.5">
                <VerifiedValueInline quantum={toQuantumValue(im, provenance)} render={(v) => v.toFixed(6)} />
              </td>
              {theoretical && (
                <td className="py-1.5">
                  {/* Listed only where the backend gave one: an omitted outcome has no value, we do not write 0 for it. */}
                  {theoretical[i.toString(2).padStart(width, '0')] !== undefined ? (
                    <VerifiedValueInline
                      quantum={toQuantumValue(theoretical[i.toString(2).padStart(width, '0')] as number, provenance)}
                      render={(v) => v.toFixed(6)}
                    />
                  ) : (
                    <span className="text-void-300">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
