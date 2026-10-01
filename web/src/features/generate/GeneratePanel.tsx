/**
 * "Generate code": describe a circuit in words, a language model proposes OpenQASM 3, the server reads it, and the learner decides.
 *
 * What this panel shows, and refuses to show:
 *  - A proposal is ALWAYS labelled "AI proposal — not yet verified against your intent" (the server sends the label; it is shown
 *    verbatim and not hidden by any action). Nothing here says a proposal is correct, verified or equivalent to anything: the only
 *    claims are what the server did (it read the text into a circuit and it fits the limits) and, after Run, the backend's own
 *    result with its provenance.
 *  - The text offered for insertion is the server's CANONICAL emission of the parsed circuit, not the model's own text; the model's
 *    own text is kept behind a disclosure, for transparency.
 *  - The explanation is the model's only when the server's claim guard found no claim in it that no backend produced; otherwise it
 *    is written by the server from the parsed circuit, and the panel says which.
 *  - With no language model configured the panel says so and offers no form: Qentor has no other generator and substitutes nothing.
 *
 * Actions reuse the Lab: Insert replaces the circuit as ONE undo step; Run is the ordinary Run; Explain asks the ordinary
 * result-grounded tutor question; Reject forgets the proposal. No quantum number is computed or invented here.
 */
import { useEffect, useId } from 'react'
import type { CircuitProposal } from '@/api'
import { sameCircuit } from '@/circuit/edit'
import { useBuildStore } from '@/features/build/store'
import { useChallengeStore } from '@/features/challenges/store'
import { useLearnStore } from '@/features/learn/store'
import { StateNotice } from '@/features/shell/StateNotice'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { toQuantumValue } from '@/provenance/QuantumValue'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import { PROMPT_MAX, PROMPT_MIN, useGenerateStore } from './store'

const EXAMPLES = [
  'Create a Bell state using two qubits.',
  'Put one qubit into the |+⟩ state.',
  'Make a qubit that looks like |+⟩ when measured but has the opposite phase.',
  'Build a 3-qubit circuit that entangles all three qubits.',
]

const BUTTON =
  'rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-45'

/** `onShowExplanation`: called after Explain so the surrounding panel can show the tutor's answer (it is not shown here). */
export function GeneratePanel({
  onShowExplanation,
  challengeId,
}: {
  onShowExplanation?: () => void
  /** The challenge on screen, if there is one: the request then carries its id (the server adds its PUBLIC brief as context). */
  challengeId?: string | null
} = {}) {
  const availability = useGenerateStore((s) => s.availability)
  const checking = useGenerateStore((s) => s.checkingAvailability)
  const availabilityError = useGenerateStore((s) => s.availabilityError)
  const phase = useGenerateStore((s) => s.phase)
  const error = useGenerateStore((s) => s.error)
  const proposal = useGenerateStore((s) => s.proposal)
  const checkAvailability = useGenerateStore((s) => s.checkAvailability)

  useEffect(() => {
    if (availability === null && !checking && !availabilityError) void checkAvailability()
  }, [availability, checking, availabilityError, checkAvailability])

  const setChallengeId = useGenerateStore((s) => s.setChallengeId)
  useEffect(() => {
    if (challengeId !== undefined) setChallengeId(challengeId)
  }, [challengeId, setChallengeId])

  const unavailable = availability?.available === false || phase === 'unavailable'

  return (
    <section aria-label="Generate code" data-testid="generate-panel" className="flex h-full min-h-0 flex-col gap-3 overflow-auto px-4 py-3">
      {checking && availability === null && <StateNotice kind="loading" compact title="Checking whether AI code generation is available…" />}

      {availabilityError && availability === null && (
        <StateNotice
          kind="error"
          compact
          title="Could not check AI code generation"
          detail={availabilityError}
          hint="Nothing is generated or substituted."
          onRetry={() => void checkAvailability()}
        />
      )}

      {unavailable && <Unavailable reason={availability?.reason ?? error} />}

      {!unavailable && availability?.available && <RequestForm />}

      {phase === 'generating' && <StateNotice kind="loading" compact title="Asking the language model… this can take up to 20 seconds." />}

      {phase === 'failed' && (
        <StateNotice
          kind="error"
          compact
          title="The proposal could not be generated"
          detail={error ?? undefined}
          hint="No circuit was produced and nothing was substituted. Your circuit is unchanged."
          onRetry={() => void useGenerateStore.getState().retry()}
          retryLabel="Try again"
        />
      )}

      {proposal && proposal.status === 'REJECTED' && <Rejected proposal={proposal} />}
      {proposal && proposal.status === 'PROPOSED' && <Proposed proposal={proposal} onShowExplanation={onShowExplanation} />}
    </section>
  )
}

