/**
 * One Bloch sphere PER QUBIT for a multi-qubit trace step — drawn from what the backend computed for each qubit.
 *
 * TRUST RULE (absolute): this component renders the per-qubit values the backend returned and nothing else. It is handed
 * `TraceQubitState[]` — never an amplitude, a statevector, a gate or a circuit — so there is nothing here from which a
 * coordinate, a length, a purity or an entanglement verdict could be computed, and none is. Every number goes through
 * `VerifiedValueInline` with its step's provenance, formatted by `traceFormat.formatComponent` (a string). The drawing
 * is the same fixed linear projection the single-qubit sphere uses (`blochProjection.ts`).
 *
 * Why a sphere per qubit and not one for the register: an entangled register has no single Bloch vector, but each
 * qubit has its OWN reduced state. A qubit whose vector is (nearly) zero-length is maximally mixed, which for a pure
 * register means it is entangled with the rest; one of (nearly) unit length is in a pure state of its own. The
 * backend says which (`entangledWithRest`), and this component shows that as words, never by looking at the length.
 *
 * `status: 'UNUSABLE'` is shown as exactly that, with the backend's reason, and no sphere. An empty list (an older
 * backend that sends no per-qubit states) is shown as "not provided", never as a row of zero vectors.
 */
import { useId } from 'react'
import type { TraceQubitState } from '@/api'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { toQuantumValue } from '@/provenance/QuantumValue'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { SphereSvg } from './BlochSphere'
import { isDrawable } from './blochProjection'
import { describeEntanglement, qubitLabel } from './reducedFormat'
import { displayStepNumber, formatComponent } from './traceFormat'

export interface QubitSpheresProps {
  /** The backend's per-qubit states for the selected step, `q[0]` first. */
  qubitStates: TraceQubitState[]
  /** Only selects which "not provided" wording to show when `qubitStates` is empty. */
  numQubits: number
  /** The level of this section's heading, so it nests under whatever heading the page has above it (default 4). */
  headingLevel?: 3 | 4
  /** Which state this is ("Final state of this run", "Step 2 of 3 …"): part of the section's name, so two views on one page are distinguishable landmarks. */
  labelContext?: string
}

