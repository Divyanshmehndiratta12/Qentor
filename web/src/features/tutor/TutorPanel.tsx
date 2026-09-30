/**
 * The AI tutor panel (the Lab's bottom panel, and the Guide's embedded tutor).
 * Per docs/AI_BOUNDARY.md, the client sends the learner's question plus **ids
 * and the current circuit only** — never a probability, count, amplitude,
 * verdict or lesson text. The server (`POST /api/tutor`) is the only place that
 * reads the persisted execution and the lesson registry and builds the facts an
 * answer is grounded in; this component only renders exactly what it returned.
 *
 * WHICH CONVERSATION. A panel shows exactly one conversation, chosen by its
 * `context` (see `tutorContext.ts`): the Lab's (the default — so the Lab footer
 * is unchanged), one lesson's, or none. It never shows another context's turns,
 * and it can ask only about its own context:
 *
 * - `lab`: needs a real execution result; sends result id + circuit (exactly the
 *   original request).
 * - `lesson`: needs no Lab result; sends `lesson_id` (+ `section_id`) only. The
 *   backend resolves them against its own lesson registry, so no lesson text is
 *   ever held or sent here. Each typed question is independent — the backend
 *   has no conversation-history protocol, and none is invented here.
 * - `none` (Learn, no lesson open): nothing to ask about.
 *
 * State lives in `useBuildStore` (`tutorTurns`/`lessonTutorTurns`/`askTutor`),
 * not local state, so the Lab conversation is cleared exactly where `result`
 * is — a past answer grounded in a circuit that has since changed is stale.
 *
 * The visual design (chat bubbles, suggestion chips) deliberately does NOT port
 * the finalized design's own tutor logic, which calls an LLM directly from the
 * browser with computed amplitudes/counts spliced into the prompt — that is
 * exactly what AI_BOUNDARY.md forbids.
 */
import { useState } from 'react'
import type { TutorLanguage } from '@/api'
import type { TutorTurn } from '@/features/build/store'
import { useBuildStore } from '@/features/build/store'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { executionStatusLabel } from '@/provenance/executionStatus'
import type { ExecutionStatus } from '@/provenance/schema'
import {
  LAB_TUTOR_CONTEXT,
  TRACE_STEP_QUESTION,
  isAskingFor,
  tutorContextKey,
  tutorTurnsFor,
  type TutorContext,
} from './tutorContext'

const STARTER_QUESTIONS = ['What does this circuit do?', 'What was the result?']

/** Matches `TutorLanguage` — labels only, the code sent to the backend is
 * what actually selects the deterministic template / LLM prompt language. */
const LANGUAGE_LABELS: Record<TutorLanguage, string> = {
  en: 'English',
  hi: 'हिन्दी',
  kn: 'ಕನ್ನಡ',
}

/**
 * `showStarters` (default true, i.e. exactly the original behaviour) controls
 * only the two starter-question chips shown before the first answer in the Lab.
 * The Qentor Guide embeds this same panel with `showStarters={false}` because it
 * offers its own context-specific quick questions above it — one tutor, not two.
 *
 * `context` (default: the Lab) selects the conversation; see the file header.
 */
