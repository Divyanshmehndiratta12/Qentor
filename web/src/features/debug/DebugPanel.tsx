/**
 * "Debug my circuit": one button, and the server's structured answer - what was observed, the concrete evidence, the likely
 * mismatch, the next experiment and (for a challenge) a hint. Nothing here is computed in the browser: it sends identifiers and
 * the learner's own words, and shows what came back, with the ids of the facts each part rests on.
 *
 * The evidence is facts quoted by the server; the prose is either the server's template ("Explanation generated without AI") or an
 * AI draft that the server's claim guard accepted - and the panel says which. The hint is always authored, never generated.
 */
import { useState } from 'react'
import type { DebugRequestInput, DebugSection } from '@/api'
import { StateNotice } from '@/features/shell/StateNotice'
import { useDebugStore, type DebugScope } from './store'

const GOAL_MAX = 400

function Section({ title, section, testId }: { title: string; section: DebugSection; testId: string }) {
  return (
    <div data-testid={testId}>
      <h4 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{title}</h4>
      <p className="mt-0.5 text-[12px] leading-snug text-slate-200">{section.text}</p>
      <FactChips ids={section.factIds} />
    </div>
  )
}

function FactChips({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null
  return (
    <p className="mt-1 flex flex-wrap gap-1" aria-label="Based on facts">
      {ids.map((id) => (
        <span key={id} className="rounded border border-void-400 px-1 font-mono-qasm text-[10px] text-void-200">
          {id}
        </span>
      ))}
    </p>
  )
}

export function DebugPanel({
  scope,
  input,
  disabledReason,
  askForGoal = false,
}: {
  scope: DebugScope
  /** The request to send (without the goal), or `null` when there is nothing to debug yet. */
  input: Omit<DebugRequestInput, 'goal'> | null
  /** Shown when `input` is `null`: what the learner needs to do first. */
  disabledReason: string
  /** Offer a box for the learner's goal in their own words (the Lab has no challenge to supply one). */
  askForGoal?: boolean
}) {
  const entry = useDebugStore((s) => s.entries[scope])
  const debug = useDebugStore((s) => s.debug)
  const [goal, setGoal] = useState('')
  const { report, isDebugging, error, errorStatus } = entry
  const stale = !!report && !!input && entry.circuit !== input.circuit

  const run = () => input && void debug(scope, { ...input, goal: goal.trim() || null })

  return (
    <section aria-labelledby={`debug-heading-${scope}`} className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4" data-testid={`debug-${scope}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 id={`debug-heading-${scope}`} className="text-[13px] font-semibold text-slate-100">
          Debug my circuit
        </h3>
        <button
          type="button"
          onClick={run}
          disabled={!input || isDebugging}
          className="rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDebugging ? 'Debugging…' : report ? 'Debug again' : 'Debug my circuit'}
        </button>
      </div>

      {askForGoal && (
        <label className="flex flex-col gap-1 text-[12px] text-slate-400">
          What were you trying to do? <span className="text-void-200">(optional, in your own words)</span>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value.slice(0, GOAL_MAX))}
            rows={2}
            maxLength={GOAL_MAX}
            className="rounded border border-void-400 bg-void-950 px-2 py-1 text-[12px] text-slate-200 focus:border-cyan-glow focus:outline-none"
          />
        </label>
      )}

      {!input && !report && <StateNotice kind="empty" compact title={disabledReason} />}
      {isDebugging && <StateNotice kind="loading" compact title="The server is looking at your circuit…" />}

      {error && !isDebugging && (
        <StateNotice
          kind="error"
          compact
          title={errorStatus !== null && errorStatus >= 400 && errorStatus < 500 ? 'The server could not debug this circuit' : 'Debugging is unavailable'}
          detail={error}
          hint="No explanation is shown: nothing was made up."
          onRetry={input ? run : undefined}
        />
      )}

      {report && !isDebugging && !error && (
        <div className="flex flex-col gap-3" data-testid="debug-report" data-stale={stale}>
          {stale && (
            <p role="status" className="rounded-md border border-amber-glow/40 bg-amber-dim/20 px-2.5 py-1.5 text-[12px] text-amber-glow">
              You changed the circuit after this. Debug again to look at the new one.
            </p>
          )}
          <p className="text-[11px] text-void-200" data-testid="debug-source">
            {report.usedFallbackTemplate
              ? 'Explanation generated without AI — built by the server from the facts below.'
              : 'Written by AI, then checked by the server against the facts below.'}
          </p>

          <Section title="What happened" section={report.observed} testId="debug-observed" />

          <div data-testid="debug-evidence">
            <h4 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Evidence</h4>
            <ul className="mt-0.5 flex flex-col gap-1.5">
              {report.evidence.map((e, i) => (
                <li key={i} className="text-[12px] leading-snug text-slate-200">
                  {e.text}
                  <FactChips ids={e.factIds} />
                </li>
              ))}
            </ul>
          </div>

          {report.engineEvidence.length > 0 && (
            <div data-testid="debug-engine-evidence">
              <h4 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">What the reasoning engine found</h4>
              <ul className="mt-0.5 flex flex-col gap-1.5">
                {report.engineEvidence.map((e, i) => (
                  <li key={i} className="text-[12px] leading-snug text-slate-200">
                    {e.text}
                    <FactChips ids={e.factIds} />
                  </li>
                ))}
              </ul>
              {report.analysisId && <p className="mt-1 font-mono-qasm text-[10px] text-void-200">analysis {report.analysisId} · computed by the server, not by a model</p>}
            </div>
          )}

          <Section title="Most likely mismatch" section={report.mismatch} testId="debug-mismatch" />
          <Section title="Try this next" section={report.nextExperiment} testId="debug-experiment" />
          {report.hint && <Section title="Hint" section={report.hint} testId="debug-hint" />}

          <details className="text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">Facts this rests on ({report.facts.length})</summary>
            <ul className="mt-1.5 flex flex-col gap-1">
              {report.facts.map((f) => (
                <li key={f.id} className="leading-snug">
                  <span className="mr-1.5 font-mono-qasm text-void-200">{f.id}</span>
                  {f.description}
                  {f.resultId && <span className="ml-1.5 font-mono-qasm text-[10px] text-void-200">[{f.resultId.slice(0, 12)}…]</span>}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  )
}
