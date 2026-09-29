/**
 * Bloch sphere for ONE backend-produced trace step.
 *
 * TRUST RULE (absolute): this component draws the (x, y, z) the backend
 * returned and nothing else. It is handed a `TraceBlochVector` (or `null`) —
 * it never receives amplitudes, a statevector, a gate or a circuit, so there is
 * nothing here from which a coordinate could be computed, and none is. It does
 * not calculate probabilities, angles, magnitudes or any other quantum number;
 * numbers are only FORMATTED for reading (`traceFormat.formatComponent`,
 * string-only), and the exact value is kept in each readout's `title`.
 * `blochProjection.ts` documents the one thing that IS computed: a fixed
 * linear screen projection of the supplied coordinates — presentation, not
 * physics. Coordinates are never clamped or normalised; a value outside the
 * unit ball is shown as received and not drawn.
 *
 * `null` means "no Bloch vector for this step" (the backend gives none for a
 * multi-qubit register — an entangled state has no single-qubit vector). It
 * is rendered as an explanation, never as an empty sphere or a zero vector.
 *
 * The vector's provenance is the step's provenance (it is derived from that
 * step's statevector). It is labelled as backend-derived state data, and
 * explicitly NOT as a statement about circuit correctness.
 *
 * Accessibility: the SVG is an `img` with a text alternative stating the
 * coordinates; the same numbers are in a visible readout; the vector is
 * distinguished by an arrowhead, an endpoint marker and labels (never colour
 * alone), and a vector pointing into the far hemisphere is dashed.
 */
import { useId } from 'react'
import type { TraceBlochVector } from '@/api'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { toQuantumValue } from '@/provenance/QuantumValue'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import {
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
  CENTER,
  RADIUS,
  VIEWBOX,
  facing,
  greatCircleTransform,
  isDrawable,
  projectBloch,
} from './blochProjection'
import { displayStepNumber, formatComponent } from './traceFormat'

export interface BlochSphereProps {
  /** The backend's Bloch vector for the selected step, or null. */
  bloch: TraceBlochVector | null
  /** Only selects which "unavailable" wording to show when `bloch` is null. */
  numQubits: number
}

/** The six standard poles: fixed labels on the sphere's axes (geometry of the
 * picture, not a lookup from any gate or state). */
const POLES = [
  { ket: '|0⟩', name: '+z', at: [0, 0, 1] },
  { ket: '|1⟩', name: '−z', at: [0, 0, -1] },
  { ket: '|+⟩', name: '+x', at: [1, 0, 0] },
  { ket: '|−⟩', name: '−x', at: [-1, 0, 0] },
  { ket: '|+i⟩', name: '+y', at: [0, 1, 0] },
  { ket: '|−i⟩', name: '−y', at: [0, -1, 0] },
] as const

const AXES = [
  { name: 'x', tip: [1, 0, 0] },
  { name: 'y', tip: [0, 1, 0] },
  { name: 'z', tip: [0, 0, 1] },
] as const

export function BlochSphere({ bloch, numQubits }: BlochSphereProps) {
  return (
    <section
      aria-labelledby="bloch-heading"
      data-testid="bloch-section"
      className="flex flex-col gap-2.5 rounded-lg border border-void-500 bg-void-950/60 p-3"
    >
      <h4 id="bloch-heading" className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
        Bloch sphere
      </h4>
      {bloch ? <SphereAndReadout bloch={bloch} /> : <Unavailable numQubits={numQubits} />}
    </section>
  )
}

function Unavailable({ numQubits }: { numQubits: number }) {
  const multiQubit = numQubits > 1
  return (
    <div data-testid="bloch-unavailable" className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-slate-200">Bloch sphere unavailable for this state.</p>
      {multiQubit ? (
        <>
          <p className="text-xs text-slate-300">
            Single-qubit Bloch vector unavailable for this multi-qubit state.
          </p>
          <p className="text-[11px] leading-snug text-void-200">
            A Bloch sphere shows one qubit. Qentor only provides one for single-qubit trace states and never draws
            one for a register of several qubits: an entangled state such as a Bell state has no single-qubit
            vector, and one arrow for the whole register would hide the correlations. The full state is in the
            table above.
          </p>
        </>
      ) : (
        <p className="text-[11px] leading-snug text-void-200">
          The backend did not provide a Bloch vector for this step, so none is shown. Qentor does not work one out
          itself.
        </p>
      )}
    </div>
  )
}

