/**
 * Zustand store for the Build screen. Owns the canonical circuit, the
 * derived QASM text, and the latest execution result. The result field is
 * always either `null` or a `QuantumValue` obtained by calling the
 * `ApiClient` — nothing in this store ever fabricates or hand-computes a
 * probability, count or statevector. See docs/ARCHITECTURE.md §3 for the
 * two-way canvas/code sync and 250ms debounce this store supports.
 */
import { create } from 'zustand'
import { getApiClient, BackendUnavailableError, EndpointNotImplementedError } from '@/api'
import type { ExecutePayload, ExecutionMode, OptimizationResult, TutorAnswerResult, VerifyBellStateResult } from '@/api'
import type { QuantumValue } from '@/provenance/QuantumValue'
import { emptyCircuit, gateArityError, type Circuit, type GateName, type GateOp } from '@/circuit/types'
import { toQasm3 } from '@/circuit/qasmEmitter'
import { parseQasm3, QasmParseError } from '@/circuit/qasmParser'

export const ROTATION_DEFAULT_ANGLE = Math.PI / 2

/**
 * One turn in the Tutor panel's conversation. A `tutor` turn's `answer` is
 * exactly what POST /api/tutor returned — this store never adds, rounds or
 * invents a fact of its own. Cleared in full (not just the pending answer)
 * whenever the circuit or execution result changes, since every past answer
 * was grounded in the circuit/result that is now stale.
 */
export type TutorTurn =
  | { role: 'learner'; text: string }
  | { role: 'tutor'; answer: TutorAnswerResult }
  | { role: 'error'; message: string }

interface BuildState {
  circuit: Circuit
  qasmText: string
  canvasError: string | null

  selectedGate: GateName | null
  pendingAngle: number
  pendingControl: number | null

  mode: ExecutionMode
  shots: number

  isExecuting: boolean
  result: QuantumValue<ExecutePayload> | null
  executionError: string | null

  isVerifying: boolean
  verification: VerifyBellStateResult | null
  verificationError: string | null

  tutorTurns: TutorTurn[]
  isAskingTutor: boolean

  isOptimizing: boolean
  optimization: OptimizationResult | null
  optimizationError: string | null

  setNumQubits: (n: number) => void
  selectGate: (gate: GateName | null) => void
  setPendingAngle: (angle: number) => void
  onWireClick: (qubitIndex: number) => void
  removeOpAt: (index: number) => void
  applyQasmEdit: (text: string) => { ok: true } | { ok: false; error: string; line: number | null }
  setMode: (mode: ExecutionMode) => void
  setShots: (shots: number) => void
  runExecution: () => Promise<void>
  runVerification: () => Promise<void>
  askTutor: (question: string) => Promise<void>
  runOptimization: () => Promise<void>
  applyOptimizedCircuit: () => void
}

function syncFromCircuit(circuit: Circuit) {
  return { circuit, qasmText: toQasm3(circuit) }
}

