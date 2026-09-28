/**
 * Bottom AI tutor panel. Per docs/AI_BOUNDARY.md, the client sends the
 * learner's question plus **a result id and the current circuit only** —
 * never a probability, count, amplitude or verdict pulled off the results
 * panel. The server (`POST /api/tutor`) is the only place that reads the
 * persisted execution and builds the fact sheet the answer is grounded in;
 * this component only renders exactly what it returned.
 *
 * Conversation state lives in `useBuildStore` (`tutorTurns`/`isAskingTutor`/
 * `askTutor`), not local state, specifically so it is cleared in the same
 * places `result`/`verification` are — a past answer grounded in a circuit
 * that has since changed is stale and must not linger on screen.
 *
 * This restyle (chat bubbles, suggestion chips, context card) is visual
 * only. It deliberately does NOT port the finalized design's own tutor
 * logic, which calls an LLM directly from the browser with computed
 * amplitudes/counts spliced into the prompt — that is exactly what
 * AI_BOUNDARY.md forbids.
 */
import { useState } from 'react'
import type { TutorTurn } from '@/features/build/store'
import { useBuildStore } from '@/features/build/store'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'

const STARTER_QUESTIONS = ['What does this circuit do?', 'What was the result?']

export function TutorPanel() {
  const [question, setQuestion] = useState('')
  const result = useBuildStore((s) => s.result)
  const executionError = useBuildStore((s) => s.executionError)
  const turns = useBuildStore((s) => s.tutorTurns)
  const asking = useBuildStore((s) => s.isAskingTutor)
  const askTutor = useBuildStore((s) => s.askTutor)

  const canAsk = Boolean(result) && !asking

  function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed || !canAsk) return
    setQuestion('')
    void askTutor(trimmed)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-void-500 px-4 py-2">
        <h2 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">Tutor</h2>
        {result ? (
          <ProvenanceBadge provenance={result.provenance} />
        ) : (
          <span className="flex items-center gap-1.5 font-mono-qasm text-[11px] text-void-200">
            <span className="h-1.5 w-1.5 rounded-full bg-void-300" />
            no result to ground on yet
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {!result && turns.length === 0 && (
          <div className="rounded-lg border border-void-500 bg-void-800 p-3.5">
            <p className="font-serif-prose text-[15px] leading-snug text-slate-200">
              {executionError
                ? "The last run didn't succeed, so there's nothing to ask about yet. Fix the circuit and run it again."
                : 'Run the circuit to get a result, then ask about it. The tutor only ever explains results the backend actually produced.'}
            </p>
          </div>
        )}

        {result && turns.length === 0 && (
          <div className="rounded-lg border border-void-500 bg-void-800 p-3.5">
            <p className="font-serif-prose text-[15px] leading-snug text-slate-200">
              Ask about the circuit you just ran. The tutor only ever explains results the backend
              actually produced.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {STARTER_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => submit(q)}
                  className="rounded-md border border-void-400 px-2.5 py-1.5 text-xs text-slate-300 hover:border-void-300 hover:text-slate-100"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {turns.map((turn, i) => (
            <TurnBubble key={i} turn={turn} />
          ))}
        </div>
        {asking && (
          <p className="mt-2.5 flex items-center gap-2 font-mono-qasm text-xs text-void-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-glow" />
            reading the circuit…
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-void-500 p-3">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit(question)}
          disabled={!canAsk}
          placeholder={result ? 'Ask about this result…' : 'Run the circuit first…'}
          className="flex-1 rounded-lg border border-void-400 bg-void-800 px-3 py-2 text-sm text-slate-200 placeholder:text-void-200 focus:border-violet-glow focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => submit(question)}
          disabled={!canAsk || !question.trim()}
          className="rounded-lg bg-violet-glow px-3.5 py-2 text-sm font-semibold text-void-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Ask
        </button>
      </div>
    </div>
  )
}

function AiAvatar() {
  return (
    <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-slate-100 font-mono-qasm text-[9px] font-semibold text-void-950">
      AI
    </span>
  )
}

function TurnBubble({ turn }: { turn: TutorTurn }) {
  if (turn.role === 'learner') {
    return (
      <p className="max-w-[86%] self-end rounded-tl-[10px] rounded-tr-[10px] rounded-br-[3px] rounded-bl-[10px] bg-void-500 px-3 py-2 text-sm text-slate-100">
        {turn.text}
      </p>
    )
  }
  if (turn.role === 'error') {
    return (
      <div className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-2.5 text-xs text-danger-glow">
        {turn.message}
      </div>
    )
  }

  const { answer } = turn
  return (
    <div className="flex items-start gap-2.5">
      <AiAvatar />
      <div className="min-w-0 flex-1">
        {answer.usedFallbackTemplate && (
          <span className="mb-1.5 inline-block rounded-full border border-amber-glow/50 bg-amber-dim/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-glow">
            template fallback · no AI
          </span>
        )}
        <p className="font-serif-prose text-[15px] leading-relaxed whitespace-pre-wrap text-slate-100">
          {answer.answer}
        </p>
        {answer.facts.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 font-mono-qasm text-[11px] text-violet-glow/80">
            {answer.facts.map((fact) => (
              <li key={fact.id}>
                <span className="font-semibold">{fact.id}</span> · {fact.description}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 font-mono-qasm text-[11px] text-void-200">
          grounded in {answer.resultId} · {answer.provenanceClass} · {answer.verificationStatus}
        </p>
      </div>
    </div>
  )
}
