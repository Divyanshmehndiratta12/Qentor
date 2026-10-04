/**
 * A step-by-step player for a lesson's sections: shows exactly one section
 * at a time with explicit Back/Continue navigation, replacing the previous
 * milestone's all-sections-visible list. A section becomes "completed" only
 * when the learner explicitly clicks Continue/Finish on it — never merely
 * from being rendered (see `lessonState.ts`'s `LessonProgress` docstring).
 *
 * `activeSectionIndex` (navigation: which step is shown) and completion
 * (progress: what's actually done) both live in `useLearnStore`, not
 * component state — that's what makes leaving this lesson (switching to Lab,
 * or selecting a different lesson) and coming back resume exactly where the
 * learner left off, with no extra plumbing here.
 *
 * Interactive lab: `onOpenLab` only ever hands the lesson's already-validated
 * canonical `linkedCircuit` to the existing Build/Lab flow (`App.tsx`'s
 * `loadCircuit`) — nothing here executes or simulates anything, and nothing
 * here infers a "successful" lab run from Lab's own state. Completing this
 * step is the same explicit Continue click as every other section type,
 * whether or not the learner actually ran the circuit in Lab.
 */
import { useEffect, useRef } from 'react'
import type { Circuit } from '@/circuit/types'
import type { LabCapability, Lesson, LessonSection } from '@/api'
import { useLearnStore } from './store'
import { canContinueFromSection, isFullConceptCheck } from './lessonState'
import { ConceptCheckQuiz } from './ConceptCheckQuiz'
import { VariationalLab } from './VariationalLab'

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
  variational_sweep: 'variational sweep',
  noise_compare: 'ideal-versus-noisy comparison',
}

export function LessonPlayer({
  lesson,
  onOpenLab,
  onOpenNoiseLab,
}: {
  lesson: Lesson
  onOpenLab: (circuit: Circuit) => void
  onOpenNoiseLab?: (circuit: Circuit) => void
}) {
  const progress = useLearnStore((s) => s.lessonProgress[lesson.id])
  const setActiveSectionIndex = useLearnStore((s) => s.setActiveSectionIndex)
  const completeSection = useLearnStore((s) => s.completeSection)

  const total = lesson.sections.length
  const activeIndex = Math.min(progress?.activeSectionIndex ?? 0, total)
  const atEnd = activeIndex >= total
  const section = atEnd ? null : lesson.sections[activeIndex]

  // Progress, not position: how many sections the learner has explicitly
  // completed. Deliberately not derived from `activeIndex` — going Back moves
  // the position without changing this number.
  const completedCount = lesson.sections.filter((s) => progress?.completedSectionIds.has(s.id)).length

  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [lesson.id, activeIndex])

  function handleBack() {
    setActiveSectionIndex(lesson.id, Math.max(0, activeIndex - 1))
  }

  function handleContinue() {
    if (section) completeSection(lesson.id, section.id)
    setActiveSectionIndex(lesson.id, activeIndex + 1)
  }

  const canContinue = section ? canContinueFromSection(section, progress) : false

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between font-mono-qasm text-[11px] text-void-200">
          <span>{atEnd ? 'Lesson complete' : `Step ${activeIndex + 1} of ${total}`}</span>
          <span>
            {completedCount}/{total} completed
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={`${lesson.title} lesson progress`}
          aria-valuenow={completedCount}
          aria-valuemin={0}
          aria-valuemax={total}
          className="mt-1.5 flex gap-1"
        >
          {lesson.sections.map((s, i) => {
            const state = progress?.completedSectionIds.has(s.id)
              ? 'completed'
              : i === activeIndex
                ? 'current'
                : 'upcoming'
            return (
              <span
                key={s.id}
                title={`Step ${i + 1}: ${state}`}
                className={`h-1.5 flex-1 rounded-full ${
                  state === 'completed' ? 'bg-cyan-glow' : state === 'current' ? 'bg-violet-glow' : 'bg-void-600'
                }`}
              />
            )
          })}
        </div>
      </div>

      {section ? (
        <div className="rounded-lg border border-void-500 bg-void-900 p-4">
          <div className="flex items-center justify-between gap-2">
            <h4 ref={headingRef} tabIndex={-1} className="text-sm font-medium text-slate-200 outline-none">
              {section.title}
            </h4>
            <span className="shrink-0 rounded-full border border-void-400 px-1.5 py-0.5 font-mono-qasm text-[10px] text-void-200">
              {SECTION_LABEL[section.type]}
            </span>
          </div>

          {section.type === 'explanation' && (
            <p className="mt-2 font-serif-prose text-[14px] leading-relaxed text-slate-300">{section.body}</p>
          )}

          {section.type === 'reflection' && (
            <p className="mt-2 font-serif-prose text-[14px] leading-relaxed text-slate-300">{section.prompt}</p>
          )}

          {section.type === 'concept_check' &&
            (isFullConceptCheck(section) ? (
              <ConceptCheckQuiz lessonId={lesson.id} section={section} />
            ) : (
              <>
                <p className="mt-2 text-sm text-slate-300">{section.prompt}</p>
                <p className="mt-1.5 text-[11px] text-void-200">Not scored — for your own understanding only.</p>
              </>
            ))}

          {section.type === 'interactive_lab' && (
            <div className="mt-2 flex w-full flex-col items-start gap-2">
              <p className="text-sm text-slate-300">{section.instructions}</p>
              <button
                type="button"
                disabled={!lesson.linkedCircuit}
                onClick={() => {
                  if (!lesson.linkedCircuit) return
                  // A noise lab opens in the Noise Lab (the same circuit on the same canvas); every other lab opens in the Lab.
                  if (section.capability === 'noise_compare' && onOpenNoiseLab) onOpenNoiseLab(lesson.linkedCircuit)
                  else onOpenLab(lesson.linkedCircuit)
                }}
                className="rounded-lg bg-violet-glow px-3 py-1.5 text-xs font-semibold text-void-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {section.capability === 'noise_compare' && onOpenNoiseLab ? 'Open in Noise Lab' : 'Open in Lab'}
              </button>
              <p className="font-mono-qasm text-[10px] text-void-200">
                {section.capability === 'variational_sweep'
                  ? 'the sweep and the optimiser below are computed by the server — nothing is computed here'
                  : section.capability === 'noise_compare'
                    ? 'the ideal and the noisy run are both made by the server on a simulator, and the noise is simulated — nothing is computed here'
                    : `uses the existing ${CAPABILITY_LABEL[section.capability]} capability — nothing is computed here`}
              </p>
              {section.capability === 'variational_sweep' && <VariationalLab />}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-cyan-glow/40 bg-cyan-dim/20 p-4 text-center">
          <h4 ref={headingRef} tabIndex={-1} className="text-sm font-medium text-cyan-glow outline-none">
            Lesson complete
          </h4>
          <p className="mt-1 text-[12px] text-slate-300">You've been through every section in this lesson.</p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleBack}
          disabled={activeIndex === 0}
          className="rounded-lg border border-void-400 px-3 py-1.5 text-xs font-medium text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back
        </button>
        {!atEnd && (
          <button
            type="button"
            onClick={handleContinue}
            disabled={!canContinue}
            className="rounded-lg bg-cyan-glow px-3.5 py-1.5 text-xs font-semibold text-void-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {activeIndex === total - 1 ? 'Finish lesson' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  )
}
