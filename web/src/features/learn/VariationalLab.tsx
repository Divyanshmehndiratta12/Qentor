/**
 * The variational (VQE-style) lab of lesson 17: a parameter sweep, the cost curve, the Bloch sphere of a chosen angle and a small
 * classical optimisation, all of it computed by the server.
 *
 * It is ONE educational example and says so on screen: one qubit, RY(theta), the cost <Z>. It is not a chemistry calculation, not a
 * scalable VQE and needs no hardware. The browser sends angles and loop settings (the learner's own choices) and draws what comes back:
 * every <Z>, Bloch vector, probability and gradient is read by the server from a backend statevector, arrives wrapped with the provenance
 * of the run it came from, and is shown only through `VerifiedValueInline`. The chart's geometry (`variationalChart.ts`) maps those
 * values to screen positions and nothing else; the lowest point is the server's own pick (`minimumIndex`), not a minimum found here.
 */
import { useId, useState } from 'react'
import type { TraceBlochVector, VariationalPoint } from '@/api'
import { parseAngle } from '@/circuit/angle'
import { BlochSphere } from '@/features/build/BlochSphere'
import { StateNotice } from '@/features/shell/StateNotice'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import type { QuantumValue } from '@/provenance/QuantumValue'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { BASELINE_Y, CHART, COST_AXIS, angleTicks, polyline, xFor, yFor } from './variationalChart'
import { useVariationalStore } from './variationalStore'

