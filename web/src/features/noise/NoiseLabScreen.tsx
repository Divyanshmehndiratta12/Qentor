/**
 * The Noise Lab: one circuit, run ideally and under a named simulated noise model, side by side.
 *
 * The circuit is the Lab's own (`useBuildStore`), edited with the Lab's own canvas and palette: there is one circuit representation, so an edit
 * here is an edit there. The Noise Lab runs nothing on its own: pressing Run asks the server (`POST /api/noise/compare`), which makes both runs on
 * Qiskit Aer and returns stored, provenance-carrying results. The browser draws what comes back and writes the introduction and the teaching notes;
 * it never produces, adjusts or estimates a count. It is an Aer simulation feature: the other backends have no noisy mode here, and nothing on this
 * screen is hardware.
 */
import { useEffect } from 'react'
import { CircuitCanvas } from '@/features/build/CircuitCanvas'
import { GatePalette } from '@/features/build/GatePalette'
import { useBuildStore } from '@/features/build/store'
import { NOISE_EXAMPLES } from './examples'
import { NoiseControls } from './NoiseControls'
import { NoiseResults } from './NoiseResults'
import { modelInfo, useNoiseStore } from './store'

/** Teaching notes that hold for every model as implemented. None of them is a number or a prediction about a particular circuit. */
const GENERAL_NOTES: readonly string[] = [
  'Every run is a finite sample of shots. Two ideal runs of the same circuit differ a little, so a small difference between the ideal and noisy runs is not by itself evidence of noise.',
  'Gate noise is applied after each gate, so a circuit with more gates gives it more chances to act. Readout error acts only when a qubit is measured.',
  'The more noise there is, the further the noisy distribution can move from the ideal one, but how it moves depends on the model and the circuit: some noise cannot be seen in a particular measurement at all.',
  'These are simple, textbook error models run in a simulator. They are not a model of any real device, and nothing on this screen is hardware.',
]

function circuitHint(circuit: { num_qubits: number; ops: Array<{ gate: string }> }, maxQubits: number | null): string | null {
  const parts: string[] = []
  if (!circuit.ops.some((op) => op.gate === 'measure')) {
    parts.push('This circuit has no measurement, so the server will refuse to run it. Add M to each qubit you want to read, or load an example.')
  }
  if (maxQubits !== null && circuit.num_qubits > maxQubits) {
    parts.push(`A noisy simulation is limited to ${maxQubits} qubits and this circuit has ${circuit.num_qubits}, so the server will refuse it.`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

export function NoiseLabScreen() {
  const circuit = useBuildStore((s) => s.circuit)
  const loadCircuit = useBuildStore((s) => s.loadCircuit)
  const catalog = useNoiseStore((s) => s.catalog)
  const model = useNoiseStore((s) => s.model)
  const run = useNoiseStore((s) => s.run)
  const loadCatalog = useNoiseStore((s) => s.loadCatalog)
  const info = modelInfo(catalog, model)

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  return (
    <main id="main-content" tabIndex={-1} aria-labelledby="noise-heading" className="min-h-0 flex-1 overflow-auto bg-void-950 outline-none">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
        <header className="flex flex-col gap-1.5">
          <h1 id="noise-heading" className="text-lg font-semibold text-slate-100">
            Noise Lab
          </h1>
          <p className="text-sm text-slate-300">Explore how noise affects quantum circuits.</p>
          <p className="flex flex-wrap items-center gap-2 text-[11px] text-void-200" data-testid="noise-scope">
            <span className="rounded-full border border-amber-glow/50 bg-amber-dim/30 px-2 py-0.5 font-medium text-amber-glow">Simulated noise</span>
            <span>
              Qiskit Aer simulation only. Not real hardware. The ideal and the noisy runs are both made by the server; the browser only draws them.
            </span>
          </p>
        </header>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section aria-label="Circuit" className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]" role="group" aria-label="Example circuits">
              <span className="text-void-200">Start from:</span>
              {NOISE_EXAMPLES.map((example) => (
                <button
                  key={example.id}
                  type="button"
                  title={example.summary}
                  onClick={() => loadCircuit(example.circuit)}
                  className="min-h-7 rounded-md border border-void-400 px-2 py-0.5 font-medium text-slate-200 hover:border-void-300 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
                >
                  {example.title}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-void-200">This is the Lab’s circuit: an edit here is an edit there. Place gates, then measure the qubits you want to compare.</p>
            <div className="flex h-[28rem] min-h-0 flex-col overflow-hidden rounded-lg border border-void-500 bg-void-900" data-testid="noise-editor">
              <div className="relative min-h-0 flex-1">
                <CircuitCanvas />
              </div>
              <GatePalette />
            </div>
          </section>

          <div className="flex min-w-0 flex-col gap-4">
            <NoiseControls onRun={() => void run(circuit)} circuitHint={circuitHint(circuit, catalog?.limits.maxQubits ?? null)} />
            <section aria-label="Noise results" className="min-w-0">
              <h2 className="mb-2 text-xs font-semibold tracking-wider text-slate-300 uppercase">Results</h2>
              <NoiseResults circuit={circuit} />
            </section>
          </div>
        </div>

        <section aria-label="What should I expect?" className="rounded-lg border border-void-500 bg-void-900/60 p-3" data-testid="noise-expect">
          <details open>
            <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow">
              <h2 className="inline text-sm font-semibold text-slate-100">What should I expect?</h2>
            </summary>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              {info && info.name !== 'none' && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-slate-200">With {info.label.toLowerCase()}</h3>
                  <ul className="list-disc space-y-1 pl-4 text-[12px] leading-snug text-slate-300" data-testid="expect-model">
                    {info.expect.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {info && info.name === 'none' && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-slate-200">With no noise model</h3>
                  <ul className="list-disc space-y-1 pl-4 text-[12px] leading-snug text-slate-300" data-testid="expect-model">
                    {info.expect.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <h3 className="mb-1 text-xs font-semibold text-slate-200">In every case</h3>
                <ul className="list-disc space-y-1 pl-4 text-[12px] leading-snug text-slate-300" data-testid="expect-general">
                  {GENERAL_NOTES.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
        </section>
      </div>
    </main>
  )
}
