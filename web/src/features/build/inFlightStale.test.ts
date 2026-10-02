/**
 * Final quality sprint: the Lab's checks that run on the server (Bell verification, multi-input test, a trace-step question to the
 * Tutor) answer ONE circuit. If the circuit changes while the server is thinking, the late answer is dropped: it is never shown against
 * a circuit it was not made for, and it never strands a "running" flag. Also: picking a gate on the canvas picks the trace step that
 * applied it, so the canvas, the trace and the Tutor's "what changed" name the same operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutePayload } from '@/api'
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'
import { toQuantumValue, type Provenance } from '@/provenance/QuantumValue'
import { CX01, H0, traceResult, type Amplitude } from '@/test/traceFixtures'

const client = vi.hoisted(() => ({ verifyBellState: vi.fn(), runMultiInputTest: vi.fn(), askTutor: vi.fn() }))
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, getApiClient: () => client }
})

import { useBuildStore } from './store'

const INITIAL = useBuildStore.getState()
const build = () => useBuildStore.getState()
const gate = (g: GateOp['gate'], targets: number[], controls: number[] = []): GateOp => ({ gate: g, targets, controls, params: [], clbits: [] })
const BELL: Circuit = { ...emptyCircuit(2, 0), ops: [gate('h', [0]), gate('cx', [1], [0])] }

const PROVENANCE: Provenance = {
  resultId: 'res_stale_1',
  circuitHash: 'hash_stale_1',
  backend: 'qiskit-aer',
  backendVersion: '0.17.2',
  executionMode: 'statevector',
  provenanceClass: 'SIMULATION',
  verificationStatus: 'STATE_CHECKED',
  createdAt: '2026-10-01T00:00:00Z',
}
const seedResult = () => {
  const result = toQuantumValue<ExecutePayload>({ executionId: 'aer-local-1', probabilities: { '00': 0.5, '11': 0.5 } }, PROVENANCE)
  useBuildStore.setState({ circuit: BELL, result })
  return result
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  client.verifyBellState.mockReset()
  client.runMultiInputTest.mockReset()
  client.askTutor.mockReset()
  useBuildStore.setState(INITIAL, true)
})
afterEach(() => useBuildStore.setState(INITIAL, true))

describe('a Bell verification that arrives after the circuit changed', () => {
  it('is dropped, and the running flag is released', async () => {
    seedResult()
    const d = deferred<unknown>()
    client.verifyBellState.mockReturnValue(d.promise)
    const asked = build().runVerification()
    expect(build().isVerifying).toBe(true)
    build().insertOpAt(0, gate('z', [0])) // an edit while the server thinks
    expect(build().result).toBeNull()
    d.resolve({ status: 'VERIFIED' })
    await asked
    expect(build().verification).toBeNull()
    expect(build().isVerifying).toBe(false)
  })

  it('a late failure is dropped too: no error is shown for a circuit that no longer exists', async () => {
    seedResult()
    const d = deferred<unknown>()
    client.verifyBellState.mockReturnValue(d.promise)
    const asked = build().runVerification()
    build().insertOpAt(0, gate('z', [0]))
    d.reject(new Error('late failure'))
    await asked
    expect(build().verificationError).toBeNull()
    expect(build().isVerifying).toBe(false)
  })

  it('still shows an answer for the circuit that is on screen', async () => {
    seedResult()
    client.verifyBellState.mockResolvedValue({ status: 'VERIFIED' })
    await build().runVerification()
    expect(build().verification).toEqual({ status: 'VERIFIED' })
    expect(build().isVerifying).toBe(false)
  })

  it('a newer verification owns the flag: the older answer is dropped and does not release it', async () => {
    seedResult()
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    client.verifyBellState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = build().runVerification()
    const b = build().runVerification()
    first.resolve({ status: 'FIRST' })
    await a
    expect(build().verification).toBeNull()
    expect(build().isVerifying).toBe(true)
    second.resolve({ status: 'SECOND' })
    await b
    expect(build().verification).toEqual({ status: 'SECOND' })
  })
})

describe('a multi-input test that arrives after the circuit changed', () => {
  const run = () => build().runMultiInputTest([0], [1], [{ input: '0', expected: '0' }] as never, 'qiskit-aer' as never)

  it('is dropped, and the running flag is released', async () => {
    useBuildStore.setState({ circuit: BELL })
    const d = deferred<unknown>()
    client.runMultiInputTest.mockReturnValue(d.promise)
    const asked = run()
    expect(build().isMultiInputTesting).toBe(true)
    build().insertOpAt(0, gate('z', [0]))
    d.resolve({ allPassed: true })
    await asked
    expect(build().multiInputTest).toBeNull()
    expect(build().isMultiInputTesting).toBe(false)
  })

  it('a late failure is dropped too', async () => {
    useBuildStore.setState({ circuit: BELL })
    const d = deferred<unknown>()
    client.runMultiInputTest.mockReturnValue(d.promise)
    const asked = run()
    build().insertOpAt(0, gate('z', [0]))
    d.reject(new Error('late failure'))
    await asked
    expect(build().multiInputTestError).toBeNull()
    expect(build().isMultiInputTesting).toBe(false)
  })

  it('still shows an answer for the circuit that is on screen', async () => {
    useBuildStore.setState({ circuit: BELL })
    client.runMultiInputTest.mockResolvedValue({ allPassed: true })
    await run()
    expect(build().multiInputTest).toEqual({ allPassed: true })
  })
})

const R = 0.7071067811865476
const BELL_STATES: Amplitude[][] = [
  [[1, 0], [0, 0], [0, 0], [0, 0]],
  [[R, 0], [R, 0], [0, 0], [0, 0]],
  [[R, 0], [0, 0], [0, 0], [R, 0]],
]
const seedTrace = () => useBuildStore.setState({ circuit: BELL, trace: traceResult({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES, tag: 's' }), selectedTraceStep: 0 })

describe('a trace-step question to the Tutor (no Lab result) that is answered after the circuit changed', () => {
  it('is dropped: the answer about the old circuit is never added to the new conversation', async () => {
    seedTrace()
    expect(build().result).toBeNull()
    const d = deferred<unknown>()
    client.askTutor.mockReturnValue(d.promise)
    const asked = build().askTutor('What changed in this step?')
    expect(build().tutorTurns).toHaveLength(1)
    build().insertOpAt(0, gate('z', [0]))
    expect(build().tutorTurns).toHaveLength(0)
    d.resolve({ answer: 'ANSWER ABOUT THE OLD CIRCUIT', facts: [] })
    await asked
    expect(build().tutorTurns).toHaveLength(0)
    expect(build().isAskingTutor).toBe(false)
  })

  it('a late failure is dropped too', async () => {
    seedTrace()
    const d = deferred<unknown>()
    client.askTutor.mockReturnValue(d.promise)
    const asked = build().askTutor('What changed in this step?')
    build().insertOpAt(0, gate('z', [0]))
    d.reject(new Error('late failure'))
    await asked
    expect(build().tutorTurns).toHaveLength(0)
  })

  it('an answer for the circuit that is still on screen is kept', async () => {
    seedTrace()
    client.askTutor.mockResolvedValue({ answer: 'ok', facts: [] })
    await build().askTutor('What changed in this step?')
    expect(build().tutorTurns.map((t) => t.role)).toEqual(['learner', 'tutor'])
  })
})

describe('picking a gate on the canvas picks its trace step', () => {
  it('moves the trace to the step that applied that gate, and back', () => {
    seedTrace()
    expect(build().selectedTraceStep).toBe(0)
    build().selectOp(1) // the CX
    expect(build().selectedTraceStep).toBe(2)
    build().selectOp(0) // the H
    expect(build().selectedTraceStep).toBe(1)
  })

  it('without a trace it only selects the gate', () => {
    useBuildStore.setState({ circuit: BELL })
    build().selectOp(1)
    expect(build().selectedOpIndex).toBe(1)
    expect(build().selectedTraceStep).toBe(0)
  })

  it('a gate with no step of its own (a terminal measurement) leaves the trace step where it was', () => {
    const measured: Circuit = { ...BELL, num_clbits: 2, ops: [...BELL.ops, { gate: 'measure', targets: [0], controls: [], params: [], clbits: [0] }] }
    useBuildStore.setState({ circuit: measured, trace: traceResult({ numQubits: 2, ops: [H0, CX01], states: BELL_STATES, tag: 'm' }), selectedTraceStep: 1 })
    build().selectOp(2)
    expect(build().selectedOpIndex).toBe(2)
    expect(build().selectedTraceStep).toBe(1)
  })

  it('deselecting leaves the trace step alone', () => {
    seedTrace()
    build().selectOp(1)
    build().selectOp(null)
    expect(build().selectedTraceStep).toBe(2)
  })
})
