/**
 * The Tutor's contextual actions: Analyze probability, Optimize circuit, What if…, Explain change.
 *
 * Each one is shown ONLY when the context it needs exists (a probability needs a Lab result; optimize and what-if need a circuit with
 * operations; explain change needs a selected trace step), and each asks the server's reasoning engine with a structured request:
 * the circuit, identifiers and a small typed choice. The learner never types a number the engine would use as a result, and the
 * browser computes nothing: a probability, a shorter circuit, a counterfactual and a step's change all come back from the server.
 *
 * What if… is a controlled form, not free text: pick one operation and ONE change (remove, replace, change an angle, add a gate).
 * The server builds the counterfactual circuit and the learner SEES it (its operations, what differs, its OpenQASM) before anything
 * runs; only then can the comparison be run, and the server checks the hashes it showed.
 */
import { useId, useState } from 'react'
import type { ModificationInput, ProbabilityTargetInput } from '@/api'
import { parseAngle } from '@/circuit/angle'
import { GATE_DISPLAY, MULTI_QUBIT_PLACEMENT, gateTakesAngle } from '@/circuit/gateSpec'
import type { GateName } from '@/circuit/types'
import { describeOperation } from '@/features/build/traceFormat'
import { useBuildStore } from '@/features/build/store'

const ONE_QUBIT: readonly GateName[] = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'rx', 'ry', 'rz']
const INSERTABLE: readonly GateName[] = [...ONE_QUBIT, 'cx', 'cz', 'cp', 'swap', 'ccx']
const ROTATIONS: readonly GateName[] = ['rx', 'ry', 'rz']

const field =
  'rounded-md border border-void-400 bg-void-800 px-1.5 py-1 text-xs text-slate-200 focus:border-violet-glow focus:outline-none disabled:opacity-50'
const button =
  'rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-45'
const primary = `${button} border-violet-glow/60 bg-violet-dim/30 text-violet-glow hover:bg-violet-dim/50`
const quiet = `${button} border-void-400 text-slate-300 hover:border-void-300 hover:text-slate-100`

type Open = null | 'probability' | 'what_if'

