/**
 * A verdict badge for POST /api/optimize's four possible statuses, in the
 * same visual language as `VerificationStatusBadge`/`ProvenanceBadge` but its
 * own vocabulary (`qentor.verification.optimizer.OptimizationStatus`) — kept
 * as its own component for the same reason `VerificationStatusBadge` isn't
 * `ProvenanceBadge`: an `OptimizationResult` carries no full `Provenance`
 * object either, and this status means something different from both the
 * execution status and the Bell verifier's status.
 *
 * All four statuses are visually distinct on purpose: a learner must never
 * mistake "nothing to optimise" (NO_OPTIMIZATION_FOUND), "this optimizer
 * can't check your circuit" (UNVERIFIABLE), or "a candidate was found but
 * discarded as unsafe" (REJECTED) for a genuine verified improvement.
 */
import type { OptimizationStatus } from './schema'

const STATUS_LABEL: Record<OptimizationStatus, string> = {
  VERIFIED_SHORTER: 'Verified shorter',
  NO_OPTIMIZATION_FOUND: 'No optimization found',
  REJECTED: 'Rejected',
  UNVERIFIABLE: 'Unverifiable',
}

const STATUS_STYLE: Record<OptimizationStatus, string> = {
  VERIFIED_SHORTER: 'border-cyan-glow/40 bg-cyan-dim/40 text-cyan-glow',
  NO_OPTIMIZATION_FOUND: 'border-void-300/60 bg-void-700 text-void-200',
  REJECTED: 'border-danger-glow/40 bg-danger-dim/40 text-danger-glow',
  UNVERIFIABLE: 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow',
}

export interface OptimizationStatusBadgeProps {
  status: OptimizationStatus
  className?: string
}

export function OptimizationStatusBadge({ status, className = '' }: OptimizationStatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap ${STATUS_STYLE[status]} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  )
}
