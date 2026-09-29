/**
 * The step-aware tutor from the frontend's side: the selected trace step reaches
 * the tutor as an IDENTITY (never a value), the contextual starter appears only
 * with a trace, changing the step changes only which step is selected, and
 * Learn / Trace / Lab conversations stay separate. Real stores and the real
 * Guide + Tutor panels; only `@/api`'s client is mocked (no backend).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ExecutePayload, Lesson, TutorAnswerResult } from '@/api'
import { emptyCircuit } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { hzhWithBloch } from '@/test/traceFixtures'

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

import { useBuildStore } from '@/features/build/store'
import { selectedTraceStepContext } from '@/features/build/traceStepContext'
import { useLearnStore } from '@/features/learn/store'
import { TRACE_STEP_QUESTION } from '@/features/tutor/tutorContext'
import { GuidePanel } from './GuidePanel'

const PROVENANCE: Provenance = {
  resultId: 'res_lab',
  circuitHash: 'hash_lab',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'shots',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'VERIFIED',
  createdAt: '2026-01-01T00:00:00Z',
}

const HZH_CIRCUIT = {
  ...emptyCircuit(1, 0),
  ops: [
    { gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'z' as const, targets: [0], controls: [], params: [], clbits: [] },
    { gate: 'h' as const, targets: [0], controls: [], params: [], clbits: [] },
  ],
}

const LESSON: Lesson = {
  id: 'bell',
  title: 'Bell Lesson',
  shortDescription: 'SHORT',
  concept: 'entanglement',
  difficulty: 'beginner',
  estimatedMinutes: 10,
  learningObjectives: ['OBJ'],
  sections: [{ type: 'explanation', id: 's1', title: 'Intro', body: 'LESSON BODY' }],
  linkedCircuit: HZH_CIRCUIT,
  prerequisiteLessonIds: [],
}

const STEP_ANSWER: TutorAnswerResult = {
  answer: 'STEP ANSWER',
  resultId: 'trace-res',
  circuitHash: 'trace-hash',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'VERIFIED',
  usedFallbackTemplate: true,
  facts: [],
  traceStep: {
    stepIndex: 2,
    stepNumber: 3,
    totalSteps: 4,
    operationIndex: 1,
    resultId: 'trace-res',
    circuitHash: 'trace-hash',
    provenanceClass: 'SIMULATION',
    verificationStatus: 'VERIFIED',
  },
}
const LESSON_ANSWER: TutorAnswerResult = {
  answer: 'LESSON ANSWER',
  resultId: null,
  circuitHash: null,
  provenanceClass: null,
  verificationStatus: null,
  usedFallbackTemplate: true,
  facts: [],
  lessonId: 'bell',
  sectionId: 's1',
}

const INITIAL_BUILD = useBuildStore.getState()
const INITIAL_LEARN = useLearnStore.getState()

/** A loaded trace (H, Z, H) on the Build circuit; optionally also a Lab result. */
function seedTrace({ withResult = true }: { withResult?: boolean } = {}) {
  const trace = hzhWithBloch('t')
  act(() => {
    useBuildStore.setState({
      circuit: HZH_CIRCUIT,
      trace,
      selectedTraceStep: 0,
      ...(withResult
        ? { result: toQuantumValue<ExecutePayload>({ executionId: 'aer-local-x', probabilities: { '0': 1 } }, PROVENANCE) }
        : {}),
    })
  })
  return trace
}

const panel = () => screen.getByRole('complementary', { name: 'Qentor Guide' })
const quick = () => within(within(panel()).getByRole('region', { name: 'Quick questions' }))
const stepStarter = () => quick().queryByRole('button', { name: TRACE_STEP_QUESTION })

beforeEach(() => {
  askTutor.mockReset()
  askTutor.mockResolvedValue(STEP_ANSWER)
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})
afterEach(() => {
  cleanup()
  useBuildStore.setState(INITIAL_BUILD, true)
  useLearnStore.setState(INITIAL_LEARN, true)
})

