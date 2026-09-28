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
import type { ExecutePayload, ExecutionMode } from '@/api'
import type { QuantumValue } from '@/provenance/QuantumValue'
import { emptyCircuit, gateArityError, type Circuit, type GateName, type GateOp } from '@/circuit/types'
import { toQasm3 } from '@/circuit/qasmEmitter'
import { parseQasm3, QasmParseError } from '@/circuit/qasmParser'

export const ROTATION_DEFAULT_ANGLE = Math.PI / 2

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

  setNumQubits: (n: number) => void
  selectGate: (gate: GateName | null) => void
  setPendingAngle: (angle: number) => void
  onWireClick: (qubitIndex: number) => void
  removeOpAt: (index: number) => void
  applyQasmEdit: (text: string) => { ok: true } | { ok: false; error: string; line: number | null }
  setMode: (mode: ExecutionMode) => void
  setShots: (shots: number) => void
  runExecution: () => Promise<void>
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

  setNumQubits: (n) => {
    set({ ...syncFromCircuit(emptyCircuit(Math.max(1, Math.min(8, n)))), result: null, canvasError: null, pendingControl: null })
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
    set({ ...syncFromCircuit({ ...circuit, ops }), result: null })
  },

  applyQasmEdit: (text) => {
    try {
      const circuit = parseQasm3(text)
      set({ circuit, qasmText: text, canvasError: null, result: null })
      return { ok: true }
    } catch (err) {
      if (err instanceof QasmParseError) {
        return { ok: false, error: err.message, line: err.line }
      }
      return { ok: false, error: String(err), line: null }
    }
  },

  setMode: (mode) => set({ mode, result: null }),
  setShots: (shots) => set({ shots: Math.max(1, Math.floor(shots)) }),

  runExecution: async () => {
    const { circuit, mode, shots } = get()
    if (circuit.ops.length === 0) {
      set({ result: null, executionError: null })
      return
    }
    set({ isExecuting: true, executionError: null })
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
  set({ ...syncFromCircuit({ ...circuit, ops }), canvasError: null, result: null })
}
