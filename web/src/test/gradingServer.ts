/**
 * TEST FIXTURE ONLY — never imported by shipped code (it lives under `src/test/`).
 *
 * A stand-in for the SERVER's grading endpoints, for the Learn tests. The real catalog the browser receives carries no answer key,
 * so a test that needs "the server says this is right" has to supply the key itself — here, in one place, on the test side of the
 * boundary. `keys` maps `"lessonId/checkId"` to the correct option id; `options` (optional) maps the same key to the option ids the
 * check offers, so an option that is not offered is refused exactly as the server refuses it.
 *
 * Everything a component or store receives from this double has the same shape as the real client's return values
 * (`ConceptCheckGrade`, `RegradedAnswer`), and every call is recorded so a test can assert what was sent — and that nothing else was.
 */
import { vi } from 'vitest'
import { GradeRejectedError, type ConceptCheckGrade, type RegradedAnswer, type SavedAnswer } from '@/api'

export interface FakeGradingServerOptions {
  keys: Record<string, string>
  /** `"lessonId/checkId"` -> the option ids offered. When omitted for a check, any option id is accepted. */
  options?: Record<string, string[]>
  /** The explanation each check returns; defaults to `Explanation for <lesson>/<check>.` */
  explanations?: Record<string, string>
}

export function fakeGradingServer({ keys, options = {}, explanations = {} }: FakeGradingServerOptions) {
  const state = { keys: { ...keys } }
  const explain = (key: string) => explanations[key] ?? `Explanation for ${key}.`

  const gradeConceptCheck = vi.fn(async (lessonId: string, checkId: string, selectedOptionId: string): Promise<ConceptCheckGrade> => {
    const key = `${lessonId}/${checkId}`
    if (!(key in state.keys)) throw new GradeRejectedError('CONCEPT_CHECK_NOT_FOUND', `no concept check ${key}`, 404)
    if (options[key] && !options[key]!.includes(selectedOptionId)) {
      throw new GradeRejectedError('OPTION_NOT_FOUND', `${selectedOptionId} is not one of the options`, 422)
    }
    return { lessonId, checkId, selectedOptionId, correct: selectedOptionId === state.keys[key], explanation: explain(key) }
  })

  const regradeConceptChecks = vi.fn(async (answers: SavedAnswer[]): Promise<RegradedAnswer[]> =>
    answers.map((a) => {
      const key = `${a.lessonId}/${a.checkId}`
      if (!(key in state.keys)) return { ...a, status: 'UNKNOWN_CHECK' as const, correct: null, explanation: null }
      if (options[key] && !options[key]!.includes(a.selectedOptionId)) {
        return { ...a, status: 'UNKNOWN_OPTION' as const, correct: null, explanation: null }
      }
      return { ...a, status: 'GRADED' as const, correct: a.selectedOptionId === state.keys[key], explanation: explain(key) }
    }),
  )

  return {
    /** Change the key the "server" holds (a lesson's answer key edited between visits). */
    setKey(lessonId: string, checkId: string, optionId: string) {
      state.keys[`${lessonId}/${checkId}`] = optionId
    },
    removeCheck(lessonId: string, checkId: string) {
      delete state.keys[`${lessonId}/${checkId}`]
    },
    gradeConceptCheck,
    regradeConceptChecks,
  }
}