function SphereAndReadout({ bloch }: { bloch: TraceBlochVector }) {
  const { coordinates, derivedFrom, method } = bloch
  const { x, y, z } = coordinates.value
  const { provenance } = coordinates
  const drawable = isDrawable(x, y, z)

  const readout = `x = ${formatComponent(x)}, y = ${formatComponent(y)}, z = ${formatComponent(z)}`
  const label = drawable
    ? `Bloch sphere. Backend-provided vector: ${readout}.`
    : `Bloch sphere. Backend-provided vector: ${readout}. Outside the unit sphere, so not drawn.`

  return (
    <div className="flex flex-col gap-3">
      <figure className="m-0 flex flex-col items-center gap-1.5">
        <SphereSvg x={x} y={y} z={z} drawable={drawable} label={label} />
        <figcaption className="text-center text-[11px] text-void-200">
          Bloch vector for this backend-produced state.
        </figcaption>
      </figure>

      {!drawable && (
        <p role="alert" className="rounded-md border border-amber-glow/40 bg-amber-dim/30 p-2 text-xs text-amber-glow">
          The backend returned a Bloch vector outside the unit sphere. It is shown as received and not drawn — Qentor
          does not correct it.
        </p>
      )}

      <dl
        aria-label="Bloch vector coordinates"
        data-testid="bloch-readout"
        className="grid grid-cols-3 gap-2 font-mono-qasm text-xs"
      >
        {(['x', 'y', 'z'] as const).map((axis) => {
          const value = coordinates.value[axis]
          return (
            <div key={axis} className="rounded-md border border-void-500 bg-void-900 px-2 py-1.5">
              <dt className="text-[11px] text-void-200">{axis} =</dt>
              <dd className="mt-0.5 text-sm text-slate-100" title={`exact value from the backend: ${value}`}>
                <VerifiedValueInline quantum={toQuantumValue(value, provenance)} render={formatComponent} />
              </dd>
            </div>
          )
        })}
      </dl>

      <div className="flex flex-col gap-2 rounded-md border border-void-500 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Derived from</span>
          <ProvenanceBadge provenance={provenance} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono-qasm text-[11px] text-void-200">
          <dt>source step</dt>
          <dd className="text-slate-300">trace step {displayStepNumber(derivedFrom.stepIndex)}</dd>
          <dt>source result</dt>
          <dd className="truncate text-slate-300" title={derivedFrom.resultId ?? undefined}>
            {derivedFrom.resultId ?? '—'}
          </dd>
          <dt>source execution</dt>
          <dd className="truncate text-slate-300" title={derivedFrom.executionId}>
            {derivedFrom.executionId}
          </dd>
          <dt>source circuit</dt>
          <dd className="truncate text-slate-300" title={derivedFrom.circuitHash}>
            {derivedFrom.circuitHash}
          </dd>
          <dt>source backend</dt>
          <dd className="text-slate-300">
            {derivedFrom.backend} {derivedFrom.backendVersion}
          </dd>
          <dt>method</dt>
          <dd className="text-slate-300">{method}</dd>
        </dl>
        <p className="text-[11px] leading-snug text-void-200">
          Backend-derived state data: the backend computed this vector from this step’s statevector. It describes the
          state — it is not a statement about whether your circuit is correct.
        </p>
      </div>
    </div>
  )
}

function SphereSvg({
  x,
  y,
  z,
  drawable,
  label,
}: {
  x: number
  y: number
  z: number
  drawable: boolean
  label: string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const gradientId = `bloch-shade-${uid}`
  const arrowId = `bloch-arrow-${uid}`

  const tip = projectBloch(x, y, z)
  const nearSide = facing(x, y, z) >= 0

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="bloch-svg"
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className="h-auto w-full max-w-[260px]"
    >
      <title>{label}</title>
      <defs>
        <radialGradient id={gradientId} cx="38%" cy="32%" r="75%">
          <stop offset="0%" style={{ stopColor: 'var(--color-void-600)' }} stopOpacity="0.9" />
          <stop offset="100%" style={{ stopColor: 'var(--color-void-900)' }} stopOpacity="0.95" />
        </radialGradient>
        <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" className="fill-cyan-glow" />
        </marker>
      </defs>

      {/* Sphere body and its outline. */}
      <circle cx={CENTER} cy={CENTER} r={RADIUS} fill={`url(#${gradientId})`} className="stroke-void-300" strokeWidth={1.2} />

      {/* Great circles: equator (xy) and the two meridians (xz, yz), as affine images of one unit circle. */}
      <g fill="none" className="stroke-void-400" strokeWidth={1} vectorEffect="non-scaling-stroke">
        <circle r={1} transform={greatCircleTransform(AXIS_X, AXIS_Y)} vectorEffect="non-scaling-stroke" />
        <circle r={1} transform={greatCircleTransform(AXIS_X, AXIS_Z)} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        <circle r={1} transform={greatCircleTransform(AXIS_Y, AXIS_Z)} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      </g>

      {/* Axes through the centre, a little beyond the sphere. */}
      <g className="stroke-slate-500" strokeWidth={1}>
        {AXES.map(({ name, tip: end }) => {
          const a = projectBloch(-end[0], -end[1], -end[2], 1.12)
          const b = projectBloch(end[0], end[1], end[2], 1.12)
          return <line key={name} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} />
        })}
      </g>

      {/* Pole labels: the standard state at each end of each axis. Sized to be
          readable (the ket 11px, its axis name 9px, both in light greys) and drawn
          with a dark halo (`paint-order: stroke`) so the vector's arrowhead or an
          axis line passing under a label cannot make it hard to read. Positions
          are unchanged: any farther out and the top/right labels leave the viewBox. */}
      <g
        className="fill-slate-300 stroke-void-950 font-mono-qasm"
        fontSize={11}
        textAnchor="middle"
        strokeWidth={3}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        {POLES.map(({ ket, name, at }) => {
          const p = projectBloch(at[0], at[1], at[2], 1.34)
          return (
            <text key={name} x={p.sx} y={p.sy} data-testid={`bloch-pole-${name}`}>
              <tspan>{ket}</tspan>
              <tspan x={p.sx} dy={10} fontSize={9} className="fill-slate-400">
                {name}
              </tspan>
            </text>
          )
        })}
      </g>

      {/* The backend's vector: centre -> supplied (x, y, z), with an arrowhead and an endpoint marker.
          Dashed when it points into the far hemisphere. Not drawn at all if the values are out of range. */}
      {drawable && (
        <g data-testid="bloch-vector" data-facing={nearSide ? 'near' : 'far'}>
          <line
            x1={CENTER}
            y1={CENTER}
            x2={tip.sx}
            y2={tip.sy}
            className="stroke-cyan-glow"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeDasharray={nearSide ? undefined : '5 3'}
            markerEnd={`url(#${arrowId})`}
          />
          <circle
            cx={tip.sx}
            cy={tip.sy}
            r={4.5}
            data-testid="bloch-endpoint"
            className="fill-cyan-glow stroke-void-950"
            strokeWidth={1.5}
          />
        </g>
      )}
    </svg>
  )
}
