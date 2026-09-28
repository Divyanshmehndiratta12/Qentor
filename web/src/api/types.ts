/**
 * Domain types for endpoints the backend does not expose yet (lessons only —
 * tutor is real now, see `client.ts`'s `TutorAnswerResult`/`TutorFactResult`
 * and `POST /api/tutor`). These lesson shapes are still a forward-looking
 * contract, not derived from a live schema, and will need reconciling once
 * `learning/` is built server-side (docs/ARCHITECTURE.md §1).
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
