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
import { TraceRejectedError } from '@/api'
import type {
  AgreementResult,
  Backend,
  EquivalenceResult,
  ExecutePayload,
  ExecutionMode,
  ExecutionTraceResult,
  MultiInputTestCase,
  MultiInputTestResult,
  OptimizationResult,
  TutorAnswerResult,
  TutorLanguage,
  TutorLessonContext,
  VerifyBellStateResult,
} from '@/api'
import type { QuantumValue } from '@/provenance/QuantumValue'
import { emptyCircuit, type Circuit, type GateName, type GateOp } from '@/circuit/types'
import { toQasm3 } from '@/circuit/qasmEmitter'
import { selectedTraceStepContext } from './traceStepContext'
import { MULTI_QUBIT_PLACEMENT, buildMultiQubitOp } from '@/circuit/gateSpec'
import { parseQasm3, QasmParseError } from '@/circuit/qasmParser'
import { deleteOp, insertOp, moveOp, relocateOp, sameCircuit, shiftOpWires, type EditResult } from '@/circuit/edit'

export const ROTATION_DEFAULT_ANGLE = Math.PI / 2

/** How many earlier circuits Undo can step back through. */
export const HISTORY_LIMIT = 100
/** Typing in the QASM editor applies a change every pause; changes this close together are ONE undo step. */
const QASM_COALESCE_MS = 1000
let lastQasmCommitAt = 0

/** The outcome of an editing action: done, or refused with a reason (the circuit is then exactly as it was). */
export type EditOutcome = { ok: true } | { ok: false; error: string }

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

/**
 * Why a trace request produced no trace. `rejected` is the backend's own
 * structured refusal (stable `code` + `message`, no quantum data);
 * `unexpected` is anything else (unreachable backend, an endpoint with no
 * implementation, a response that didn't match the expected shape). Neither
 * ever carries substitute data.
 */
export type TraceFailure =
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'unexpected'; message: string }

function toTraceFailure(err: unknown): TraceFailure {
  if (err instanceof TraceRejectedError) return { kind: 'rejected', code: err.code, message: err.message }
  if (err instanceof Error && err.name === 'ZodError') {
    return { kind: 'unexpected', message: "the backend's trace response did not match the expected shape" }
  }
  return { kind: 'unexpected', message: err instanceof Error ? err.message : String(err) }
}

/** What a circuit-changing action resets on the trace side: a trace is the
 * backend's states for one specific circuit, so it goes stale the moment that
 * circuit does. Deliberately NOT applied by `runExecution`/`setMode`: the
 * Build screen re-executes on a debounce, and that must not erase a trace of
 * the (unchanged) circuit the learner just asked for. */
const TRACE_CLEARED = { isTracing: false, trace: null, traceError: null, selectedTraceStep: 0 } as const

/**
 * Everything derived from the circuit on screen. It belongs to ONE circuit, so every change of the circuit (an edit, an undo, a
 * QASM edit, a loaded lesson, an applied optimisation) resets all of it in one place: a result, trace, verification, tutor
 * conversation, optimisation report or multi-input test is never shown against a circuit it was not made for.
 */
const DERIVED_CLEARED: Partial<BuildState> = {
  ...TRACE_CLEARED,
  result: null,
  verification: null,
  verificationError: null,
  tutorTurns: [],
  isAskingTutor: false,
  optimization: null,
  optimizationError: null,
  multiInputTest: null,
  multiInputTestError: null,
}

// Guards against an older, slower trace request resolving after a newer one.
let traceRequestSeq = 0
// Same for executions: the newest `runExecution` call is the only one whose
// answer may be shown.
let executionRequestSeq = 0

// Newest-request-wins counters for the two read-only Lab checks (see `runEquivalence` / `runAgreement`).
let equivalenceRequestSeq = 0
let agreementRequestSeq = 0

interface BuildState {
  circuit: Circuit
  qasmText: string
  canvasError: string | null

  /** Circuits before and after the current one, for Undo and Redo. Immutable snapshots of the canonical model, nothing else:
   * there is no canvas-only state, so undoing restores exactly what the QASM editor and the server would see. */
  past: Circuit[]
  future: Circuit[]
  /** The operation the learner has picked on the canvas (to move or delete it), by its position; `null` when none. */
  selectedOpIndex: number | null
  /** Where the next placed gate goes (an operation position); `null` means at the end. */
  insertAt: number | null