export const useBuildStore = create<BuildState>((set, get) => ({
  ...syncFromCircuit(emptyCircuit(3)),
  canvasError: null,

  selectedGate: null,
  pendingAngle: ROTATION_DEFAULT_ANGLE,
  pendingControl: null,

  mode: 'statevector',
  shots: 1024,

  isExecuting: false,
  result: null,
  executionError: null,

  isVerifying: false,
  verification: null,
  verificationError: null,

  tutorTurns: [],
  isAskingTutor: false,

  isOptimizing: false,
  optimization: null,
  optimizationError: null,

  setNumQubits: (n) => {
    set({
      ...syncFromCircuit(emptyCircuit(Math.max(1, Math.min(8, n)))),
      result: null,
      canvasError: null,
      pendingControl: null,
      verification: null,
      verificationError: null,
      tutorTurns: [],
      isAskingTutor: false,
      optimization: null,
      optimizationError: null,
    })
  },

  selectGate: (gate) => set({ selectedGate: gate, pendingControl: null, canvasError: null }),

  setPendingAngle: (angle) => set({ pendingAngle: angle }),

  onWireClick: (qubitIndex) => {
    const { selectedGate, pendingAngle, pendingControl, circuit } = get()
    if (!selectedGate) return

    if (selectedGate === 'cx') {
      if (pendingControl === null) {
        set({ pendingControl: qubitIndex })
        return
      }
      if (pendingControl === qubitIndex) {
        set({ pendingControl: null })
        return
      }
      addOp(set, get, { gate: 'cx', controls: [pendingControl], targets: [qubitIndex], params: [], clbits: [] })
      set({ pendingControl: null })
      return
    }

    if (selectedGate === 'measure') {
      const clbit = Math.min(qubitIndex, circuit.num_clbits - 1)
      if (clbit < 0) {
        set({ canvasError: 'circuit has no classical bits to measure into' })
        return
      }
      addOp(set, get, { gate: 'measure', targets: [qubitIndex], clbits: [clbit], controls: [], params: [] })
      return
    }

    if (selectedGate === 'rx' || selectedGate === 'ry' || selectedGate === 'rz') {
      addOp(set, get, { gate: selectedGate, targets: [qubitIndex], params: [pendingAngle], controls: [], clbits: [] })
      return
    }

    addOp(set, get, { gate: selectedGate, targets: [qubitIndex], controls: [], params: [], clbits: [] })
  },

  removeOpAt: (index) => {
    const { circuit } = get()
    const ops = circuit.ops.filter((_, i) => i !== index)
    set({
      ...syncFromCircuit({ ...circuit, ops }),
      result: null,
      verification: null,
      verificationError: null,
      tutorTurns: [],
      isAskingTutor: false,
      optimization: null,
      optimizationError: null,
    })
  },

  applyQasmEdit: (text) => {
    try {
      const circuit = parseQasm3(text)
      set({
        circuit,
        qasmText: text,
        canvasError: null,
        result: null,
        verification: null,
        verificationError: null,
        tutorTurns: [],
        isAskingTutor: false,
        optimization: null,
        optimizationError: null,
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof QasmParseError) {
        return { ok: false, error: err.message, line: err.line }
      }
      return { ok: false, error: String(err), line: null }
    }
  },

  setMode: (mode) =>
    set({
      mode,
      result: null,
      verification: null,
      verificationError: null,
      tutorTurns: [],
      isAskingTutor: false,
      optimization: null,
      optimizationError: null,
    }),
  setShots: (shots) => set({ shots: Math.max(1, Math.floor(shots)) }),

  runExecution: async () => {
    const { circuit, mode, shots } = get()
    if (circuit.ops.length === 0) {
      set({
        result: null,
        executionError: null,
        verification: null,
        verificationError: null,
        tutorTurns: [],
        isAskingTutor: false,
        optimization: null,
        optimizationError: null,
      })
      return
    }
    set({
      isExecuting: true,
      executionError: null,
      verification: null,
      verificationError: null,
      tutorTurns: [],
      isAskingTutor: false,
      optimization: null,
      optimizationError: null,
    })
    try {
      const client = getApiClient()
      const result = await client.executeCircuit(circuit, mode, mode === 'shots' ? shots : undefined)
      set({ result, isExecuting: false })
    } catch (err) {
      const message =
        err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      set({ executionError: message, result: null, isExecuting: false })
    }
  },

  runVerification: async () => {
    const { circuit, result } = get()
    // Only ever verify a real, already-executed result — the resultId comes
    // from the provenance the backend returned for it, never a client guess.
    if (!result) return
    set({ isVerifying: true, verificationError: null })
    try {
      const client = getApiClient()
      const verification = await client.verifyBellState(result.provenance.resultId, circuit)
      set({ verification, isVerifying: false })
    } catch (err) {
      const message =
        err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      set({ verificationError: message, verification: null, isVerifying: false })
    }
  },

  runOptimization: async () => {
    const { circuit } = get()
    // Optimize operates on the circuit itself, not an execution result — it
    // never needs a resultId, so unlike runVerification/askTutor it does not
    // gate on `result` existing at all.
    if (circuit.ops.length === 0) return
    set({ isOptimizing: true, optimizationError: null })
    try {
      const client = getApiClient()
      const optimization = await client.optimizeCircuit(circuit)
      set({ optimization, isOptimizing: false })
    } catch (err) {
      const message =
        err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      set({ optimizationError: message, optimization: null, isOptimizing: false })
    }
  },

  applyOptimizedCircuit: () => {
    // Never automatic — this is only ever invoked from an explicit user
    // click (OptimizePanel's "Apply optimized circuit" button), and only
    // does anything for a report the server itself marked VERIFIED_SHORTER
    // with an actual candidate circuit attached.
    const { optimization } = get()
    if (!optimization || optimization.status !== 'VERIFIED_SHORTER' || !optimization.candidateCircuit) return
    set({
      ...syncFromCircuit(optimization.candidateCircuit),
      canvasError: null,
      result: null,
      verification: null,
      verificationError: null,
      tutorTurns: [],
      isAskingTutor: false,
      optimization: null,
      optimizationError: null,
    })
  },

  askTutor: async (question) => {
    const trimmed = question.trim()
    if (!trimmed) return
    const { circuit, result } = get()
    // Only ever ask about a real, already-executed result — same discipline
    // as runVerification. resultId comes from the backend's own provenance,
    // never guessed or typed in by the learner.
    if (!result) return
    const resultId = result.provenance.resultId

    set((state) => ({
      tutorTurns: [...state.tutorTurns, { role: 'learner', text: trimmed }],
      isAskingTutor: true,
    }))

    // If the circuit/result changes while this request is in flight, the
    // reset above (setMode/addOp/runExecution/...) already clears tutorTurns
    // and isAskingTutor — discard this response rather than resurrecting a
    // stale conversation grounded in a circuit that no longer applies.
    const isStale = () => get().result?.provenance.resultId !== resultId

    try {
      const client = getApiClient()
      const answer = await client.askTutor(resultId, circuit, trimmed)
      if (isStale()) return
      set((state) => ({ tutorTurns: [...state.tutorTurns, { role: 'tutor', answer }], isAskingTutor: false }))
    } catch (err) {
      if (isStale()) return
      const message =
        err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      set((state) => ({ tutorTurns: [...state.tutorTurns, { role: 'error', message }], isAskingTutor: false }))
    }
  },
}))

function addOp(
  set: (partial: Partial<BuildState>) => void,
  get: () => BuildState,
  op: GateOp,
) {
  const error = gateArityError(op)
  if (error) {
    set({ canvasError: error })
    return
  }
  const { circuit } = get()
  const ops = [...circuit.ops, op]
  set({
    ...syncFromCircuit({ ...circuit, ops }),
    canvasError: null,
    result: null,
    verification: null,
    verificationError: null,
    tutorTurns: [],
    isAskingTutor: false,
    optimization: null,
    optimizationError: null,
  })
}
