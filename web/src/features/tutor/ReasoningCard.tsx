/**
 * One reasoning-engine analysis, as the server returned it: the answer worded from the engine's `R#` facts, the structured result
 * beside it (a table of probabilities, an operation count and diff, a what-if comparison, a step's change), the backend runs it
 * rests on, and its provenance.
 *
 * Nothing here computes a quantum quantity. Every number is a `QuantumValue` (parsed from the response and wrapped with the analysis
 * record's own provenance) and is rendered only through `VerifiedValueInline`; counts of operations and indices are structure, not
 * results, and come straight from the response. Bitstrings are written `q[n-1]…q[0]` and the card says so beside each table.
 */
import { useContext } from 'react'
import type { ReasoningResult, ReasoningQubit } from '@/api'
import { useBuildStore } from '@/features/build/store'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { LandmarkSuffix } from './LandmarkSuffix'
import type { QuantumValue } from '@/provenance/QuantumValue'

const f6 = (x: number) => x.toFixed(6)
const signed6 = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(6)}`

const INTENT_LABEL: Record<ReasoningResult['intent'], string> = {
  PROBABILITY: 'Probability',
  OPTIMIZE: 'Optimization',
  WHAT_IF: 'What if',
  TRACE_CHANGE: 'What this step changed',
  COMPARE: 'Comparison',
  DEBUG: 'Debug evidence',
}

const STATUS_LABEL: Record<string, string> = {
  OK: 'computed by the backend',
  NO_IMPROVEMENT: 'no safe improvement',
  NOT_APPLICABLE: 'not applicable',
  INITIAL_STATE: 'initial state',
}

function Num({ value, render = f6 }: { value: QuantumValue<number> | null; render?: (x: number) => string }) {
  if (!value) return <span className="text-void-200">—</span>
  return <VerifiedValueInline quantum={value} render={render} />
}

const th = 'px-2 py-1 text-left text-[10px] font-semibold tracking-wider text-slate-400 uppercase'
const td = 'px-2 py-1 align-top text-[12px] text-slate-200'

function Table({ caption, children }: { caption: string; children: React.ReactNode }) {
  const suffix = useContext(LandmarkSuffix)
  return (
    <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label={`${caption}${suffix}`}>
      <table className="w-full min-w-[22rem] border-collapse text-left">
        <caption className="pb-1 text-left text-[11px] text-void-200">{caption}</caption>
        {children}
      </table>
    </div>
  )
}

export function ReasoningCard({ result }: { result: ReasoningResult }) {
  return (
    <article
      className="flex min-w-0 flex-1 flex-col gap-2"
      data-testid="reasoning-card"
      data-intent={result.intent}
      data-status={result.status}
      aria-label={`${INTENT_LABEL[result.intent]} analysis`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12px] font-semibold tracking-wider text-slate-200 uppercase">{INTENT_LABEL[result.intent]}</h3>
        <span
          className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
            result.status === 'OK' ? 'border-cyan-glow/40 bg-cyan-dim/20 text-cyan-glow' : 'border-amber-glow/50 bg-amber-dim/40 text-amber-glow'
          }`}
        >
          {STATUS_LABEL[result.status] ?? result.status}
        </span>
        {result.usedFallbackTemplate && (
          <span className="rounded-full border border-amber-glow/50 bg-amber-dim/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-glow">template fallback · no AI</span>
        )}
      </header>

      <p className="font-serif-prose text-[15px] leading-relaxed whitespace-pre-wrap text-slate-100" data-testid="reasoning-answer">
        {result.answer}
      </p>

      {result.reason && result.status !== 'OK' && (
        <p role="status" className="rounded-md border border-amber-glow/40 bg-amber-dim/20 px-2.5 py-1.5 text-[12px] text-amber-glow" data-testid="reasoning-reason">
          {result.reason}
        </p>
      )}

      {result.intent === 'PROBABILITY' && <ProbabilityView result={result} />}
      {result.intent === 'OPTIMIZE' && <OptimizationView result={result} />}
      {result.intent === 'WHAT_IF' && <WhatIfView result={result} />}
      {result.intent === 'TRACE_CHANGE' && <TraceChangeView result={result} />}

      <details className="text-[11px] text-slate-400" data-testid="reasoning-sources">
        <summary className="cursor-pointer text-slate-300">Backend runs this rests on ({result.sources.length})</summary>
        <ul className="mt-1 flex flex-col gap-1">
          {result.sources.map((s) => (
            <li key={s.resultId} className="font-mono-qasm text-[10px] leading-snug text-void-200">
              <span className="text-slate-300">{s.role}</span> · {s.resultId} · {s.backend} {s.backendVersion} · {s.provenanceClass} · {s.executionMode} · {s.verificationStatus}
            </li>
          ))}
        </ul>
      </details>

      <details className="text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">Facts the answer is worded from ({result.facts.length})</summary>
        <ul className="mt-1 flex flex-col gap-1 font-mono-qasm text-[11px] text-violet-glow/80">
          {result.facts.map((fact) => (
            <li key={fact.id}>
              <span className="font-semibold">{fact.id}</span> · {fact.description}
            </li>
          ))}
        </ul>
      </details>

      <div className="flex flex-wrap items-center gap-2 font-mono-qasm text-[11px] text-void-200">
        <ProvenanceBadge provenance={result.provenance} />
        <span>analysis {result.analysisId}</span>
      </div>
    </article>
  )
}

