/**
 * Renders the latest execution result. Every number here is wrapped through
 * `VerifiedValue`/`VerifiedValueInline` — no raw field from `payload` is ever
 * interpolated directly into JSX. Per docs/ARCHITECTURE.md §3, the frontend
 * never computes a probability, amplitude or fidelity itself: for
 * `statevector` mode this renders the backend's own amplitude components
 * (re, im) as given, with no client-side arithmetic on them.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import createPlotlyComponent from 'react-plotly.js/factory'
import Plotly from 'plotly.js-basic-dist-min'
import { useBuildStore } from './store'
import { VerificationPanel } from './VerificationPanel'
import { OptimizePanel } from './OptimizePanel'
import { MultiInputTestPanel } from './MultiInputTestPanel'
import { TracePanel } from './TracePanel'
import { LabFlow, type FlowTarget } from './LabFlow'
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

export function ResultsPanel({ showOptimize = true }: { showOptimize?: boolean } = {}) {
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
  const trace = useBuildStore((s) => s.trace)

  // Bring a part of the Results column into view inside ITS OWN scroller (the page itself never moves). A folded group is opened first.
  const scroller = useRef<HTMLDivElement>(null)
  const reveal = useCallback((target: FlowTarget) => {
    const box = scroller.current
    if (!box) return
    const group = target === 'result' ? null : box.querySelector<HTMLDetailsElement>(`[data-testid="results-group-${target}"]`)
    if (group) group.open = true
    const top = group ? group.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8 : 0
    if (typeof box.scrollTo === 'function') box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [])
  // A trace that has just arrived is shown: it is below the result, and a learner who asked for it should see it.
  useEffect(() => {
    if (trace) reveal('trace')
  }, [trace, reveal])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-void-500 px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-slate-100">Results</h2>
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

      <LabFlow onReveal={reveal} />

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-4">
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

        {/* The tools below the result, grouped so the column is a short list of named sections instead of one long scroll. Native
            disclosure elements: keyboard and screen-reader operable with no script, every panel stays in the page (closed groups only
            fold it away), and a group's own state (a run, an error) is kept while it is folded. */}
        <ResultsGroup id="trace" title="Step-by-step trace" hint="state after each operation" defaultOpen>
          <TracePanel />
        </ResultsGroup>
        <ResultsGroup id="verify" title="Verify and optimize" hint="checks the server makes" defaultOpen>
          <VerificationPanel />
          {showOptimize && <OptimizePanel />}
        </ResultsGroup>
        <ResultsGroup id="compare" title="Compare runs and backends" hint="two runs, or three simulators">
          <ComparePanel />
          <AgreementPanel />
        </ResultsGroup>
        <ResultsGroup id="test" title="Equivalence and multi-input tests" hint="is it the same circuit; does it do the right thing">
          <EquivalencePanel />
          <MultiInputTestPanel />
        </ResultsGroup>
        <ResultsGroup id="share" title="Share and export" hint="read-only page, link, files">
          <ExportPanel />
        </ResultsGroup>
      </div>
    </div>
  )
}

/**
 * One named, foldable section of the Results column (a native `<details>`). The summary is the control and the name; `hint` says in a few
 * words what is inside. Nothing here reads or changes a result.
 */
function ResultsGroup({ id, title, hint, defaultOpen, children }: { id: string; title: string; hint: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details
      open={defaultOpen}
      data-testid={`results-group-${id}`}
      className="group mt-4 rounded-lg border border-void-500 bg-void-950/40 [&[open]>summary]:border-b"
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 border-void-500 px-3 py-2 text-[13px] font-semibold text-slate-100 hover:bg-void-800 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan-glow [&::-webkit-details-marker]:hidden">
        <span>
          {title} <span className="ml-1 text-[11px] font-normal text-void-200">{hint}</span>
        </span>
        <span aria-hidden="true" className="text-void-200 transition-transform group-open:rotate-90">
          ▸
        </span>
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  )
}

/**
 * One bar chart of backend-supplied values keyed by bitstring. The values are plotted as given; nothing is derived here. The chart is a drawing:
 * for a screen reader it is ONE image with a name that says what it shows and where the same values are as text (the table that follows it).
 * It states no value of its own, so no number reaches a reader except through the table's provenance-carrying cells.
 */
function OutcomeChart({ values, yTitle, color }: { values: Record<string, number>; yTitle: string; color: string }) {
  const bitstrings = Object.keys(values).sort()
  return (
    <div
      role="img"
      data-testid="outcome-chart"
      aria-label={`Bar chart of the ${yTitle} of each of ${bitstrings.length} measurement outcome${bitstrings.length === 1 ? '' : 's'}. Bitstrings are written q[n-1] … q[0]. The same values are listed in the table that follows.`}
    >
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
    </div>
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

export function ShotsResult({
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
        <caption className="sr-only">
          Sampled frequency of each measurement outcome{shots !== undefined ? `, from ${shots} shots` : ''}, with its count. Bitstrings are q[n-1] … q[0].
        </caption>
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

export function StatevectorResult({
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
        <caption className="sr-only">
          The statevector the backend returned: the real and imaginary part of the amplitude of each basis state
          {theoretical ? ', and its theoretical probability' : ''}. Basis states are q[n-1] … q[0].
        </caption>
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
                    <span className="text-void-200">—</span>
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
