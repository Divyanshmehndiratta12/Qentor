/**
 * The qubit state view: one interactive 3D Bloch sphere per qubit, drawn from what the backend computed for each qubit.
 *
 * TRUST RULE (absolute): this view renders the per-qubit values the backend returned and nothing else. It is handed
 * `TraceQubitState[]` (or one single-qubit `TraceBlochVector`) — never an amplitude, a statevector, a gate or a circuit — so there
 * is nothing here from which a coordinate, a length, a purity or an entanglement verdict could be computed, and none is. Every
 * number goes through `VerifiedValueInline` with its own provenance, formatted by `traceFormat.formatComponent` (a string). A
 * general register has no single Bloch vector, so a register of several qubits gets one sphere PER qubit (its reduced state), and
 * an entangled qubit's sphere shows the backend's reduced vector, never an invented global one.
 *
 * What is shown, and for which state:
 *  - one qubit  -> "Interactive Bloch sphere"; several qubits -> "Qubit state view", one sphere per usable qubit;
 *  - a qubit the backend could not give a usable state -> an explicit "Bloch vector unavailable" card with the backend's reason;
 *  - no per-qubit state at all (a shots run, an older backend) -> an honest "unavailable" card that says why.
 *
 * Every sphere has a text alternative: the same numbers, as page text beside it (X, Y, Z, length, purity, entanglement),
 * and an accessible name. The 3D drawing is a convenience on top of those numbers, never the only place they appear.
 *
 * The 3D code (three.js) is a separate chunk, loaded when the first view mounts. Where WebGL is unavailable, or the chunk
 * cannot load, the flat projection (`QubitSpheres` / `BlochSphere`) is shown instead, with the same numbers, and the view says so.
 */
