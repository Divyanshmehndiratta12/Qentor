import { describe, expect, it } from 'vitest'
import {
  LAB_NEEDS_RESULT_NOTICE,
  LAB_QUICK_ACTIONS,
  LEARN_NEEDS_LESSON_NOTICE,
  LEARN_QUICK_ACTIONS,
  LEARN_SOURCE_LINE,
  buildGuideContext,
  type GuideContextInput,
} from './guideContext'

const circuit = (qubits: number, ops: number) => ({ num_qubits: qubits, ops: Array.from({ length: ops }, () => ({})) })
const RESULT = { resultId: 'res_abc', executionMode: 'statevector', backend: 'qiskit-aer' }
const lesson = (over: Partial<NonNullable<GuideContextInput['lesson']>> = {}): NonNullable<GuideContextInput['lesson']> => ({
  id: 'phase',
  title: 'Phase',
  stepNumber: 1,
  totalSteps: 4,
  sectionId: 's1',
  sectionTitle: 'Phase',
  ...over,
})

function labInput(overrides: Partial<GuideContextInput> = {}): GuideContextInput {
  return { screen: 'lab', circuit: circuit(2, 3), result: null, traceSteps: null, lesson: null, ...overrides }
}
function learnInput(overrides: Partial<GuideContextInput> = {}): GuideContextInput {
  return { screen: 'learn', circuit: circuit(1, 0), result: null, traceSteps: null, lesson: null, ...overrides }
}

describe('Lab context', () => {
  it('describes the circuit and says plainly when there is no result — it never implies one', () => {
    const ctx = buildGuideContext(labInput())

    expect(ctx.label).toBe('Lab')
    expect(ctx.lines).toEqual([
      '2 qubits · 3 operations in the circuit',
      'No result yet — run the circuit, then ask about it.',
    ])
    expect(ctx.groundedResultId).toBeNull()
    expect(ctx.lines.join(' ')).not.toMatch(/res_|Latest result/)
    expect(ctx.lessonRequest).toBeNull()
    expect(ctx.canAsk).toBe(false)
    expect(ctx.disabledReason).toBe(LAB_NEEDS_RESULT_NOTICE)
  })

  it('uses singular forms', () => {
    expect(buildGuideContext(labInput({ circuit: circuit(1, 1) })).lines[0]).toBe('1 qubit · 1 operation in the circuit')
  })

  it('reports the latest REAL result by id, mode and backend, and grounds questions in it', () => {
    const ctx = buildGuideContext(labInput({ result: RESULT }))

    expect(ctx.lines).toContain('Latest result: res_abc (statevector, qiskit-aer)')
    expect(ctx.groundedResultId).toBe('res_abc')
    expect(ctx.lines.join(' ')).not.toContain('No result yet')
    expect(ctx.canAsk).toBe(true)
    expect(ctx.disabledReason).toBeNull()
    expect(ctx.lessonRequest).toBeNull() // Lab questions never carry lesson ids
  })

  it('mentions a loaded trace only when one exists (step count only — no quantum values)', () => {
    expect(buildGuideContext(labInput()).lines.join(' ')).not.toMatch(/trace/i)
    const withTrace = buildGuideContext(labInput({ traceSteps: 4 }))
    expect(withTrace.lines).toContain('A trace of this circuit is loaded (4 steps).')
    expect(buildGuideContext(labInput({ traceSteps: 1 })).lines).toContain('A trace of this circuit is loaded (1 step).')
  })

  it('offers the Lab quick questions', () => {
    expect(buildGuideContext(labInput()).quickActions).toEqual(LAB_QUICK_ACTIONS)
  })
})

