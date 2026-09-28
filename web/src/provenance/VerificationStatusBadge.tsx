/**
 * A verification verdict badge, in the same visual language as
 * `ProvenanceBadge` but for a different fact: whether a verifier's check of an
 * already-executed result holds (docs/VERIFICATION_ARCHITECTURE.md §4), not
 * which backend produced the execution. Kept as its own component rather than
 * reusing `ProvenanceBadge` because a `VerifyBellStateResult` does not carry a
 * full `Provenance` object (no backend/backendVersion/executionMode/createdAt)
 * — inventing one would mean fabricating fields the backend never returned.
 *
 * The four statuses (VERIFIED, FAILED, UNVERIFIABLE, ERROR) are visually
 * distinct on purpose: a learner must never mistake "this verifier doesn't
 * know how to check this circuit" (UNVERIFIABLE) or "the request itself was
 * broken" (ERROR) for either a pass or a fail.
 */
import type { BellVerificationStatus } from './schema'

const STATUS_LABEL: Record<BellVerificationStatus, string> = {
  VERIFIED: 'Verified',
  FAILED: 'Failed',
  UNVERIFIABLE: 'Unverifiable',
  ERROR: 'Error',
}

const STATUS_STYLE: Record<BellVerificationStatus, string> = {
  VERIFIED: 'border-cyan-glow/40 bg-cyan-dim/40 text-cyan-glow',
  FAILED: 'border-danger-glow/40 bg-danger-dim/40 text-danger-glow',
  UNVERIFIABLE: 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow',
  ERROR: 'border-danger-glow/60 bg-danger-dim/50 text-danger-glow',
}

export interface VerificationStatusBadgeProps {
  status: BellVerificationStatus
  className?: string
}

export function VerificationStatusBadge({ status, className = '' }: VerificationStatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap ${STATUS_STYLE[status]} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  )
}
