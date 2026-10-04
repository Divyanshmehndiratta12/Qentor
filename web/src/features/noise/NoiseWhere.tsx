/**
 * Where the chosen noise model acts, as a conceptual picture: gates, then measurement, then the counts. It is a drawing of how the SIMULATION is
 * set up (gate noise is applied right after each gate, readout error when a qubit is measured), taken from the server's description of the model.
 * It is not a picture of any device and says nothing about calibration. The picture states no quantum number.
 */
import type { NoiseAppliesTo } from '@/api'

const STAGES: ReadonlyArray<{ id: Exclude<NoiseAppliesTo, 'none'> | 'counts'; label: string; note: string }> = [
  { id: 'gates', label: 'Gates', note: 'noise acts right after each gate' },
  { id: 'measurement', label: 'Measurement', note: 'noise acts on what is read out' },
  { id: 'counts', label: 'Counts', note: 'what the simulator returns' },
]

export function NoiseWhere({ appliesTo }: { appliesTo: NoiseAppliesTo }) {
  return (
    <figure aria-label="Where the chosen noise model acts in the simulation" data-testid="noise-where" data-applies-to={appliesTo} className="flex flex-col gap-1.5">
      <ol className="flex flex-wrap items-stretch gap-1.5 text-[11px]">
        {STAGES.map((stage, i) => {
          const active = stage.id === appliesTo
          return (
            <li key={stage.id} className="flex items-center gap-1.5" data-stage={stage.id} data-active={active}>
              {i > 0 && (
                <span aria-hidden="true" className="text-void-200">
                  →
                </span>
              )}
              <span
                className={`flex flex-col rounded-md border px-2 py-1 ${
                  active ? 'border-amber-glow/60 bg-amber-dim/30 text-amber-glow' : 'border-void-500 bg-void-900 text-slate-300'
                }`}
              >
                <span className="font-semibold">{stage.label}</span>
                <span className="text-[10px] opacity-80">{active ? `${stage.note}: noise here` : stage.note}</span>
              </span>
            </li>
          )
        })}
      </ol>
      <figcaption className="text-[11px] leading-snug text-void-200">
        {appliesTo === 'none'
          ? 'No noise model is chosen, so only the ideal simulation runs.'
          : 'A conceptual picture of how the simulation is set up. It is not a model of any real device.'}
      </figcaption>
    </figure>
  )
}
