/**
 * The Noise Lab's controls: which noise model, how strong, how many shots, an optional seed, and Run.
 *
 * The models, their ranges and their words come from the server's catalog (`GET /api/noise/models`); nothing here keeps a second copy. The
 * checks below are only so a learner is told about a value the server would refuse before sending it; the server validates every value again and
 * is the authority. Everything is a native form control (select, range, number) with a visible label, so it works from the keyboard and reads
 * its current value aloud.
 */
import { useEffect, useId, useState } from 'react'
import type { NoiseModelName } from '@/api'
import { modelInfo, useNoiseStore } from './store'
import { seedProblem, shotsProblem, strengthProblem } from './noiseValidation'
import { NoiseWhere } from './NoiseWhere'

const FIELD = 'w-full rounded border border-void-400 bg-void-800 px-2 py-1 font-mono-qasm text-sm text-slate-200 focus:border-cyan-glow focus:outline-none aria-[invalid=true]:border-danger-glow'
const LABEL = 'text-xs font-medium text-slate-300'

/** A number field that lets a learner type freely and only reports a number once the text is one. */
function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  onNumber,
  invalid,
  describedBy,
  disabled,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number | 'any'
  onNumber: (n: number) => void
  invalid: boolean
  describedBy?: string
  disabled?: boolean
}) {
  // What the learner is typing, kept only while it still reads as the stored number (so "0." or "" can be typed on the way to a value).
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft !== null && (draft.trim() === '' ? Number.isNaN(value) : Number(draft) === value) ? draft : String(value)
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={text}
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      onChange={(e) => {
        setDraft(e.target.value)
        onNumber(e.target.value.trim() === '' ? Number.NaN : Number(e.target.value))
      }}
      onBlur={() => setDraft(null)}
      className={FIELD}
    />
  )
}

