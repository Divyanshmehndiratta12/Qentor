/**
 * Concept-check grading from the client's side. What goes out is three identifiers and the option the learner picked —
 * never a verdict, a key or a score — and what comes back (the server's verdict and explanation) is shown as the server wrote it.
 * The lesson catalog carries no answer key, and a key a server sends anyway is dropped at the boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError, GradeRejectedError } from './client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const GRADE = {
  lesson_id: 'bell-state',
  check_id: 's5',
  selected_option_id: 'b',
  correct: false,
  explanation: 'H makes the superposition; CX then ties the two qubits together.',
  grader: 'qentor.lessons.grading/1',
}

let fetchMock: ReturnType<typeof vi.fn>
const requestBody = (call = 0) => JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('RealApiClient.gradeConceptCheck', () => {
  it('POSTs the chosen option id and nothing else, to the check’s own grading path', async () => {
    fetchMock.mockResolvedValueOnce(json(GRADE))
    await new RealApiClient().gradeConceptCheck('bell-state', 's5', 'b')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/lessons/bell-state/concept-checks/s5/grade')
    expect(init.method).toBe('POST')
    expect(requestBody()).toEqual({ selected_option_id: 'b' }) // no verdict, no key, no score, no "correct"
  })

  it('encodes identifiers in the path, so an id cannot alter the route', async () => {
    fetchMock.mockResolvedValueOnce(json(GRADE))
    await new RealApiClient().gradeConceptCheck('a/b c', '../x?y=1', 'b')
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/lessons/a%2Fb%20c/concept-checks/..%2Fx%3Fy%3D1/grade')
  })

  it('returns the server’s verdict and explanation, mapped and otherwise untouched', async () => {
    fetchMock.mockResolvedValueOnce(json(GRADE))
    await expect(new RealApiClient().gradeConceptCheck('bell-state', 's5', 'b')).resolves.toEqual({
      lessonId: 'bell-state',
      checkId: 's5',
      selectedOptionId: 'b',
      correct: false,
      explanation: GRADE.explanation,
    })
  })

  it('a correct verdict is passed through as the server said it', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...GRADE, correct: true }))
    expect((await new RealApiClient().gradeConceptCheck('bell-state', 's5', 'a')).correct).toBe(true)
  })

  it.each([
    [404, 'LESSON_NOT_FOUND'],
    [404, 'CONCEPT_CHECK_NOT_FOUND'],
    [422, 'OPTION_NOT_FOUND'],
    [422, 'CONCEPT_CHECK_NOT_GRADED'],
    [422, 'GRADE_REQUEST_INVALID'],
  ])('a %s refusal with code %s becomes a GradeRejectedError carrying the server’s own code and message', async (status, code) => {
    fetchMock.mockResolvedValueOnce(json({ detail: { code, message: 'the reason' } }, status))
    const error = await new RealApiClient().gradeConceptCheck('l', 'c', 'o').catch((e) => e)
    expect(error).toBeInstanceOf(GradeRejectedError)
    expect(error).toMatchObject({ code, message: 'the reason', status })
  })

  it('an unstructured error is reported as unavailable, with no code invented for it', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: [{ loc: ['body'], msg: 'bad' }] }, 422))
    const error = await new RealApiClient().gradeConceptCheck('l', 'c', 'o').catch((e) => e)
    expect(error).toBeInstanceOf(BackendUnavailableError)
    expect(error).not.toBeInstanceOf(GradeRejectedError)
    expect(error.status).toBe(422)
  })

  it('a gateway error page that is not JSON is unavailable, not a verdict', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    await expect(new RealApiClient().gradeConceptCheck('l', 'c', 'o')).rejects.toMatchObject({ name: 'BackendUnavailableError', status: 502 })
  })

  it('a network failure is unavailable, never a guessed verdict', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))
    await expect(new RealApiClient().gradeConceptCheck('l', 'c', 'o')).rejects.toBeInstanceOf(BackendUnavailableError)
  })

  it.each([
    ['a missing verdict', { ...GRADE, correct: undefined }],
    ['a verdict that is not a boolean', { ...GRADE, correct: 'yes' }],
    ['a missing explanation', { ...GRADE, explanation: undefined }],
    ['an empty object', {}],
  ])('refuses a malformed success response: %s', async (_name, body) => {
    fetchMock.mockResolvedValueOnce(json(body))
    await expect(new RealApiClient().gradeConceptCheck('bell-state', 's5', 'b')).rejects.toThrow()
  })
})

describe('RealApiClient.regradeConceptChecks', () => {
  const RESULT = { lesson_id: 'l1', check_id: 'q1', selected_option_id: 'a', status: 'GRADED', correct: true, explanation: 'because' }

  it('POSTs only the saved selections — ids and choices — and no verdict', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [RESULT] }))
    await new RealApiClient().regradeConceptChecks([{ lessonId: 'l1', checkId: 'q1', selectedOptionId: 'a' }])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/assessments/regrade')
    expect(init.method).toBe('POST')
    expect(requestBody()).toEqual({ answers: [{ lesson_id: 'l1', check_id: 'q1', selected_option_id: 'a' }] })
  })

  it('maps each answer back, in order, with its status', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        results: [
          RESULT,
          { lesson_id: 'l1', check_id: 'gone', selected_option_id: 'a', status: 'UNKNOWN_CHECK', correct: null, explanation: null },
        ],
      }),
    )
    const answers = await new RealApiClient().regradeConceptChecks([
      { lessonId: 'l1', checkId: 'q1', selectedOptionId: 'a' },
      { lessonId: 'l1', checkId: 'gone', selectedOptionId: 'a' },
    ])
    expect(answers).toEqual([
      { lessonId: 'l1', checkId: 'q1', selectedOptionId: 'a', status: 'GRADED', correct: true, explanation: 'because' },
      { lessonId: 'l1', checkId: 'gone', selectedOptionId: 'a', status: 'UNKNOWN_CHECK', correct: null, explanation: null },
    ])
  })

  it('refuses a status the server does not define', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [{ ...RESULT, status: 'PROBABLY_FINE' }] }))
    await expect(new RealApiClient().regradeConceptChecks([{ lessonId: 'l1', checkId: 'q1', selectedOptionId: 'a' }])).rejects.toThrow()
  })

  it('a structured refusal is a GradeRejectedError; an unreachable server is BackendUnavailableError', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: { code: 'GRADE_REQUEST_INVALID', message: 'too many' } }, 422))
    await expect(new RealApiClient().regradeConceptChecks([])).rejects.toMatchObject({ name: 'GradeRejectedError', code: 'GRADE_REQUEST_INVALID' })
    fetchMock.mockRejectedValueOnce(new TypeError('down'))
    await expect(new RealApiClient().regradeConceptChecks([])).rejects.toBeInstanceOf(BackendUnavailableError)
  })
})

describe('the catalog carries no answer key, and a key sent anyway is dropped', () => {
  const CHECK_ON_THE_WIRE = {
    type: 'concept_check',
    id: 's5',
    title: 'Check',
    prompt: 'p',
    question: 'Which?',
    options: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ],
    concept: 'bell-state',
  }
  const lessonWith = (section: Record<string, unknown>) => ({
    lessons: [
      {
        id: 'bell-state', title: 'Bell', short_description: 's', concept: 'c', difficulty: 'beginner', estimated_minutes: 5,
        learning_objectives: ['o'], sections: [section], linked_circuit: null, prerequisite_lesson_ids: [],
      },
    ],
  })

  it('maps a concept check to question and options only', async () => {
    fetchMock.mockResolvedValueOnce(json(lessonWith(CHECK_ON_THE_WIRE)))
    const [lesson] = await new RealApiClient().listLessons()
    expect(lesson!.sections[0]).toEqual({
      type: 'concept_check', id: 's5', title: 'Check', prompt: 'p', question: 'Which?',
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], concept: 'bell-state',
    })
  })

  it('drops a correct_option_id and an explanation that a server sent anyway, so no component can read them', async () => {
    fetchMock.mockResolvedValueOnce(json(lessonWith({ ...CHECK_ON_THE_WIRE, correct_option_id: 'a', explanation: 'LEAKED EXPLANATION' })))
    const [lesson] = await new RealApiClient().listLessons()
    const section = lesson!.sections[0]! as unknown as Record<string, unknown>
    expect(Object.keys(section).sort()).toEqual(['concept', 'id', 'options', 'prompt', 'question', 'title', 'type'])
    expect(JSON.stringify(lesson)).not.toContain('LEAKED EXPLANATION')
    expect(JSON.stringify(lesson)).not.toMatch(/correct_?[Oo]ption|"explanation"/)
  })

  it('a prompt-only check has no question and no options', async () => {
    fetchMock.mockResolvedValueOnce(json(lessonWith({ ...CHECK_ON_THE_WIRE, question: null, options: null, concept: null })))
    const [lesson] = await new RealApiClient().listLessons()
    expect(lesson!.sections[0]).toMatchObject({ question: null, options: null })
  })
})
