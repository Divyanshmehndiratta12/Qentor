/**
 * The server's verdict on a submitted circuit, check by check. Everything shown is what `POST /api/challenges/{id}/submit`
 * returned: pass/fail, the per-check details, and the numbers behind them — each number renders through `VerifiedValue`
 * with the provenance record it came from. Nothing here judges anything.
 */
import type { ChallengeCheckOutcome, ChallengeSubmission } from '@/api'
import { StateNotice } from '@/features/shell/StateNotice'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { VerifiedValue } from '@/provenance/VerifiedValue'

const EVIDENCE_LABEL: Record<string, string> = {
  fidelity: 'Fidelity with the reference state',
  largest_probability_difference: 'Largest difference in outcome probability',
  lowest_top_outcome_probability: 'Lowest top-outcome probability along the way',
  top_outcome_probability: 'Probability of the top outcome',
  bloch_vector_distance: 'Distance between the qubit’s Bloch vector and the required one (zero: the same arrow)',
  qubit_purity: 'Purity of the qubit’s own state (one: a definite state of its own; one half: entangled with the rest)',
}

function CheckRow({ check }: { check: ChallengeCheckOutcome }) {
  const state = !check.evaluated ? 'pending' : check.passed ? 'pass' : 'fail'
  const mark = state === 'pass' ? '✓' : state === 'fail' ? '✗' : '–'
  const markLabel = state === 'pass' ? 'Passed' : state === 'fail' ? 'Not yet' : 'Not checked yet'
  return (
    <li className="flex gap-2.5" data-testid={`check-${check.id}`} data-state={state}>
      <span
        role="img"
        aria-label={markLabel}
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-bold ${
          state === 'pass'
            ? 'border-cyan-glow/50 bg-cyan-dim/40 text-cyan-glow'
            : state === 'fail'
              ? 'border-danger-glow/50 bg-danger-dim/30 text-danger-glow'
              : 'border-void-400 text-void-200'
        }`}
      >
        {mark}
      </span>
      <div className="min-w-0 text-[12px]">
        <p className="font-medium text-slate-200">{check.label}</p>
        <p className="mt-0.5 text-slate-400">{check.detail}</p>
        {check.evidence.map((e) => (
          <p key={e.name} className="mt-1 flex flex-wrap items-center gap-x-2 text-slate-400">
            <span>{EVIDENCE_LABEL[e.name] ?? e.name}:</span>
            <VerifiedValue quantum={e.value} render={(v) => v.toFixed(6)} />
          </p>
        ))}
      </div>
    </li>
  )
}

export function SubmissionPanel({
  submission,
  isCurrent,
  isSubmitting,
  error,
  errorStatus,
  onSubmit,
  onShowHint,
  hintsLeft,
  onRetry,
  canSubmit,
  nextStep,
  debugSlot,
}: {
  submission: ChallengeSubmission | null
  /** True while the circuit on screen is still the one that was judged. */
  isCurrent: boolean
  isSubmitting: boolean
  error: string | null
  errorStatus: number | null
  onSubmit: () => void
  onShowHint: () => void
  /** Whether there is a hint the learner has not yet been shown. */
  hintsLeft: boolean
  onRetry: () => void
  canSubmit: boolean
  /** Rendered after a solve: where to go next (chosen by the recommendation, never by the verdict). */
  nextStep?: React.ReactNode
  /** The debugger, shown under the checks once there is a verdict to debug. */
  debugSlot?: React.ReactNode
}) {
  const evaluatedChecks = submission?.checks.filter((c) => c.evaluated) ?? []
  const passedCount = evaluatedChecks.filter((c) => c.passed).length

  return (
    <section aria-labelledby="verdict-heading" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 id="verdict-heading" className="text-[13px] font-semibold text-slate-100">
          Check your circuit
        </h3>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || isSubmitting}
          className="rounded-lg bg-slate-100 px-3.5 py-1.5 text-[13px] font-semibold whitespace-nowrap text-void-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSubmitting ? 'Checking…' : 'Submit for checking'}
        </button>
      </div>

      {!submission && !error && !isSubmitting && (
        <StateNotice
          kind="empty"
          compact
          title="Build the circuit on the canvas, then submit it. The Qentor server checks it against the goal — the tutor never does."
        />
      )}
      {isSubmitting && <StateNotice kind="loading" compact title="The server is checking your circuit…" />}

      {error && !isSubmitting && (
        <StateNotice
          kind="error"
          title={errorStatus !== null && errorStatus >= 400 && errorStatus < 500 ? 'The server could not check this circuit' : 'Checking is unavailable'}
          detail={error}
          hint="No verdict is shown: this circuit has not been checked."
          onRetry={onRetry}
        />
      )}

      {submission && !isSubmitting && !error && (
        <div data-testid="verdict" data-passed={submission.passed} data-current={isCurrent}>
          {!isCurrent && (
            <p role="status" className="mb-2 rounded-md border border-amber-glow/40 bg-amber-dim/20 px-2.5 py-1.5 text-[12px] text-amber-glow">
              You changed the circuit after this check. Submit again to check the new one.
            </p>
          )}
          <div
            role="status"
            className={`rounded-lg border px-3 py-2 text-[13px] ${
              submission.passed ? 'border-cyan-glow/50 bg-cyan-dim/30 text-cyan-glow' : 'border-void-400 bg-void-800 text-slate-200'
            }`}
          >
            <p className="font-semibold">
              {submission.passed ? 'Solved' : 'Not solved yet'}
              <span className="ml-2 font-normal text-slate-400">
                {passedCount} of {evaluatedChecks.length} checks passed
                {evaluatedChecks.length < submission.checks.length ? ` (${submission.checks.length - evaluatedChecks.length} not checked yet)` : ''}
              </span>
            </p>
            {submission.passed && submission.successMessage && <p className="mt-1 text-[12px] text-slate-300">{submission.successMessage}</p>}
          </div>

          <ul className="mt-3 flex flex-col gap-2.5" aria-label="Checks">
            {submission.checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>

          {!submission.passed && (
            <div className="mt-3 rounded-md border border-void-400 bg-void-800 px-3 py-2 text-[12px]">
              {submission.nextHint && <p className="text-slate-300">A hint that fits what is missing: {submission.nextHint}</p>}
              {hintsLeft && (
                <button
                  type="button"
                  onClick={onShowHint}
                  className="mt-1.5 rounded-md border border-void-400 px-2 py-1 font-medium text-slate-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
                >
                  Add it to the hints
                </button>
              )}
            </div>
          )}

          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-void-200">
            {submission.finalProvenance ? (
              <>
                <ProvenanceBadge provenance={submission.finalProvenance} />
                <span>
                  judged by {submission.verifier} on {submission.backend} {submission.backendVersion}
                </span>
              </>
            ) : (
              <span>Nothing was run: the circuit's structure has to be right first.</span>
            )}
            <span title={submission.attemptId}>attempt {submission.attemptId.slice(0, 12)}…</span>
          </p>

          {submission.passed && nextStep}
          {debugSlot}
        </div>
      )}
    </section>
  )
}