  selectedGate: GateName | null
  pendingAngle: number
  /** Wires already clicked for a multi-wire gate (cx, cz, ccx, swap), in click order; empty otherwise. */
  pendingQubits: number[]

  mode: ExecutionMode
  shots: number
  /** Which simulator Run, Trace and Optimize send their request to (the server runs it; this is only a name). */
  backend: Backend

  isExecuting: boolean
  result: QuantumValue<ExecutePayload> | null
  executionError: string | null
  /** HTTP status behind `executionError` when the server answered (a 4xx is a refusal, not an outage); `null` when it never did. */
  executionErrorStatus: number | null

  isVerifying: boolean
  verification: VerifyBellStateResult | null
  verificationError: string | null

  /** The LAB conversation (see `features/tutor/tutorContext.ts`): grounded in
   * the Build circuit's result, so cleared whenever that circuit/result
   * changes. Lesson conversations live in `lessonTutorTurns`, not here. */
  tutorTurns: TutorTurn[]
  isAskingTutor: boolean
  /** One conversation PER LESSON, keyed by lesson id, kept for the session
   * (in memory only). Not grounded in the Build circuit, so circuit/result
   * changes never touch it; switching lesson never shows another lesson's. */
  lessonTutorTurns: Record<string, TutorTurn[]>
  /** Whether a request is in flight for each lesson's conversation. */
  lessonAskingTutor: Record<string, boolean>
  /** The learner's chosen answer language (docs/ARCHITECTURE.md §10). A pure
   * UI preference, not derived from the circuit/result — unlike every other
   * tutor field above, it is never cleared by a circuit-mutating action. */
  tutorLanguage: TutorLanguage

  isOptimizing: boolean
  optimization: OptimizationResult | null
  optimizationError: string | null

  isMultiInputTesting: boolean
  multiInputTest: MultiInputTestResult | null
  multiInputTestError: string | null

  /** The backend's per-operation state trace of the CURRENT circuit
   * (POST /api/execute/trace). Fully separate from `result`, verification,
   * optimization, multi-input and tutor state: requesting or clearing a trace
   * never touches any of them, and they never touch it. */
  isTracing: boolean
  trace: ExecutionTraceResult | null
  traceError: TraceFailure | null
  /** Which step of `trace` the learner is looking at (the trace's own
   * zero-based `stepIndex`). Pure selection: choosing a step writes THIS field
   * only — never the circuit, result, verification, trace, Bloch state,
   * tutor conversation or language. Reset to 0 whenever a trace is loaded or
   * cleared, so it can never point past the trace it belongs to. The tutor reads
   * it (as an identity, see `traceStepContext.ts`) so it can explain that step. */
  selectedTraceStep: number

  setNumQubits: (n: number) => void
  selectGate: (gate: GateName | null) => void
  setPendingAngle: (angle: number) => void
  onWireClick: (qubitIndex: number) => void
  removeOpAt: (index: number) => void
  /** Pick (or with `null`, drop) the operation to act on. Selection only: the circuit is not touched. */
  selectOp: (index: number | null) => void
  /** Choose where the next placed gate goes; `null` = the end. Selection only. */
  setInsertAt: (index: number | null) => void
  /** Put `op` in as operation number `index`. Refused (with a reason, circuit unchanged) if the server would refuse the result. */
  insertOpAt: (index: number, op: GateOp) => EditOutcome
  /** Move operation `from` so it becomes operation `to` (earlier or later in time). */
  moveOpTo: (from: number, to: number) => EditOutcome
  /** Move an operation to other wires by `delta` (all its wires together). */
  shiftOp: (index: number, delta: number) => EditOutcome
  /** Drag an operation to position `to`, and (a single-wire gate) onto wire `qubit`: one edit, one undo step. */
  dropOp: (from: number, to: number, qubit: number | null) => EditOutcome
  undo: () => void
  redo: () => void
  applyQasmEdit: (text: string) => { ok: true } | { ok: false; error: string; line: number | null }
  setMode: (mode: ExecutionMode) => void
  setShots: (shots: number) => void
  runExecution: () => Promise<void>
  runVerification: () => Promise<void>