import { Component, Suspense, lazy, useId, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import type { TraceBlochVector, TraceQubitState } from '@/api'
import { usePrefersReducedMotion } from '@/features/guide/usePrefersReducedMotion'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { toQuantumValue } from '@/provenance/QuantumValue'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { BlochSphere } from '@/features/build/BlochSphere'
import { QubitSpheres } from '@/features/build/QubitSpheres'
import { isDrawable } from '@/features/build/blochProjection'
import { describeEntanglement, qubitLabel } from '@/features/build/reducedFormat'
import { formatComponent } from '@/features/build/traceFormat'
import type { SphereController, SphereTile } from './types'
import { blochVectorAsQubitState } from './vectorAsQubit'
import { webglSupported } from './webgl'

const SphereGrid = lazy(() => import('./SphereGrid'))

export interface QubitStateViewProps {
  /** The backend's per-qubit states, `q[0]` first. Empty when the backend gave none. */
  qubitStates: TraceQubitState[]
  /** One qubit's Bloch vector from a path that has no per-qubit states (the variational lab). Used only when `qubitStates` is empty. */
  blochVector?: TraceBlochVector | null
  numQubits: number
  /** Says which state this is, e.g. "Final state of this run" or "After step 3 of 5". */
  context?: ReactNode
  /** Why there is no per-qubit state, when there is none (e.g. a shots run). Shown instead of the generic wording. */
  unavailableReason?: ReactNode
  /** An extra caution to show with the spheres (e.g. "this is one collapsed post-measurement state"). */
  caution?: ReactNode
  testId?: string
  /** The level of the view's heading, so it nests under the page's heading above it (default 4). */
  headingLevel?: 3 | 4
}

export function QubitStateView({ qubitStates, blochVector = null, numQubits, context, unavailableReason, caution, testId, headingLevel = 4 }: QubitStateViewProps) {
  const uid = useId()
  const headingId = `qsv-heading-${uid}`
  const contextId = `qsv-context-${uid}`
  const contextText = typeof context === 'string' ? context : undefined
  const helpId = `qsv-help-${uid}`
  const reducedMotion = usePrefersReducedMotion()
  const [autoRotate, setAutoRotate] = useState(false) // manual rotation is the default; nothing spins until asked
  const [threeFailed, setThreeFailed] = useState(false)
  const controllers = useRef<Map<string, SphereController>>(new Map())

  const states: TraceQubitState[] = qubitStates.length > 0 ? qubitStates : blochVector && numQubits === 1 ? [blochVectorAsQubitState(blochVector)] : []
  const single = numQubits === 1
  const heading = single ? 'Interactive Bloch sphere' : 'Qubit state view'
  const Heading = headingLevel === 3 ? 'h3' : 'h4'
  const has3D = webglSupported() && !threeFailed
  const usable = states.filter((s) => s.status === 'OK' && s.bloch)

  const fallback = (
    <FlatView qubitStates={qubitStates} blochVector={blochVector} numQubits={numQubits} headingLevel={headingLevel} labelContext={contextText} />
  )

  // The backend gave no state at all. With a reason to give (a shots run), say that; otherwise the flat component's own honest
  // "unavailable" wording applies (it knows the single-qubit and register cases).
  if (states.length === 0 && !unavailableReason) {
    return (
      <div data-testid={testId ?? 'qubit-state-view'} data-mode="unavailable">
        {fallback}
      </div>
    )
  }

  // No WebGL (or it failed): the flat projection IS the view, with its own headings, plus a plain statement of why it is flat.
  if (states.length > 0 && !has3D) {
    return (
      <div data-testid={testId ?? 'qubit-state-view'} data-mode="flat" className="flex flex-col gap-2">
        {context && (
          <p className="font-mono-qasm text-[11px] text-slate-300" data-testid="qubit-state-context">
            {context}
          </p>
        )}
        <p role="note" data-testid="flat-note" className="text-[11px] leading-snug text-void-200">
          {threeFailed
            ? 'The 3D view could not start in this browser, so the flat projection is shown. The numbers are the same.'
            : 'This browser cannot draw the 3D view (WebGL is not available), so the flat projection is shown. The numbers are the same.'}
        </p>
        {caution && (
          <p role="note" className="rounded border border-amber-glow/40 bg-amber-dim/20 p-2 text-[11px] leading-snug text-amber-glow">
            {caution}
          </p>
        )}
        {fallback}
      </div>
    )
  }

  const tiles: SphereTile[] = usable.map((state) => makeTile(state))

  return (
    <section
      aria-labelledby={context ? `${headingId} ${contextId}` : headingId} // the heading AND which state it is, so two views on one page have different names
      data-testid={testId ?? 'qubit-state-view'}
      data-mode={states.length === 0 ? 'unavailable' : has3D ? '3d' : 'flat'}
      className="flex flex-col gap-2.5 rounded-lg border border-void-500 bg-void-950/60 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Heading id={headingId} className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
          {heading}
        </Heading>
        {context && (
          <span id={contextId} className="font-mono-qasm text-[11px] text-slate-300" data-testid="qubit-state-context">
            {context}
          </span>
        )}
      </div>

      {states.length === 0 ? (
        <Unavailable numQubits={numQubits} reason={unavailableReason} />
      ) : (
        <>
          <p className="text-[11px] leading-snug text-void-200">
            {single
              ? 'The qubit’s state as a point on the Bloch sphere, drawn from the vector the backend computed.'
              : 'A register has no single Bloch vector, but every qubit has its own. Each sphere is one qubit’s own state, computed by the backend: a full-length arrow is a qubit in a pure state of its own, a zero-length one is a qubit entangled with the rest.'}
          </p>
          {caution && (
            <p role="note" className="rounded border border-amber-glow/40 bg-amber-dim/20 p-2 text-[11px] leading-snug text-amber-glow">
              {caution}
            </p>
          )}

          {has3D && usable.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="3D view controls">
              <button
                type="button"
                onClick={() => controllers.current.forEach((c) => c.reset())}
                className="rounded-md border border-void-400 px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-void-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
              >
                Reset view
              </button>
              <button
                type="button"
                aria-pressed={autoRotate && !reducedMotion}
                disabled={reducedMotion}
                title={reducedMotion ? 'Off because your device asks for reduced motion' : undefined}
                onClick={() => setAutoRotate((on) => !on)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-50 ${
                  autoRotate && !reducedMotion ? 'border-cyan-glow/60 bg-cyan-dim/30 text-cyan-glow' : 'border-void-400 text-slate-200 hover:border-void-300'
                }`}
              >
                Auto rotate
              </button>
              <p id={helpId} className="text-[11px] text-void-200">
                Drag to rotate, scroll or pinch to zoom. With a sphere focused: arrow keys rotate, + and − zoom, 0 resets.
              </p>
            </div>
          )}

          {usable.length > 0 ? (
            <ThreeBoundary fallback={fallback} onFailure={() => setThreeFailed(true)}>
              <Suspense fallback={fallback}>
                <SphereGrid tiles={tiles} helpId={helpId} autoRotate={autoRotate} reducedMotion={reducedMotion} controllers={controllers} />
              </Suspense>
            </ThreeBoundary>
          ) : (
            fallback
          )}

          {/* Qubits the backend could not give a state for: explicit cards that say so and why. */}
          {states.some((s) => s.status !== 'OK' || !s.bloch) && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2" data-testid="qubit3d-unavailable-grid">
              {states
                .filter((s) => s.status !== 'OK' || !s.bloch)
                .map((s) => (
                  <UnusableCard key={s.qubit} state={s} />
                ))}
            </div>
          )}

          <p className="text-[11px] leading-snug text-void-200">
            Backend-derived state data. It describes the state at this point — it is not a statement about whether your circuit is correct.
          </p>
        </>
      )}
    </section>
  )
}

function Unavailable({ numQubits, reason }: { numQubits: number; reason?: ReactNode }) {
  return (
    <div data-testid="qubit-state-unavailable" className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-slate-200">Bloch vector unavailable.</p>
      <p className="text-[11px] leading-snug text-void-200">
        {reason ??
          `The backend did not provide a state for ${numQubits === 1 ? 'this qubit' : `each of the ${numQubits} qubits`}, so no sphere is shown. Qentor does not work one out itself, and never draws one arrow for a whole register.`}
      </p>
    </div>
  )
}

/** The flat projection, with exactly the numbers the 3D cards list: the fallback while the 3D chunk loads, and where it cannot run. */
function FlatView({ qubitStates, blochVector, numQubits, headingLevel, labelContext }: { qubitStates: TraceQubitState[]; blochVector: TraceBlochVector | null; numQubits: number; headingLevel: 3 | 4; labelContext?: string }) {
  // One qubit: the single-qubit sphere (with its "derived from" card) when the backend gave a vector; otherwise the per-qubit cards.
  if (numQubits === 1 && blochVector) return <BlochSphere bloch={blochVector} numQubits={1} headingLevel={headingLevel} labelContext={labelContext} />
  if (numQubits === 1 && qubitStates.length === 0) return <BlochSphere bloch={null} numQubits={1} headingLevel={headingLevel} labelContext={labelContext} />
  return <QubitSpheres qubitStates={qubitStates} numQubits={numQubits} headingLevel={headingLevel} labelContext={labelContext} />
}

function makeTile(state: TraceQubitState): SphereTile {
  const bloch = state.bloch!
  const { x, y, z } = bloch.value
  const drawable = isDrawable(x, y, z)
  const name = qubitLabel(state.qubit)
  const readout = `x = ${formatComponent(x)}, y = ${formatComponent(y)}, z = ${formatComponent(z)}`
  const label = drawable
    ? `Interactive 3D Bloch sphere of qubit ${state.qubit}. Backend-provided vector: ${readout}. The same values are listed beside it.`
    : `Bloch sphere of qubit ${state.qubit}. Backend-provided vector: ${readout}. Outside the unit sphere, so not drawn.`
  return {
    id: `q${state.qubit}`,
    vector: { x, y, z },
    headScale: state.blochLength ? state.blochLength.value : null,
    drawable,
    label,
    renderCard: (sphere) => <QubitCard3D state={state} name={name} drawable={drawable} sphere={sphere} />,
  }
}

function QubitCard3D({ state, name, drawable, sphere }: { state: TraceQubitState; name: string; drawable: boolean; sphere: ReactNode }) {
  const bloch = state.bloch!
  const { blochLength, purity } = state
  return (
    <div
      data-testid={`qubit3d-card-${state.qubit}`}
      data-status="OK"
      className="@container flex flex-col gap-1.5 rounded-md border border-void-500 bg-void-900/60 p-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono-qasm text-xs font-semibold text-slate-100">{name}</span>
        <ProvenanceBadge provenance={bloch.provenance} />
      </div>

      {/* The sphere above its numbers; only a genuinely wide card (a wide page, not the Lab's narrow column) puts them side by side. */}
      <div className="flex flex-col gap-2 @[26rem]:flex-row @[26rem]:items-center">
        <div className="w-full @[26rem]:w-60 @[26rem]:shrink-0">{sphere}</div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {!drawable && (
            <p role="alert" className="rounded-md border border-amber-glow/40 bg-amber-dim/30 p-2 text-xs text-amber-glow">
              The backend returned a vector outside the unit sphere. It is shown as received and not drawn.
            </p>
          )}

          {/* The text alternative to the sphere: every value, as page text, with its provenance. */}
          <dl
            aria-label={`Bloch vector of qubit ${state.qubit}`}
            data-testid={`qubit3d-readout-${state.qubit}`}
            className="grid grid-cols-3 gap-1 font-mono-qasm text-xs"
          >
            {(['x', 'y', 'z'] as const).map((axis) => (
              <div key={axis} className="flex items-baseline justify-between gap-1 rounded border border-void-500 bg-void-900 px-1.5 py-0.5">
                <dt className="text-[10px] text-void-200">{axis.toUpperCase()}</dt>
                <dd className="text-xs text-slate-100" data-testid={`qubit3d-${axis}-${state.qubit}`} title={`exact value from the backend: ${bloch.value[axis]}`}>
                  <VerifiedValueInline quantum={toQuantumValue(bloch.value[axis], bloch.provenance)} render={formatComponent} />
                </dd>
              </div>
            ))}
          </dl>

          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono-qasm text-[11px] text-void-200">
            <dt>length</dt>
            <dd className="text-slate-200" data-testid={`qubit3d-length-${state.qubit}`}>
              {blochLength ? <VerifiedValueInline quantum={blochLength} render={formatComponent} /> : <span>not provided</span>}
            </dd>
            <dt>purity</dt>
            <dd className="text-slate-200" data-testid={`qubit3d-purity-${state.qubit}`}>
              {purity ? <VerifiedValueInline quantum={purity} render={formatComponent} /> : <span>not provided</span>}
            </dd>
            <dt>entanglement</dt>
            <dd className="text-slate-200" data-testid={`qubit3d-entanglement-${state.qubit}`}>
              {describeEntanglement(state.entangledWithRest)}
            </dd>
          </dl>

          <p
            className="truncate font-mono-qasm text-[10px] text-void-200"
            data-testid={`qubit3d-source-${state.qubit}`}
            title={`${state.derivedFrom.resultId ?? ''} · ${state.derivedFrom.circuitHash} · ${state.method}`}
          >
            from result {state.derivedFrom.resultId ?? '—'}
          </p>
        </div>
      </div>
    </div>
  )
}

function UnusableCard({ state }: { state: TraceQubitState }) {
  return (
    <div data-testid={`qubit3d-card-${state.qubit}`} data-status="UNUSABLE" className="flex flex-col gap-1.5 rounded-md border border-void-500 bg-void-900/60 p-2">
      <span className="font-mono-qasm text-xs text-slate-200">{qubitLabel(state.qubit)}</span>
      <p role="status" className="text-xs font-medium text-amber-glow">
        Bloch vector unavailable for this qubit.
      </p>
      <p className="text-[11px] leading-snug text-void-200">{state.reason ?? 'The backend gave no reason.'}</p>
    </div>
  )
}

/** Catches a 3D failure (no WebGL context, the chunk would not load) and shows the flat view instead of an empty hole. */
class ThreeBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onFailure() // the view above then switches to its flat layout and says why
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
