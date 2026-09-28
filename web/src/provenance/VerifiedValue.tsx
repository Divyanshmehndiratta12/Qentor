/**
 * The one component allowed to render a quantum number. Per
 * docs/VERIFICATION_ARCHITECTURE.md §5: "A frontend test fails if a component
 * renders a raw probability field outside it." Every chart, table cell or
 * inline stat that shows a probability, count, amplitude or fidelity must go
 * through this component (or `VerifiedValueInline` for compact contexts) so
 * the provenance badge and tooltip are structurally impossible to omit.
 */
import type { ReactNode } from 'react'
import type { QuantumValue } from './QuantumValue'
import { ProvenanceBadge } from './ProvenanceBadge'

export interface VerifiedValueProps<T> {
  quantum: QuantumValue<T>
  render: (value: T) => ReactNode
  className?: string
}

export function VerifiedValue<T>({ quantum, render, className = '' }: VerifiedValueProps<T>) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="font-mono-qasm tabular-nums">{render(quantum.value)}</span>
      <ProvenanceBadge provenance={quantum.provenance} />
    </span>
  )
}

/** Compact variant for dense tables — badge collapses to a dot with a tooltip. */
export function VerifiedValueInline<T>({ quantum, render }: VerifiedValueProps<T>) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono-qasm tabular-nums"
      title={`${quantum.provenance.provenanceClass} · ${quantum.provenance.backend} · ${quantum.provenance.resultId}`}
    >
      {render(quantum.value)}
      <span
        className="h-1.5 w-1.5 rounded-full bg-cyan-glow/70"
        aria-hidden="true"
      />
    </span>
  )
}
