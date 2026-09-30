/**
 * What an execution's status means, in one place — copy, not data. The backend says
 * `STATE_CHECKED`; this says what that does and does not tell a learner.
 *
 * Three things used to share the word "verified": the backend ran; what it returned is
 * a well-formed result (norm 1, probabilities that add up); the circuit has a property.
 * Only the last is verification, and it comes from a verifier (Bell check, multi-input
 * test, equivalence), never from a plain run. So a run is "state checked".
 */
import type { BellVerificationStatus, ExecutionStatus } from './schema'

const LABEL: Record<ExecutionStatus, string> = {
  STATE_CHECKED: 'state checked',
  FAILED: 'state check failed',
  ERROR: 'run failed',
  SUCCEEDED: 'ran, not state-checked',
}

const EXPLANATION: Record<ExecutionStatus, string> = {
  STATE_CHECKED:
    'The backend ran and returned a well-formed result. This does not show the circuit does what you intend.',
  FAILED: 'The backend ran but returned a result that failed the state check, so it is not shown or explained.',
  ERROR: 'The run failed, so there is no result.',
  SUCCEEDED: 'An older record: the backend ran, but no state check was recorded for it.',
}

/**
 * What a Bell-state VERDICT covers. "Verified" here is a property verdict from a verifier — and the
 * property is one specific thing. It is never a statement that the circuit is correct in general.
 */
const BELL_SCOPE: Record<BellVerificationStatus, string> = {
  VERIFIED:
    'Verified against the Bell-state pattern only: this circuit and run match it. It says nothing else about the circuit.',
  FAILED: 'This run does not match the Bell-state pattern.',
  UNVERIFIABLE: 'This check only knows the Bell-state pattern, so it cannot judge this circuit or run.',
  ERROR: 'The check could not be run, so there is no verdict.',
}

export function bellVerdictScope(status: BellVerificationStatus): string {
  return BELL_SCOPE[status]
}

export function executionStatusLabel(status: ExecutionStatus): string {
  return LABEL[status]
}

export function executionStatusExplanation(status: ExecutionStatus): string {
  return EXPLANATION[status]
}
