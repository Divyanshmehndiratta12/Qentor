/**
 * A static diagram of a canonical circuit: one wire per qubit, one column per operation, in program order. Pure drawing of the circuit
 * it is given; it has no handlers, so there is nothing to edit, and it computes nothing about the quantum state. Wires are labelled
 * q[0] (top) to q[n-1], and the same circuit is also described in words for screen readers.
 */
import type { Circuit, GateOp } from '@/circuit/types'

const ROW = 38
const COL = 46
const LEFT = 52
const TOP = 22

const LABEL: Record<string, string> = { h: 'H', x: 'X', y: 'Y', z: 'Z', s: 'S', sdg: 'S†', t: 'T', tdg: 'T†', rx: 'Rx', ry: 'Ry', rz: 'Rz', measure: 'M' }

export function describeOp(op: GateOp): string {
  const q = (list: number[]) => list.map((n) => `q[${n}]`).join(', ')
  switch (op.gate) {
    case 'cx':
      return `controlled-NOT, control ${q(op.controls)}, target ${q(op.targets)}`
    case 'cz':
      return `controlled-Z, control ${q(op.controls)}, target ${q(op.targets)}`
    case 'cp':
      return `controlled phase ${op.params[0] ?? ''}, control ${q(op.controls)}, target ${q(op.targets)}`
    case 'ccx':
      return `Toffoli, controls ${q(op.controls)}, target ${q(op.targets)}`
    case 'swap':
      return `swap ${q(op.targets)}`
    case 'measure':
      return `measure ${q(op.targets)} into c[${op.clbits[0] ?? '?'}]`
    default:
      return `${op.gate}${op.params.length ? `(${op.params.join(', ')})` : ''} on ${q(op.targets)}`
  }
}

export function ReadOnlyCircuit({ circuit }: { circuit: Circuit }) {
  const n = circuit.num_qubits
  const width = LEFT + Math.max(circuit.ops.length, 1) * COL + 16
  const height = TOP + n * ROW
  const y = (qubit: number) => TOP + qubit * ROW + ROW / 2 - 6
  const x = (index: number) => LEFT + index * COL + COL / 2

  const summary =
    circuit.ops.length === 0
      ? `An empty circuit on ${n} qubit${n === 1 ? '' : 's'}.`
      : `A circuit on ${n} qubit${n === 1 ? '' : 's'} with ${circuit.ops.length} operation${circuit.ops.length === 1 ? '' : 's'}: ${circuit.ops.map(describeOp).join('; ')}.`

  return (
    <figure className="m-0" data-testid="readonly-circuit">
      <div className="overflow-x-auto rounded-lg border border-void-500 bg-void-950 p-2">
        <svg role="img" aria-label={summary} width={width} height={height} className="block">
          {Array.from({ length: n }, (_, q) => (
            <g key={q}>
              <text x={6} y={y(q) + 4} className="fill-slate-400" fontSize="11" fontFamily="monospace">
                q[{q}]
              </text>
              <line x1={LEFT - 6} x2={width - 8} y1={y(q)} y2={y(q)} className="stroke-void-300" strokeWidth="1" />
            </g>
          ))}
          {circuit.ops.map((op, i) => {
            const cx = x(i)
            const all = [...op.controls, ...op.targets]
            const lo = Math.min(...all)
            const hi = Math.max(...all)
            return (
              <g key={i} data-op={op.gate}>
                <title>{describeOp(op)}</title>
                {all.length > 1 && <line x1={cx} x2={cx} y1={y(lo)} y2={y(hi)} className="stroke-slate-300" strokeWidth="1.5" />}
                {op.controls.map((c) => (
                  <circle key={`c${c}`} cx={cx} cy={y(c)} r={4} className="fill-slate-100" />
                ))}
                {op.targets.map((t) => {
                  if (op.gate === 'cx' || op.gate === 'ccx') {
                    return (
                      <g key={`t${t}`}>
                        <circle cx={cx} cy={y(t)} r={10} className="fill-void-950 stroke-slate-100" strokeWidth="1.5" />
                        <line x1={cx - 10} x2={cx + 10} y1={y(t)} y2={y(t)} className="stroke-slate-100" strokeWidth="1.5" />
                        <line x1={cx} x2={cx} y1={y(t) - 10} y2={y(t) + 10} className="stroke-slate-100" strokeWidth="1.5" />
                      </g>
                    )
                  }
                  if (op.gate === 'cz' || op.gate === 'cp') return <circle key={`t${t}`} cx={cx} cy={y(t)} r={4} className="fill-slate-100" />
                  if (op.gate === 'swap') {
                    return (
                      <g key={`t${t}`} className="stroke-slate-100" strokeWidth="2">
                        <line x1={cx - 5} x2={cx + 5} y1={y(t) - 5} y2={y(t) + 5} />
                        <line x1={cx - 5} x2={cx + 5} y1={y(t) + 5} y2={y(t) - 5} />
                      </g>
                    )
                  }
                  return (
                    <g key={`t${t}`}>
                      <rect x={cx - 15} y={y(t) - 12} width={30} height={24} rx={4} className="fill-void-700 stroke-void-300" />
                      <text x={cx} y={y(t) + 4} textAnchor="middle" className="fill-slate-100" fontSize="12" fontFamily="monospace">
                        {LABEL[op.gate] ?? op.gate}
                      </text>
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  )
}