export function TutorPanel({
  showStarters = true,
  context = LAB_TUTOR_CONTEXT,
}: { showStarters?: boolean; context?: TutorContext } = {}) {
  const [question, setQuestion] = useState('')
  const result = useBuildStore((s) => s.result)
  const hasTraceStep = useBuildStore((s) => s.trace !== null && s.trace.steps[s.selectedTraceStep] !== undefined)
  const executionError = useBuildStore((s) => s.executionError)
  const turns = useBuildStore((s) => tutorTurnsFor(s, context))
  const asking = useBuildStore((s) => isAskingFor(s, context))
  const askTutor = useBuildStore((s) => s.askTutor)
  const tutorLanguage = useBuildStore((s) => s.tutorLanguage)
  const setTutorLanguage = useBuildStore((s) => s.setTutorLanguage)

  // The Lab needs a real result to ground on; a lesson needs only itself.
  const hasContext = context.kind === 'lab' ? Boolean(result) : context.kind === 'lesson'
  const canAsk = hasContext && !asking
  // In the Lab a selected trace step is enough to ask about, with or without a result.
  const canAskStep = (context.kind === 'lab' ? hasTraceStep : false) && !asking

  function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed || !(canAsk || (trimmed === TRACE_STEP_QUESTION && canAskStep))) return
    setQuestion('')
    if (context.kind === 'lesson') {
      void askTutor(trimmed, { lessonId: context.lessonId, sectionId: context.sectionId })
    } else {
      void askTutor(trimmed)
    }
  }

  const placeholder =
    context.kind === 'lesson'
      ? 'Ask about this lesson…'
      : context.kind === 'none'
        ? 'Open a lesson first…'
        : result
          ? 'Ask about this result…'
          : 'Run the circuit first…'

  return (
    <div className="flex h-full flex-col" data-tutor-context={tutorContextKey(context)}>
      <div className="flex items-center justify-between border-b border-void-500 px-4 py-2">
        <h2 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">Tutor</h2>
        <div className="flex items-center gap-2.5">
          <select
            aria-label="Tutor answer language"
            value={tutorLanguage}
            onChange={(e) => setTutorLanguage(e.target.value as TutorLanguage)}
            className="rounded-md border border-void-400 bg-void-800 px-1.5 py-1 text-[11px] text-slate-300 focus:border-violet-glow focus:outline-none"
          >
            {(Object.keys(LANGUAGE_LABELS) as TutorLanguage[]).map((code) => (
              <option key={code} value={code}>
                {LANGUAGE_LABELS[code]}
              </option>
            ))}
          </select>
          <ContextBadge context={context} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {turns.length === 0 && (
          <div className="rounded-lg border border-void-500 bg-void-800 p-3.5">
            <p className="font-serif-prose text-[15px] leading-snug text-slate-200">
              {context.kind === 'lesson'
                ? 'Ask a question about this lesson, or pick a quick question above. Answers come from the lesson material, not from a Lab run.'
                : context.kind === 'none'
                  ? 'No lesson is open, so there is nothing to ask about yet. The tutor answers from a lesson’s material.'
                  : result
                    ? 'Ask about the circuit you just ran. The tutor only ever explains results the backend actually produced.'
                    : executionError
                      ? "The last run didn't succeed, so there's nothing to ask about yet. Fix the circuit and run it again."
                      : 'Run the circuit to get a result, then ask about it. The tutor only ever explains results the backend actually produced.'}
            </p>
            {context.kind === 'lab' && (result || hasTraceStep) && showStarters && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {/* The usual starters need a Lab result; the one contextual starter needs a selected trace step. */}
                {[...(result ? STARTER_QUESTIONS : []), ...(hasTraceStep ? [TRACE_STEP_QUESTION] : [])].map((q) => (
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
            )}
          </div>
        )}

        <div role="log" aria-label="Tutor conversation" aria-live="polite" className="flex flex-col gap-2.5">
          {turns.map((turn, i) => (
            <TurnBubble key={i} turn={turn} />
          ))}
        </div>
        {asking && (
          <p role="status" className="mt-2.5 flex items-center gap-2 font-mono-qasm text-xs text-void-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-glow" />
            {context.kind === 'lesson' ? 'reading the lesson…' : 'reading the circuit…'}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-void-500 p-3">
        <input
          aria-label="Ask the tutor"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit(question)}
          disabled={!canAsk}
          placeholder={placeholder}
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

/** What this panel's answers are grounded in, at a glance. */
function ContextBadge({ context }: { context: TutorContext }) {
  const result = useBuildStore((s) => s.result)
  if (context.kind === 'lab') {
    return result ? (
      <ProvenanceBadge provenance={result.provenance} />
    ) : (
      <span className="flex items-center gap-1.5 font-mono-qasm text-[11px] text-void-200">
        <span className="h-1.5 w-1.5 rounded-full bg-void-300" />
        no result to ground on yet
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 font-mono-qasm text-[11px] text-void-200">
      <span className={`h-1.5 w-1.5 rounded-full ${context.kind === 'lesson' ? 'bg-cyan-glow' : 'bg-void-300'}`} />
      {context.kind === 'lesson' ? `lesson material · ${context.lessonId}` : 'no lesson open'}
    </span>
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
      <div role="alert" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-2.5 text-xs text-danger-glow">
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
        <AnswerSource answer={answer} />
      </div>
    </div>
  )
}

/**
 * Says where an answer came from. Three cases, never blurred:
 * - a quantum result only: the existing provenance line, unchanged;
 * - lesson material only: no result and no provenance — "lesson material, not a
 *   quantum result";
 * - both: the result's provenance line AND, separately, the lesson material line,
 *   so the learner can tell which claim came from which source.
 */
function AnswerSource({ answer }: { answer: Extract<TutorTurn, { role: 'tutor' }>['answer'] }) {
  const lesson = answer.lessonId
    ? `lesson ${answer.lessonId}${answer.sectionId ? ` · section ${answer.sectionId}` : ''}`
    : null
  const step = answer.traceStep
    ? `trace step ${answer.traceStep.stepNumber} of ${answer.traceStep.totalSteps} · ${answer.traceStep.resultId} · ${answer.traceStep.provenanceClass} · ${executionStatusLabel(answer.traceStep.verificationStatus as ExecutionStatus)}`
    : null

  if (answer.resultId === null) {
    // A lesson-only answer: course material from the lesson registry.
    return (
      <p className="mt-1.5 font-mono-qasm text-[11px] text-void-200">
        from {lesson ?? 'lesson material'} · lesson material, not a quantum result
      </p>
    )
  }
  return (
    <>
      <p className="mt-1.5 font-mono-qasm text-[11px] text-void-200">
        grounded in {answer.resultId} · {answer.provenanceClass} · {answer.verificationStatus ? executionStatusLabel(answer.verificationStatus as ExecutionStatus) : ''}
      </p>
      {step && <p className="mt-0.5 font-mono-qasm text-[11px] text-void-200">about {step}</p>}
      {lesson && (
        <p className="mt-0.5 font-mono-qasm text-[11px] text-void-200">
          plus {lesson} · lesson material, not a quantum result
        </p>
      )}
    </>
  )
}
