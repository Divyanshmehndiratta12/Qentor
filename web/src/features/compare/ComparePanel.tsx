/**
 * "Compare experiments": pin one real run as A, run another as B, and see how the two differ - the circuits, the measurements,
 * and (for two statevector runs) the states - as the SERVER computed it. Every number goes through `VerifiedValue` with the
 * comparison's provenance; nothing is subtracted or compared in the browser. "Ask Tutor about this difference" sends only the
 * comparison's id: the tutor reads the server's own record of it.
 */
import { useState } from 'react'
import type { ComparisonRun, ComparisonValueKind, ExperimentComparison } from '@/api'
import { useBuildStore } from '@/features/build/store'
import { StateNotice } from '@/features/shell/StateNotice'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { useCompareStore } from './store'

const KIND_LABEL: Record<ComparisonValueKind, string> = {
  sampled_frequency: 'sampled frequency',
  theoretical_probability: 'theoretical probability',
}

const EQUIVALENCE_TEXT = {
  EQUIVALENT: 'Equivalent up to a global phase (the operator check).',
  NOT_EQUIVALENT: 'Not equivalent, even up to a global phase (the operator check).',
  UNVERIFIABLE: 'Equivalence could not be decided',
} as const

function RunCard({ label, run }: { label: string; run: ComparisonRun }) {
  const p = run.provenance
  return (
    <div className="rounded-md border border-void-400 bg-void-800 p-2 text-[11px] text-slate-300" data-testid={`run-${label}`}>
      <p className="font-semibold text-slate-100">Run {label}</p>
      <p className="mt-0.5">
        {p.backend} {p.backendVersion} · {p.executionMode}
        {run.shots !== null ? ` · ${run.shots} shots` : ''} · {run.numQubits} qubit{run.numQubits === 1 ? '' : 's'}
      </p>
      <p className="mt-0.5 font-mono-qasm text-void-200" title={`result ${p.resultId}\ncircuit ${p.circuitHash}`}>
        {p.resultId.slice(0, 14)}…
      </p>
      <ProvenanceBadge provenance={p} className="mt-1" />
    </div>
  )
}

function CircuitDiff({ c }: { c: ExperimentComparison['circuit'] }) {
  return (
    <div data-testid="compare-circuit">
      <h4 className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Circuit difference</h4>
      <p className="mt-0.5 text-[12px] text-slate-200">
        {c.sameCircuit
          ? 'The two circuits are identical.'
          : `A has ${c.numOpsA} operation${c.numOpsA === 1 ? '' : 's'} on ${c.numQubitsA} qubit${c.numQubitsA === 1 ? '' : 's'}; B has ${c.numOpsB} on ${c.numQubitsB}.`}
      </p>
      {!c.sameCircuit && (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono-qasm text-[11px]">
          {c.changes
            .filter((x) => x.tag !== 'equal')
            .map((x, i) => (
              <li key={i} data-tag={x.tag}>
                {x.aOps.length > 0 && <span className="text-danger-glow">− A: {x.aOps.join(', ')}</span>}
                {x.aOps.length > 0 && x.bOps.length > 0 && ' '}
                {x.bOps.length > 0 && <span className="text-cyan-glow">+ B: {x.bOps.join(', ')}</span>}
              </li>
            ))}
        </ul>
      )}
      <p className="mt-1 text-[12px] text-slate-300" data-testid="compare-equivalence" data-status={c.equivalenceStatus}>
        {EQUIVALENCE_TEXT[c.equivalenceStatus]}
        {c.equivalenceStatus === 'UNVERIFIABLE' && c.equivalenceReason ? `: ${c.equivalenceReason}` : ''}
      </p>
    </div>
  )
}