export function QubitSpheres({ qubitStates, numQubits, headingLevel = 4, labelContext }: QubitSpheresProps) {
  const headingId = `qubit-spheres-heading-${useId()}` // unique: the Lab can show this for a run and for a trace step at once
  const Heading = headingLevel === 3 ? 'h3' : 'h4'
  return (
    <section
      aria-labelledby={labelContext ? undefined : headingId}
      aria-label={labelContext ? `Per-qubit Bloch spheres, ${labelContext}` : undefined}
      data-testid="qubit-spheres-section"
      className="flex flex-col gap-2.5 rounded-lg border border-void-500 bg-void-950/60 p-3"
    >
      <Heading id={headingId} className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
        Per-qubit Bloch spheres
      </Heading>
      {qubitStates.length === 0 ? (
        <NotProvided numQubits={numQubits} />
      ) : (
        <>
          <p className="text-[11px] leading-snug text-void-200">
            A register has no single Bloch vector, but every qubit has its own. Each sphere is one qubit’s own state, computed
            by the backend from this step’s statevector. An arrow of length 1 is a qubit in a pure state of its own; an
            arrow of length 0 is a qubit entangled with the rest of the register.
          </p>
          {/* as many columns as fit at 10.5rem each: the Lab's results panel is narrow even on a wide screen, so this is by the panel's
              own width, not the viewport's. Each card lays itself out by ITS width (a container query): a wide card puts the sphere
              beside its readout, a narrow one stacks them, so two cards fit side by side on a phone without clipping. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2" data-testid="qubit-card-grid">
            {qubitStates.map((state) => (
              <QubitCard key={state.qubit} state={state} />
            ))}
          </div>
          <p className="text-[11px] leading-snug text-void-200">
            Backend-derived state data. It describes the state at this step — it is not a statement about whether your
            circuit is correct.
          </p>
        </>
      )}
    </section>
  )
}

function NotProvided({ numQubits }: { numQubits: number }) {
  return (
    <div data-testid="qubit-spheres-unavailable" className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-slate-200">Per-qubit spheres unavailable for this step.</p>
      <p className="text-[11px] leading-snug text-void-200">
        The backend did not provide a state for each of the {numQubits} qubits, so none is shown. Qentor does not work
        them out itself, and never draws one arrow for the whole register.
      </p>
    </div>
  )
}

function QubitCard({ state }: { state: TraceQubitState }) {
  const name = qubitLabel(state.qubit)
  const common = '@container flex flex-col gap-1.5 rounded-md border border-void-500 bg-void-900/60 p-2'

  if (state.status !== 'OK' || !state.bloch || !state.blochLength || !state.purity) {
    return (
      <div data-testid={`qubit-card-${state.qubit}`} data-status="UNUSABLE" className={common}>
        <span className="font-mono-qasm text-xs text-slate-200">{name}</span>
        <p role="status" className="text-xs font-medium text-amber-glow">
          Unavailable for this qubit.
        </p>
        <p className="text-[11px] leading-snug text-void-200">{state.reason ?? 'The backend gave no reason.'}</p>
        <Source state={state} />
      </div>
    )
  }

  const { bloch, blochLength, purity } = state
  const { x, y, z } = bloch.value
  const drawable = isDrawable(x, y, z)
  const readout = `x = ${formatComponent(x)}, y = ${formatComponent(y)}, z = ${formatComponent(z)}`
  const label = drawable
    ? `Bloch sphere of qubit ${state.qubit}. Backend-provided vector: ${readout}.`
    : `Bloch sphere of qubit ${state.qubit}. Backend-provided vector: ${readout}. Outside the unit sphere, so not drawn.`

  return (
    <div data-testid={`qubit-card-${state.qubit}`} data-status="OK" className={common}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono-qasm text-xs font-semibold text-slate-100">{name}</span>
        <ProvenanceBadge provenance={bloch.provenance} />
      </div>

      <div className="flex flex-col items-center gap-2 @[15rem]:flex-row @[15rem]:items-start" data-testid={`qubit-compact-${state.qubit}`}>
        {/* a small sphere (about 6rem): the arrow and its colour carry the state, the numbers beside it carry the values */}
        <div className="w-24 shrink-0">
          <SphereSvg x={x} y={y} z={z} drawable={drawable} label={label} />
        </div>
        <dl
          aria-label={`Bloch vector coordinates of qubit ${state.qubit}`}
          data-testid={`qubit-readout-${state.qubit}`}
          className="grid w-full grid-cols-3 gap-1 font-mono-qasm text-xs @[15rem]:grid-cols-1"
        >
          {(['x', 'y', 'z'] as const).map((axis) => (
            <div key={axis} className="flex items-baseline justify-between gap-1 rounded border border-void-500 bg-void-900 px-1.5 py-0.5 @[15rem]:justify-start">
              <dt className="text-[10px] text-void-200">{axis} =</dt>
              <dd className="text-xs text-slate-100" title={`exact value from the backend: ${bloch.value[axis]}`}>
                <VerifiedValueInline quantum={toQuantumValue(bloch.value[axis], bloch.provenance)} render={formatComponent} />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {!drawable && (
        <p role="alert" className="rounded-md border border-amber-glow/40 bg-amber-dim/30 p-2 text-xs text-amber-glow">
          The backend returned a vector outside the unit sphere. It is shown as received and not drawn.
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono-qasm text-[11px] text-void-200">
        <dt>length</dt>
        <dd className="text-slate-200" data-testid={`qubit-length-${state.qubit}`} title={`exact value from the backend: ${blochLength.value}`}>
          <VerifiedValueInline quantum={blochLength} render={formatComponent} />
        </dd>
        <dt>purity</dt>
        <dd className="text-slate-200" data-testid={`qubit-purity-${state.qubit}`} title={`exact value from the backend: ${purity.value}`}>
          <VerifiedValueInline quantum={purity} render={formatComponent} />
        </dd>
        <dt>entanglement</dt>
        <dd className="text-slate-200" data-testid={`qubit-entanglement-${state.qubit}`}>
          {describeEntanglement(state.entangledWithRest)}
        </dd>
      </dl>

      <Source state={state} />
    </div>
  )
}

function Source({ state }: { state: TraceQubitState }) {
  const { derivedFrom } = state
  return (
    <p className="truncate font-mono-qasm text-[10px] text-void-200" data-testid={`qubit-source-${state.qubit}`} title={`${derivedFrom.resultId ?? ''} · ${derivedFrom.circuitHash} · ${state.method}`}>
      from trace step {displayStepNumber(derivedFrom.stepIndex)} · {derivedFrom.resultId ?? '—'}
    </p>
  )
}
