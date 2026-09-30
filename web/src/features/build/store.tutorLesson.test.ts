/**
 * `useBuildStore.askTutor` with lesson context. The real store, with only
 * `@/api`'s client mocked. A lesson question is the Guide's Learn quick action:
 * it sends lesson/section IDS through the same tutor request, needs no Lab
 * result, and leaves a Lab question exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutePayload, TutorAnswerResult } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'

const askTutor = vi.fn()

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    getApiClient: () => ({
      executeCircuit: vi.fn(),
      verifyBellState: vi.fn(),
      listLessons: vi.fn(),
      optimizeCircuit: vi.fn(),
      runMultiInputTest: vi.fn(),
      traceCircuit: vi.fn(),
      askTutor,
    }),
  }
})

import { useBuildStore } from './store'

const PROVENANCE: Provenance = {
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'shots',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-01-01T00:00:00Z',
}

const CIRCUIT = {
  ...emptyCircuit(1, 1),
  ops: [{ gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] }],
}

const LESSON = { lessonId: 'phase', sectionId: 's1' }

const LESSON_ANSWER: TutorAnswerResult = {
  answer: 'About this part of the lesson: (L3).',
  resultId: null,
  circuitHash: null,
  provenanceClass: null,
  verificationStatus: null,
  usedFallbackTemplate: true,
  facts: [],
  lessonId: 'phase',
  sectionId: 's1',
}

const RESULT_ANSWER: TutorAnswerResult = {
  answer: 'For this result: ...',
  resultId: 'res_abc',
  circuitHash: 'hash_abc',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  usedFallbackTemplate: true,
  facts: [],
}

const INITIAL = useBuildStore.getState()

function seedResult() {
  const result = toQuantumValue<ExecutePayload>(
    { executionId: 'aer-local-abc', probabilities: { '0': 0.5, '1': 0.5 } },
    PROVENANCE,
  )
  useBuildStore.setState({ circuit: CIRCUIT, result, executionError: null })
  return result
}

beforeEach(() => {
  askTutor.mockReset()
  useBuildStore.setState(INITIAL, true)
})
afterEach(() => useBuildStore.setState(INITIAL, true))

describe('askTutor with lesson context', () => {
  it('sends lesson and section IDS with NO result and NO circuit — and needs no Lab result to do so', async () => {
    askTutor.mockResolvedValueOnce(LESSON_ANSWER)
    expect(useBuildStore.getState().result).toBeNull()

    await useBuildStore.getState().askTutor('Explain this concept', LESSON)

    expect(askTutor).toHaveBeenCalledTimes(1)
    expect(askTutor).toHaveBeenCalledWith(null, null, 'Explain this concept', 'en', LESSON)
  })

  it('a Lab result on screen is NOT attached to a lesson question', async () => {
    seedResult()
    askTutor.mockResolvedValueOnce(LESSON_ANSWER)

    await useBuildStore.getState().askTutor('Give me a hint', LESSON)

    const args = askTutor.mock.calls[0]!
    expect(args[0]).toBeNull()
    expect(args[1]).toBeNull()
    expect(JSON.stringify(args)).not.toContain('res_abc')
  })

  it('appends the learner question and the backend answer, exactly as returned', async () => {
    askTutor.mockResolvedValueOnce(LESSON_ANSWER)

    await useBuildStore.getState().askTutor('Explain this concept', LESSON)

    const { lessonTutorTurns, lessonAskingTutor, tutorTurns, isAskingTutor } = useBuildStore.getState()
    expect(lessonTutorTurns.phase).toEqual([
      { role: 'learner', text: 'Explain this concept' },
      { role: 'tutor', answer: LESSON_ANSWER },
    ])
    expect(lessonAskingTutor.phase).toBe(false)
    // ...in THAT LESSON's conversation, and nowhere else: the Lab's is untouched.
    expect(tutorTurns).toEqual([])
    expect(isAskingTutor).toBe(false)
  })

  it('shows the asking state for that lesson while the request is in flight (and not the Lab’s)', async () => {
    let resolve!: (a: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((r) => (resolve = r)))

    const pending = useBuildStore.getState().askTutor('Explain this concept', LESSON)
    expect(useBuildStore.getState().lessonAskingTutor.phase).toBe(true)
    expect(useBuildStore.getState().isAskingTutor).toBe(false)
    resolve(LESSON_ANSWER)
    await pending

    expect(useBuildStore.getState().lessonAskingTutor.phase).toBe(false)
  })

  it('does not start a second request for a lesson while one is in flight', async () => {
    let resolve!: (a: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((r) => (resolve = r)))

    const first = useBuildStore.getState().askTutor('First', LESSON)
    await useBuildStore.getState().askTutor('Second', LESSON) // ignored
    resolve(LESSON_ANSWER)
    await first

    expect(askTutor).toHaveBeenCalledTimes(1)
    expect(useBuildStore.getState().lessonTutorTurns.phase!.filter((t) => t.role === 'learner')).toHaveLength(1)
  })

  it('sends the selected tutor language, and asking does not change it', async () => {
    useBuildStore.getState().setTutorLanguage('hi')
    askTutor.mockResolvedValueOnce(LESSON_ANSWER)

    await useBuildStore.getState().askTutor('Explain this concept', LESSON)

    expect(askTutor.mock.calls[0]![3]).toBe('hi')
    expect(useBuildStore.getState().tutorLanguage).toBe('hi')
  })

  it('turns a backend refusal into an error turn — no invented answer', async () => {
    askTutor.mockRejectedValueOnce(new Error("no lesson with id 'phase'"))

    await useBuildStore.getState().askTutor('Explain this concept', LESSON)

    expect(useBuildStore.getState().lessonTutorTurns.phase).toEqual([
      { role: 'learner', text: 'Explain this concept' },
      { role: 'error', message: "no lesson with id 'phase'" },
    ])
    expect(useBuildStore.getState().lessonAskingTutor.phase).toBe(false)
  })

  it('drops an answer whose conversation was discarded while it was in flight', async () => {
    let resolve!: (a: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((r) => (resolve = r)))

    const pending = useBuildStore.getState().askTutor('Explain this concept', LESSON)
    useBuildStore.setState({ lessonTutorTurns: {}, lessonAskingTutor: {} })
    resolve(LESSON_ANSWER)
    await pending

    expect(useBuildStore.getState().lessonTutorTurns).toEqual({})
    expect(useBuildStore.getState().lessonAskingTutor.phase).toBe(false) // never left stuck "asking"
  })

  it('drops a failure whose conversation was discarded while it was in flight', async () => {
    let reject!: (e: Error) => void
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((_, r) => (reject = r)))

    const pending = useBuildStore.getState().askTutor('Explain this concept', LESSON)
    useBuildStore.setState({ lessonTutorTurns: {}, lessonAskingTutor: {} })
    reject(new Error('late failure'))
    await pending

    expect(useBuildStore.getState().lessonTutorTurns).toEqual({})
  })

  it('ignores a blank question', async () => {
    await useBuildStore.getState().askTutor('   ', LESSON)
    expect(askTutor).not.toHaveBeenCalled()
    expect(useBuildStore.getState().lessonTutorTurns).toEqual({})
  })

  it('changes only the conversation: no circuit, result, trace or language is touched', async () => {
    const result = seedResult()
    askTutor.mockResolvedValueOnce(LESSON_ANSWER)
    const before = useBuildStore.getState()

    await useBuildStore.getState().askTutor('Explain this concept', LESSON)

    const after = useBuildStore.getState()
    expect(after.circuit).toBe(before.circuit)
    expect(after.result).toBe(result)
    expect(after.trace).toBe(before.trace)
    const changed = (Object.keys(after) as Array<keyof typeof after>).filter((k) => after[k] !== before[k])
    // Only the lesson conversation slices: not the Lab's turns/flag, not the circuit, result, trace or language.
    expect(changed.sort()).toEqual(['lessonAskingTutor', 'lessonTutorTurns'])
  })
})

describe('conversations are scoped to their context', () => {
  const ASK = (lessonId: string, sectionId: string | null = 's1') => ({ lessonId, sectionId })

  it('each lesson has its own conversation: asking in one never appears in another', async () => {
    askTutor.mockResolvedValue(LESSON_ANSWER)

    await useBuildStore.getState().askTutor('About qubits', ASK('qubits-measurement'))
    await useBuildStore.getState().askTutor('About interference', ASK('interference'))

    const { lessonTutorTurns } = useBuildStore.getState()
    expect(Object.keys(lessonTutorTurns).sort()).toEqual(['interference', 'qubits-measurement'])
    expect(lessonTutorTurns['qubits-measurement']!.map((t) => (t.role === 'learner' ? t.text : t.role))).toEqual(['About qubits', 'tutor'])
    expect(lessonTutorTurns.interference!.map((t) => (t.role === 'learner' ? t.text : t.role))).toEqual(['About interference', 'tutor'])
  })

  it('returning to a lesson finds its own conversation still there (in-memory, this session)', async () => {
    askTutor.mockResolvedValue(LESSON_ANSWER)
    await useBuildStore.getState().askTutor('Q1', ASK('qubits-measurement'))
    await useBuildStore.getState().askTutor('Q2', ASK('interference'))
    await useBuildStore.getState().askTutor('Q3', ASK('qubits-measurement'))

    const turns = useBuildStore.getState().lessonTutorTurns['qubits-measurement']!
    expect(turns.filter((t) => t.role === 'learner').map((t) => (t as { text: string }).text)).toEqual(['Q1', 'Q3'])
  })

  it('sections of the same lesson share ONE conversation, and each request names its own section', async () => {
    askTutor.mockResolvedValue(LESSON_ANSWER)

    await useBuildStore.getState().askTutor('On s1', ASK('phase', 's1'))
    await useBuildStore.getState().askTutor('On s2', ASK('phase', 's2'))

    expect(useBuildStore.getState().lessonTutorTurns.phase!.filter((t) => t.role === 'learner')).toHaveLength(2)
    expect(askTutor.mock.calls.map((c) => c[4])).toEqual([
      { lessonId: 'phase', sectionId: 's1' },
      { lessonId: 'phase', sectionId: 's2' },
    ])
  })

  it('a lesson conversation never lands in the Lab conversation, and vice versa', async () => {
    seedResult()
    askTutor.mockResolvedValueOnce(LESSON_ANSWER).mockResolvedValueOnce(RESULT_ANSWER)

    await useBuildStore.getState().askTutor('Lesson question', ASK('phase'))
    await useBuildStore.getState().askTutor('Lab question')

    const s = useBuildStore.getState()
    expect(s.tutorTurns.map((t) => (t.role === 'learner' ? t.text : t.role))).toEqual(['Lab question', 'tutor'])
    expect(s.lessonTutorTurns.phase!.map((t) => (t.role === 'learner' ? t.text : t.role))).toEqual(['Lesson question', 'tutor'])
  })

  it('a Lab reset (circuit/result change) clears the Lab conversation but NOT any lesson conversation', async () => {
    seedResult()
    askTutor.mockResolvedValueOnce(LESSON_ANSWER).mockResolvedValueOnce(RESULT_ANSWER)
    await useBuildStore.getState().askTutor('Lesson question', ASK('phase'))
    await useBuildStore.getState().askTutor('Lab question')

    useBuildStore.getState().loadCircuit(CIRCUIT) // the app's own full reset

    const s = useBuildStore.getState()
    expect(s.tutorTurns).toEqual([])
    expect(s.lessonTutorTurns.phase).toHaveLength(2)
  })

  it('an answer that arrives after the learner moved to another lesson still belongs to the lesson it was asked in', async () => {
    let resolve!: (a: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((r) => (resolve = r)))

    const pending = useBuildStore.getState().askTutor('Slow question', ASK('qubits-measurement'))
    askTutor.mockResolvedValueOnce(LESSON_ANSWER)
    await useBuildStore.getState().askTutor('Other lesson question', ASK('interference')) // asked while the first is pending
    resolve({ ...LESSON_ANSWER, answer: 'LATE ANSWER', lessonId: 'qubits-measurement' })
    await pending

    const { lessonTutorTurns, lessonAskingTutor } = useBuildStore.getState()
    expect(JSON.stringify(lessonTutorTurns['qubits-measurement'])).toContain('LATE ANSWER')
    expect(JSON.stringify(lessonTutorTurns.interference)).not.toContain('LATE ANSWER')
    expect(lessonAskingTutor).toEqual({ 'qubits-measurement': false, interference: false })
  })

  it('one lesson waiting on the backend does not block asking in another', async () => {
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>(() => {})) // never resolves
    void useBuildStore.getState().askTutor('Stuck', ASK('qubits-measurement'))
    askTutor.mockResolvedValueOnce(LESSON_ANSWER)

    await useBuildStore.getState().askTutor('Free', ASK('interference'))

    expect(useBuildStore.getState().lessonAskingTutor).toEqual({ 'qubits-measurement': true, interference: false })
    expect(useBuildStore.getState().lessonTutorTurns.interference).toHaveLength(2)
  })

  it('the answer language is one preference: switching lesson or language does not reset the other', async () => {
    askTutor.mockResolvedValue(LESSON_ANSWER)
    useBuildStore.getState().setTutorLanguage('kn')

    await useBuildStore.getState().askTutor('In Kannada', ASK('qubits-measurement'))
    await useBuildStore.getState().askTutor('Still Kannada', ASK('interference'))
    useBuildStore.getState().setTutorLanguage('hi')

    expect(askTutor.mock.calls.map((c) => c[3])).toEqual(['kn', 'kn'])
    // switching the language did not disturb either conversation
    expect(useBuildStore.getState().lessonTutorTurns['qubits-measurement']).toHaveLength(2)
    expect(useBuildStore.getState().lessonTutorTurns.interference).toHaveLength(2)
    expect(useBuildStore.getState().tutorLanguage).toBe('hi')
  })

  it('a follow-up in the same lesson sends the same lesson_id/section_id and makes an independent request', async () => {
    askTutor.mockResolvedValue(LESSON_ANSWER)

    await useBuildStore.getState().askTutor('What is a qubit?', ASK('qubits-measurement'))
    await useBuildStore.getState().askTutor('Explain that more simply.', ASK('qubits-measurement'))

    expect(askTutor.mock.calls[1]).toEqual([null, null, 'Explain that more simply.', 'en', { lessonId: 'qubits-measurement', sectionId: 's1' }])
    // no conversation-history protocol: the request has no history argument
    expect(askTutor.mock.calls[1]).toHaveLength(5)
  })
})

describe('askTutor without lesson context is unchanged (Lab)', () => {
  it('sends exactly result id, circuit, question and language — four arguments', async () => {
    const result = seedResult()
    askTutor.mockResolvedValueOnce(RESULT_ANSWER)

    await useBuildStore.getState().askTutor('What was the result?')

    const args = askTutor.mock.calls[0]!
    expect(args).toHaveLength(4)
    expect(args).toEqual([result.provenance.resultId, CIRCUIT, 'What was the result?', 'en'])
  })

  it('still does nothing without a real result', async () => {
    await useBuildStore.getState().askTutor('What was the result?')
    expect(askTutor).not.toHaveBeenCalled()
    expect(useBuildStore.getState().tutorTurns).toEqual([])
  })

  it('the selected language is still sent', async () => {
    seedResult()
    useBuildStore.getState().setTutorLanguage('kn')
    askTutor.mockResolvedValueOnce(RESULT_ANSWER)

    await useBuildStore.getState().askTutor('What was the result?')

    expect(askTutor.mock.calls[0]![3]).toBe('kn')
  })

  it('a result change while asking still discards the stale answer', async () => {
    seedResult()
    let resolve!: (a: TutorAnswerResult) => void
    askTutor.mockReturnValueOnce(new Promise<TutorAnswerResult>((r) => (resolve = r)))

    const pending = useBuildStore.getState().askTutor('What was the result?')
    useBuildStore.setState({ result: null, tutorTurns: [], isAskingTutor: false })
    resolve(RESULT_ANSWER)
    await pending

    expect(useBuildStore.getState().tutorTurns).toEqual([])
  })
})