function Measurements({ m }: { m: ExperimentComparison['measurement'] }) {
  return (
    <div data-testid="compare-measurement">
      <h4 className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Measurement difference</h4>
      {!m.comparable ? (
        <p className="mt-0.5 text-[12px] text-slate-300">Not comparable: {m.reason}</p>
      ) : (
        <>
          <p className="mt-0.5 text-[11px] text-void-200">
            A: {KIND_LABEL[m.kindA!]} · B: {KIND_LABEL[m.kindB!]} · bitstrings q[n-1] … q[0]
          </p>
          <table className="mt-1 w-full text-left text-xs">
            <thead>
              <tr className="text-void-200">
                <th className="pb-1 font-medium">outcome</th>
                <th className="pb-1 font-medium">A</th>
                <th className="pb-1 font-medium">B</th>
                <th className="pb-1 font-medium">|A − B|</th>
              </tr>
            </thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.outcome} className="border-t border-void-600">
                  <td className="py-1 font-mono-qasm text-slate-300">{r.outcome}</td>
                  {[r.a, r.b, r.difference].map((v, i) => (
                    <td key={i} className="py-1">
                      {v ? <VerifiedValueInline quantum={v} render={(x) => x.toFixed(6)} /> : <span className="text-void-300" title="not reported by this run">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-slate-300">
            <span>
              Total variation distance:{' '}
              {m.totalVariationDistance && <VerifiedValueInline quantum={m.totalVariationDistance} render={(x) => x.toFixed(6)} />}
            </span>
            <span>
              Largest difference: {m.maxDifference && <VerifiedValueInline quantum={m.maxDifference} render={(x) => x.toFixed(6)} />}
            </span>
          </p>
          {m.note && <p className="mt-1 text-[11px] text-amber-glow">{m.note}</p>}
        </>
      )}
    </div>
  )
}

function States({ s }: { s: ExperimentComparison['state'] }) {
  return (
    <div data-testid="compare-state">
      <h4 className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">State difference</h4>
      {!s.comparable ? (
        <p className="mt-0.5 text-[12px] text-slate-300">Not comparable: {s.reason}</p>
      ) : (
        <>
          <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] text-slate-300">
            <dt>Fidelity</dt>
            <dd>{s.fidelity && <VerifiedValueInline quantum={s.fidelity} render={(x) => x.toFixed(6)} />}</dd>
            <dt>Largest probability difference</dt>
            <dd>{s.maxProbabilityDifference && <VerifiedValueInline quantum={s.maxProbabilityDifference} render={(x) => x.toFixed(6)} />}</dd>
            <dt>Largest amplitude difference</dt>
            <dd>{s.maxAmplitudeDifference && <VerifiedValueInline quantum={s.maxAmplitudeDifference} render={(x) => x.toFixed(6)} />}</dd>
          </dl>
          {s.note && <p className="mt-1 text-[11px] text-void-200">{s.note}</p>}
        </>
      )}
    </div>
  )
}

const DEFAULT_QUESTION = 'What is different between run A and run B?'

function AskTutor({ comparison }: { comparison: ExperimentComparison }) {
  const turns = useCompareStore((s) => s.turns)
  const isAsking = useCompareStore((s) => s.isAsking)
  const ask = useCompareStore((s) => s.ask)
  const language = useBuildStore((s) => s.tutorLanguage)
  const [text, setText] = useState('')

  return (
    <div className="flex flex-col gap-2" data-testid="compare-tutor" data-comparison={comparison.comparisonId}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void ask(DEFAULT_QUESTION, language)}
          disabled={isAsking}
          className="rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-50"
        >
          Ask Tutor about this difference
        </button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void ask(text, language)
          setText('')
        }}
      >
        <label className="sr-only" htmlFor="compare-question">
          Ask about this comparison
        </label>
        <input
          id="compare-question"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          placeholder="Ask about this comparison…"
          className="min-w-0 flex-1 rounded border border-void-400 bg-void-950 px-2 py-1 text-xs text-slate-200 focus:border-cyan-glow focus:outline-none"
        />
        <button type="submit" disabled={isAsking || !text.trim()} className="rounded-md border border-void-400 px-2.5 py-1 text-xs text-slate-300 disabled:opacity-50">
          Ask
        </button>
      </form>
      {isAsking && <StateNotice kind="loading" compact title="The tutor is reading the comparison…" />}
      <ul aria-label="Comparison conversation" className="flex flex-col gap-2">
        {turns.map((t, i) =>
          t.role === 'learner' ? (
            <li key={i} className="self-end rounded-md bg-void-600 px-2 py-1 text-[12px] text-slate-100">
              {t.text}
            </li>
          ) : t.role === 'error' ? (
            <li key={i}>
              <StateNotice kind="error" compact title="The tutor couldn’t answer" detail={t.message} hint="No answer is shown: nothing was made up." />
            </li>
          ) : (
            <li key={i} className="rounded-md border border-void-500 bg-void-800 px-2 py-1.5 text-[12px] text-slate-200" data-testid="compare-answer">
              <p>{t.answer.answer}</p>
              <p className="mt-1 text-[10px] text-void-200">
                {t.answer.usedFallbackTemplate ? 'Explanation generated without AI.' : 'Written by AI, checked against the facts.'} Grounded in comparison{' '}
                {t.answer.resultId?.slice(0, 12)}…
              </p>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}

export function ComparePanel() {
  const circuit = useBuildStore((s) => s.circuit)
  const result = useBuildStore((s) => s.result)
  const pinned = useCompareStore((s) => s.pinned)
  const comparison = useCompareStore((s) => s.comparison)
  const isComparing = useCompareStore((s) => s.isComparing)
  const error = useCompareStore((s) => s.error)
  const errorStatus = useCompareStore((s) => s.errorStatus)
  const pin = useCompareStore((s) => s.pin)
  const unpin = useCompareStore((s) => s.unpin)
  const compare = useCompareStore((s) => s.compare)

  const isPinnedRun = !!pinned && !!result && pinned.result.provenance.resultId === result.provenance.resultId
  const current = result ? { circuit, result } : null

  return (
    <section aria-labelledby="compare-heading" className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4" data-testid="compare-panel">
      <h3 id="compare-heading" className="text-[13px] font-semibold text-slate-100">
        Compare experiments
      </h3>

      {!current && !pinned && <StateNotice kind="empty" compact title="Run a circuit first, then pin it as run A." />}

      {pinned && (
        <p className="text-[12px] text-slate-300" data-testid="pinned-run">
          Pinned as A: {pinned.result.provenance.backend} · {pinned.result.provenance.executionMode} · {pinned.circuit.ops.length} op
          {pinned.circuit.ops.length === 1 ? '' : 's'} · {pinned.result.provenance.resultId.slice(0, 12)}…
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => current && pin(current)}
          disabled={!current || isPinnedRun}
          className="rounded-md border border-void-400 px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pinned ? 'Pin this run as A instead' : 'Pin this run as A'}
        </button>
        {pinned && (
          <button
            type="button"
            onClick={() => current && void compare(current)}
            disabled={!current || isPinnedRun || isComparing}
            className="rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isComparing ? 'Comparing…' : 'Compare A with this run (B)'}
          </button>
        )}
        {pinned && (
          <button type="button" onClick={unpin} className="rounded-md px-2.5 py-1 text-xs text-void-200 hover:text-slate-200">
            Unpin
          </button>
        )}
      </div>
      {isPinnedRun && (
        <p className="text-[11px] text-void-200">This is the pinned run. Change the circuit, the backend or the mode and run again to get run B.</p>
      )}

      {isComparing && <StateNotice kind="loading" compact title="The server is comparing the two runs…" />}
      {error && !isComparing && (
        <StateNotice
          kind="error"
          compact
          title={errorStatus !== null && errorStatus >= 400 && errorStatus < 500 ? 'The server could not compare these runs' : 'Comparison is unavailable'}
          detail={error}
          hint="No comparison is shown: nothing was worked out here."
          onRetry={current ? () => void compare(current) : undefined}
        />
      )}

      {comparison && !isComparing && !error && (
        <div className="flex flex-col gap-3" data-testid="comparison">
          <div className="grid grid-cols-2 gap-2">
            <RunCard label="A" run={comparison.a} />
            <RunCard label="B" run={comparison.b} />
          </div>
          {comparison.a.provenance.backend !== comparison.b.provenance.backend && (
            <p className="text-[12px] text-slate-300" data-testid="compare-backends">
              The runs used different backends: {comparison.a.provenance.backend} and {comparison.b.provenance.backend}.
            </p>
          )}
          <CircuitDiff c={comparison.circuit} />
          <Measurements m={comparison.measurement} />
          <States s={comparison.state} />
          <p className="flex flex-wrap items-center gap-2 text-[11px] text-void-200">
            <ProvenanceBadge provenance={comparison.provenance} />
            <span>computed by the server ({comparison.method})</span>
          </p>
          <AskTutor comparison={comparison} />
        </div>
      )}
    </section>
  )
}
