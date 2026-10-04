/**
 * Small measured circuits a learner can load into the Noise Lab to start from. Only CIRCUITS and words are here: what each one produces, ideally
 * or under noise, is decided by the server when the learner runs it. The summaries say what to LOOK for, never a number.
 */
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'

export interface NoiseExample {
  id: string
  title: string
  summary: string
  circuit: Circuit
}

const op = (gate: GateOp['gate'], targets: number[], controls: number[] = [], params: number[] = [], clbits: number[] = []): GateOp => ({
  gate,
  targets,
  controls,
  params,
  clbits,
})
const measureAll = (n: number): GateOp[] => Array.from({ length: n }, (_, q) => op('measure', [q], [], [], [q]))
const circuitOf = (numQubits: number, ops: GateOp[]): Circuit => ({ ...emptyCircuit(numQubits, numQubits), ops: [...ops, ...measureAll(numQubits)] })

export const NOISE_EXAMPLES: readonly NoiseExample[] = [
  {
    id: 'bell',
    title: 'Bell pair',
    summary: 'H then CX, then measure both qubits. An ideal run gives only two of the four outcomes; look for the other two under noise.',
    circuit: circuitOf(2, [op('h', [0]), op('cx', [1], [0])]),
  },
  {
    id: 'flip',
    title: 'One flipped qubit',
    summary: 'A single X gate, then measure. An ideal run always gives the same outcome, so every other outcome you see comes from noise.',
    circuit: circuitOf(1, [op('x', [0])]),
  },
  {
    id: 'ghz',
    title: 'Three-qubit GHZ state',
    summary: 'H then two CX gates, then measure all three. More gates give gate noise more chances to act; compare it with the Bell pair.',
    circuit: circuitOf(3, [op('h', [0]), op('cx', [1], [0]), op('cx', [2], [1])]),
  },
  {
    id: 'readout-only',
    title: 'No gates, just measure',
    summary: 'Two qubits that are never touched, then measured. Only readout error can change what is read here; gate noise has nothing to act on.',
    circuit: circuitOf(2, []),
  },
]
