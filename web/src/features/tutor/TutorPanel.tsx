/**
 * Bottom AI tutor panel. Per docs/AI_BOUNDARY.md, the client sends the
 * learner's question plus **result ids only** — never a number pulled off
 * the results panel — and the server is responsible for building a fact
 * sheet from its own provenance log. No tutor module exists server-side yet
 * (`backend/qentor/` has no `tutor/` package), so the real client throws
 * `EndpointNotImplementedError`, shown honestly rather than answered with an
 * invented reply. With `VITE_USE_MOCK_API=true`, replies are visibly tagged
 * FIXTURE so a mock reply can never be mistaken for a real grounded answer.
 *
 * This restyle (chat bubbles, suggestion chips, context card) is visual
 * only. It deliberately does NOT port the finalized design's own tutor
 * logic, which calls an LLM directly from the browser with computed
 * amplitudes/counts spliced into the prompt — that is exactly what
 * AI_BOUNDARY.md forbids. `handleAsk` below is unchanged: question text plus
 * `resultIds`, nothing else.
 */
import { useState } from 'react'
import { getApiClient, EndpointNotImplementedError } from '@/api'
import type { TutorReply } from '@/api'
import { useBuildStore } from '@/features/build/store'

type Turn =
  | { role: 'learner'; text: string }
  | { role: 'tutor'; reply: TutorReply }
  | { role: 'unavailable'; message: string }
  | { role: 'error'; message: string }

const STARTER_QUESTIONS = ['What does this circuit do?', 'Explain the last result']

export function TutorPanel() {
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [asking, setAsking] = useState(false)
  const currentResultId = useBuildStore((s) => s.result?.provenance.resultId ?? null)

  async function ask(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    setQuestion('')
    setTurns((t) => [...t, { role: 'learner', text: trimmed }])
    setAsking(true)
    try {
      const reply = await getApiClient().askTutor({
        question: trimmed,
        resultIds: currentResultId ? [currentResultId] : [],
      })
      setTurns((t) => [...t, { role: 'tutor', reply }])
    } catch (err) {
      if (err instanceof EndpointNotImplementedError) {
        setTurns((t) => [...t, { role: 'unavailable', message: err.message }])
      } else {
        setTurns((t) => [...t, { role: 'error', message: err instanceof Error ? err.message : String(err) }])
      }
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-void-500 px-4 py-2">
        <h2 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">Tutor</h2>
        <span
          className={`flex items-center gap-1.5 font-mono-qasm text-[11px] ${
            currentResultId ? 'text-cyan-glow' : 'text-void-200'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${currentResultId ? 'bg-cyan-glow' : 'bg-void-300'}`} />
          {currentResultId ? `grounded in ${currentResultId}` : 'no result to ground on yet'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {turns.length === 0 && (
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
                  onClick={() => void ask(q)}
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
          onKeyDown={(e) => e.key === 'Enter' && void ask(question)}
          placeholder="Ask about this result…"
          className="flex-1 rounded-lg border border-void-400 bg-void-800 px-3 py-2 text-sm text-slate-200 placeholder:text-void-200 focus:border-violet-glow focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void ask(question)}
          disabled={asking || !question.trim()}
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

function TurnBubble({ turn }: { turn: Turn }) {
  if (turn.role === 'learner') {
    return (
      <p className="max-w-[86%] self-end rounded-tl-[10px] rounded-tr-[10px] rounded-br-[3px] rounded-bl-[10px] bg-void-500 px-3 py-2 text-sm text-slate-100">
        {turn.text}
      </p>
    )
  }
  if (turn.role === 'unavailable') {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-void-500 bg-void-800 p-2.5 text-xs text-void-200">
        <AiAvatar />
        <p>
          The AI tutor isn't connected yet — no tutor endpoint exists on the backend
          (<code className="font-mono-qasm">POST /api/tutor</code>). Nothing is faked here.
        </p>
      </div>
    )
  }
  if (turn.role === 'error') {
    return (
      <div className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-2.5 text-xs text-danger-glow">
        {turn.message}
      </div>
    )
  }
  const { reply } = turn
  return (
    <div className="flex items-start gap-2.5">
      <AiAvatar />
      <div className="min-w-0 flex-1">
        {reply.usedFallbackTemplate && (
          <span className="mb-1.5 inline-block rounded-full border border-amber-glow/50 bg-amber-dim/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-glow">
            template fallback · no AI
          </span>
        )}
        {reply.segments.map((s, i) => (
          <p key={i} className="font-serif-prose text-[15px] leading-relaxed whitespace-pre-wrap text-slate-100">
            {s}
          </p>
        ))}
        {reply.factReferences.length > 0 && (
          <p className="mt-1.5 font-mono-qasm text-[11px] text-violet-glow/80">
            referencing: {reply.factReferences.map((f) => f.resultId).join(', ')}
          </p>
        )}
        {reply.rejectedClaimCount > 0 && (
          <p className="mt-1.5 font-mono-qasm text-[11px] text-amber-glow">
            {reply.rejectedClaimCount} AI claim(s) rejected by the simulator
          </p>
        )}
      </div>
    </div>
  )
}