export function NoiseControls({ onRun, circuitHint }: { onRun: () => void; circuitHint: string | null }) {
  const uid = useId()
  const catalog = useNoiseStore((s) => s.catalog)
  const catalogError = useNoiseStore((s) => s.catalogError)
  const isLoadingCatalog = useNoiseStore((s) => s.isLoadingCatalog)
  const loadCatalog = useNoiseStore((s) => s.loadCatalog)
  const model = useNoiseStore((s) => s.model)
  const strength = useNoiseStore((s) => s.strength)
  const shots = useNoiseStore((s) => s.shots)
  const seedText = useNoiseStore((s) => s.seedText)
  const isRunning = useNoiseStore((s) => s.isRunning)
  const setModel = useNoiseStore((s) => s.setModel)
  const setStrength = useNoiseStore((s) => s.setStrength)
  const setShots = useNoiseStore((s) => s.setShots)
  const setSeedText = useNoiseStore((s) => s.setSeedText)

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  if (!catalog) {
    return (
      <section aria-label="Noise settings" className="flex flex-col gap-2 text-sm">
        {isLoadingCatalog && (
          <p role="status" className="text-slate-400">
            Loading the noise models from the server…
          </p>
        )}
        {catalogError && (
          <div role="alert" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3 text-xs text-danger-glow">
            <p className="font-semibold">The noise models could not be loaded.</p>
            <p className="mt-1 font-mono-qasm break-words text-danger-glow/80">{catalogError}</p>
            <p className="mt-2 text-slate-400">Nothing was substituted: without the server there are no noise models to choose from.</p>
            <button type="button" onClick={() => void loadCatalog()} className="mt-2 rounded-md border border-danger-glow/50 px-2.5 py-1 text-xs font-medium text-danger-glow hover:bg-danger-dim/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow">
              Try again
            </button>
          </div>
        )}
      </section>
    )
  }

  const info = modelInfo(catalog, model)
  const noisy = model !== 'none'
  const sProblem = strengthProblem(info, strength)
  const hProblem = shotsProblem(catalog, shots)
  const dProblem = seedProblem(catalog, seedText)
  const blocked = Boolean(sProblem || hProblem || dProblem)
  const ids = { model: `${uid}-model`, strength: `${uid}-strength`, strengthNumber: `${uid}-strength-number`, shots: `${uid}-shots`, seed: `${uid}-seed` }

  return (
    <section aria-label="Noise settings" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.model} className={LABEL}>
          Noise model
        </label>
        <select
          id={ids.model}
          value={model}
          onChange={(e) => setModel(e.target.value as NoiseModelName)}
          aria-describedby={`${ids.model}-help`}
          className={FIELD}
        >
          {catalog.models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.label}
            </option>
          ))}
        </select>
        <p id={`${ids.model}-help`} className="text-[11px] leading-snug text-void-200">
          {info?.summary}
        </p>
      </div>

      <NoiseWhere appliesTo={info?.appliesTo ?? 'none'} />

      <fieldset className="flex flex-col gap-1" disabled={!noisy}>
        <legend className={LABEL}>
          Noise strength{noisy && info ? ` (${info.parameter})` : ''}
        </legend>
        {noisy && info ? (
          <>
            <div className="flex items-center gap-2">
              <input
                id={ids.strength}
                type="range"
                aria-label="Noise strength, slider"
                aria-valuetext={`${strength}`}
                min={info.minStrength}
                max={info.maxStrength}
                step={info.step}
                value={Number.isFinite(strength) ? Math.min(Math.max(strength, info.minStrength), info.maxStrength) : info.defaultStrength}
                onChange={(e) => setStrength(Number(e.target.value))}
                aria-describedby={`${ids.strength}-help`}
                className="min-w-0 flex-1 accent-cyan-glow"
              />
              <div className="w-24 shrink-0">
                <NumberField
                  id={ids.strengthNumber}
                  label="Noise strength, value"
                  value={strength}
                  min={info.minStrength}
                  max={info.maxStrength}
                  step="any"
                  onNumber={setStrength}
                  invalid={Boolean(sProblem)}
                  describedBy={`${ids.strength}-help`}
                />
              </div>
            </div>
            <p id={`${ids.strength}-help`} className="text-[11px] leading-snug text-void-200">
              {info.parameterDescription}. Range {info.minStrength} to {info.maxStrength}.
            </p>
            {sProblem && (
              <p role="alert" className="text-[11px] text-danger-glow">
                {sProblem}
              </p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-void-200">Choose a noise model to set its strength.</p>
        )}
      </fieldset>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.shots} className={LABEL}>
            Shots
          </label>
          <NumberField id={ids.shots} label="Shots" value={shots} min={1} max={catalog.limits.maxShots} step={1} onNumber={setShots} invalid={Boolean(hProblem)} describedBy={`${ids.shots}-help`} />
          <p id={`${ids.shots}-help`} className={`text-[11px] leading-snug ${hProblem ? 'text-danger-glow' : 'text-void-200'}`} role={hProblem ? 'alert' : undefined}>
            {hProblem ?? `1 to ${catalog.limits.maxShots}`}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.seed} className={LABEL}>
            Seed (optional)
          </label>
          <input
            id={ids.seed}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            aria-invalid={Boolean(dProblem)}
            aria-describedby={`${ids.seed}-help`}
            placeholder="random"
            className={FIELD}
          />
          <p id={`${ids.seed}-help`} className={`text-[11px] leading-snug ${dProblem ? 'text-danger-glow' : 'text-void-200'}`} role={dProblem ? 'alert' : undefined}>
            {dProblem ?? 'Same seed, same sample.'}
          </p>
        </div>
      </div>

      {circuitHint && (
        <p role="note" className="rounded border border-amber-glow/40 bg-amber-dim/20 p-2 text-[11px] leading-snug text-amber-glow" data-testid="noise-circuit-hint">
          {circuitHint}
        </p>
      )}

      <button
        type="button"
        onClick={onRun}
        disabled={isRunning || blocked}
        aria-busy={isRunning}
        className="min-h-9 rounded-lg bg-slate-100 px-3.5 py-1.5 text-[13px] font-semibold text-void-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isRunning ? 'Running…' : noisy ? 'Run ideal vs noisy' : 'Run ideal simulation'}
      </button>
      <p className="text-[11px] leading-snug text-void-200">
        {noisy
          ? 'The server runs the circuit twice on Qiskit Aer: once ideally and once with this noise. Both are simulations.'
          : 'The server runs the circuit once, ideally, on Qiskit Aer. Choose a noise model to add a noisy run beside it.'}
      </p>
    </section>
  )
}