// ------------------------------------------------------------------------------------------------ probability

function ProbabilityView({ result }: { result: Extract<ReasoningResult, { intent: 'PROBABILITY' }> }) {
  if (result.rows.length === 0) return null
  const sampled = result.rows.some((r) => r.sampled)
  return (
    <Table caption={`Probabilities from the backend's own run. ${result.bitOrder}.`}>
      <thead>
        <tr>
          <th className={th}>Outcome</th>
          <th className={th}>Theoretical probability</th>
          {sampled && <th className={th}>Sampled frequency</th>}
          {sampled && <th className={th}>Difference</th>}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row) => (
          <tr key={row.label} className="border-t border-void-500">
            <td className={td}>{row.label}</td>
            <td className={td}>
              <Num value={row.theoretical} />
            </td>
            {sampled && (
              <td className={td}>
                <Num value={row.sampled} />
                {row.sampledCount !== null && row.shots !== null && <span className="ml-1.5 text-[10px] text-void-200">({row.sampledCount} of {row.shots} shots)</span>}
              </td>
            )}
            {sampled && (
              <td className={td}>
                <Num value={row.difference} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

// ----------------------------------------------------------------------------------------------- optimization

function OptimizationView({ result }: { result: Extract<ReasoningResult, { intent: 'OPTIMIZE' }> }) {
  const loadCircuit = useBuildStore((s) => s.loadCircuit)
  const candidate = result.candidateCircuit
  return (
    <div className="flex flex-col gap-2" data-testid="optimization-view">
      <p className="text-[12px] text-slate-300">
        {candidate
          ? `${result.originalOpCount} operations before, ${result.candidateOpCount} after (${result.operationsRemoved} removed).`
          : `${result.originalOpCount} operations; no shorter circuit was confirmed.`}
      </p>
      {result.rewrites.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] text-slate-300">
          {result.rewrites.map((r, i) => (
            <li key={i}>
              {r.rule}
              {r.explanation && <span className="text-slate-400"> — {r.explanation}</span>}
            </li>
          ))}
        </ul>
      )}
      {result.changes.some((c) => c.kind !== 'kept') && (
        <ul className="flex flex-col gap-0.5 font-mono-qasm text-[11px]" aria-label="What changed in the circuit">
          {result.changes
            .filter((c) => c.kind !== 'kept')
            .map((c, i) => (
              <li key={i} className={c.kind === 'removed' ? 'text-danger-glow' : 'text-cyan-glow'}>
                {c.kind === 'removed' ? '− removed' : '+ added'} · {c.description}
              </li>
            ))}
        </ul>
      )}
      {result.equivalence && (
        <p className="text-[11px] text-void-200" data-testid="optimization-equivalence">
          Equivalence decided by the backend&rsquo;s checker ({result.equivalence.method}): {result.equivalence.status}. The tutor did not decide this.
        </p>
      )}
      {candidate && (
        <button
          type="button"
          onClick={() => loadCircuit(candidate)}
          className="self-start rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
        >
          Apply the shorter circuit (one undo step)
        </button>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------------------------------- what-if

function WhatIfView({ result }: { result: Extract<ReasoningResult, { intent: 'WHAT_IF' }> }) {
  const { comparison } = result
  return (
    <div className="flex flex-col gap-2" data-testid="whatif-view">
      <p className="text-[12px] text-slate-300">
        {result.description}. {result.originalOpCount} operations became {result.counterfactualOpCount}.
      </p>
      {result.changes.some((c) => c.kind !== 'kept') && (
        <ul className="flex flex-col gap-0.5 font-mono-qasm text-[11px]" aria-label="What changed in the circuit">
          {result.changes
            .filter((c) => c.kind !== 'kept')
            .map((c, i) => (
              <li key={i} className={c.kind === 'removed' ? 'text-danger-glow' : 'text-cyan-glow'}>
                {c.kind === 'removed' ? '− removed' : '+ added'} · {c.description}
              </li>
            ))}
        </ul>
      )}
      <p className="text-[12px] text-slate-300" data-testid="whatif-equivalence">
        {comparison.circuit.equivalenceStatus === 'EQUIVALENT'
          ? 'The backend’s equivalence check: the counterfactual is equivalent to the original up to a global phase.'
          : comparison.circuit.equivalenceStatus === 'NOT_EQUIVALENT'
            ? 'The backend’s equivalence check: the counterfactual is not equivalent to the original.'
            : `The backend could not decide whether they are equivalent (${comparison.circuit.equivalenceReason ?? 'unverifiable'}).`}
      </p>
      {comparison.measurement.comparable && (
        <Table caption={`Theoretical probabilities of the two circuits' states. ${result.comparedValues}. An outcome missing from a run has probability zero in it.`}>
          <thead>
            <tr>
              <th className={th}>Outcome</th>
              <th className={th}>Original</th>
              <th className={th}>With the change</th>
              <th className={th}>Difference</th>
            </tr>
          </thead>
          <tbody>
            {comparison.measurement.rows.map((row) => (
              <tr key={row.outcome} className="border-t border-void-500">
                <td className={`${td} font-mono-qasm`}>{row.outcome}</td>
                <td className={td}>{row.a ? <Num value={row.a} /> : <span className="text-void-200">zero (absent)</span>}</td>
                <td className={td}>{row.b ? <Num value={row.b} /> : <span className="text-void-200">zero (absent)</span>}</td>
                <td className={td}>{row.difference ? <Num value={row.difference} /> : <span className="text-void-200">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="text-[12px] text-slate-300">
        Total variation distance <Num value={comparison.measurement.totalVariationDistance} />
        {comparison.state.comparable && (
          <>
            {' · '}state fidelity <Num value={comparison.state.fidelity} />
          </>
        )}
      </p>
    </div>
  )
}

// ----------------------------------------------------------------------------------------------- trace change

function QubitRows({ before, after }: { before: ReasoningQubit[]; after: ReasoningQubit[] }) {
  const bloch = (q: ReasoningQubit | undefined) =>
    q?.bloch ? (
      <VerifiedValueInline quantum={q.bloch} render={(v) => `(${f6(v.x)}, ${f6(v.y)}, ${f6(v.z)})`} />
    ) : (
      <span className="text-void-200">{q?.reason ?? '—'}</span>
    )
  return (
    <>
      {after.map((a) => {
        const b = before.find((x) => x.qubit === a.qubit)
        return (
          <tr key={a.qubit} className="border-t border-void-500">
            <td className={`${td} font-mono-qasm`}>q[{a.qubit}]</td>
            {before.length > 0 && <td className={td}>{bloch(b)}</td>}
            <td className={td}>{bloch(a)}</td>
            <td className={td}>
              <Num value={a.purity} />
            </td>
            <td className={td}>{a.entangledWithRest === null ? '—' : a.entangledWithRest ? 'entangled with the rest' : 'a state of its own'}</td>
          </tr>
        )
      })}
    </>
  )
}

function TraceChangeView({ result }: { result: Extract<ReasoningResult, { intent: 'TRACE_CHANGE' }> }) {
  return (
    <div className="flex flex-col gap-2" data-testid="trace-change-view">
      <p className="text-[12px] text-slate-300">
        Step {result.stepNumber} of {result.totalSteps}
        {result.operation ? `: ${result.operation.description}` : ': the initial state'}.
      </p>
      {result.changeSummary && <p className="text-[12px] text-slate-300">{result.changeSummary}</p>}
      {result.probabilityChanges.length > 0 && (
        <Table caption={`Outcome probabilities that changed at this step. ${result.bitOrder}.`}>
          <thead>
            <tr>
              <th className={th}>Outcome</th>
              <th className={th}>Before</th>
              <th className={th}>After</th>
              <th className={th}>Change</th>
            </tr>
          </thead>
          <tbody>
            {result.probabilityChanges.map((c) => (
              <tr key={c.outcome} className="border-t border-void-500">
                <td className={`${td} font-mono-qasm`}>{c.outcome}</td>
                <td className={td}>
                  <Num value={c.before} />
                </td>
                <td className={td}>
                  <Num value={c.after} />
                </td>
                <td className={td}>
                  <Num value={c.difference} render={signed6} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {result.operation !== null && result.probabilityChanges.length === 0 && <p className="text-[12px] text-slate-300">No outcome probability changed at this step.</p>}
      <Table caption="Each qubit's own state (Bloch vector from its reduced density matrix, and purity). A qubit entangled with the rest has no state of its own.">
        <thead>
          <tr>
            <th className={th}>Qubit</th>
            {result.beforeQubits.length > 0 && <th className={th}>Bloch vector before</th>}
            <th className={th}>{result.beforeQubits.length > 0 ? 'Bloch vector after' : 'Bloch vector'}</th>
            <th className={th}>Purity</th>
            <th className={th}>Now</th>
          </tr>
        </thead>
        <tbody>
          <QubitRows before={result.beforeQubits} after={result.afterQubits} />
        </tbody>
      </Table>
    </div>
  )
}
