/**
 * The overall verdict badge for POST /api/test/multi-input, in the same
 * visual language as `VerificationStatusBadge`/`OptimizationStatusBadge` but
 * its own vocabulary (`qentor.verification.multi_input_harness.OverallStatus`)
 * — a third, distinct status enum in this codebase, since a multi-input test
 * run means something different from either a Bell-state verdict or an
 * optimization verdict.
 *
 * `INCOMPLETE` is deliberately visually distinct from `SOME_FAILED`: it means
 * at least one case's *execution itself* failed (backend unavailable, SDK
 * error) before any pass/fail judgement could even be made — never rendered
 * as if it were a confirmed algorithm failure.
 */
import type { MultiInputOverallStatus } from './schema'

const STATUS_LABEL: Record<MultiInputOverallStatus, string> = {
  ALL_PASSED: 'All passed',
  SOME_FAILED: 'Some failed',
  INCOMPLETE: 'Incomplete',
}

const STATUS_STYLE: Record<MultiInputOverallStatus, string> = {
  ALL_PASSED: 'border-cyan-glow/40 bg-cyan-dim/40 text-cyan-glow',
  SOME_FAILED: 'border-danger-glow/40 bg-danger-dim/40 text-danger-glow',
  INCOMPLETE: 'border-amber-glow/40 bg-amber-dim/30 text-amber-glow',
}

export interface MultiInputTestStatusBadgeProps {
  status: MultiInputOverallStatus
  className?: string
}

export function MultiInputTestStatusBadge({ status, className = '' }: MultiInputTestStatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap ${STATUS_STYLE[status]} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  )
}