const f6 = (x: number) => x.toFixed(6)
const signed6 = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(6)}`

const RANGES = [
  { id: 'full', label: '0 to 2π', min: 0, max: 2 * Math.PI },
  { id: 'centred', label: '−π to π', min: -Math.PI, max: Math.PI },
] as const
const POINT_CHOICES = [9, 17, 25, 41] as const
const RATES = [0.2, 0.4, 0.6, 0.8] as const
const STEP_CHOICES = [5, 10, 15, 20] as const

const field = 'rounded-md border border-void-400 bg-void-800 px-1.5 py-1 text-xs text-slate-200 focus:border-violet-glow focus:outline-none disabled:opacity-50'
const button =
  'rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-45'
const primary = `${button} border-violet-glow/60 bg-violet-dim/30 text-violet-glow hover:bg-violet-dim/50`
const th = 'px-2 py-1 text-left text-[10px] font-semibold tracking-wider text-slate-400 uppercase'
const td = 'px-2 py-1 align-top text-[12px] text-slate-200'

function Num({ value, render = f6 }: { value: QuantumValue<number>; render?: (x: number) => string }) {
  return <VerifiedValueInline quantum={value} render={render} />
}

function blochOf(point: VariationalPoint, index: number): TraceBlochVector {
  return {
    coordinates: point.bloch,
    method: 'bloch-from-statevector/1',
    derivedFrom: {
      stepIndex: index,
      resultId: point.resultId,
      executionId: point.executionId,
      circuitHash: point.circuitHash,
      backend: point.provenance.backend,
      backendVersion: point.provenance.backendVersion,
    },
  }
}

export function VariationalLab() {
  const id = useId()
  const sweep = useVariationalStore((s) => s.sweep)
  const isSweeping = useVariationalStore((s) => s.isSweeping)
  const sweepError = useVariationalStore((s) => s.sweepError)
  const optimization = useVariationalStore((s) => s.optimization)
  const isOptimizing = useVariationalStore((s) => s.isOptimizing)
  const optimizationError = useVariationalStore((s) => s.optimizationError)
  const source = useVariationalStore((s) => s.source)
  const selected = useVariationalStore((s) => s.selected)
  const runSweep = useVariationalStore((s) => s.runSweep)
  const runOptimization = useVariationalStore((s) => s.runOptimization)
  const setSource = useVariationalStore((s) => s.setSource)
  const select = useVariationalStore((s) => s.select)

  const [rangeId, setRangeId] = useState<(typeof RANGES)[number]['id']>('full')
  const [points, setPoints] = useState<number>(25)
  const [startText, setStartText] = useState('0.8')
  const [rate, setRate] = useState<number>(0.6)
  const [steps, setSteps] = useState<number>(15)

  const range = RANGES.find((r) => r.id === rangeId)!
  const start = parseAngle(startText)

  const sweepPoints = sweep?.points ?? []
  const path = optimization?.steps ?? []
  // The chart's angle axis is the range of the runs the server returned (their first and last angles), so it always matches what is drawn.
  const first = sweepPoints[0]
  const last = sweepPoints[sweepPoints.length - 1]
  const thetaMin = first?.theta.value ?? range.min
  const thetaMax = last?.theta.value ?? range.max
  const length = source === 'sweep' ? sweepPoints.length : path.length
  const chosen: VariationalPoint | null = source === 'sweep' ? (sweepPoints[selected] ?? null) : (path[selected]?.point ?? null)
  const chosenStep = source === 'path' ? (path[selected] ?? null) : null
  const caption = 'Cost curve: the expectation value of Z for each angle theta. Each point is one backend run.'

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-void-500 pt-3" data-testid="variational-lab">
      <p className="rounded-md border border-amber-glow/40 bg-amber-dim/20 px-2.5 py-1.5 text-[12px] leading-snug text-amber-glow" data-testid="variational-label">
        {sweep?.label ??
          'Educational one-parameter demonstration: not a chemistry calculation, not a scalable VQE, and no quantum hardware. Every value below is computed by the server.'}
      </p>

      <form
        className="flex flex-col gap-2"
        aria-label="Parameter sweep"
        onSubmit={(e) => {
          e.preventDefault()
          void runSweep({ thetaMin: range.min, thetaMax: range.max, points })
        }}
      >
        <h5 className="text-[12px] font-semibold text-slate-200">1. Sweep the angle</h5>
        <p className="text-[12px] text-slate-400">The server runs RY(θ) at evenly spaced angles and reads the expectation value of Z from each state.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-slate-300" htmlFor={`${id}-range`}>
            Angle range
            <select id={`${id}-range`} className={field} value={rangeId} onChange={(e) => setRangeId(e.target.value as typeof rangeId)}>
              {RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-slate-300" htmlFor={`${id}-points`}>
            Points
            <select id={`${id}-points`} className={field} value={points} onChange={(e) => setPoints(Number(e.target.value))}>
              {POINT_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={primary} disabled={isSweeping}>
            {isSweeping ? 'Running the sweep…' : sweep ? 'Run the sweep again' : 'Run the sweep'}
          </button>
        </div>
        {isSweeping && <StateNotice kind="loading" compact title="The server is running the circuit at each angle…" />}
        {sweepError && !isSweeping && (
          <StateNotice kind="error" compact title="The sweep could not run" detail={sweepError} hint="No curve is shown: nothing was made up." onRetry={() => void runSweep({ thetaMin: range.min, thetaMax: range.max, points })} />
        )}
      </form>

      <figure className="flex flex-col gap-2" data-testid="variational-chart">
        <svg
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          role="img"
          aria-label={`${caption} Vertical axis: the expectation value of Z, from -1 to +1. Horizontal axis: the angle. ${sweepPoints.length > 0 ? `${sweepPoints.length} sweep points${path.length > 0 ? ` and an optimiser path of ${path.length} steps` : ''}; the same values are in the tables.` : 'No sweep has been run yet.'}`}
          className="h-auto w-full max-w-xl rounded-md border border-void-500 bg-void-950/60"
        >
          {[COST_AXIS.max, 0, COST_AXIS.min].map((cost) => (
            <g key={cost}>
              <line x1={CHART.left} x2={CHART.width - CHART.right} y1={yFor(cost)} y2={yFor(cost)} className="stroke-void-500" strokeDasharray={cost === 0 ? '4 3' : undefined} />
              <text x={CHART.left - 6} y={yFor(cost)} textAnchor="end" dominantBaseline="middle" className="fill-slate-400 text-[10px]">
                {cost > 0 ? '+1' : cost < 0 ? '-1' : '0'}
              </text>
            </g>
          ))}
          {angleTicks(thetaMin, thetaMax).map((tick) => (
            <g key={tick.label}>
              <line x1={xFor(tick.theta, thetaMin, thetaMax)} x2={xFor(tick.theta, thetaMin, thetaMax)} y1={BASELINE_Y} y2={BASELINE_Y + 4} className="stroke-void-300" />
              <text x={xFor(tick.theta, thetaMin, thetaMax)} y={BASELINE_Y + 16} textAnchor="middle" className="fill-slate-400 text-[10px]">
                {tick.label}
              </text>
            </g>
          ))}
          <text x={CHART.left + (CHART.width - CHART.left - CHART.right) / 2} y={CHART.height - 4} textAnchor="middle" className="fill-slate-400 text-[10px]">
            angle θ (radians)
          </text>
          <text transform={`translate(10 ${CHART.top + (CHART.height - CHART.top - CHART.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="fill-slate-400 text-[10px]">
            ⟨Z⟩
          </text>

          {sweepPoints.length > 1 && (
            <polyline
              fill="none"
              className="stroke-cyan-glow"
              strokeWidth={1.5}
              points={polyline(sweepPoints.map((p) => ({ theta: p.theta.value, cost: p.expectationZ.value })), thetaMin, thetaMax)}
            />
          )}
          {sweepPoints.map((p, i) => (
            <circle
              key={p.resultId}
              cx={xFor(p.theta.value, thetaMin, thetaMax)}
              cy={yFor(p.expectationZ.value)}
              r={source === 'sweep' && i === selected ? 5 : 2.5}
              className={source === 'sweep' && i === selected ? 'fill-violet-glow stroke-slate-100' : 'fill-cyan-glow'}
              onClick={() => {
                setSource('sweep')
                select(i)
              }}
              aria-hidden="true"
            />
          ))}
          {sweep && sweepPoints[sweep.minimumIndex] && (
            <g aria-hidden="true">
              <rect
                x={xFor(sweepPoints[sweep.minimumIndex]!.theta.value, thetaMin, thetaMax) - 4}
                y={yFor(sweepPoints[sweep.minimumIndex]!.expectationZ.value) - 4}
                width={8}
                height={8}
                transform={`rotate(45 ${xFor(sweepPoints[sweep.minimumIndex]!.theta.value, thetaMin, thetaMax)} ${yFor(sweepPoints[sweep.minimumIndex]!.expectationZ.value)})`}
                className="fill-none stroke-slate-100"
              />
            </g>
          )}
          {path.length > 1 && (
            <polyline
              fill="none"
              className="stroke-amber-glow"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              points={polyline(path.map((s) => ({ theta: s.point.theta.value, cost: s.point.expectationZ.value })), thetaMin, thetaMax)}
            />
          )}
          {path.map((s, i) => (
            <circle
              key={s.point.resultId}
              cx={xFor(s.point.theta.value, thetaMin, thetaMax)}
              cy={yFor(s.point.expectationZ.value)}
              r={source === 'path' && i === selected ? 5 : 3}
              className={source === 'path' && i === selected ? 'fill-amber-glow stroke-slate-100' : 'fill-void-950 stroke-amber-glow'}
              onClick={() => {
                setSource('path')
                select(i)
              }}
              aria-hidden="true"
            />
          ))}
        </svg>
        <figcaption className="text-[11px] leading-snug text-void-200">
          <span className="text-cyan-glow">●</span> a sweep point · <span className="text-slate-100">◇</span> the lowest point the server found in the sweep ·{' '}
          <span className="text-amber-glow">○</span> the optimiser&rsquo;s path. The vertical axis is the range of the Z observable, −1 to +1.
        </figcaption>
        {sweepPoints.length > 0 && (
          <details className="text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">The sweep as a table ({sweepPoints.length} runs)</summary>
            <div className="mt-1 max-h-56 overflow-auto" tabIndex={0} role="region" aria-label="Sweep table, scrollable">
              <table className="w-full min-w-[20rem] border-collapse text-left">
                <caption className="pb-1 text-left text-[11px] text-void-200">{caption}</caption>
                <thead>
                  <tr>
                    <th className={th}>θ</th>
                    <th className={th}>⟨Z⟩</th>
                    <th className={th}>P(reads 0)</th>
                    <th className={th}>P(reads 1)</th>
                  </tr>
                </thead>
                <tbody>
                  {sweepPoints.map((p) => (
                    <tr key={p.resultId} className="border-t border-void-500">
                      <td className={td}>
                        <Num value={p.theta} />
                      </td>
                      <td className={td}>
                        <Num value={p.expectationZ} />
                      </td>
                      <td className={td}>
                        <Num value={p.probabilityZero} />
                      </td>
                      <td className={td}>
                        <Num value={p.probabilityOne} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </figure>

      <section aria-label="Selected run" className="flex flex-col gap-2" data-testid="variational-selected">
        <h5 className="text-[12px] font-semibold text-slate-200">2. Look at one angle</h5>
        {chosen === null ? (
          <p className="text-[12px] text-slate-400">Run the sweep, then pick a point on the curve to see the qubit&rsquo;s arrow for that angle.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-[12px] text-slate-300">
              {sweepPoints.length > 0 && path.length > 0 && (
                <div role="radiogroup" aria-label="Show a run from" className="flex gap-1.5">
                  {(['sweep', 'path'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={source === s}
                      onClick={() => setSource(s)}
                      className={`${button} ${source === s ? 'border-violet-glow/60 bg-violet-dim/30 text-violet-glow' : 'border-void-400 text-slate-300'}`}
                    >
                      {s === 'sweep' ? 'The sweep' : 'The optimiser path'}
                    </button>
                  ))}
                </div>
              )}
              <label className="flex flex-1 items-center gap-2" htmlFor={`${id}-slider`}>
                {source === 'sweep' ? 'Angle point' : 'Optimiser step'}
                <input
                  id={`${id}-slider`}
                  type="range"
                  min={0}
                  max={Math.max(0, length - 1)}
                  value={Math.min(selected, Math.max(0, length - 1))}
                  onChange={(e) => select(Number(e.target.value))}
                  aria-valuetext={`${source === 'sweep' ? 'point' : 'step'} ${selected + 1} of ${length}`}
                  className="min-w-[8rem] flex-1 accent-violet-400"
                />
                <span className="font-mono-qasm text-[11px] text-void-200">
                  {selected + 1} / {length}
                </span>
              </label>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]" aria-live="polite">
              <dt className="text-slate-400">Angle θ</dt>
              <dd>
                <Num value={chosen.theta} />
              </dd>
              <dt className="text-slate-400">Expectation value ⟨Z⟩</dt>
              <dd>
                <Num value={chosen.expectationZ} />
              </dd>
              <dt className="text-slate-400">The qubit reads 0 / 1</dt>
              <dd>
                <Num value={chosen.probabilityZero} /> / <Num value={chosen.probabilityOne} />
              </dd>
              {chosenStep && (
                <>
                  <dt className="text-slate-400">Slope from the two shifted runs</dt>
                  <dd>
                    <Num value={chosenStep.gradient} render={signed6} />
                  </dd>
                </>
              )}
            </dl>
            <p className="flex flex-wrap items-center gap-2 font-mono-qasm text-[10px] text-void-200">
              <ProvenanceBadge provenance={chosen.provenance} />
              <span>run {chosen.resultId}</span>
            </p>
            <BlochSphere bloch={blochOf(chosen, selected)} numQubits={1} />
          </>
        )}
      </section>

      <form
        className="flex flex-col gap-2"
        aria-label="Classical optimisation"
        onSubmit={(e) => {
          e.preventDefault()
          if (start !== null) void runOptimization({ thetaStart: start, steps, learningRate: rate })
        }}
      >
        <h5 className="text-[12px] font-semibold text-slate-200">3. Let a classical loop search for the lowest cost</h5>
        <p className="text-[12px] text-slate-400">
          Each step asks the server for the cost at the current angle and at the angle shifted a quarter turn either way, builds the slope from those three backend
          runs, and moves the angle downhill.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-slate-300" htmlFor={`${id}-start`}>
            Start angle (radians; pi expressions work)
            <input id={`${id}-start`} className={`${field} w-28 font-mono-qasm`} value={startText} aria-invalid={start === null} onChange={(e) => setStartText(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-slate-300" htmlFor={`${id}-rate`}>
            Learning rate
            <select id={`${id}-rate`} className={field} value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-slate-300" htmlFor={`${id}-steps`}>
            Steps
            <select id={`${id}-steps`} className={field} value={steps} onChange={(e) => setSteps(Number(e.target.value))}>
              {STEP_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={primary} disabled={start === null || isOptimizing}>
            {isOptimizing ? 'Running the loop…' : optimization ? 'Run the loop again' : 'Run the classical optimiser'}
          </button>
        </div>
        {start === null && (
          <p role="status" className="text-[12px] text-amber-glow">
            That is not an angle the editor can read.
          </p>
        )}
        {isOptimizing && <StateNotice kind="loading" compact title="The server is running the loop: three backend runs per step…" />}
        {optimizationError && !isOptimizing && <StateNotice kind="error" compact title="The loop could not run" detail={optimizationError} hint="No path is shown: nothing was made up." />}
      </form>

      {optimization && !isOptimizing && (
        <section aria-label="Optimiser result" className="flex flex-col gap-2" data-testid="variational-path">
          <p className="text-[12px] text-slate-200" data-testid="variational-summary">
            {path.length - 1} steps. The lowest cost seen was at step {optimization.lowestIndex}: ⟨Z⟩ <Num value={path[optimization.lowestIndex]!.point.expectationZ} /> at θ{' '}
            <Num value={path[optimization.lowestIndex]!.point.theta} />.{' '}
            {optimization.converged ? 'The slope at the last angle is flat: the loop has settled.' : 'The slope at the last angle is not flat yet: the loop was still moving.'}
          </p>
          {optimization.notes.map((note) => (
            <p key={note} role="status" className="rounded-md border border-amber-glow/40 bg-amber-dim/20 px-2.5 py-1.5 text-[12px] text-amber-glow">
              {note}
            </p>
          ))}
          <div className="max-h-64 overflow-auto" tabIndex={0} role="region" aria-label="Optimiser path table, scrollable">
            <table className="w-full min-w-[20rem] border-collapse text-left">
              <caption className="pb-1 text-left text-[11px] text-void-200">
                Optimiser path: each row is three backend runs. The learning rate is {optimization.learningRate} (your setting); the slope comes from the two shifted runs.
              </caption>
              <thead>
                <tr>
                  <th className={th}>Step</th>
                  <th className={th}>θ</th>
                  <th className={th}>⟨Z⟩</th>
                  <th className={th}>Slope</th>
                </tr>
              </thead>
              <tbody>
                {path.map((s, i) => (
                  <tr key={s.point.resultId} className={`border-t border-void-500 ${source === 'path' && i === selected ? 'bg-void-800' : ''}`}>
                    <td className={`${td} font-mono-qasm`}>{s.step}</td>
                    <td className={td}>
                      <Num value={s.point.theta} />
                    </td>
                    <td className={td}>
                      <Num value={s.point.expectationZ} />
                    </td>
                    <td className={td}>
                      <Num value={s.gradient} render={signed6} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="font-mono-qasm text-[10px] text-void-200">
            demonstration {optimization.provenance.resultId} · {optimization.backend} {optimization.backendVersion} · {optimization.observable} · {optimization.ansatz}
          </p>
        </section>
      )}
    </div>
  )
}
