/**
 * Educational rewrite examples for the Optimize panel: three small circuits a learner can load to watch the optimiser work.
 *
 * Only the CIRCUITS and the words are here. What the optimiser does with each one (its status, the rule that fires, the operation counts)
 * is decided by the server when the learner presses Optimize, and the backend test `test_optimizer_examples.py` pins that the three really
 * do produce what the descriptions lead the learner to expect. This file must match `fixtures/optimizer_examples.json` exactly
 * (`optimizeExamples.test.ts` compares them), the same arrangement as the golden circuits.
 */
import { emptyCircuit, type Circuit, type GateOp } from '@/circuit/types'

export interface OptimizeExample {
  id: string
  title: string
  /** What to expect and why, in words. A prediction about which rule should match, never a result. */
  summary: string
  circuit: Circuit
}

const op = (gate: GateOp['gate'], targets: number[], controls: number[] = [], params: number[] = []): GateOp => ({ gate, targets, controls, params, clbits: [] })
const circuitOf = (numQubits: number, ops: GateOp[]): Circuit => ({ ...emptyCircuit(numQubits, 0), ops })

export const OPTIMIZE_EXAMPLES: readonly OptimizeExample[] = [
  {
    id: 'two-hadamards-cancel',
    title: 'Two Hadamards in a row',
    summary:
      "H followed straight away by H on the same qubit. The rule 'a self-inverse gate twice cancels' should match, and the backend then checks the shorter circuit does the same thing.",
    circuit: circuitOf(2, [op('h', [0]), op('h', [0]), op('cx', [1], [0])]),
  },
  {
    id: 'rotations-merge',
    title: 'Two rotations about the same axis',
    summary:
      "Two RZ rotations back to back on one qubit. The rule 'same-axis rotations add their angles' should replace them with one, and the backend checks the result.",
    circuit: circuitOf(2, [op('h', [0]), op('rz', [0], [], [0.5]), op('rz', [0], [], [0.25]), op('cx', [1], [0])]),
  },
  {
    id: 'no-rule-matches',
    title: 'Reducible, but no rule for it',
    summary:
      'H, X, H on one qubit has a shorter equivalent (the Z gate, a textbook identity), but this optimizer only knows adjacent cancellations and merges. It proposes nothing rather than guess.',
    circuit: circuitOf(1, [op('h', [0]), op('x', [0]), op('h', [0])]),
  },
]