describe('Learn context', () => {
  it('with no lesson open: says so, and the quick actions have nothing to ask about', () => {
    const ctx = buildGuideContext(learnInput())

    expect(ctx.label).toBe('Learn')
    expect(ctx.lines).toEqual(['No lesson is open — pick one from the list.'])
    expect(ctx.lessonRequest).toBeNull()
    expect(ctx.canAsk).toBe(false)
    expect(ctx.disabledReason).toBe(LEARN_NEEDS_LESSON_NOTICE)
  })

  it('shows the open lesson and current step by title, read from state — not lesson content', () => {
    const ctx = buildGuideContext(
      learnInput({ lesson: lesson({ title: 'Bell State', stepNumber: 2, totalSteps: 3, sectionTitle: 'Build it' }) }),
    )

    expect(ctx.lines).toContain('Lesson: Bell State')
    expect(ctx.lines).toContain('Step 2 of 3: Build it')
    expect(ctx.lines).toContain(LEARN_SOURCE_LINE)
  })

  it('handles a step with no title and a finished lesson', () => {
    expect(
      buildGuideContext(learnInput({ lesson: lesson({ stepNumber: 1, totalSteps: 2, sectionTitle: null }) })).lines,
    ).toContain('Step 1 of 2')
    expect(
      buildGuideContext(
        learnInput({ lesson: lesson({ stepNumber: 3, totalSteps: 2, sectionId: null, sectionTitle: null }) }),
      ).lines,
    ).toContain('You have been through every step of this lesson.')
  })

  it('with a lesson open, the quick actions are enabled and carry the lesson and section IDS only', () => {
    const ctx = buildGuideContext(learnInput({ lesson: lesson({ id: 'interference', sectionId: 's2' }) }))

    expect(ctx.canAsk).toBe(true)
    expect(ctx.disabledReason).toBeNull()
    expect(ctx.lessonRequest).toEqual({ lessonId: 'interference', sectionId: 's2' })
    expect(Object.keys(ctx.lessonRequest!).sort()).toEqual(['lessonId', 'sectionId'])
  })

  it('once every step is done the request names the lesson but no section', () => {
    const ctx = buildGuideContext(learnInput({ lesson: lesson({ stepNumber: 5, sectionId: null, sectionTitle: null }) }))
    expect(ctx.lessonRequest).toEqual({ lessonId: 'phase', sectionId: null })
    expect(ctx.canAsk).toBe(true)
  })

  it('Learn questions do not depend on, name or attach a Lab result', () => {
    const withResult = buildGuideContext(learnInput({ lesson: lesson(), result: RESULT }))
    const without = buildGuideContext(learnInput({ lesson: lesson() }))

    expect(withResult.lines).toEqual(without.lines)
    expect(withResult.lines.join(' ')).not.toMatch(/res_abc|Latest result/)
    expect(withResult.lessonRequest).toEqual(without.lessonRequest)
    expect(withResult.canAsk).toBe(true)
    // No lesson open: a Lab result alone does not enable Learn's lesson questions.
    expect(buildGuideContext(learnInput({ result: RESULT })).canAsk).toBe(false)
  })

  it('no longer carries the "cannot see lesson text" limitation — the backend now can', () => {
    const everything = JSON.stringify(buildGuideContext(learnInput({ lesson: lesson() })))
    expect(everything).not.toMatch(/aren’t available yet|can’t see lesson text/)
  })

  it('offers the Learn quick questions', () => {
    expect(buildGuideContext(learnInput()).quickActions).toEqual(LEARN_QUICK_ACTIONS)
  })

  it('is deterministic — the same input always gives the same context', () => {
    const input = learnInput({ lesson: lesson(), result: RESULT })
    expect(buildGuideContext(input)).toEqual(buildGuideContext(input))
  })
})

describe('quick-action questions', () => {
  // The backend's deterministic tutor (backend/qentor/tutor/deterministic.py)
  // routes on these substrings, circuit first. Copied here so this test fails
  // if the Lab wording drifts away from what the backend can actually answer.
  const CIRCUIT_KEYWORDS = ['circuit', 'gate', 'qubit', 'does this do', 'what does']
  const RESULT_KEYWORDS = ['result', 'probability', 'probabilities', 'outcome', 'count', 'counts', 'measure', 'measured', 'statevector', 'amplitude']
  const routes = (q: string) => {
    const s = q.toLowerCase()
    if (CIRCUIT_KEYWORDS.some((k) => s.includes(k))) return 'circuit'
    if (RESULT_KEYWORDS.some((k) => s.includes(k))) return 'result'
    return 'unsupported'
  }

  it('are fixed strings with no quantum content and no numbers', () => {
    for (const q of [...LAB_QUICK_ACTIONS, ...LEARN_QUICK_ACTIONS]) {
      expect(q).toMatch(/^[A-Za-z' ?]+$/)
      expect(q).not.toMatch(/probabilit|amplitude|statevector|bloch|fidelity|entangle/i)
    }
  })

  it('the Lab questions each reach a real backend answer path', () => {
    expect(routes('Explain this circuit')).toBe('circuit')
    expect(routes('Explain my result')).toBe('result')
    expect(routes('What does each gate in this circuit do?')).toBe('circuit')
    for (const q of LAB_QUICK_ACTIONS) expect(routes(q)).not.toBe('unsupported')
  })

  it('the Learn questions each reach a LESSON route in the backend router (which only runs when lesson ids are attached)', () => {
    // Mirrors backend/qentor/tutor/lesson_answers.py::route_question's lesson
    // patterns. Copied here so this test fails if the Learn wording drifts away
    // from what the backend's lesson router recognises.
    const HINT = /\b(hints?|clues?)\b/
    const SIMPLER = /\b(simpler|simple|simplify|easier|eli5)\b/
    const LESSON_WORDS = /\b(concept|section|lesson)\b/
    const lessonRoute = (q: string) => {
      const s = q.toLowerCase()
      if (HINT.test(s)) return 'hint'
      if (SIMPLER.test(s)) return 'simpler'
      if (LESSON_WORDS.test(s)) return 'explain'
      return 'other'
    }
    expect(LEARN_QUICK_ACTIONS.map(lessonRoute)).toEqual(['explain', 'simpler', 'hint'])
  })
})
