/**
 * Domain types for endpoints the backend does not expose yet (lessons, tutor).
 * `backend/qentor/verification/` is an empty package and no tutor module
 * exists (see docs/BUILD_STATE.md) — these shapes are a forward-looking
 * contract, not something derived from a live schema. They will need
 * reconciling against real pydantic models once `learning/` and `tutor/` are
 * built server-side (docs/ARCHITECTURE.md §1).
 */
import type { Circuit } from '@/circuit/types'

export interface LessonSummary {
  id: string
  title: string
  concept: string
  masteryFraction: number | null
}

export interface LessonStep {
  kind: 'explain' | 'example' | 'predict-then-run'
  body: string
  exampleCircuit?: Circuit
}

export interface Lesson extends LessonSummary {
  steps: LessonStep[]
}

/**
 * Per docs/AI_BOUNDARY.md, the client sends result ids, never numbers, and the
 * tutor's reply is structured: text segments plus fact references, not a
 * free-text blob the UI trusts blindly.
 */
export interface TutorQuery {
  question: string
  resultIds: string[]
  lessonId?: string
}

export interface TutorFactReference {
  resultId: string
  label: string
}

export interface TutorReply {
  segments: string[]
  factReferences: TutorFactReference[]
  candidateCircuit: Circuit | null
  usedFallbackTemplate: boolean
  rejectedClaimCount: number
}