describe('the contextual starter', () => {
  it('is absent without a trace, present (and enabled) with one', () => {
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(stepStarter()).toBeNull()
    cleanup()
    seedTrace()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(stepStarter()).toBeEnabled()
  })

  it('works with a trace and NO Lab result; the other quick questions stay disabled', () => {
    seedTrace({ withResult: false })
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(stepStarter()).toBeEnabled()
    expect(quick().getByRole('button', { name: 'Explain my result' })).toBeDisabled()
  })

  it('is not offered on Learn', () => {
    seedTrace()
    act(() => useLearnStore.setState({ lessons: [LESSON], selectedLessonId: 'bell' }))
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(stepStarter()).toBeNull()
  })

  it('the Guide names the selected step, from state that already exists', () => {
    seedTrace()
    act(() => useBuildStore.getState().selectTraceStep(2))
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    expect(within(panel()).getByText(/Selected trace step: Step 3 of 4/)).toBeInTheDocument()
  })
})

describe('the request carries the selected step’s identity', () => {
  it('the quick action sends the step identity as the sixth argument, plus the Lab result and circuit', async () => {
    const trace = seedTrace()
    act(() => useBuildStore.getState().selectTraceStep(2))
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)

    fireEvent.click(stepStarter()!)
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))

    const step = trace.steps[2]!
    const [resultId, circuit, question, language, lesson, traceStep] = askTutor.mock.calls[0]!
    expect(resultId).toBe('res_lab')
    expect(circuit).toBe(HZH_CIRCUIT)
    expect(question).toBe(TRACE_STEP_QUESTION)
    expect(language).toBe('en')
    expect(lesson).toBeUndefined()
    expect(traceStep).toEqual({
      stepIndex: 2,
      operationIndex: step.operationIndex,
      operation: step.operation,
      resultId: step.state.provenance.resultId,
      executionId: step.executionId,
      circuitHash: step.state.provenance.circuitHash,
      backend: step.state.provenance.backend,
      backendVersion: step.state.provenance.backendVersion,
      previousResultId: trace.steps[1]!.state.provenance.resultId,
    })
  })

  it('the identity has exactly the identity fields — no statevector, amplitude, probability or Bloch value', () => {
    seedTrace()
    act(() => useBuildStore.getState().selectTraceStep(1))
    const context = selectedTraceStepContext(useBuildStore.getState())!
    expect(Object.keys(context).sort()).toEqual([
      'backend',
      'backendVersion',
      'circuitHash',
      'executionId',
      'operation',
      'operationIndex',
      'previousResultId',
      'resultId',
      'stepIndex',
    ])
    const json = JSON.stringify(context)
    expect(json).not.toMatch(/statevector|amplitude|probabilit|bloch|coordinates|0\.7071/i)
  })

  it('with a trace and NO result the question is still asked, with a null result id', async () => {
    seedTrace({ withResult: false })
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    fireEvent.click(stepStarter()!)
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    expect(askTutor.mock.calls[0]![0]).toBeNull()
    expect(askTutor.mock.calls[0]![5]).toMatchObject({ stepIndex: 0 })
    expect(await within(panel()).findByText('STEP ANSWER')).toBeInTheDocument()
  })

  it('free text is allowed and carries the same identity', async () => {
    seedTrace()
    act(() => useBuildStore.getState().selectTraceStep(1))
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    fireEvent.change(within(panel()).getByRole('textbox', { name: 'Ask the tutor' }), {
      target: { value: 'why did the Bloch vector move?' },
    })
    fireEvent.click(within(panel()).getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    expect(askTutor.mock.calls[0]![2]).toBe('why did the Bloch vector move?')
    expect(askTutor.mock.calls[0]![5]).toMatchObject({ stepIndex: 1 })
  })

  it('a trace-less Lab question is exactly the original four arguments', async () => {
    act(() => {
      useBuildStore.setState({
        circuit: HZH_CIRCUIT,
        result: toQuantumValue<ExecutePayload>({ executionId: 'aer-local-x', probabilities: { '0': 1 } }, PROVENANCE),
      })
    })
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    fireEvent.click(quick().getByRole('button', { name: 'Explain my result' }))
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    expect(askTutor.mock.calls[0]).toHaveLength(4)
  })

  it('the answer states which step it was about and where the step’s record came from', async () => {
    seedTrace()
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    fireEvent.click(stepStarter()!)
    expect(await within(panel()).findByText(/about trace step 3 of 4 · trace-res · SIMULATION · VERIFIED/)).toBeInTheDocument()
  })
})

