/**
 * RealApiClient.askTutor with lesson context — the exact request body that
 * reaches POST /api/tutor. `fetch` is stubbed; nothing here needs a backend.
 *
 * The contract: a Lab question is byte-for-byte the original four-field body;
 * a lesson question adds `lesson_id`/`section_id` (IDENTIFIERS — never lesson
 * text) and, with no result, omits `result_id`/`circuit`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import type { Circuit } from '@/circuit/types'

const CIRCUIT: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 1,
  num_clbits: 0,
  ops: [{ gate: 'h', targets: [0], controls: [], params: [], clbits: [] }],
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const RESULT_ANSWER = {
  answer: 'For this result: |0⟩ amplitude (F3).',
  result_id: 'res_abc',
  circuit_hash: 'hash_abc',
  provenance_class: 'SIMULATION',
  verification_status: 'VERIFIED',
  used_fallback_template: true,
  facts: [{ id: 'F1', kind: 'circuit_summary', description: '1-qubit circuit: h(q0)', result_id: 'res_abc' }],
}

const LESSON_ANSWER = {
  answer: 'About this part of the lesson: A Z gate flips the sign of the |1> amplitude. (L3).',
  result_id: null,
  circuit_hash: null,
  provenance_class: null,
  verification_status: null,
  used_fallback_template: true,
  facts: [
    { id: 'L1', kind: 'lesson_overview', description: 'lesson "Phase" (phase, beginner): ...', result_id: null },
    { id: 'L3', kind: 'lesson_section', description: 'section s1 "Phase" (explanation): ...', result_id: null },
  ],
  lesson_id: 'phase',
  section_id: 's1',
}

describe('RealApiClient.askTutor — request body', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const body = () => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('a Lab question with no lesson is exactly the original four fields', async () => {
    fetchMock.mockResolvedValueOnce(json(RESULT_ANSWER))

    await new RealApiClient().askTutor('res_abc', CIRCUIT, 'What was the result?', 'hi')

    expect(Object.keys(body()).sort()).toEqual(['circuit', 'language', 'question', 'result_id'])
    expect(body()).toMatchObject({ result_id: 'res_abc', question: 'What was the result?', language: 'hi' })
    expect(body()).not.toHaveProperty('lesson_id')
    expect(body()).not.toHaveProperty('section_id')
  })

  it('a Lab question with the language omitted still defaults to English', async () => {
    fetchMock.mockResolvedValueOnce(json(RESULT_ANSWER))
    await new RealApiClient().askTutor('res_abc', CIRCUIT, 'q')
    expect(body().language).toBe('en')
  })

  it('a lesson question sends lesson_id AND section_id, the question and the language', async () => {
    fetchMock.mockResolvedValueOnce(json(LESSON_ANSWER))

    await new RealApiClient().askTutor(null, null, 'Explain this concept', 'kn', { lessonId: 'phase', sectionId: 's1' })

    expect(body()).toEqual({
      question: 'Explain this concept',
      language: 'kn',
      lesson_id: 'phase',
      section_id: 's1',
    })
  })

  it('a lesson question sends no result_id and no circuit when it has none', async () => {
    fetchMock.mockResolvedValueOnce(json(LESSON_ANSWER))

    await new RealApiClient().askTutor(null, null, 'Give me a hint', 'en', { lessonId: 'phase', sectionId: 's1' })

    expect(body()).not.toHaveProperty('result_id')
    expect(body()).not.toHaveProperty('circuit')
  })

  it('a lesson with no current section sends lesson_id only', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...LESSON_ANSWER, section_id: null }))

    await new RealApiClient().askTutor(null, null, 'Explain this concept', 'en', { lessonId: 'phase', sectionId: null })

    expect(body()).toEqual({ question: 'Explain this concept', language: 'en', lesson_id: 'phase' })
  })

  it('a lesson question CAN also carry a real result and circuit (the backend combines them)', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...RESULT_ANSWER, lesson_id: 'phase', section_id: 's1' }))

    await new RealApiClient().askTutor('res_abc', CIRCUIT, 'Why?', 'en', { lessonId: 'phase', sectionId: 's1' })

    expect(Object.keys(body()).sort()).toEqual(['circuit', 'language', 'lesson_id', 'question', 'result_id', 'section_id'])
  })

  it('never sends anything but identifiers for the lesson — no text, title or body field exists', async () => {
    fetchMock.mockResolvedValueOnce(json(LESSON_ANSWER))

    await new RealApiClient().askTutor(null, null, 'Explain this concept', 'en', { lessonId: 'phase', sectionId: 's1' })

    const allowed = ['language', 'lesson_id', 'question', 'section_id']
    expect(Object.keys(body()).sort()).toEqual(allowed)
    expect(JSON.stringify(body())).not.toMatch(/lesson_text|section_body|title|instructions/)
  })

  it('refuses (before any network call) a request with neither a result nor a lesson', async () => {
    await expect(new RealApiClient().askTutor(null, null, 'hello')).rejects.toThrow(/result .* or a lesson/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a result id without its circuit, and a circuit without its result id', async () => {
    const client = new RealApiClient()
    await expect(client.askTutor('res_abc', null, 'q', 'en', { lessonId: 'phase', sectionId: null })).rejects.toThrow(/together/)
    await expect(client.askTutor(null, CIRCUIT, 'q', 'en', { lessonId: 'phase', sectionId: null })).rejects.toThrow(/together/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('RealApiClient.askTutor — response', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('parses a lesson-only answer: no provenance, lesson ids echoed, lesson facts without a result id', async () => {
    fetchMock.mockResolvedValueOnce(json(LESSON_ANSWER))

    const result = await new RealApiClient().askTutor(null, null, 'Explain this concept', 'en', {
      lessonId: 'phase',
      sectionId: 's1',
    })

    expect(result.answer).toBe(LESSON_ANSWER.answer)
    expect(result.resultId).toBeNull()
    expect(result.circuitHash).toBeNull()
    expect(result.provenanceClass).toBeNull()
    expect(result.verificationStatus).toBeNull()
    expect(result.lessonId).toBe('phase')
    expect(result.sectionId).toBe('s1')
    expect(result.facts.map((f) => [f.id, f.resultId])).toEqual([
      ['L1', null],
      ['L3', null],
    ])
  })

  it('a Lab answer from a server that predates lesson fields still parses (lesson ids become null)', async () => {
    fetchMock.mockResolvedValueOnce(json(RESULT_ANSWER)) // no lesson_id / section_id at all

    const result = await new RealApiClient().askTutor('res_abc', CIRCUIT, 'What was the result?')

    expect(result.resultId).toBe('res_abc')
    expect(result.lessonId).toBeNull()
    expect(result.sectionId).toBeNull()
  })

  it.each([
    ['TUTOR_LESSON_NOT_FOUND', 404, "no lesson with id 'nope'"],
    ['TUTOR_SECTION_NOT_FOUND', 404, "lesson 'phase' has no section with id 's99'"],
    ['TUTOR_SECTION_MISMATCH', 422, "section 's4' does not belong to lesson 'bloch-sphere'"],
  ])('%s is reported as a BackendUnavailableError carrying the human message and the status', async (code, status, message) => {
    fetchMock.mockResolvedValueOnce(json({ detail: { code, message } }, status))

    await expect(
      new RealApiClient().askTutor(null, null, 'Explain this concept', 'en', { lessonId: 'x', sectionId: null }),
    ).rejects.toMatchObject({ name: 'BackendUnavailableError', status, message })
  })

  it('other error shapes are reported exactly as before (string detail, validation list)', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "no provenance record found for result_id 'res_x'" }, 404))
    await expect(new RealApiClient().askTutor('res_x', CIRCUIT, 'q')).rejects.toMatchObject({
      status: 404,
      message: "no provenance record found for result_id 'res_x'",
    })

    fetchMock.mockResolvedValueOnce(json({ detail: [{ loc: ['body'], msg: 'bad', type: 'value_error' }] }, 422))
    await expect(new RealApiClient().askTutor('res_x', CIRCUIT, 'q')).rejects.toMatchObject({ status: 422 })
  })

  it('a malformed lesson answer (a number where a string belongs) is rejected, not trusted', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...LESSON_ANSWER, answer: 42 }))
    await expect(
      new RealApiClient().askTutor(null, null, 'q', 'en', { lessonId: 'phase', sectionId: null }),
    ).rejects.toThrow()
  })
})
