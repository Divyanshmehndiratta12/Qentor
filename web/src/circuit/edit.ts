/**
 * Pure edits of the canonical circuit: insert, delete, move in time, move across wires. Every canvas action goes through
 * these functions and every one of them returns a NEW canonical `Circuit` (or a reason it refused), so there is no separate
 * canvas-only state that could drift from the model: what the canvas draws, what the QASM editor shows and what the server runs
 * are all derived from the circuit these functions return.
 *
 * What they check is what the server's model checks (`gateArityError` mirrors `GateOp._check_arity`, plus the index ranges the
 * server's `Circuit` validates): an edit that would produce a circuit the server must reject is refused HERE with a reason, and
 * the circuit is left exactly as it was. They compute nothing quantum: moving a gate changes the order of operations, and what
 * that does to the state is whatever the backend says when the new circuit is run.
 */
import { gateArityError, type Circuit, type GateOp } from './types'

export type EditResult = { ok: true; circuit: Circuit } | { ok: false; error: string }

const refuse = (error: string): EditResult => ({ ok: false, error })

/** Every wire an operation touches (controls first, then targets), without repeats. */
export function wiresOf(op: GateOp): number[] {
  return [...new Set([...op.controls, ...op.targets])]
}

/** Why `op` cannot be part of `circuit`, or `null`. Arity as the server's model has it, then the qubit and bit ranges. */
export function validateOp(circuit: Pick<Circuit, 'num_qubits' | 'num_clbits'>, op: GateOp): string | null {
  const arity = gateArityError(op)
  if (arity) return arity
  for (const q of wiresOf(op)) {
    if (!Number.isInteger(q) || q < 0 || q >= circuit.num_qubits) {
      return `qubit q[${q}] does not exist: the circuit has ${circuit.num_qubits} qubit${circuit.num_qubits === 1 ? '' : 's'}`
    }
  }
  for (const c of op.clbits) {
    if (!Number.isInteger(c) || c < 0 || c >= circuit.num_clbits) {
      return `classical bit c[${c}] does not exist: the circuit has ${circuit.num_clbits} classical bit${circuit.num_clbits === 1 ? '' : 's'}`
    }
  }
  return null
}

function withOps(circuit: Circuit, ops: GateOp[]): Circuit {
  return { ...circuit, ops }
}

function validIndex(index: number, upTo: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= upTo
}

/** Put `op` so that it becomes operation number `index` (0 = first). `index === ops.length` appends. */
export function insertOp(circuit: Circuit, index: number, op: GateOp): EditResult {
  if (!validIndex(index, circuit.ops.length)) {
    return refuse(`there is no position ${index}: the circuit has ${circuit.ops.length} operation${circuit.ops.length === 1 ? '' : 's'}`)
  }
  const problem = validateOp(circuit, op)
  if (problem) return refuse(problem)
  return { ok: true, circuit: withOps(circuit, [...circuit.ops.slice(0, index), op, ...circuit.ops.slice(index)]) }
}

export function deleteOp(circuit: Circuit, index: number): EditResult {
  if (!validIndex(index, circuit.ops.length - 1)) return refuse(`there is no operation ${index} to delete`)
  return { ok: true, circuit: withOps(circuit, circuit.ops.filter((_, i) => i !== index)) }
}

/** Move operation `from` so that it becomes operation `to` (both zero-based positions in the operation list). */
export function moveOp(circuit: Circuit, from: number, to: number): EditResult {
  const last = circuit.ops.length - 1
  if (!validIndex(from, last)) return refuse(`there is no operation ${from} to move`)
  if (!validIndex(to, last)) return refuse(`cannot move there: positions run from 0 to ${last}`)
  if (from === to) return { ok: true, circuit }
  const ops = [...circuit.ops]
  const [moved] = ops.splice(from, 1)
  ops.splice(to, 0, moved!)
  return { ok: true, circuit: withOps(circuit, ops) }
}

/**
 * Move an operation to other wires by `delta` (negative = towards q[0]). All of its wires shift together, so a CX keeps the same
 * distance between control and target; a measurement keeps its classical bit. Refused if any wire would leave the register.
 */
export function shiftOpWires(circuit: Circuit, index: number, delta: number): EditResult {
  if (!validIndex(index, circuit.ops.length - 1)) return refuse(`there is no operation ${index} to move`)
  if (!Number.isInteger(delta) || delta === 0) return { ok: true, circuit }
  const op = circuit.ops[index]!
  const moved: GateOp = { ...op, targets: op.targets.map((q) => q + delta), controls: op.controls.map((q) => q + delta) }
  const wires = wiresOf(moved)
  const low = Math.min(...wires)
  const high = Math.max(...wires)
  if (low < 0) return refuse('cannot move up: the gate is already on q[0]')
  if (high >= circuit.num_qubits) return refuse(`cannot move down: the gate is already on the last qubit, q[${circuit.num_qubits - 1}]`)
  const problem = validateOp(circuit, moved)
  if (problem) return refuse(problem)
  return { ok: true, circuit: withOps(circuit, circuit.ops.map((o, i) => (i === index ? moved : o))) }
}

/**
 * Move a SINGLE-wire operation onto wire `qubit` (a drag onto another row). A gate on several wires cannot be dropped on one wire
 * without changing what it is, so it is refused; use `shiftOpWires` for those.
 */
export function moveOpToWire(circuit: Circuit, index: number, qubit: number): EditResult {
  if (!validIndex(index, circuit.ops.length - 1)) return refuse(`there is no operation ${index} to move`)
  const op = circuit.ops[index]!
  const wires = wiresOf(op)
  if (wires.length !== 1) return refuse('a gate on several wires moves up or down as a whole; use the move buttons')
  return shiftOpWires(circuit, index, qubit - wires[0]!)
}

/** Two circuits are the same circuit when their canonical JSON is: the check undo/redo and the QASM sync use. */
export function sameCircuit(a: Circuit, b: Circuit): boolean {
  if (a === b) return true
  if (a.num_qubits !== b.num_qubits || a.num_clbits !== b.num_clbits || a.ops.length !== b.ops.length) return false
  return a.ops.every((op, i) => {
    const other = b.ops[i]!
    return (
      op.gate === other.gate &&
      op.targets.join() === other.targets.join() &&
      op.controls.join() === other.controls.join() &&
      op.params.join() === other.params.join() &&
      op.clbits.join() === other.clbits.join()
    )
  })
}

/**
 * Drag an operation to a new place: operation number `to`, and (for a gate on one wire) wire `qubit`. One edit, so one undo step.
 * A gate on several wires only changes position in time: dropping it on a row cannot say which of its wires moved.
 */
export function relocateOp(circuit: Circuit, from: number, to: number, qubit: number | null): EditResult {
  const moved = moveOp(circuit, from, to)
  if (!moved.ok || qubit === null) return moved
  const op = circuit.ops[from]
  if (!op || wiresOf(op).length !== 1) return moved
  return moveOpToWire(moved.circuit, to, qubit)
}