function Unavailable({ reason }: { reason: string | null }) {
  return (
    <div role="status" data-testid="generate-unavailable" className="rounded-lg border border-amber-glow/40 bg-amber-dim/20 p-3.5 text-[13px]">
      <p className="font-semibold text-amber-glow">AI code generation is not available on this server</p>
      <p className="mt-1.5 leading-snug text-slate-300">{reason ?? 'No language model is configured.'}</p>
      <p className="mt-2 leading-snug text-slate-300">
        Qentor does not make up a circuit in its place. Build one on the canvas, or write OpenQASM in the code editor: the backend
        reads, runs and verifies those exactly the same, and everything else in Qentor works without a language model.
      </p>
      <p className="mt-2 text-[11px] leading-snug text-void-200">
        For whoever runs the server: set QENTOR_TUTOR_LLM_ENABLED and an API key in the server&rsquo;s environment (see docs). The key
        is never sent to or stored in the browser.
      </p>
    </div>
  )
}

function RequestForm() {
  const promptId = useId()
  const prompt = useGenerateStore((s) => s.prompt)
  const setPrompt = useGenerateStore((s) => s.setPrompt)
  const phase = useGenerateStore((s) => s.phase)
  const generate = useGenerateStore((s) => s.generate)
  const includeCurrent = useGenerateStore((s) => s.includeCurrentCircuit)
  const setIncludeCurrent = useGenerateStore((s) => s.setIncludeCurrentCircuit)
  const lessonId = useGenerateStore((s) => s.lessonId)
  const setLessonId = useGenerateStore((s) => s.setLessonId)
  const challengeId = useGenerateStore((s) => s.challengeId)
  const setChallengeId = useGenerateStore((s) => s.setChallengeId)
  const hasOps = useBuildStore((s) => s.circuit.ops.length > 0)
  const lessons = useLearnStore((s) => s.lessons)
  const challenges = useChallengeStore((s) => s.challenges)
  const busy = phase === 'generating'
  const ready = prompt.trim().length >= PROMPT_MIN && !busy

  return (
    <form
      data-testid="generate-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) void generate()
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={promptId} className="text-[12px] font-medium text-slate-200">
        Describe the circuit you want
      </label>
      <textarea
        id={promptId}
        data-testid="generate-prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ready) {
            e.preventDefault()
            void generate()
          }
        }}
        rows={2}
        maxLength={PROMPT_MAX}
        disabled={busy}
        placeholder="For example: Create a Bell state using two qubits."
        aria-describedby={`${promptId}-help`}
        className="w-full resize-y rounded-lg border border-void-400 bg-void-800 px-3 py-2 text-sm text-slate-200 placeholder:text-void-200 focus:border-violet-glow focus:outline-none disabled:opacity-60"
      />
      <p id={`${promptId}-help`} className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-void-200">
        <span>The model writes OpenQASM 3 only. Qentor reads it itself and runs it on its own backend.</span>
        <span aria-label={`${prompt.length} of ${PROMPT_MAX} characters`}>
          {prompt.length}/{PROMPT_MAX}
        </span>
      </p>

      <div className="flex flex-wrap gap-1.5" aria-label="Example requests">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" onClick={() => setPrompt(example)} disabled={busy} className={`${BUTTON} border-void-400 text-slate-300 hover:border-void-300 hover:text-slate-100`}>
            {example}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-300">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={includeCurrent && hasOps} disabled={!hasOps || busy} onChange={(e) => setIncludeCurrent(e.target.checked)} />
          Use my current circuit as context
        </label>
        {lessons.length > 0 && (
          <label className="flex items-center gap-1.5">
            Lesson
            <select
              value={lessonId ?? ''}
              onChange={(e) => setLessonId(e.target.value || null)}
              disabled={busy}
              className="max-w-40 rounded border border-void-400 bg-void-800 px-1.5 py-1 text-[11px] text-slate-200"
            >
              <option value="">none</option>
              {lessons.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {challenges.length > 0 && (
          <label className="flex items-center gap-1.5">
            Challenge
            <select
              value={challengeId ?? ''}
              onChange={(e) => setChallengeId(e.target.value || null)}
              disabled={busy}
              className="max-w-40 rounded border border-void-400 bg-void-800 px-1.5 py-1 text-[11px] text-slate-200"
            >
              <option value="">none</option>
              {challenges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          data-testid="generate-submit"
          disabled={!ready}
          className={`${BUTTON} border-violet-glow bg-violet-glow text-void-950 hover:bg-violet-glow/90`}
        >
          {busy ? 'Generating…' : 'Generate a proposal'}
        </button>
        <span className="text-[11px] text-void-200">Ctrl+Enter</span>
      </div>
    </form>
  )
}

function Rejected({ proposal }: { proposal: CircuitProposal }) {
  const generate = useGenerateStore((s) => s.generate)
  const reject = useGenerateStore((s) => s.reject)
  return (
    <div role="alert" data-testid="proposal-rejected" className="flex flex-col gap-2 rounded-lg border border-danger-glow/40 bg-danger-dim/20 p-3 text-[13px]">
      <p className="font-semibold text-danger-glow">{proposal.label}</p>
      <p className="font-semibold text-danger-glow">The server could not use this proposal</p>
      <ul className="flex flex-col gap-1 text-slate-200">
        {proposal.problems.map((p, i) => (
          <li key={i}>
            {p.line !== null && <span className="font-mono-qasm text-danger-glow/90">line {p.line}: </span>}
            {p.message}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-400">It was not added to your circuit and cannot be. Nothing was run.</p>
      <details className="text-[11px] text-slate-300">
        <summary className="cursor-pointer">What the model wrote (rejected)</summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded border border-void-500 bg-void-950 p-2 font-mono-qasm text-[11px] whitespace-pre-wrap">{proposal.rawQasm}</pre>
      </details>
      <div className="flex gap-2">
        <button type="button" onClick={() => void generate()} data-testid="retry-generation" className={`${BUTTON} border-danger-glow/50 text-danger-glow hover:bg-danger-dim/60`}>
          Try again
        </button>
        <button type="button" onClick={reject} className={`${BUTTON} border-void-400 text-slate-300 hover:text-slate-100`}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

function Proposed({ proposal, onShowExplanation }: { proposal: CircuitProposal; onShowExplanation?: () => void }) {
  const insert = useGenerateStore((s) => s.insert)
  const run = useGenerateStore((s) => s.run)
  const explain = useGenerateStore((s) => s.explain)
  const reject = useGenerateStore((s) => s.reject)
  const buildCircuit = useBuildStore((s) => s.circuit)
  const isRunning = useBuildStore((s) => s.isExecuting)
  const isAsking = useBuildStore((s) => s.isAskingTutor)
  const canUndo = useBuildStore((s) => s.past.length > 0)
  const result = useBuildStore((s) => s.result)
  const mode = useBuildStore((s) => s.mode)

  const onCanvas = !!proposal.circuit && sameCircuit(buildCircuit, proposal.circuit)
  const resultIsForThis = onCanvas && result !== null
  const hasMeasurement = !!proposal.circuit?.ops.some((op) => op.gate === 'measure')

  return (
    <article data-testid="proposal-card" aria-label="AI proposal" className="flex flex-col gap-2.5 rounded-lg border border-amber-glow/40 bg-void-800 p-3">
      <header className="flex flex-wrap items-center gap-2">
        <span data-testid="proposal-label" className="rounded-full border border-amber-glow/60 bg-amber-dim/40 px-2 py-0.5 text-[11px] font-semibold text-amber-glow">
          {proposal.label}
        </span>
        <span className="font-mono-qasm text-[10px] text-void-200">
          proposed by {proposal.generator}
          {proposal.model ? ` · ${proposal.model}` : ''}
        </span>
      </header>

      <p data-testid="proposal-summary" className="text-[12px] leading-snug text-slate-300">
        {proposal.summary}
      </p>

      <div>
        <p className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">OpenQASM 3 (read and re-written by the server)</p>
        <pre data-testid="proposal-qasm" aria-label="Proposed OpenQASM 3" tabIndex={0} className="max-h-44 overflow-auto rounded border border-void-500 bg-void-950 p-2 font-mono-qasm text-[11px] leading-snug text-slate-200">
          {proposal.canonicalQasm}
        </pre>
        <p className="mt-1 font-mono-qasm text-[10px] text-void-200">circuit {proposal.circuitHash?.slice(0, 12)}…</p>
      </div>

      <div data-testid="proposal-explanation">
        <p className="mb-0.5 flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
          What it does
          <span
            data-testid="proposal-explanation-source"
            data-source={proposal.explanationSource ?? ''}
            className="rounded-full border border-void-400 px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-slate-300 normal-case"
          >
            {proposal.explanationSource === 'AI' ? 'written by the model, accepted by the claim guard' : 'written by Qentor from the parsed circuit'}
          </span>
        </p>
        <p className="text-[12px] leading-snug text-slate-200">{proposal.explanation}</p>
        {proposal.explanationNote && <p className="mt-1 text-[11px] text-amber-glow/90">{proposal.explanationNote}</p>}
      </div>

      {proposal.constraintNotes.length > 0 && (
        <ul data-testid="proposal-constraint-notes" className="list-disc pl-5 text-[11px] text-amber-glow/90">
          {proposal.constraintNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {proposal.rawQasm.trim() !== (proposal.canonicalQasm ?? '').trim() && (
        <details className="text-[11px] text-slate-300">
          <summary className="cursor-pointer">What the model wrote (before the server read it)</summary>
          <pre className="mt-1 max-h-32 overflow-auto rounded border border-void-500 bg-void-950 p-2 font-mono-qasm text-[11px] whitespace-pre-wrap">{proposal.rawQasm}</pre>
        </details>
      )}

      <div role="group" aria-label="What to do with this proposal" data-testid="proposal-actions" className="flex flex-wrap gap-2">
        <button type="button" onClick={() => insert()} disabled={onCanvas} className={`${BUTTON} border-cyan-glow/50 text-cyan-glow hover:bg-cyan-dim/40`}>
          Insert into editor
        </button>
        <button type="button" onClick={() => void run()} disabled={isRunning} className={`${BUTTON} border-void-300 text-slate-100 hover:bg-void-600`}>
          {isRunning ? 'Running…' : 'Run'}
        </button>
        <button
          type="button"
          onClick={() => {
            void explain()
            onShowExplanation?.()
          }}
          disabled={isRunning || isAsking}
          className={`${BUTTON} border-violet-glow/50 text-violet-glow hover:bg-violet-dim/40`}
        >
          Explain
        </button>
        <button type="button" onClick={reject} className={`${BUTTON} border-void-400 text-slate-300 hover:border-danger-glow hover:text-danger-glow`}>
          Reject
        </button>
      </div>

      {onCanvas && (
        <p role="status" data-testid="proposal-inserted" className="text-[11px] text-cyan-glow">
          This circuit is in the editor now.{canUndo ? ' Undo (Ctrl+Z) brings back the circuit it replaced.' : ''}
        </p>
      )}

      {resultIsForThis && result && (
        <div data-testid="proposal-result" className="rounded border border-void-500 bg-void-900 p-2.5">
          <p className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            What the backend computed for it <ProvenanceBadge provenance={result.provenance} />
          </p>
          {hasMeasurement && mode === 'statevector' ? (
            <p className="text-[11px] leading-snug text-amber-glow">
              This circuit contains measurements, so a statevector run shows one collapsed state, not the ideal distribution. Switch to shots
              mode to see sampled outcomes.
            </p>
          ) : (
            <OutcomeRows />
          )}
          <p className="mt-1.5 text-[11px] text-void-200">
            This is the backend&rsquo;s result for the circuit as written. Whether it is what you meant is for you to judge, or for a challenge&rsquo;s
            checker to decide when you submit it.
          </p>
        </div>
      )}
    </article>
  )
}

/** The backend's outcome numbers for the circuit on the canvas, each through `VerifiedValueInline` (no arithmetic here). */
function OutcomeRows() {
  const result = useBuildStore((s) => s.result)
  if (!result) return null
  const sampled = result.value.probabilities
  const values = sampled ?? result.value.theoreticalProbabilities
  if (!values) return null
  const rows = Object.keys(values).sort()
  return (
    <table className="w-full text-left text-[11px]">
      <caption className="sr-only">{sampled ? 'Sampled frequencies' : 'Theoretical probabilities'} by outcome, bitstrings q[n-1] … q[0]</caption>
      <thead>
        <tr className="text-void-200">
          <th scope="col" className="pb-1 font-medium">
            outcome
          </th>
          <th scope="col" className="pb-1 font-medium">
            {sampled ? 'sampled frequency' : 'theoretical probability'}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((bits) => (
          <tr key={bits} className="border-t border-void-600">
            <td className="py-1 font-mono-qasm text-slate-300">{bits}</td>
            <td className="py-1">
              <VerifiedValueInline quantum={toQuantumValue(values[bits] as number, result.provenance)} render={(v) => v.toFixed(6)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