  /** Choosing another simulator makes every derived result (which belongs to the old one) stale, so they are cleared. */
  setBackend: (backend: Backend) => void

  /**
   * A snapshot of the circuit to compare later edits against ("am I still equivalent to what I started with?").
   * Just a circuit the learner chose to keep; it holds no result. The verdict comes from the server's checker.
   */
  referenceCircuit: Circuit | null
  pinReference: () => void
  clearReference: () => void
  isCheckingEquivalence: boolean
  /** The server's verdict on `{a, b}`; shown only while `b` is still the circuit on screen and `a` the pinned one. */
  equivalence: { result: EquivalenceResult; a: Circuit; b: Circuit } | null
  equivalenceError: string | null
  runEquivalence: () => Promise<void>

  isComparingBackends: boolean
  /** The server's cross-backend comparison of `circuit`; shown only while that is still the circuit on screen. */
  agreement: { result: AgreementResult; circuit: Circuit } | null
  agreementError: string | null
  runAgreement: () => Promise<void>
  /** Asks the backend for the per-operation trace of the current circuit.
   * Reads the circuit, never writes it. */
  runTrace: () => Promise<void>
  /** Selects a step of the loaded trace (clamped to its range); a no-op with no trace. */
  selectTraceStep: (index: number) => void
  askTutor: (question: string, lesson?: TutorLessonContext) => Promise<void>
  setTutorLanguage: (language: TutorLanguage) => void
  /**
   * Loads an externally-supplied canonical circuit (e.g. a Learn lesson's
   * `linkedCircuit`, via an interactive_lab section's "Open in Lab" action)
   * into the Build workspace — the same full reset every circuit-mutating
   * action here already performs. Never computes or fabricates anything: the
   * circuit itself must already be a real, already-validated canonical
   * `Circuit`, and running/verifying it still goes through the normal
   * `/api/execute` etc. flow once the learner acts on it here.
   */
  loadCircuit: (circuit: Circuit) => void
  runOptimization: () => Promise<void>
  applyOptimizedCircuit: () => void
  runMultiInputTest: (
    inputQubits: number[],
    outputQubits: number[],
    cases: MultiInputTestCase[],
    backend?: Backend,
  ) => Promise<void>
}

function syncFromCircuit(circuit: Circuit) {
  return { circuit, qasmText: toQasm3(circuit) }
}

