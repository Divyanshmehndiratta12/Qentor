/**
 * The classroom endpoints from the client's side: what goes out (identifiers, a code, a circuit and the
 * capability headers, never a number, a verdict, a role or somebody else's id) and how each answer is mapped or refused. `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealApiClient } from './realClient'
import { BackendUnavailableError, ClassroomRejectedError } from './client'
import { setLearnerTokenSource } from './learnerToken'
import type { Circuit } from '@/circuit/types'

const TOKEN = 'ql_' + 'a'.repeat(32)
const KEY = 'qi_' + 'b'.repeat(32)
const CIRCUIT: Circuit = {
  schema: 'qentor.circuit/1',
  num_qubits: 2,
  num_clbits: 0,
  ops: [
    { gate: 'h', targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'cx', targets: [1], controls: [0], params: [], clbits: [] },
  ],
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const refusal = (status: number, code: string, message: string) => json({ detail: { code, message } }, status)

describe('RealApiClient: classroom', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const client = new RealApiClient()
  const init = (call = 0) => fetchMock.mock.calls[call]![1] as RequestInit
  const body = (call = 0) => JSON.parse(init(call).body as string)
  const headers = (call = 0) => init(call).headers as Record<string, string>
  const url = (call = 0) => fetchMock.mock.calls[call]![0] as string

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    setLearnerTokenSource(() => null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setLearnerTokenSource(() => null)
  })

  describe('creating and joining', () => {
    it('creating a class sends only a title and returns the code and the one-time key', async () => {
      fetchMock.mockResolvedValue(json({ class_code: 'ABCD-2345', instructor_key: KEY, title: 'Period 3', created_at: '2026-10-01T00:00:00Z', notice: 'Keep it.' }, 201))
      const made = await client.createClass('  Period 3 ')
      expect(url()).toBe('/api/classes')
      expect(init().method).toBe('POST')
      expect(body()).toEqual({ title: 'Period 3' })
      expect(headers()).not.toHaveProperty('X-Qentor-Learner')
      expect(made).toEqual({ classCode: 'ABCD-2345', instructorKey: KEY, title: 'Period 3', createdAt: '2026-10-01T00:00:00Z', notice: 'Keep it.' })
    })

    it('a blank title sends an empty body, not an empty string', async () => {
      fetchMock.mockResolvedValue(json({ class_code: 'ABCD-2345', instructor_key: KEY, title: 'Class', created_at: 'x', notice: '' }, 201))
      await client.createClass('   ')
      expect(body()).toEqual({})
    })

    it('joining sends the code, and this browser’s token only as a header', async () => {
      fetchMock.mockResolvedValue(json({ learner_token: TOKEN, alias: 'Learner 4F2A', class_code: 'ABCD-2345', class_title: 'Period 3', rejoined: false, new_identity: true }))
      const joined = await client.joinClass('abcd-2345', TOKEN)
      expect(body()).toEqual({ class_code: 'abcd-2345' })
      expect(headers()['X-Qentor-Learner']).toBe(TOKEN)
      expect(url()).not.toContain(TOKEN)
      expect(JSON.stringify(body())).not.toContain(TOKEN)
      expect(joined).toEqual({ learnerToken: TOKEN, alias: 'Learner 4F2A', classCode: 'ABCD-2345', classTitle: 'Period 3', rejoined: false, newIdentity: true })
    })

    it('the first join sends no token at all', async () => {
      fetchMock.mockResolvedValue(json({ learner_token: TOKEN, alias: 'Learner 4F2A', class_code: 'ABCD-2345', class_title: 'P', rejoined: false, new_identity: true }))
      await client.joinClass('ABCD-2345', null)
      expect(headers()).not.toHaveProperty('X-Qentor-Learner')
    })

    it.each([
      [404, 'CLASS_NOT_FOUND', 'No class has that code.'],
      [422, 'CLASS_CODE_INVALID', 'A class code is eight letters and digits.'],
      [429, 'RATE_LIMITED', 'Too many requests.'],
    ])('a %i refusal keeps the server’s own code and words', async (status, code, message) => {
      fetchMock.mockResolvedValue(refusal(status, code, message))
      const err = await client.joinClass('X', null).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClassroomRejectedError)
      expect(err).toMatchObject({ code, message, status })
    })

    it('an unstructured failure is “unavailable”, and a framework validation list is never echoed as advice', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      await expect(client.joinClass('X', null)).rejects.toBeInstanceOf(BackendUnavailableError)
      fetchMock.mockResolvedValueOnce(json({ detail: [{ loc: ['body', 'class_code'], msg: 'secret internal detail', type: 'x' }] }, 422))
      const err = await client.joinClass('X', null).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BackendUnavailableError)
      expect((err as Error).message).not.toContain('secret internal detail')
    })

    it('a network failure is “could not reach the backend”', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
      await expect(client.joinClass('X', null)).rejects.toThrow(/could not reach the Qentor backend/)
    })

    it('a malformed success body is refused, not trusted', async () => {
      fetchMock.mockResolvedValue(json({ learner_token: 5 }))
      await expect(client.joinClass('X', null)).rejects.toThrow()
    })
  })

  describe('membership, progress and events', () => {
    it('me and leave send the token as a header only', async () => {
      fetchMock.mockResolvedValueOnce(json({ in_class: true, token_known: true, class_code: 'ABCD-2345', class_title: 'P', alias: 'Learner 4F2A', joined_at: 'now' }))
      fetchMock.mockResolvedValueOnce(json({ left: true }))
      const me = await client.getMyClass(TOKEN)
      expect(url(0)).toBe('/api/classes/me')
      expect(headers(0)['X-Qentor-Learner']).toBe(TOKEN)
      expect(me).toMatchObject({ inClass: true, classCode: 'ABCD-2345', alias: 'Learner 4F2A' })
      expect(await client.leaveClass(TOKEN)).toBe(true)
      expect(url(1)).toBe('/api/classes/leave')
      expect(init(1).body).toBeUndefined()
    })

    it('not in a class maps to nulls', async () => {
      fetchMock.mockResolvedValue(json({ in_class: false, token_known: true }))
      expect(await client.getMyClass(TOKEN)).toEqual({ inClass: false, tokenKnown: true, classCode: null, classTitle: null, alias: null, joinedAt: null })
    })

    it('syncing progress sends identifiers only: no verdict, no score', async () => {
      fetchMock.mockResolvedValue(json({ recorded: 1, duplicates: 0, unknown: 0 }))
      await client.syncClassProgress(TOKEN, [{ lessonId: 'l', checkId: 'c', selectedOptionId: 'o' }])
      expect(body()).toEqual({ answers: [{ lesson_id: 'l', check_id: 'c', selected_option_id: 'o' }] })
      expect(JSON.stringify(body())).not.toMatch(/correct|score|passed|verdict/i)
    })

    it('reporting an event sends a kind and a subject id, nothing else', async () => {
      fetchMock.mockResolvedValue(json({ status: 'RECORDED' }))
      expect(await client.reportLearnerEvent(TOKEN, 'lesson_started', 'quantum-fourier-transform')).toBe('RECORDED')
      expect(body()).toEqual({ kind: 'lesson_started', subject_id: 'quantum-fourier-transform' })
      expect(headers()['X-Qentor-Learner']).toBe(TOKEN)
    })

    it('the learner-event body has no field through which a role, an outcome or another learner could be named', async () => {
      fetchMock.mockResolvedValue(json({ status: 'DUPLICATE' }))
      await client.reportLearnerEvent(TOKEN, 'challenge_started', 'x')
      expect(Object.keys(body()).sort()).toEqual(['kind', 'subject_id'])
    })
  })

  describe('the instructor’s dashboard', () => {
    const DASH = {
      class_info: { class_code: 'ABCD-2345', title: 'Period 3', created_at: 'c' },
      sample: { learners_in_class: 2, learners_left: 1, active_learners: 2, active_window_days: 7, events_total: 9 },
      empty: false,
      data_note: 'Anonymous.',
      lessons: [{ lesson_id: 'l1', title: 'L1', started: 2, completed: 1, developing: 1, assessment_answered: 4, assessment_correct: 3, checks: [{ check_id: 'c1', concept: 'x', answered: 2, correct: 1 }] }],
      challenges: [{ challenge_id: 'ch', title: 'C', lesson_id: 'l1', started: 2, attempting_learners: 2, attempts: 3, solved_learners: 1, failed_attempts: 2, failure_patterns: [{ check_id: 'k', label: 'Wrong', count: 2, learners: 1 }] }],
      misconceptions: [{ kind: 'concept', category: 'x', lesson_id: 'l1', challenge_id: null, learners_affected: 1, still_incorrect: 1, sample_size: 2, explanation: null }],
      recent: [{ alias: 'Learner 4F2A', kind: 'lesson_started', subject_id: 'l1', subject_label: 'L1', outcome: null, created_at: 't' }],
    }

    it('sends the instructor key as a header and nothing about a role', async () => {
      fetchMock.mockResolvedValue(json(DASH))
      const d = await client.getClassDashboard('ABCD-2345', KEY)
      expect(url()).toBe('/api/classes/ABCD-2345/dashboard')
      expect(init().method).toBe('GET')
      expect(headers()['X-Qentor-Instructor']).toBe(KEY)
      expect(url()).not.toContain(KEY)
      expect(init().body).toBeUndefined()
      expect(d).toMatchObject({ classCode: 'ABCD-2345', learnersInClass: 2, learnersLeft: 1, activeLearners: 2, eventsTotal: 9, empty: false })
      expect(d.lessons[0]).toMatchObject({ lessonId: 'l1', completed: 1, developing: 1, assessmentCorrect: 3 })
      expect(d.challenges[0]!.failurePatterns[0]).toEqual({ checkId: 'k', label: 'Wrong', count: 2, learners: 1 })
      expect(d.recent[0]!.alias).toBe('Learner 4F2A')
    })

    it('a dashboard response carrying an unknown field is refused, so a leaked token could not be rendered', async () => {
      fetchMock.mockResolvedValue(json({ ...DASH, recent: [{ ...DASH.recent[0], learner_token: TOKEN }] }))
      const d = await client.getClassDashboard('ABCD-2345', KEY)
      expect(JSON.stringify(d)).not.toContain(TOKEN)
    })

    it('a wrong key is a structured 403 with no detail about why', async () => {
      fetchMock.mockResolvedValue(refusal(403, 'NOT_AUTHORIZED', 'that instructor key does not open this class'))
      await expect(client.getClassDashboard('ABCD-2345', KEY)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED', status: 403 })
    })

    it('deleting a class uses DELETE and the key header', async () => {
      fetchMock.mockResolvedValue(json({ deleted: true, events_deleted: 7 }))
      expect(await client.deleteClass('ABCD-2345', KEY)).toEqual({ eventsDeleted: 7 })
      expect(init().method).toBe('DELETE')
      expect(headers()['X-Qentor-Instructor']).toBe(KEY)
    })
  })

  describe('the learner token rides along only where the server derives an event from it', () => {
    it('is sent with a concept-check grade and a challenge submission when the browser is in a class', async () => {
      setLearnerTokenSource(() => TOKEN)
      fetchMock.mockResolvedValueOnce(json({ lesson_id: 'l', check_id: 'c', selected_option_id: 'o', correct: true, explanation: 'e', grader: 'server' }))
      await client.gradeConceptCheck('l', 'c', 'o')
      expect(headers(0)['X-Qentor-Learner']).toBe(TOKEN)
      expect(body(0)).toEqual({ selected_option_id: 'o' })
      fetchMock.mockResolvedValueOnce(json({}, 500))
      await client.submitChallenge('ch', CIRCUIT).catch(() => undefined)
      expect(headers(1)['X-Qentor-Learner']).toBe(TOKEN)
      expect(Object.keys(body(1))).toEqual(['circuit'])
    })

    it('is NOT sent when the browser is not in a class, nor with other requests', async () => {
      fetchMock.mockResolvedValue(json({ lesson_id: 'l', check_id: 'c', selected_option_id: 'o', correct: true, explanation: 'e', grader: 'server' }))
      await client.gradeConceptCheck('l', 'c', 'o')
      expect(headers(0)).not.toHaveProperty('X-Qentor-Learner')
      setLearnerTokenSource(() => TOKEN)
      fetchMock.mockResolvedValueOnce(json({ circuit_hash: 'h', code: { qiskit: '', cirq: '', pennylane: '' }, generator: 'g' }))
      await client.generateCode(CIRCUIT).catch(() => undefined)
      expect(headers(1)).not.toHaveProperty('X-Qentor-Learner')
    })

    it('a token source that throws means no header, not a failed request', async () => {
      setLearnerTokenSource(() => {
        throw new Error('storage blocked')
      })
      fetchMock.mockResolvedValue(json({ lesson_id: 'l', check_id: 'c', selected_option_id: 'o', correct: true, explanation: 'e', grader: 'server' }))
      await client.gradeConceptCheck('l', 'c', 'o')
      expect(headers(0)).not.toHaveProperty('X-Qentor-Learner')
    })
  })
})