export function ReasoningActions() {
  const circuit = useBuildStore((s) => s.circuit)
  const result = useBuildStore((s) => s.result)
  const hasTraceStep = useBuildStore((s) => s.trace !== null && s.trace.steps[s.selectedTraceStep] !== undefined)
  const asking = useBuildStore((s) => s.isAskingTutor)
  const runReasoning = useBuildStore((s) => s.runReasoning)
  const clearWhatIfPreview = useBuildStore((s) => s.clearWhatIfPreview)
  const [open, setOpen] = useState<Open>(null)

  const hasOps = circuit.ops.length > 0
  const canProbability = result !== null
  const canOptimize = hasOps
  const canWhatIf = hasOps
  const canExplain = hasTraceStep
  if (!canProbability && !canOptimize && !canWhatIf && !canExplain) return null

  const toggle = (which: Exclude<Open, null>) => {
    if (open === 'what_if' && which !== 'what_if') clearWhatIfPreview()
    setOpen(open === which ? null : which)
  }

  return (
    <section aria-label="Analyze this circuit" className="mb-3 rounded-lg border border-void-500 bg-void-800 p-3" data-testid="reasoning-actions">
      <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Ask the backend</h3>
      <p className="mt-0.5 text-[11px] text-void-200">The server computes each answer from its own runs; the tutor only words it.</p>
      <div role="group" aria-label="Analysis actions" className="mt-2 flex flex-wrap gap-1.5">
        {canProbability && (
          <button type="button" className={quiet} aria-expanded={open === 'probability'} disabled={asking} onClick={() => toggle('probability')}>
            Analyze probability
          </button>
        )}
        {canOptimize && (
          <button type="button" className={quiet} disabled={asking} onClick={() => void runReasoning({ kind: 'optimize' })}>
            Optimize circuit
          </button>
        )}
        {canWhatIf && (
          <button type="button" className={quiet} aria-expanded={open === 'what_if'} disabled={asking} onClick={() => toggle('what_if')}>
            What if…
          </button>
        )}
        {canExplain && (
          <button type="button" className={quiet} disabled={asking} onClick={() => void runReasoning({ kind: 'trace_change' })}>
            Explain change
          </button>
        )}
      </div>
      {open === 'probability' && canProbability && <ProbabilityForm onDone={() => setOpen(null)} />}
      {open === 'what_if' && canWhatIf && <WhatIfForm />}
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ probability

type Kind = 'most_likely' | 'basis_state' | 'qubit_value' | 'sampled_vs_theoretical'

function ProbabilityForm({ onDone }: { onDone: () => void }) {
  const id = useId()
  const n = useBuildStore((s) => s.circuit.num_qubits)
  const mode = useBuildStore((s) => s.result?.provenance.executionMode)
  const asking = useBuildStore((s) => s.isAskingTutor)
  const runReasoning = useBuildStore((s) => s.runReasoning)
  const [kind, setKind] = useState<Kind>('most_likely')
  const [bits, setBits] = useState('')
  const [qubit, setQubit] = useState(0)
  const [value, setValue] = useState<0 | 1>(1)

  const bitsOk = new RegExp(`^[01]{${n}}$`).test(bits)
  const target: ProbabilityTargetInput | null =
    kind === 'most_likely'
      ? { kind }
      : kind === 'basis_state'
        ? bitsOk
          ? { kind, bits }
          : null
        : kind === 'qubit_value'
          ? { kind, qubit, value }
          : { kind, bits: bits === '' ? null : bitsOk ? bits : undefined }
  const valid = target !== null && !(kind === 'sampled_vs_theoretical' && target.kind === 'sampled_vs_theoretical' && target.bits === undefined)

  return (
    <form
      className="mt-3 flex flex-col gap-2 border-t border-void-500 pt-3"
      aria-label="Probability question"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid || !target) return
        void runReasoning({ kind: 'probability', target })
        onDone()
      }}
    >
      <label htmlFor={`${id}-kind`} className="text-[12px] text-slate-300">
        What do you want to know?
      </label>
      <select id={`${id}-kind`} className={field} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        <option value="most_likely">The most likely outcome</option>
        <option value="basis_state">The probability of one outcome</option>
        <option value="qubit_value">The probability that one qubit reads 0 or 1</option>
        {mode === 'shots' && <option value="sampled_vs_theoretical">Sampled frequency against theoretical probability</option>}
      </select>
      {(kind === 'basis_state' || kind === 'sampled_vs_theoretical') && (
        <label className="flex flex-col gap-1 text-[12px] text-slate-300">
          Outcome, {n} bit{n === 1 ? '' : 's'} written q[{n - 1}]…q[0]
          {kind === 'sampled_vs_theoretical' ? ' (leave empty for every outcome)' : ''}
          <input
            className={`${field} font-mono-qasm`}
            value={bits}
            inputMode="numeric"
            maxLength={n}
            pattern={`[01]{${n}}`}
            placeholder={'0'.repeat(n)}
            aria-invalid={bits !== '' && !bitsOk}
            onChange={(e) => setBits(e.target.value.replace(/[^01]/g, ''))}
          />
        </label>
      )}
      {kind === 'qubit_value' && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-300">
          <label className="flex items-center gap-1.5">
            Qubit
            <select className={field} value={qubit} onChange={(e) => setQubit(Number(e.target.value))}>
              {Array.from({ length: n }, (_, q) => (
                <option key={q} value={q}>
                  q[{q}]
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            reads
            <select className={field} value={value} onChange={(e) => setValue(Number(e.target.value) as 0 | 1)}>
              <option value={0}>0</option>
              <option value={1}>1</option>
            </select>
          </label>
        </div>
      )}
      <button type="submit" className={`${primary} self-start`} disabled={!valid || asking}>
        Analyze
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------------- what if

type ChangeKind = 'remove_gate' | 'replace_gate' | 'set_angle' | 'insert_gate'

function WhatIfForm() {
  const id = useId()
  const circuit = useBuildStore((s) => s.circuit)
  const selectedOpIndex = useBuildStore((s) => s.selectedOpIndex)
  const pending = useBuildStore((s) => s.whatIfPending)
  const error = useBuildStore((s) => s.whatIfError)
  const previewing = useBuildStore((s) => s.isPreviewingWhatIf)
  const asking = useBuildStore((s) => s.isAskingTutor)
  const previewWhatIf = useBuildStore((s) => s.previewWhatIf)
  const clearWhatIfPreview = useBuildStore((s) => s.clearWhatIfPreview)
  const runReasoning = useBuildStore((s) => s.runReasoning)

  const ops = circuit.ops
  const [kind, setKind] = useState<ChangeKind>('remove_gate')
  const [picked, setPicked] = useState<number | null>(null)
  const index = Math.min(picked ?? selectedOpIndex ?? 0, ops.length - 1)
  const op = ops[index]!
  const [newGate, setNewGate] = useState<GateName>('x')
  const [angleText, setAngleText] = useState('pi/2')
  const [insertAtRaw, setInsertAt] = useState(ops.length)
  const insertAt = Math.min(insertAtRaw, ops.length) // the circuit may have shrunk since the choice was made
  const [insertGate, setInsertGate] = useState<GateName>('x')
  const [wires, setWires] = useState<number[]>([0, 1, 2])

  const angle = parseAngle(angleText)
  const oneQubit = (ONE_QUBIT as readonly string[]).includes(op.gate)
  const controlled = op.gate === 'cx' || op.gate === 'cz'
  const replaceChoices: readonly GateName[] = oneQubit ? ONE_QUBIT : controlled ? ['cx', 'cz'] : []
  const effectiveNew: GateName = replaceChoices.includes(newGate) ? newGate : (replaceChoices[0] ?? 'x')
  const canSetAngle = op.gate === 'rx' || op.gate === 'ry' || op.gate === 'rz' || op.gate === 'cp'
  const roles = MULTI_QUBIT_PLACEMENT[insertGate]
  const arity = roles ? roles.length : 1
  const chosenWires = wires.slice(0, arity)
  const distinct = new Set(chosenWires).size === chosenWires.length
  const inRange = chosenWires.every((q) => q >= 0 && q < circuit.num_qubits)

  const needsAngleReplace = ROTATIONS.includes(effectiveNew) && !(ROTATIONS as readonly string[]).includes(op.gate)
  const modification: ModificationInput | null = (() => {
    if (kind === 'remove_gate') return { op: 'remove_gate', index }
    if (kind === 'replace_gate') {
      if (replaceChoices.length === 0) return null
      if (needsAngleReplace) return angle === null ? null : { op: 'replace_gate', index, gate: effectiveNew, angle }
      return { op: 'replace_gate', index, gate: effectiveNew }
    }
    if (kind === 'set_angle') return canSetAngle && angle !== null ? { op: 'set_angle', index, angle } : null
    if (!distinct || !inRange) return null
    if (gateTakesAngle(insertGate) && angle === null) return null
    const targets = roles ? chosenWires.filter((_, i) => roles[i] === 'target') : [chosenWires[0]!]
    const controls = roles ? chosenWires.filter((_, i) => roles[i] === 'control') : []
    return { op: 'insert_gate', index: insertAt, gate: insertGate, targets, controls, ...(gateTakesAngle(insertGate) ? { angle: angle! } : {}) }
  })()

  const showAngle = (kind === 'replace_gate' && needsAngleReplace) || kind === 'set_angle' || (kind === 'insert_gate' && gateTakesAngle(insertGate))
  const stale = pending !== null && pending.circuit !== circuit

  return (
    <div className="mt-3 flex flex-col gap-2.5 border-t border-void-500 pt-3" data-testid="whatif-form">
      <form
        className="flex flex-col gap-2"
        aria-label="What if: one change"
        onSubmit={(e) => {
          e.preventDefault()
          if (modification) void previewWhatIf(modification)
        }}
      >
        <label htmlFor={`${id}-kind`} className="text-[12px] text-slate-300">
          One change to try
        </label>
        <select
          id={`${id}-kind`}
          className={field}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as ChangeKind)
            clearWhatIfPreview()
          }}
        >
          <option value="remove_gate">Remove a gate</option>
          <option value="replace_gate">Replace a gate</option>
          <option value="set_angle">Change an angle</option>
          <option value="insert_gate">Add a gate</option>
        </select>

        {kind !== 'insert_gate' && (
          <label className="flex flex-col gap-1 text-[12px] text-slate-300">
            Which operation{selectedOpIndex !== null ? ' (the one you picked on the canvas is chosen)' : ''}
            <select
              className={field}
              value={index}
              onChange={(e) => {
                setPicked(Number(e.target.value))
                clearWhatIfPreview()
              }}
            >
              {ops.map((o, i) => (
                <option key={i} value={i}>
                  {i + 1}. {describeOperation(o)}
                </option>
              ))}
            </select>
          </label>
        )}

        {kind === 'replace_gate' &&
          (replaceChoices.length === 0 ? (
            <p role="status" className="text-[12px] text-amber-glow">
              {GATE_DISPLAY[op.gate]} cannot be replaced here: only a one-qubit gate, CX or CZ can.
            </p>
          ) : (
            <label className="flex flex-col gap-1 text-[12px] text-slate-300">
              Replace it with
              <select
                className={field}
                value={effectiveNew}
                onChange={(e) => {
                  setNewGate(e.target.value as GateName)
                  clearWhatIfPreview()
                }}
              >
                {replaceChoices.map((g) => (
                  <option key={g} value={g}>
                    {GATE_DISPLAY[g]}
                  </option>
                ))}
              </select>
            </label>
          ))}

        {kind === 'set_angle' && !canSetAngle && (
          <p role="status" className="text-[12px] text-amber-glow">
            {GATE_DISPLAY[op.gate]} has no angle. Pick an RX, RY, RZ or CP operation.
          </p>
        )}

        {kind === 'insert_gate' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[12px] text-slate-300">
              Add it as operation number
              <select
                className={field}
                value={insertAt}
                onChange={(e) => {
                  setInsertAt(Number(e.target.value))
                  clearWhatIfPreview()
                }}
              >
                {Array.from({ length: ops.length + 1 }, (_, i) => (
                  <option key={i} value={i}>
                    {i + 1}
                    {i === ops.length ? ' (at the end)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-slate-300">
              Gate
              <select
                className={field}
                value={insertGate}
                onChange={(e) => {
                  setInsertGate(e.target.value as GateName)
                  clearWhatIfPreview()
                }}
              >
                {INSERTABLE.map((g) => (
                  <option key={g} value={g}>
                    {GATE_DISPLAY[g]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: arity }, (_, i) => (
                <label key={i} className="flex items-center gap-1.5 text-[12px] text-slate-300">
                  {roles ? (insertGate === 'swap' ? (i === 0 ? 'First qubit' : 'Second qubit') : `${roles[i] === 'control' ? 'Control' : 'Target'}${roles.filter((r) => r === roles[i]).length > 1 ? ` ${i + 1}` : ''}`) : 'Qubit'}
                  <select
                    className={field}
                    value={wires[i] ?? 0}
                    onChange={(e) => {
                      setWires((w) => w.map((q, j) => (j === i ? Number(e.target.value) : q)))
                      clearWhatIfPreview()
                    }}
                  >
                    {Array.from({ length: circuit.num_qubits }, (_, q) => (
                      <option key={q} value={q}>
                        q[{q}]
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {!distinct && <p role="status" className="text-[12px] text-amber-glow">The qubits must be different.</p>}
          </div>
        )}

        {showAngle && (
          <label className="flex flex-col gap-1 text-[12px] text-slate-300">
            Angle in radians (you can write pi/2, -3*pi/4…)
            <input
              className={`${field} font-mono-qasm`}
              value={angleText}
              aria-invalid={angle === null}
              onChange={(e) => {
                setAngleText(e.target.value)
                clearWhatIfPreview()
              }}
            />
            {angle === null && <span className="text-amber-glow">That is not an angle the editor can read.</span>}
          </label>
        )}

        <button type="submit" className={`${quiet} self-start`} disabled={!modification || previewing}>
          {previewing ? 'Building the new circuit…' : 'Show the new circuit'}
        </button>
      </form>

      {error && (
        <p role="alert" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-2.5 text-xs text-danger-glow" data-testid="whatif-error">
          {error}
        </p>
      )}

      {pending && !stale && (
        <div className="flex flex-col gap-2 rounded-md border border-cyan-glow/30 bg-void-900 p-2.5" data-testid="whatif-preview">
          <h4 className="text-[11px] font-semibold tracking-wider text-cyan-glow uppercase">The server built this circuit (nothing has run yet)</h4>
          <p className="text-[12px] text-slate-200">
            {pending.preview.description}. {pending.preview.originalOpCount} operations become {pending.preview.counterfactualOpCount}.
          </p>
          <ol className="flex flex-col gap-0.5 font-mono-qasm text-[11px]" aria-label="Operations of the new circuit">
            {pending.preview.changes.map((c, i) => (
              <li key={i} className={c.kind === 'removed' ? 'text-danger-glow line-through' : c.kind === 'added' ? 'text-cyan-glow' : 'text-slate-300'}>
                {c.kind === 'removed' ? '− ' : c.kind === 'added' ? '+ ' : '  '}
                {c.description}
              </li>
            ))}
          </ol>
          <details className="text-[11px] text-slate-400">
            <summary className="cursor-pointer text-slate-300">OpenQASM 3 of the new circuit</summary>
            <pre className="mt-1 overflow-x-auto rounded bg-void-950 p-2 font-mono-qasm text-[11px] text-slate-300">{pending.preview.counterfactualQasm}</pre>
          </details>
          <p className="font-mono-qasm text-[10px] text-void-200">
            circuit {pending.preview.originalCircuitHash.slice(0, 12)} → {pending.preview.counterfactualCircuitHash.slice(0, 12)}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={primary} disabled={asking} onClick={() => void runReasoning({ kind: 'what_if' })}>
              Run both and compare
            </button>
            <button type="button" className={quiet} onClick={clearWhatIfPreview}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
