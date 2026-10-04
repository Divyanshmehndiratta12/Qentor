/**
 * Grouped bar chart of the ideal and noisy sampled frequencies per measurement outcome, drawn with the same Plotly setup as the Lab's result chart.
 *
 * The bars are exactly the server's frequencies for each run (`QuantumValue.value`, unwrapped here only to be plotted): nothing is derived, scaled
 * or smoothed, and an outcome one run never produced is plotted as the 0 the server's table holds for it (a missing key is an outcome that run
 * did not see). For a screen reader the chart is ONE image whose name says what it shows and where the same values are as text (the table beside it,
 * every cell of which carries its provenance). The chart states no value of its own.
 */
import createPlotlyComponent from 'react-plotly.js/factory'
import Plotly from 'plotly.js-basic-dist-min'
import type { QuantumValue } from '@/provenance/QuantumValue'

const Plot = createPlotlyComponent(Plotly)

export interface ChartSeries {
  name: string
  color: string
  frequencies: Record<string, QuantumValue<number>>
}

export function NoiseComparisonChart({ series }: { series: ChartSeries[] }) {
  const outcomes = [...new Set(series.flatMap((s) => Object.keys(s.frequencies)))].sort()
  const names = series.map((s) => s.name).join(' and ')
  return (
    <div
      role="img"
      data-testid="noise-chart"
      aria-label={`Grouped bar chart of the sampled frequency of each of ${outcomes.length} measurement outcome${outcomes.length === 1 ? '' : 's'}, for the ${names} run${series.length === 1 ? '' : 's'}. Bitstrings are written q[n-1] … q[0]. The same values are listed in the table that follows.`}
    >
      <Plot
        data={series.map((s) => ({
          x: outcomes,
          y: outcomes.map((o) => s.frequencies[o]?.value ?? 0),
          name: s.name,
          type: 'bar' as const,
          marker: { color: s.color },
        }))}
        layout={{
          barmode: 'group',
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { color: '#a3abb7', size: 11, family: 'JetBrains Mono, monospace' },
          margin: { l: 44, r: 10, t: 10, b: 40 },
          yaxis: { title: { text: 'sampled frequency' }, gridcolor: '#232830' },
          // Bitstrings are labels: without an explicit category axis Plotly reads "011" as the number 11.
          xaxis: { type: 'category', gridcolor: '#232830' },
          legend: { orientation: 'h', y: 1.18, x: 0 },
          height: 240,
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%' }}
      />
    </div>
  )
}
