/**
 * Which conversation a tutor panel is showing — an explicit context, not "the
 * latest turns in the store".
 *
 * There are three contexts, and a conversation belongs to exactly one:
 *
 * - `lab`: the Lab conversation (grounded in the Build circuit's real result).
 *   It is the store's `tutorTurns`/`isAskingTutor`, exactly as before, so it is
 *   cleared in the same places `result` is (a circuit change makes every past
 *   answer stale).
 * - `lesson`: one conversation PER LESSON (`lessonTutorTurns[lessonId]`), kept
 *   for the rest of the session. A lesson conversation is not grounded in the
 *   Build circuit, so a circuit change does not touch it. Moving between
 *   SECTIONS of the same lesson keeps the same conversation (each answer states
 *   which section it was about); moving to a DIFFERENT lesson shows that
 *   lesson's own conversation — never the previous one's.
 * - `none`: Learn with no lesson open. There is nothing to ask about and no
 *   conversation to show (and the Lab's is never shown here).
 *
 * The answer language is deliberately not part of a context: switching language
 * never switches conversation, and switching conversation never resets it.
 *
 * All of this is in-memory session state. Nothing is persisted; a page reload
 * starts every conversation empty.
 */
import type { TutorTurn } from '@/features/build/store'

export type TutorContext =
  | { kind: 'lab' }
  | { kind: 'lesson'; lessonId: string; sectionId: string | null }
  | { kind: 'none' }

/** The one contextual starter offered when a trace is loaded. The backend's step
 * router recognises it (`qentor.tutor.step_answers`); it is a fixed string with no
 * quantum content. */
export const TRACE_STEP_QUESTION = 'What changed in this step?'

export const LAB_TUTOR_CONTEXT: TutorContext = { kind: 'lab' }
export const NO_TUTOR_CONTEXT: TutorContext = { kind: 'none' }

/** The identity of a conversation. Deliberately excludes the section: sections
 * of one lesson share a conversation. */
export function tutorContextKey(context: TutorContext): string {
  switch (context.kind) {
    case 'lab':
      return 'lab'
    case 'lesson':
      return `lesson:${context.lessonId}`
    case 'none':
      return 'none'
  }
}

/** The slice of the Build store that holds conversations. */
export interface TutorConversations {
  tutorTurns: TutorTurn[]
  isAskingTutor: boolean
  lessonTutorTurns: Record<string, TutorTurn[]>
  lessonAskingTutor: Record<string, boolean>
}

// One shared empty list, so a selector for a conversation that has no turns
// returns the SAME reference every time (a fresh `[]` per call would make a
// store subscription think the value changed on every render).
const NO_TURNS: readonly TutorTurn[] = Object.freeze([])

/** The turns to show for `context` — only that context's own conversation. */
export function tutorTurnsFor(state: TutorConversations, context: TutorContext): readonly TutorTurn[] {
  switch (context.kind) {
    case 'lab':
      return state.tutorTurns
    case 'lesson':
      return state.lessonTutorTurns[context.lessonId] ?? NO_TURNS
    case 'none':
      return NO_TURNS
  }
}

/** Whether a request is in flight for `context` (not for any other context). */
export function isAskingFor(state: TutorConversations, context: TutorContext): boolean {
  switch (context.kind) {
    case 'lab':
      return state.isAskingTutor
    case 'lesson':
      return state.lessonAskingTutor[context.lessonId] === true
    case 'none':
      return false
  }
}
