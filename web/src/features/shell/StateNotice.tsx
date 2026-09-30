/**
 * The one shape for "loading", "empty" and "failed" across screens, so they look, read and announce the same way:
 *  - loading → `role="status"` (polite live region), never an alert;
 *  - error   → `role="alert"`, what failed, the real error text, an honest "nothing was substituted" line when one applies,
 *              and — when the action can be repeated — a "Try again" button;
 *  - empty   → plain text: nothing to announce.
 * It never fabricates content to fill a gap; it only states the situation.
 */
export type StateNoticeProps =
  | { kind: 'loading'; title: string; compact?: boolean; className?: string }
  | { kind: 'empty'; title: string; compact?: boolean; className?: string }
  | {
      kind: 'error'
      title: string
      /** The underlying error text, shown verbatim. */
      detail?: string
      /** A plain-language line under the detail (e.g. that no substitute result is shown). */
      hint?: string
      /** Present when repeating the action makes sense; renders the retry button. */
      onRetry?: () => void
      retryLabel?: string
      compact?: boolean
      className?: string
    }

export function StateNotice(props: StateNoticeProps) {
  const size = props.compact ? 'text-xs' : 'text-sm'
  const extra = props.className ?? ''

  if (props.kind === 'loading') {
    return (
      <p role="status" className={`flex items-center gap-2 ${size} text-slate-400 ${extra}`}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-glow" aria-hidden="true" />
        {props.title}
      </p>
    )
  }

  if (props.kind === 'empty') {
    return <p className={`${size} text-void-200 ${extra}`}>{props.title}</p>
  }

  return (
    <div role="alert" className={`rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3 ${size} ${extra}`}>
      <p className="font-semibold text-danger-glow">{props.title}</p>
      {props.detail && <p className="mt-1 font-mono-qasm text-xs break-words text-danger-glow/80">{props.detail}</p>}
      {props.hint && <p className="mt-2.5 text-xs text-slate-400">{props.hint}</p>}
      {props.onRetry && (
        <button
          type="button"
          onClick={props.onRetry}
          className="mt-3 rounded-md border border-danger-glow/50 px-2.5 py-1 text-xs font-medium text-danger-glow hover:bg-danger-dim/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
        >
          {props.retryLabel ?? 'Try again'}
        </button>
      )}
    </div>
  )
}
