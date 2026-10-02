/**
 * The Guide's side panel: a shell around the EXISTING tutor experience.
 *
 * What it adds: a heading and close button, a short "context" card (what a
 * question would be grounded in — see `guideContext.ts`), and a few quick
 * questions. What it does NOT add: a chatbot. The conversation, the answer
 * language, the deterministic fallback, the provenance badge and the guard all
 * come from the existing `TutorPanel` and `useBuildStore` (`tutorTurns`,
 * `lessonTutorTurns`, `tutorLanguage`, `askTutor`), which this panel embeds — so
 * opening, closing or re-opening the Guide cannot reset any of them, and there
 * is one source of truth for each. It tells the embedded tutor WHICH
 * conversation to show (`guideContext.tutorContext`: the Lab's on Lab, the open
 * lesson's on Learn), so a lesson never shows another lesson's — or the Lab's —
 * messages, and free-text questions on Learn are lesson questions.
 *
 * A quick action is just a fixed question string sent through the store's
 * existing `askTutor` (the same call the tutor's own input makes). On Lab the
 * request carries the latest execution's result id, the current circuit, the
 * question and the selected language. On Learn it carries the open lesson's
 * and section's IDS instead (`guideContext.lessonRequest`) — the backend
 * resolves them against its own lesson registry; no lesson text is sent or held
 * here. Never a quantum value either way. The panel never calls an LLM or any
 * API itself; it does not import the API layer at all. A button is enabled only
 * when there is something real to ask about (a Lab result / an open lesson);
 * otherwise the panel says why instead of implying otherwise.
 *
 * Accessibility: a labelled complementary region (not a modal — no focus trap,
 * so it can't strand a keyboard user), focus moves to it on open, Escape or the
 * close button closes it and the caller restores focus to the launcher.
 */
import { useEffect, useRef } from 'react'
import { useBuildStore } from '@/features/build/store'
import { TutorPanel } from '@/features/tutor/TutorPanel'
import { TRACE_STEP_QUESTION, isAskingFor } from '@/features/tutor/tutorContext'
import { GuideCharacter } from './GuideCharacter'
import { useGuideContext, type GuideScreen } from './guideContext'

export interface GuidePanelProps {
  screen: GuideScreen
  onClose: () => void
}

export function GuidePanel({ screen, onClose }: GuidePanelProps) {
  const context = useGuideContext(screen)
  const askTutor = useBuildStore((s) => s.askTutor)
  // In flight for THIS context's conversation only (not another lesson's, not the Lab's).
  const asking = useBuildStore((s) => isAskingFor(s, context.tutorContext))
  const panelRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  return (
    <aside
      ref={panelRef}
      id="qentor-guide-panel"
      data-testid="guide-panel"
      aria-labelledby="qentor-guide-heading"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
      className="qentor-guide-panel fixed top-[52px] right-0 bottom-0 z-40 flex w-[380px] max-w-full flex-col border-l border-void-500 bg-void-900 shadow-[-12px_0_32px_rgba(0,0,0,0.35)] outline-none focus-visible:ring-2 focus-visible:ring-cyan-glow/60"
    >
      <div className="flex items-center gap-2.5 border-b border-void-500 px-4 py-2.5">
        <GuideCharacter size={30} />
        <h2 id="qentor-guide-heading" className="font-sans-ui text-[15px] font-semibold text-slate-100">
          Qentor Guide
        </h2>
        <span className="rounded-full border border-void-400 px-2 py-0.5 font-mono-qasm text-[10px] text-slate-300">
          {context.label}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close guide panel"
          className="ml-auto grid h-7 w-7 place-items-center rounded-md border border-void-400 text-slate-300 hover:border-void-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
        >
          <span aria-hidden="true" className="text-base leading-none">
            ×
          </span>
        </button>
      </div>

      <section aria-label="Guide context" className="flex flex-col gap-1.5 border-b border-void-500 px-4 py-3">
        <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Where you are</h3>
        <ul className="flex flex-col gap-1 text-[13px] text-slate-300">
          {context.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="qentor-guide-quick" className="flex flex-col gap-2 border-b border-void-500 px-4 py-3">
        <h3 id="qentor-guide-quick" className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
          Quick questions
        </h3>
        <ul className="flex flex-wrap gap-1.5">
          {context.quickActions.map((question) => (
            <li key={question}>
              <button
                type="button"
                disabled={(question === TRACE_STEP_QUESTION ? !context.canAskStep : !context.canAsk) || asking}
                onClick={() =>
                  // Lab: the question alone (the store attaches the latest
                  // result + circuit). Learn: the same question plus the open
                  // lesson's and section's IDS — the backend resolves them.
                  void (context.lessonRequest ? askTutor(question, context.lessonRequest) : askTutor(question))
                }
                className="rounded-md border border-void-400 px-2.5 py-1.5 text-left text-xs text-slate-200 hover:border-violet-glow/60 hover:text-slate-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-void-400"
              >
                {question}
              </button>
            </li>
          ))}
        </ul>
        {context.disabledReason && (
          <p className="text-[11px] leading-snug text-void-200">{context.disabledReason}</p>
        )}
        {asking && <p className="text-[11px] text-void-200">Waiting for the tutor…</p>}
      </section>

      <div className="min-h-0 flex-1">
        <TutorPanel showStarters={false} showModes={false} context={context.tutorContext} landmarkSuffix=" (in the Guide)" />
      </div>
    </aside>
  )
}
