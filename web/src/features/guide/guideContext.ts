/**
 * What the Guide knows about where the learner is — READ from state that
 * already exists (`useBuildStore`, `useLearnStore`), never invented, never
 * copied into the tutor.
 *
 * The tutor API takes `{result_id, circuit, question, language}` and,
 * optionally, `{lesson_id, section_id}` (`backend/qentor/api/schemas.py::
 * TutorRequest`). The backend resolves the lesson ids against its own lesson
 * registry, so the Guide sends IDENTIFIERS only — it holds no lesson text and
 * has no lesson registry of its own.
 *
 * - Lab: the circuit (size only), the latest real execution result if there is
 *   one, and whether a trace is loaded. Quick actions are grounded in that
 *   result and are enabled only when a real one exists — never pretended.
 * - Learn: the open lesson and current step, by title, from the Learn store.
 *   Quick actions send the open lesson's id and the current section's id, and
 *   the backend answers from that lesson's material. They need no Lab result
 *   and do not attach one: a Lab result belongs to whatever circuit the learner
 *   built, which need not be the lesson's, so lesson questions stay lesson
 *   questions. With no lesson open there is nothing to ask about, and they are
 *   disabled with a reason.
 *
 * Quick-action questions are fixed strings. They contain no quantum content.
 * The Lab wording matches what the backend's deterministic tutor routes on
 * ("circuit"/"gate"/"what does" -> circuit summary; "result" -> result
 * summary); the Learn wording matches its lesson router (concept / simpler /
 * hint).
 */
import type { TutorLessonContext } from '@/api'
import { useBuildStore } from '@/features/build/store'
import { useLearnStore } from '@/features/learn/store'
import { LAB_TUTOR_CONTEXT, NO_TUTOR_CONTEXT, type TutorContext } from '@/features/tutor/tutorContext'

export type GuideScreen = 'lab' | 'learn'

export const LAB_QUICK_ACTIONS = [
  'Explain this circuit',
  'Explain my result',
  'What does each gate in this circuit do?',
] as const

export const LEARN_QUICK_ACTIONS = [
  'Explain this concept',
  'Give me a simpler explanation',
  'Give me a hint',
] as const

export const LAB_NEEDS_RESULT_NOTICE =
  'Quick questions unlock once there is a real result to ask about — run a circuit in the Lab first.'

export const LEARN_NEEDS_LESSON_NOTICE = 'Open a lesson to ask about it — the quick questions use the lesson you are on.'

export const LEARN_SOURCE_LINE = 'Answers here come from the lesson material, not from a Lab run.'

export interface GuideContextInput {
  screen: GuideScreen
  circuit: { num_qubits: number; ops: readonly unknown[] }
  result: { resultId: string; executionMode: string; backend: string } | null
  /** Number of steps in the loaded trace, or null when no trace is loaded. */
  traceSteps: number | null
  lesson: {
    id: string
    title: string
    stepNumber: number
    totalSteps: number
    /** The current section's id/title, or null once every step is done. */
    sectionId: string | null
    sectionTitle: string | null
  } | null
}

export interface GuideContext {
  screen: GuideScreen
  label: string
  /** Plain statements about the current context, from real state only. */
  lines: string[]
  quickActions: readonly string[]
  /** The result id Lab questions are grounded in, or null when there is none. */
  groundedResultId: string | null
  /**
   * For Learn with a lesson open: the identifiers the quick actions send.
   * `null` on Lab, and on Learn with no lesson open.
   */
  lessonRequest: TutorLessonContext | null
  /**
   * Which tutor conversation the Guide's embedded tutor shows and asks in:
   * the Lab's on Lab, the open lesson's on Learn, none on Learn with no lesson
   * open. (The Lab's is never shown on Learn, or a lesson's on Lab.)
   */
  tutorContext: TutorContext
  /** Whether the quick actions have anything real to ask about right now. */
  canAsk: boolean
  /** Why they cannot be used, when `canAsk` is false. */
  disabledReason: string | null
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function buildGuideContext(input: GuideContextInput): GuideContext {
  const { screen, circuit, result, traceSteps, lesson } = input
  const groundedResultId = result?.resultId ?? null

  if (screen === 'lab') {
    const lines = [
      `${plural(circuit.num_qubits, 'qubit')} · ${plural(circuit.ops.length, 'operation')} in the circuit`,
      result
        ? `Latest result: ${result.resultId} (${result.executionMode}, ${result.backend})`
        : 'No result yet — run the circuit, then ask about it.',
    ]
    if (traceSteps !== null) lines.push(`A trace of this circuit is loaded (${plural(traceSteps, 'step')}).`)
    return {
      screen,
      label: 'Lab',
      lines,
      quickActions: LAB_QUICK_ACTIONS,
      groundedResultId,
      lessonRequest: null,
      tutorContext: LAB_TUTOR_CONTEXT,
      canAsk: result !== null,
      disabledReason: result ? null : LAB_NEEDS_RESULT_NOTICE,
    }
  }

  const lines = [lesson ? `Lesson: ${lesson.title}` : 'No lesson is open — pick one from the list.']
  if (lesson) {
    lines.push(
      lesson.stepNumber > lesson.totalSteps
        ? 'You have been through every step of this lesson.'
        : `Step ${lesson.stepNumber} of ${lesson.totalSteps}${lesson.sectionTitle ? `: ${lesson.sectionTitle}` : ''}`,
    )
    lines.push(LEARN_SOURCE_LINE)
  }
  const lessonRequest: TutorLessonContext | null = lesson
    ? { lessonId: lesson.id, sectionId: lesson.sectionId }
    : null
  return {
    screen,
    label: 'Learn',
    lines,
    quickActions: LEARN_QUICK_ACTIONS,
    groundedResultId,
    lessonRequest,
    tutorContext: lessonRequest
      ? { kind: 'lesson', lessonId: lessonRequest.lessonId, sectionId: lessonRequest.sectionId }
      : NO_TUTOR_CONTEXT,
    canAsk: lessonRequest !== null,
    disabledReason: lessonRequest ? null : LEARN_NEEDS_LESSON_NOTICE,
  }
}

/** The context for `screen`, from the live stores. Read-only. */
export function useGuideContext(screen: GuideScreen): GuideContext {
  const circuit = useBuildStore((s) => s.circuit)
  const result = useBuildStore((s) => s.result)
  const trace = useBuildStore((s) => s.trace)
  const lessons = useLearnStore((s) => s.lessons)
  const selectedLessonId = useLearnStore((s) => s.selectedLessonId)
  const lessonProgress = useLearnStore((s) => s.lessonProgress)

  const selected = lessons.find((lesson) => lesson.id === selectedLessonId) ?? null
  const activeIndex = selected ? (lessonProgress[selected.id]?.activeSectionIndex ?? 0) : 0
  const section = selected?.sections[activeIndex] ?? null

  return buildGuideContext({
    screen,
    circuit,
    result: result
      ? {
          resultId: result.provenance.resultId,
          executionMode: result.provenance.executionMode,
          backend: result.provenance.backend,
        }
      : null,
    traceSteps: trace ? trace.steps.length : null,
    lesson: selected
      ? {
          id: selected.id,
          title: selected.title,
          stepNumber: activeIndex + 1,
          totalSteps: selected.sections.length,
          sectionId: section?.id ?? null,
          sectionTitle: section?.title ?? null,
        }
      : null,
  })
}
