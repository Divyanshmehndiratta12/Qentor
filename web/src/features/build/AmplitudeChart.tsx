/**
 * Amplitude-and-phase chart for ONE trace step: how large each basis state's amplitude is, and which way its phase
 * points — drawn from values the backend computed.
 *
 * TRUST RULE (absolute): this component renders the magnitude, probability and phase the backend returned and nothing
 * else. It is handed a `QuantumValue<TraceAmplitude[]>` — never a statevector, a gate or a circuit — so there is
 * nothing here to derive them from, and no arithmetic is done on them: a bar is drawn by setting the CSS custom
 * property `--amp` to the backend's number (CSS turns it into a width), an arrow by setting `--phase` to the backend's
 * angle (CSS turns it into a rotation), and every printed number goes through `VerifiedValueInline` with the step's
 * provenance, formatted by `traceFormat.formatComponent` / `reducedFormat.formatAngle` (both strings).
 *
 * What a phase is (and is not): the backend reports the angle of each amplitude as its simulator holds it. The overall
 * (global) phase of a state cannot be observed, so only the DIFFERENCES between the arrows of different basis states
 * mean anything — which is why a Z gate can turn the whole chart without changing a single outcome probability. A
 * basis state whose amplitude is zero has no phase; the backend says so (`null`) and no arrow is drawn for it.
 *
 * `null` (an older backend that sends no amplitude view) is shown as "not provided", never as a chart of zeros.
 */
import type { CSSProperties } from 'react'
import type { TraceAmplitude } from '@/api'
import type { QuantumValue } from '@/provenance/QuantumValue'
import { toQuantumValue } from '@/provenance/QuantumValue'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { formatAngle } from './reducedFormat'
import { basisLabel, formatComponent } from './traceFormat'

export interface AmplitudeChartProps {
  /** The backend's polar amplitudes for the selected step, in statevector order, or null. */
  view: QuantumValue<TraceAmplitude[]> | null
  numQubits: number
  /** Whether the backend's basis-ordering statement is one the viewer can label; otherwise raw indices are shown. */
  labelled: boolean
}

export function AmplitudeChart({ view, numQubits, labelled }: AmplitudeChartProps) {
  return (
    <section
      aria-labelledby="amplitude-chart-heading"
      data-testid="amplitude-chart"
      className="flex flex-col gap-2 rounded-lg border border-void-500 bg-void-950/60 p-3"
    >
      <h4 id="amplitude-chart-heading" className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
        Amplitude and phase
      </h4>
      {view === null ? (
        <div data-testid="amplitude-chart-unavailable" className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-slate-200">Amplitude and phase unavailable for this step.</p>
          <p className="text-[11px] leading-snug text-void-200">
            The backend did not provide them, so none are shown. Qentor does not work them out itself.
          </p>
        </div>
      ) : (
        <>
          <p className="text-[11px] leading-snug text-void-200">
            Each row is one basis state. The bar is the size of its amplitude and the arrow points along its phase, both as
            the backend computed them. Only differences between phases are physical: the overall phase of a state cannot
            be observed.
          </p>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-void-200">
                  <th className="pb-1.5 font-medium">{labelled ? 'basis state' : 'index'}</th>
                  <th className="pb-1.5 font-medium">size</th>
                  <th className="pb-1.5 font-medium">phase</th>
                  <th className="pb-1.5 text-right font-medium">amplitude</th>
                  <th className="pb-1.5 text-right font-medium">angle</th>
                  <th className="pb-1.5 text-right font-medium">outcome weight</th>
                </tr>
              </thead>
              <tbody>
                {view.value.map((row, index) => (
                  <tr
                    key={index}
                    data-testid={`amplitude-row-${index}`}
                    data-has-phase={row.phase === null ? 'false' : 'true'}
                    className={`border-t border-void-600 ${row.phase === null ? 'text-void-300' : 'text-slate-200'}`}
                  >
                    <td className="py-1.5 font-mono-qasm">{labelled ? basisLabel(index, numQubits) : index}</td>
                    <td className="w-24 py-1.5 pr-2">
                      <span className="amp-track" role="img" aria-label={`amplitude size ${formatComponent(row.magnitude)}`}>
                        <span className="amp-bar" data-testid={`amplitude-bar-${index}`} style={{ '--amp': row.magnitude } as CSSProperties} />
                      </span>
                    </td>
                    <td className="py-1.5">
                      {row.phase === null ? (
                        <span className="text-[10px] text-void-300">none</span>
                      ) : (
                        <svg viewBox="0 0 24 24" className="h-6 w-6" role="img" aria-label={`phase ${formatAngle(row.phase)}`}>
                          <circle cx={12} cy={12} r={10} fill="none" className="stroke-void-400" strokeWidth={1} />
                          <line
                            x1={12}
                            y1={12}
                            x2={21}
                            y2={12}
                            className="phase-arrow"
                            data-testid={`phase-arrow-${index}`}
                            style={{ '--phase': row.phase } as CSSProperties}
                          />
                        </svg>
                      )}
                    </td>
                    <td className="py-1.5 text-right" data-testid={`amplitude-size-${index}`}>
                      <VerifiedValueInline quantum={toQuantumValue(row.magnitude, view.provenance)} render={formatComponent} />
                    </td>
                    <td className="py-1.5 text-right" data-testid={`amplitude-angle-${index}`}>
                      <VerifiedValueInline quantum={toQuantumValue(row.phase, view.provenance)} render={formatAngle} />
                    </td>
                    <td className="py-1.5 text-right" data-testid={`amplitude-weight-${index}`}>
                      <VerifiedValueInline quantum={toQuantumValue(row.probability, view.provenance)} render={formatComponent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] leading-snug text-void-200">
            Backend-derived state data, from the same statevector as the table above. “Outcome weight” is the backend’s
            figure for the chance of that outcome if this state were measured now.
          </p>
        </>
      )}
    </section>
  )
}