export const useBuildStore = create<BuildState>((set, get) => ({
  ...syncFromCircuit(emptyCircuit(3)),
  canvasError: null,
  past: [],
  future: [],
  selectedOpIndex: null,
  insertAt: null,

  selectedGate: null,
  pendingAngle: ROTATION_DEFAULT_ANGLE,
  pendingQubits: [],

  mode: 'statevector',
  shots: 1024,
  backend: 'qiskit-aer',

  isExecuting: false,
  result: null,
  executionError: null,
  executionErrorStatus: null,

  isVerifying: false,
  verification: null,
  verificationError: null,

  referenceCircuit: null,
  isCheckingEquivalence: false,
  equivalence: null,
  equivalenceError: null,

  isComparingBackends: false,
  agreement: null,
  agreementError: null,

  tutorTurns: [],
  isAskingTutor: false,
  lessonTutorTurns: {},
  lessonAskingTutor: {},
  tutorLanguage: 'en',

  isOptimizing: false,
  optimization: null,
  optimizationError: null,

  isMultiInputTesting: false,
  multiInputTest: null,
  multiInputTestError: null,

  ...TRACE_CLEARED,

  setNumQubits: (n) => {
    commit(set, get, emptyCircuit(Math.max(1, Math.min(8, n))), { extra: { pendingQubits: [] } })
  },

  selectGate: (gate) => set({ selectedGate: gate, pendingQubits: [], canvasError: null }),

  setPendingAngle: (angle) => set({ pendingAngle: angle }),

  onWireClick: (qubitIndex) => {
    const { selectedGate, pendingAngle, pendingQubits, circuit } = get()
    if (!selectedGate) return

    // A gate on several wires (cx, cz, cp, ccx, swap) takes one click per wire. Clicking a wire that is
    // already picked cancels the half-placed gate; the last click adds it (arity is checked by `addOp`).
    const roles = MULTI_QUBIT_PLACEMENT[selectedGate]
    if (roles) {
      if (pendingQubits.includes(qubitIndex)) {
        set({ pendingQubits: [] })
        return
      }
      const picked = [...pendingQubits, qubitIndex]
      if (picked.length < roles.length) {
        set({ pendingQubits: picked })
        return
      }
      addOp(set, get, buildMultiQubitOp(selectedGate, picked, pendingAngle))
      set({ pendingQubits: [] })
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
    applyEdit(set, get, deleteOp(get().circuit, index))
  },

  selectOp: (index) => {
    const { circuit, selectedOpIndex } = get()
    const next = index !== null && index >= 0 && index < circuit.ops.length ? index : null
    if (next === selectedOpIndex) return // nothing to write: no churn for subscribers
    set({ selectedOpIndex: next })
  },

  setInsertAt: (index) => {
    const { circuit, insertAt } = get()
    const next = index !== null && index >= 0 && index < circuit.ops.length ? index : null // the end is `null`
    if (next === insertAt) return
    set({ insertAt: next })
  },

  insertOpAt: (index, op) => applyEdit(set, get, insertOp(get().circuit, index, op), { insertAt: index + 1 }),
  moveOpTo: (from, to) => applyEdit(set, get, moveOp(get().circuit, from, to), { selectedOpIndex: to }),
  shiftOp: (index, delta) => applyEdit(set, get, shiftOpWires(get().circuit, index, delta), { selectedOpIndex: index }),
  dropOp: (from, to, qubit) => applyEdit(set, get, relocateOp(get().circuit, from, to, qubit), { selectedOpIndex: to }),

  undo: () => {
    const { past, future, circuit } = get()
    const previous = past[past.length - 1]
    if (!previous) return
    commit(set, get, previous, { history: { past: past.slice(0, -1), future: [circuit, ...future].slice(0, HISTORY_LIMIT) } })
  },

  redo: () => {
    const { past, future, circuit } = get()
    const next = future[0]
    if (!next) return
    commit(set, get, next, { history: { past: [...past, circuit].slice(-HISTORY_LIMIT), future: future.slice(1) } })
  },

  applyQasmEdit: (text) => {
    // Text identical to the circuit's own is not an edit: nothing changed, so
    // nothing derived from this circuit (its result, trace, verification, ...)
    // is stale. Without this, a stale echo of the store's own text would erase
    // a NEWER result. A real edit (different text) still invalidates as before.
    if (text === get().qasmText) return { ok: true }
    try {
      const circuit = parseQasm3(text)
      // Different text still counts as an edit (results are re-derived), but text that reads as the SAME canonical circuit makes no
      // undo step (see `commit`). A person typing makes a change every pause; changes within a second of each other are one step.
      const now = Date.now()
      const coalesce = now - lastQasmCommitAt < QASM_COALESCE_MS
      lastQasmCommitAt = now
      commit(set, get, circuit, { qasmText: text, history: coalesce ? 'coalesce' : 'record' })
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
      multiInputTest: null,
      multiInputTestError: null,
    }),
  setShots: (shots) => set({ shots: Math.max(1, Math.floor(shots)) }),

  setBackend: (backend) => {
    if (backend === get().backend) return // nothing to write: no churn for subscribers
    ++executionRequestSeq // anything in flight was asked of the old backend
    ++traceRequestSeq
    set({
      backend,
      ...TRACE_CLEARED,
      isExecuting: false,
      result: null,
      executionError: null,
      verification: null,
      verificationError: null,
      tutorTurns: [],
      isAskingTutor: false,
      optimization: null,
      optimizationError: null,
      multiInputTest: null,
      multiInputTestError: null,
    })
  },

  runExecution: async () => {
    const { circuit, mode, shots, backend } = get()
    // Every call is a new "latest" request; anything still in flight from an
    // earlier call is superseded (see `isStale` below).
    const seq = ++executionRequestSeq
    if (circuit.ops.length === 0) {
      set({
        isExecuting: false,
        result: null,
        executionError: null,
        verification: null,
        verificationError: null,
        tutorTurns: [],
        isAskingTutor: false,
        optimization: null,
        optimizationError: null,
        multiInputTest: null,
        multiInputTestError: null,
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
      multiInputTest: null,
      multiInputTestError: null,
    })
    // A response only counts if it is still the answer to the CURRENT question:
    // no newer run has started, and the circuit / mode / shots it was asked about
    // are still the ones on screen. Otherwise it is discarded — never shown as the
    // result of a circuit that has since changed. Only the latest request owns
    // `isExecuting`, so a discarded one cannot strand it `true` (or flip it
    // `false` under a newer run that is still going).
    const isStale = () =>
      seq !== executionRequestSeq ||
      get().circuit !== circuit ||
      get().mode !== mode ||
      get().backend !== backend ||
      (mode === 'shots' && get().shots !== shots)
    const dropStale = () => {
      if (seq === executionRequestSeq) set({ isExecuting: false })
    }

    try {
      const client = getApiClient()
      const result = await client.executeCircuit(circuit, mode, mode === 'shots' ? shots : undefined, backend)
      if (isStale()) return dropStale()
      set({ result, isExecuting: false })
    } catch (err) {
      if (isStale()) return dropStale()
      const message =
        err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      set({
        executionError: message,
        executionErrorStatus: err instanceof BackendUnavailableError ? (err.status ?? null) : null,
        result: null,
        isExecuting: false,
      })
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

  runTrace: async () => {
    // Reads the circuit and only ever writes the three trace fields — never
    // the circuit, `result`, verification, optimization, multi-input or tutor
    // state. It does not gate on an execution `result` (the backend traces
    // the circuit itself) and does no eligibility checking of its own: an
    // untraceable circuit comes back as the backend's structured refusal.
    const { circuit, backend } = get()
    const seq = ++traceRequestSeq
    set({ isTracing: true, trace: null, traceError: null, selectedTraceStep: 0 })

    // Discard the response if the circuit changed in flight (the mutation
    // already cleared the trace fields) or a newer trace request superseded
    // this one — never resurrect a trace of a circuit that no longer exists.
    const isStale = () => seq !== traceRequestSeq || get().circuit !== circuit || get().backend !== backend

    try {
      const client = getApiClient()
      const trace = await client.traceCircuit(circuit, backend)
      if (isStale()) return
      set({ trace, isTracing: false, selectedTraceStep: 0 })
    } catch (err) {
      if (isStale()) return
      set({ traceError: toTraceFailure(err), trace: null, isTracing: false })
    }
  },

  selectTraceStep: (index) => {
    const { trace, selectedTraceStep } = get()
    if (!trace) return
    const next = Math.max(0, Math.min(trace.steps.length - 1, Math.floor(index)))
    if (next === selectedTraceStep) return // nothing to write: no churn for subscribers
    set({ selectedTraceStep: next })
  },

  pinReference: () => set({ referenceCircuit: get().circuit, equivalence: null, equivalenceError: null }),

  clearReference: () => set({ referenceCircuit: null, equivalence: null, equivalenceError: null }),

  runEquivalence: async () => {
    const { circuit, referenceCircuit } = get()
    if (!referenceCircuit) return
    const seq = ++equivalenceRequestSeq
    set({ isCheckingEquivalence: true, equivalenceError: null })
    // A verdict only counts for the pair it was asked about: if the circuit or the pinned reference changed
    // while the server was thinking, the answer is dropped, never shown against a different pair.
    const isStale = () => seq !== equivalenceRequestSeq || get().circuit !== circuit || get().referenceCircuit !== referenceCircuit
    // Only the newest request owns the "checking" flag, so a dropped answer can neither strand it on nor turn it off
    // under a newer request that is still running.
    const dropStale = () => {
      if (seq === equivalenceRequestSeq) set({ isCheckingEquivalence: false })
    }
    try {
      const result = await getApiClient().checkEquivalence(referenceCircuit, circuit)
      if (isStale()) return dropStale()
      set({ equivalence: { result, a: referenceCircuit, b: circuit }, isCheckingEquivalence: false })
    } catch (err) {
      if (isStale()) return dropStale()
      set({ equivalenceError: err instanceof Error ? err.message : String(err), equivalence: null, isCheckingEquivalence: false })
    }
  },

  runAgreement: async () => {
    const { circuit } = get()
    if (circuit.ops.length === 0) return
    const seq = ++agreementRequestSeq
    set({ isComparingBackends: true, agreementError: null })
    const isStale = () => seq !== agreementRequestSeq || get().circuit !== circuit
    const dropStale = () => {
      if (seq === agreementRequestSeq) set({ isComparingBackends: false })
    }
    try {
      const result = await getApiClient().compareBackends(circuit)
      if (isStale()) return dropStale()
      set({ agreement: { result, circuit }, isComparingBackends: false })
    } catch (err) {
      if (isStale()) return dropStale()
      set({ agreementError: err instanceof Error ? err.message : String(err), agreement: null, isComparingBackends: false })
    }
  },

  runOptimization: async () => {
    const { circuit, backend } = get()
    // Optimize operates on the circuit itself, not an execution result — it
    // never needs a resultId, so unlike runVerification/askTutor it does not
    // gate on `result` existing at all.
    if (circuit.ops.length === 0) return
    set({ isOptimizing: true, optimizationError: null })
    try {
      const client = getApiClient()
      const optimization = await client.optimizeCircuit(circuit, backend)
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
    commit(set, get, optimization.candidateCircuit, {}) // one undo step: the learner can always get the original back
  },

  runMultiInputTest: async (inputQubits, outputQubits, cases, backend) => {
    const { circuit } = get()
    // Multi-input testing operates on the circuit itself, not an execution
    // result — same as runOptimization, it never gates on `result` existing.
    if (inputQubits.length === 0 || outputQubits.length === 0 || cases.length === 0) return
    set({ isMultiInputTesting: true, multiInputTestError: null })
    try {
      const client = getApiClient()
      const multiInputTest = await client.runMultiInputTest(circuit, inputQubits, outputQubits, cases, backend)
      set({ multiInputTest, isMultiInputTesting: false })
    } catch (err) {
      const message =
        err instanceof BackendUnavailableError || err instanceof EndpointNotImplementedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      set({ multiInputTestError: message, multiInputTest: null, isMultiInputTesting: false })
    }
  },

  askTutor: async (question, lesson) => {
    const trimmed = question.trim()
    if (!trimmed) return
    const { circuit, result, tutorLanguage } = get()

    // A lesson question (a Learn quick action or a typed Learn question): sends
    // the lesson and section IDS only — no circuit, no result, no lesson text —
    // and the backend answers from its own lesson registry. It needs no Lab
    // result, so it does not touch the result-based guards below.
    //
    // It belongs to THAT LESSON's conversation (`lessonTutorTurns[lessonId]`),
    // never the Lab's: the question, its answer (or error) and the in-flight
    // flag all land under `lessonId`, wherever the learner has navigated to by
    // the time the answer arrives. Nothing here writes `tutorTurns`.
    if (lesson) {
      const lessonId = lesson.lessonId
      if (get().lessonAskingTutor[lessonId]) return // one request at a time per conversation
      const turnsOf = (state: { lessonTutorTurns: Record<string, TutorTurn[]> }) => state.lessonTutorTurns[lessonId] ?? []
      const append = (turn: TutorTurn, asking: boolean) =>
        set((state) => ({
          lessonTutorTurns: { ...state.lessonTutorTurns, [lessonId]: [...turnsOf(state), turn] },
          lessonAskingTutor: { ...state.lessonAskingTutor, [lessonId]: asking },
        }))

      const learnerTurn: TutorTurn = { role: 'learner', text: trimmed }
      append(learnerTurn, true)
      // Stale = this question's turn is no longer in its conversation (the
      // conversation was discarded), so its answer is dropped, not resurrected.
      const dropIfStale = (): boolean => {
        if (turnsOf(get()).includes(learnerTurn)) return false
        set((state) => ({ lessonAskingTutor: { ...state.lessonAskingTutor, [lessonId]: false } }))
        return true
      }
      try {
        const answer = await getApiClient().askTutor(null, null, trimmed, tutorLanguage, lesson)
        if (dropIfStale()) return
        append({ role: 'tutor', answer }, false)
      } catch (err) {
        if (dropIfStale()) return
        append({ role: 'error', message: err instanceof Error ? err.message : String(err) }, false)
      }
      return
    }

    // Only ever ask about a real, already-executed result — same discipline
    // as runVerification. resultId comes from the backend's own provenance,
    // never guessed or typed in by the learner.
    // A selected trace step is itself a real, backend-recorded thing to ask
    // about, so a step question needs no Lab result (the backend resolves the step).
    const stepContext = selectedTraceStepContext(get())
    if (!result && !stepContext) return
    const resultId = result ? result.provenance.resultId : null

    set((state) => ({
      tutorTurns: [...state.tutorTurns, { role: 'learner', text: trimmed }],
      isAskingTutor: true,
    }))

    // If the circuit/result changes while this request is in flight, the
    // reset above (setMode/addOp/runExecution/...) already clears tutorTurns
    // and isAskingTutor — discard this response rather than resurrecting a
    // stale conversation grounded in a circuit that no longer applies.
    const isStale = () => (get().result?.provenance.resultId ?? null) !== resultId

    try {
      const client = getApiClient()
      // With a trace loaded the question also carries the selected step's IDENTITY
      // (never a value); the backend verifies it. With none, the request is
      // exactly the original four arguments.
      const answer = stepContext
        ? await client.askTutor(resultId, circuit, trimmed, tutorLanguage, undefined, stepContext)
        : await client.askTutor(resultId, circuit, trimmed, tutorLanguage)
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

  // A pure learner preference — deliberately does not touch the circuit,
  // result, or any other derived tutor/verification/optimization state.
  setTutorLanguage: (language) => set({ tutorLanguage: language }),

  loadCircuit: (circuit) => {
    // A circuit brought in from outside (a lesson, a challenge's starter, a share link, an AI proposal the learner inserted)
    // replaces the one on the canvas as ONE undo step, so an accidental replacement is never a loss.
    commit(set, get, circuit, { extra: { selectedGate: null, pendingQubits: [], executionError: null } })
  },
}))

type StoreSet = (partial: Partial<BuildState>) => void

/**
 * THE way the circuit changes. Sets the new canonical circuit and its QASM text, resets everything derived from the old circuit,
 * clears the selection, and keeps the undo history: the old circuit is pushed (and the redo list dropped) unless the circuit is
 * the same one, in which case nothing is recorded; `history: 'coalesce'` replaces rather than adds a step while the learner is
 * typing; an explicit `{past, future}` is what undo and redo pass.
 */
function commit(
  set: StoreSet,
  get: () => BuildState,
  circuit: Circuit,
  options: {
    qasmText?: string
    history?: 'record' | 'coalesce' | { past: Circuit[]; future: Circuit[] }
    selectedOpIndex?: number | null
    insertAt?: number | null
    extra?: Partial<BuildState>
  } = {},
): void {
  const { circuit: current, past, future } = get()
  let nextPast = past
  let nextFuture = future
  const history = options.history ?? 'record'
  if (typeof history === 'object') {
    nextPast = history.past
    nextFuture = history.future
  } else if (!sameCircuit(current, circuit)) {
    if (history === 'record' || past.length === 0) nextPast = [...past, current].slice(-HISTORY_LIMIT)
    nextFuture = []
  }
  set({
    ...DERIVED_CLEARED,
    circuit,
    qasmText: options.qasmText ?? toQasm3(circuit),
    canvasError: null,
    past: nextPast,
    future: nextFuture,
    selectedOpIndex: options.selectedOpIndex ?? null,
    insertAt: options.insertAt ?? null,
    ...options.extra,
  })
}

/** An edit from `qentor/circuit/edit.ts`: committed as one undo step if it was accepted; refused with its reason otherwise (the
 * circuit, and everything derived from it, is then left exactly as it was). */
function applyEdit(
  set: StoreSet,
  get: () => BuildState,
  result: EditResult,
  after: { selectedOpIndex?: number | null; insertAt?: number | null } = {},
): EditOutcome {
  if (!result.ok) {
    set({ canvasError: result.error })
    return { ok: false, error: result.error }
  }
  commit(set, get, result.circuit, { selectedOpIndex: after.selectedOpIndex ?? null, insertAt: after.insertAt ?? null })
  return { ok: true }
}

/** Place a gate: at the chosen insertion point, or at the end. The server's model is mirrored by `insertOp`'s checks. */
function addOp(set: StoreSet, get: () => BuildState, op: GateOp) {
  const { circuit, insertAt } = get()
  const index = insertAt === null ? circuit.ops.length : Math.min(insertAt, circuit.ops.length)
  applyEdit(set, get, insertOp(circuit, index, op), { insertAt: insertAt === null ? null : index + 1 })
}
