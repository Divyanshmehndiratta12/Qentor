/**
 * Renders one lesson section, dispatching on its `type`. Per CLAUDE.md/
 * docs/AI_BOUNDARY.md, nothing here ever computes or simulates a quantum
 * result: `interactive_lab` only hands the lesson's already-validated
 * canonical `linkedCircuit` to `onOpenLab`, which loads it into the existing
 * Build/Lab workspace — the learner still has to Run it there, through the
 * real `/api/execute` (or whichever capability this section names) flow,
 * exactly like building a circuit by hand.
 *
 * Every section (of any type) is marked "visited" in `useLearnStore` on
 * mount — this is the "section progress" half of the completion rule (see
 * `lessonState.ts`). Because `LessonDetailPanel` renders every section of the
 * selected lesson at once (no accordion/stepper in this milestone), "visited"
 * is deliberately a simple "has this section's content been shown" signal,
 * not a scroll/viewport check.
 */
import { useEffect } from 'react'
import type { Circuit } from '@/circuit/types'
import type { LabCapability, LessonSection } from '@/api'
import { useLearnStore } from './store'
import { isFullConceptCheck } from './lessonState'
import { ConceptCheckQuiz } from './ConceptCheckQuiz'

const SECTION_LABEL: Record<LessonSection['type'], string> = {
  explanation: 'Explanation',
  concept_check: 'Check your understanding',
  interactive_lab: 'Interactive lab',
  reflection: 'Reflection',
}

const CAPABILITY_LABEL: Record<LabCapability, string> = {
  execute: 'execute',
  verify_bell_state: 'verify Bell state',
  multi_input_test: 'multi-input test',
  optimize: 'optimize',
}

export function LessonSectionView({
  lessonId,
  section,
  linkedCircuit,
  onOpenLab,
}: {
  lessonId: string
  section: LessonSection
  linkedCircuit: Circuit | null
  onOpenLab: (circuit: Circuit) => void
}) {
  const markSectionVisited = useLearnStore((s) => s.markSectionVisited)

  useEffect(() => {
    markSectionVisited(lessonId, section.id)
  }, [lessonId, section.id, markSectionVisited])

  return (
    <section
      className="rounded-lg border border-void-500 bg-void-900 p-3.5"
      aria-label={`${SECTION_LABEL[section.type]}: ${section.title}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-slate-200">{section.title}</h4>
        <span className="shrink-0 rounded-full border border-void-400 px-1.5 py-0.5 font-mono-qasm text-[10px] text-void-200">
          {SECTION_LABEL[section.type]}
        </span>
      </div>

      {section.type === 'explanation' && (
        <p className="mt-2 font-serif-prose text-[14px] leading-relaxed text-slate-300">{section.body}</p>
      )}

      {section.type === 'concept_check' &&
        (isFullConceptCheck(section) ? (
          <ConceptCheckQuiz lessonId={lessonId} section={section} />
        ) : (
          <>
            <p className="mt-2 text-sm text-slate-300">{section.prompt}</p>
            <p className="mt-1.5 text-[11px] text-void-200">Not scored — for your own understanding only.</p>
          </>
        ))}

      {section.type === 'reflection' && (
        <p className="mt-2 font-serif-prose text-[14px] leading-relaxed text-slate-300">{section.prompt}</p>
      )}

      {section.type === 'interactive_lab' && (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p className="text-sm text-slate-300">{section.instructions}</p>
          <button
            type="button"
            disabled={!linkedCircuit}
            onClick={() => linkedCircuit && onOpenLab(linkedCircuit)}
            className="rounded-lg bg-violet-glow px-3 py-1.5 text-xs font-semibold text-void-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Open in Lab
          </button>
          <p className="font-mono-qasm text-[10px] text-void-200">
            uses the existing {CAPABILITY_LABEL[section.capability]} capability — nothing is computed here
          </p>
        </div>
      )}
    </section>
  )
}