describe('changing the step', () => {
  it('updates the tutor context and the next request, and mutates nothing else', async () => {
    const trace = seedTrace()
    act(() => useBuildStore.setState({ tutorTurns: [{ role: 'learner', text: 'earlier question' }] }))
    render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    const before = useBuildStore.getState()

    act(() => useBuildStore.getState().selectTraceStep(3))
    expect(within(panel()).getByText(/Selected trace step: Step 4 of 4/)).toBeInTheDocument()

    const after = useBuildStore.getState()
    const { selectedTraceStep, ...restAfter } = after
    const { selectedTraceStep: was, ...restBefore } = before
    expect([was, selectedTraceStep]).toEqual([0, 3])
    for (const key of Object.keys(restBefore) as (keyof typeof restBefore)[]) {
      // Actions are stable; every data field keeps its exact reference.
      expect(restAfter[key], String(key)).toBe(restBefore[key])
    }
    // Still the same circuit, result, trace and conversation; language untouched.
    expect(after.circuit).toBe(HZH_CIRCUIT)
    expect(after.trace).toBe(trace)
    expect(after.result).not.toBeNull()
    expect(after.tutorTurns).toHaveLength(1)
    expect(after.tutorLanguage).toBe(INITIAL_BUILD.tutorLanguage)

    fireEvent.click(stepStarter()!)
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    expect(askTutor.mock.calls[0]![5]).toMatchObject({
      stepIndex: 3,
      resultId: trace.steps[3]!.state.provenance.resultId,
      previousResultId: trace.steps[2]!.state.provenance.resultId,
    })
  })

  it('changing the answer language does not change the selected step, and vice versa', () => {
    seedTrace()
    act(() => useBuildStore.getState().selectTraceStep(2))
    act(() => useBuildStore.getState().setTutorLanguage('kn'))
    expect(useBuildStore.getState().selectedTraceStep).toBe(2)
    act(() => useBuildStore.getState().selectTraceStep(1))
    expect(useBuildStore.getState().tutorLanguage).toBe('kn')
  })

  it('does not touch Learn progress', () => {
    seedTrace()
    act(() => useLearnStore.setState({ lessons: [LESSON], selectedLessonId: 'bell' }))
    const learn = useLearnStore.getState()
    act(() => useBuildStore.getState().selectTraceStep(2))
    expect(useLearnStore.getState()).toBe(learn)
  })

  it('a new trace resets the selection to the first step', () => {
    seedTrace()
    act(() => useBuildStore.getState().selectTraceStep(3))
    act(() => useBuildStore.getState().loadCircuit(HZH_CIRCUIT))
    expect(useBuildStore.getState().selectedTraceStep).toBe(0)
    expect(useBuildStore.getState().trace).toBeNull()
  })
})

describe('Learn, Trace and Lab stay separate', () => {
  it('a lesson question carries the lesson ids and NO trace step, even with a trace selected', async () => {
    seedTrace()
    act(() => useBuildStore.getState().selectTraceStep(2))
    act(() => useLearnStore.setState({ lessons: [LESSON], selectedLessonId: 'bell' }))
    askTutor.mockResolvedValue(LESSON_ANSWER)
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)

    fireEvent.click(quick().getByRole('button', { name: 'Explain this concept' }))
    await waitFor(() => expect(askTutor).toHaveBeenCalledTimes(1))
    const call = askTutor.mock.calls[0]!
    expect(call[0]).toBeNull()
    expect(call[1]).toBeNull()
    expect(call[4]).toEqual({ lessonId: 'bell', sectionId: 's1' })
    expect(call[5]).toBeUndefined()
  })

  it('a step answer stays in the Lab conversation and is never shown on a lesson', async () => {
    seedTrace()
    const view = render(<GuidePanel screen="lab" onClose={vi.fn()} />)
    fireEvent.click(stepStarter()!)
    expect(await within(panel()).findByText('STEP ANSWER')).toBeInTheDocument()
    expect(useBuildStore.getState().lessonTutorTurns).toEqual({})

    view.unmount()
    act(() => useLearnStore.setState({ lessons: [LESSON], selectedLessonId: 'bell' }))
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(within(panel()).queryByText('STEP ANSWER')).toBeNull()
    expect(within(panel()).queryByText(/Selected trace step/)).toBeNull()
  })

  it('the selected step’s line is not shown on Learn', () => {
    seedTrace()
    act(() => useLearnStore.setState({ lessons: [LESSON], selectedLessonId: 'bell' }))
    render(<GuidePanel screen="learn" onClose={vi.fn()} />)
    expect(within(panel()).queryByText(/trace/i)).toBeNull()
  })
})
