/**
 * Canonical circuit model — mirrors `backend/qentor/circuit/model.py` field for
 * field. This is the schema the server's `Circuit` pydantic model validates with
 * `extra="forbid"`: there is no field here for a probability, count, statevector
 * or verdict, because the server would reject one anyway.
 *
 * IMPORTANT: `GATE_NAMES` is exactly the backend's `GateName` enum (h x y z s sdg t tdg
 * rx ry rz cx cz cp swap ccx measure). Adding a gate here without the backend accepting it
 * would let the UI build a circuit the server can only reject — so the palette and this
 * list are extended together, backend first, and `fixtures/circuits/` (shared with the
 * backend tests) pins that the two agree.
 */
import { z } from 'zod'

export const GATE_NAMES = [
  'h',
  'x',
  'y',
  'z',
  's',
  'sdg',
  't',
  'tdg',
  'rx',
  'ry',
  'rz',
  'cx',
  'cz',
  'cp',
  'swap',
  'ccx',
  'measure',
] as const

export type GateName = (typeof GATE_NAMES)[number]

export const SINGLE_QUBIT_GATES = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg'] as const
export const PARAMETRIC_GATES = ['rx', 'ry', 'rz'] as const

export const GateOpSchema = z.object({
  gate: z.enum(GATE_NAMES),
  targets: z.array(z.number().int().nonnegative()).default([]),
  controls: z.array(z.number().int().nonnegative()).default([]),
  params: z.array(z.number()).default([]),
  clbits: z.array(z.number().int().nonnegative()).default([]),
})

export type GateOp = z.infer<typeof GateOpSchema>

export const CIRCUIT_SCHEMA_VERSION = 'qentor.circuit/1' as const

export const CircuitSchema = z.object({
  schema: z.literal(CIRCUIT_SCHEMA_VERSION).default(CIRCUIT_SCHEMA_VERSION),
  num_qubits: z.number().int().positive().max(32),
  num_clbits: z.number().int().nonnegative().max(32),
  ops: z.array(GateOpSchema).default([]),
})

export type Circuit = z.infer<typeof CircuitSchema>

export function emptyCircuit(numQubits: number, numClbits = numQubits): Circuit {
  return {
    schema: CIRCUIT_SCHEMA_VERSION,
    num_qubits: numQubits,
    num_clbits: numClbits,
    ops: [],
  }
}

/**
 * Client-side arity check, mirroring `GateOp._check_arity` in the backend
 * model. This exists only so the canvas can reject an invalid placement
 * before a round trip — the server re-validates independently and is the
 * only authority. Never trust this function's "valid" result as a substitute
 * for a server response.
 */
export function gateArityError(op: GateOp): string | null {
  const { gate, targets, controls, params, clbits } = op

  if ((SINGLE_QUBIT_GATES as readonly string[]).includes(gate)) {
    if (targets.length !== 1) return `${gate} takes exactly 1 target qubit`
    if (controls.length) return `${gate} takes no control qubits`
    if (params.length) return `${gate} takes no parameters`
    if (clbits.length) return `${gate} takes no classical bits`
    return null
  }

  if ((PARAMETRIC_GATES as readonly string[]).includes(gate)) {
    if (targets.length !== 1) return `${gate} takes exactly 1 target qubit`
    if (controls.length) return `${gate} takes no control qubits`
    if (params.length !== 1) return `${gate} takes exactly 1 parameter (radians)`
    if (clbits.length) return `${gate} takes no classical bits`
    return null
  }

  if (gate === 'cx' || gate === 'cz') {
    if (targets.length !== 1) return `${gate} takes exactly 1 target qubit`
    if (controls.length !== 1) return `${gate} takes exactly 1 control qubit`
    if (controls[0] === targets[0]) return `${gate} control and target must differ`
    if (params.length) return `${gate} takes no parameters`
    if (clbits.length) return `${gate} takes no classical bits`
    return null
  }

  if (gate === 'cp') {
    if (targets.length !== 1) return 'cp takes exactly 1 target qubit'
    if (controls.length !== 1) return 'cp takes exactly 1 control qubit'
    if (controls[0] === targets[0]) return 'cp control and target must differ'
    if (params.length !== 1) return 'cp takes exactly 1 parameter (a phase in radians)'
    if (!Number.isFinite(params[0])) return 'cp parameter must be a finite number'
    if (clbits.length) return 'cp takes no classical bits'
    return null
  }

  if (gate === 'ccx') {
    if (targets.length !== 1) return 'ccx takes exactly 1 target qubit'
    if (controls.length !== 2) return 'ccx takes exactly 2 control qubits'
    if (new Set([...controls, ...targets]).size !== 3) return 'ccx controls and target must be three different qubits'
    if (params.length) return 'ccx takes no parameters'
    if (clbits.length) return 'ccx takes no classical bits'
    return null
  }

  if (gate === 'swap') {
    if (targets.length !== 2) return 'swap takes exactly 2 target qubits'
    if (targets[0] === targets[1]) return 'swap targets must be two different qubits'
    if (controls.length) return 'swap takes no control qubits'
    if (params.length) return 'swap takes no parameters'
    if (clbits.length) return 'swap takes no classical bits'
    return null
  }

  if (gate === 'measure') {
    if (targets.length !== 1) return 'measure takes exactly 1 target qubit'
    if (clbits.length !== 1) return 'measure takes exactly 1 classical bit'
    if (controls.length) return 'measure takes no control qubits'
    if (params.length) return 'measure takes no parameters'
    return null
  }

  return `unknown gate ${gate}`
}
