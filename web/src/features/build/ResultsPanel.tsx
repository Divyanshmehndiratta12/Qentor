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
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { toQuantumValue } from '@/provenance/QuantumValue'

const Plot = createPlotlyComponent(Plotly)

export function ResultsPanel() {
  const isExecuting = useBuildStore((s) => s.isExecuting)
  const executionError = useBuildStore((s) => s.executionError)
  const result = useBuildStore((s) => s.result)
  const mode = useBuildStore((s) => s.mode)
  const setMode = useBuildStore((s) => s.setMode)
  const shots = useBuildStore((s) => s.shots)
  const setShots = useBuildStore((s) => s.setShots)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-void-500 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-slate-100">Results</span>
        {result && <ProvenanceBadge provenance={result.provenance} />}
      </div>

      <div className="flex items-center gap-3 border-b border-void-500 px-4 py-2.5 text-xs">
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
        {isExecuting && (
          <p className="flex items-center gap-2 text-sm text-slate-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-glow" />
            Running on backend…
          </p>
        )}

        {!isExecuting && executionError && (
          <div className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
            <p className="font-semibold text-danger-glow">Backend unavailable</p>
            <p className="mt-1 font-mono-qasm text-xs text-danger-glow/80">{executionError}</p>
            <p className="mt-2.5 text-xs text-slate-400">
              No substitute result is shown. This circuit has not been executed.
            </p>
          </div>
        )}

        {!isExecuting && !executionError && !result && (
          <p className="text-sm text-void-200">Add gates to the circuit to run it.</p>
        )}

        {!isExecuting && result && result.value.probabilities && (
          <ShotsResult probabilities={result.value.probabilities} counts={result.value.counts} provenance={result.provenance} />
        )}

        {!isExecuting && result && result.value.statevector && (
          <StatevectorResult amplitudes={result.value.statevector} provenance={result.provenance} />
        )}
      </div>
    </div>
  )
}

function ShotsResult({
  probabilities,
  counts,
  provenance,
}: {
  probabilities: Record<string, number>
  counts?: Record<string, number>
  provenance: import('@/provenance/QuantumValue').Provenance
}) {
  const bitstrings = Object.keys(probabilities).sort()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Measurement</span>
        <span className="font-mono-qasm text-[11px] text-void-200">bitstrings shown as q[n-1] … q[0]</span>
      </div>
      <Plot
        data={[
          {
            x: bitstrings,
            y: bitstrings.map((b) => probabilities[b]),
            type: 'bar',
            marker: { color: 'oklch(0.8 0.12 215)' },
          },
        ]}
        layout={{
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { color: '#a3abb7', size: 11, family: 'JetBrains Mono, monospace' },
          margin: { l: 40, r: 10, t: 10, b: 40 },
          yaxis: { title: { text: 'probability' }, gridcolor: '#232830' },
          xaxis: { gridcolor: '#232830' },
          height: 220,
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%' }}
      />
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-void-200">
            <th className="pb-1.5 font-medium">bitstring</th>
            <th className="pb-1.5 font-medium">probability</th>
            {counts && <th className="pb-1.5 font-medium">counts</th>}
          </tr>
        </thead>
        <tbody>
          {bitstrings.map((b) => (
            <tr key={b} className="border-t border-void-600">
              <td className="py-1.5 font-mono-qasm text-slate-300">{b}</td>
              <td className="py-1.5">
                <VerifiedValueInline
                  quantum={toQuantumValue(probabilities[b], provenance)}
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
  provenance,
}: {
  amplitudes: Array<[number, number]>
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
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-void-200">
            <th className="pb-1.5 font-medium">basis state</th>
            <th className="pb-1.5 font-medium">Re</th>
            <th className="pb-1.5 font-medium">Im</th>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
