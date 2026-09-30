/**
 * The badge shown on every result per docs/VERIFICATION_ARCHITECTURE.md §3
 * ("UI classes, shown as a badge on every result"). FIXTURE is not one of the
 * backend's three classes — it exists only for the mock adapter and renders
 * with a hazard-stripe treatment so it can never be confused with a real
 * SIMULATION/REAL_HARDWARE/RECORDED_HARDWARE badge.
 */
import type { Provenance } from './QuantumValue'
import { FIXTURE } from './QuantumValue'
import { executionStatusExplanation, executionStatusLabel } from './executionStatus'

const CLASS_LABEL: Record<Provenance['provenanceClass'], string> = {
  SIMULATION: 'Simulated',
  REAL_HARDWARE: 'Real hardware',
  RECORDED_HARDWARE: 'Recorded hardware',
  [FIXTURE]: 'FIXTURE · mock data',
}

const CLASS_STYLE: Record<Provenance['provenanceClass'], string> = {
  SIMULATION: 'border-cyan-glow/40 bg-cyan-dim/40 text-cyan-glow',
  REAL_HARDWARE: 'border-violet-glow/40 bg-violet-dim/40 text-violet-glow',
  RECORDED_HARDWARE: 'border-violet-glow/30 bg-void-700 text-violet-glow/90',
  [FIXTURE]:
    'border-amber-glow/60 bg-[repeating-linear-gradient(135deg,var(--color-amber-dim),var(--color-amber-dim)_6px,var(--color-void-900)_6px,var(--color-void-900)_12px)] text-amber-glow',
}

export interface ProvenanceBadgeProps {
  provenance: Provenance
  className?: string
}

export function ProvenanceBadge({ provenance, className = '' }: ProvenanceBadgeProps) {
  const label = CLASS_LABEL[provenance.provenanceClass]
  const style = CLASS_STYLE[provenance.provenanceClass]

  return (
    <span
      title={badgeTooltip(provenance)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap ${style} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
      {provenance.provenanceClass !== FIXTURE && (
        <span className="text-current/70 font-normal">· {provenance.backend}</span>
      )}
    </span>
  )
}

function badgeTooltip(p: Provenance): string {
  return [
    `result: ${p.resultId}`,
    `circuit: ${p.circuitHash}`,
    `backend: ${p.backend} ${p.backendVersion}`,
    `mode: ${p.executionMode}`,
    `run: ${p.verificationStatus} (${executionStatusLabel(p.verificationStatus)})`,
    executionStatusExplanation(p.verificationStatus),
    `at: ${p.createdAt}`,
  ].join('\n')
}
