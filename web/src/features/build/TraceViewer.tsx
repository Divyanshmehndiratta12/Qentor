/**
 * Step-through viewer for POST /api/execute/trace: the BACKEND's state after
 * each operation of a circuit, one step at a time.
 *
 * Trust rule (absolute): this component renders values the backend returned
 * and nothing else. It calculates no amplitude, probability, Bloch
 * coordinate, state transition or measurement distribution, and shows none —
 * only the backend's own `[re, im]` pairs, formatted for reading
 * (`traceFormat.ts` is string-only). Every amplitude goes through
 * `VerifiedValueInline` with its step's provenance, so a state cannot appear
 * without it.
 *
 * Measurements: the backend strips trailing `measure` ops before tracing (a
 * measurement in the circuit would collapse the state at random), so the
 * timeline has NO measurement step. They are listed separately, as metadata
 * only — this component never shows, and never invents, a post-measurement
 * state.
 *
 * Purely presentational: the connected wrapper (`TracePanel`) owns the Run
 * button and the store; this takes the trace / loading / error to show.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import type { ExecutionTraceResult, TraceStep } from '@/api'
import { ProvenanceBadge } from '@/provenance/ProvenanceBadge'
import { toQuantumValue } from '@/provenance/QuantumValue'
import { VerifiedValueInline } from '@/provenance/VerifiedValue'
import type { TraceFailure } from './store'
import {
  basisLabel,
  describeOperation,
  displaysAsZero,
  formatAmplitude,
  isKnownBasisOrdering,
  shortOperationLabel,
} from './traceFormat'

export interface TraceViewerProps {
  trace: ExecutionTraceResult | null
  isLoading: boolean
  error: TraceFailure | null
}

export function TraceViewer({ trace, isLoading, error }: TraceViewerProps) {
  return (
    <div className="flex flex-col gap-3" aria-label="Execution trace">
      {isLoading && (
        <p role="status" className="flex items-center gap-2 text-sm text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-glow" aria-hidden="true" />
          Tracing on backend…
        </p>
      )}

      {!isLoading && error && <TraceErrorNotice error={error} />}

      {!isLoading && !error && !trace && (
        <p className="text-sm text-void-200">
          No trace yet. Run a trace to step through the state the backend computes after each operation.
        </p>
      )}

      {!isLoading && !error && trace && (
        // Keyed by the first step's own result id — unique per backend run —
        // so a fresh trace always starts back at step 0.
        <LoadedTrace key={trace.steps[0]?.state.provenance.resultId} trace={trace} />
      )}
    </div>
  )
}

function TraceErrorNotice({ error }: { error: TraceFailure }) {
  const rejected = error.kind === 'rejected'
  return (
    <div role="alert" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3.5 text-sm">
      <p className="font-semibold text-danger-glow">
        {rejected ? 'Trace not available' : 'Trace failed unexpectedly'}
      </p>
      {rejected && (
        <p className="mt-1 font-mono-qasm text-[11px] text-danger-glow/90" data-testid="trace-error-code">
          {error.code}
        </p>
      )}
      <p className="mt-1 text-xs text-danger-glow/80">{error.message}</p>
      <p className="mt-2.5 text-xs text-slate-400">No substitute trace is shown. Nothing here was traced.</p>
    </div>
  )
}

function LoadedTrace({ trace }: { trace: ExecutionTraceResult }) {
  const lastIndex = trace.steps.length - 1
  const [selected, setSelected] = useState(0)
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([])

  const step = trace.steps[Math.min(selected, lastIndex)] as TraceStep
  const current = step.stepIndex

  function go(index: number, focus = false) {
    const next = Math.max(0, Math.min(lastIndex, index))
    setSelected(next)
    if (focus) chipRefs.current[next]?.focus()
  }

  function onTimelineKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      Home: 0,
      End: lastIndex,
    }
    const target = keys[event.key]
    if (target === undefined) return
    event.preventDefault()
    go(target, true)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5 font-mono-qasm text-[11px] text-void-200">
        <span className="rounded border border-void-400 bg-void-800 px-1.5 py-0.5 text-slate-200">
          {trace.backend} {trace.backendVersion}
        </span>
        <span>{trace.mode}</span>
        <span>· {trace.numQubits} qubit{trace.numQubits === 1 ? '' : 's'}</span>
        <span>· {trace.steps.length} step{trace.steps.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => go(current - 1, true)}
          disabled={current === 0}
          className="rounded-md border border-void-400 px-2.5 py-1 text-xs font-medium text-slate-300 hover:border-void-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous step
        </button>
        <span className="font-mono-qasm text-xs text-slate-200" aria-live="polite">
          Step {current} of {lastIndex}
        </span>
        <button
          type="button"
          onClick={() => go(current + 1, true)}
          disabled={current === lastIndex}
          className="rounded-md border border-void-400 px-2.5 py-1 text-xs font-medium text-slate-300 hover:border-void-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next step
        </button>
      </div>

      <div
        role="group"
        aria-label="Trace steps"
        onKeyDown={onTimelineKeyDown}
        className="flex gap-1 overflow-x-auto pb-1"
      >
        {trace.steps.map((s, position) => {
          const isCurrent = s.stepIndex === current
          const label = s.operation ? shortOperationLabel(s.operation) : 'initial'
          return (
            <button
              key={s.stepIndex}
              ref={(el) => {
                chipRefs.current[position] = el
              }}
              type="button"
              onClick={() => go(position)}
              aria-current={isCurrent ? 'step' : undefined}
              aria-label={`Step ${s.stepIndex}: ${s.operation ? describeOperation(s.operation) : 'initial state'}`}
              className={`flex shrink-0 flex-col items-start rounded-md border px-2 py-1 text-left font-mono-qasm text-[11px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow ${
                isCurrent
                  ? 'border-2 border-cyan-glow bg-cyan-dim/40 font-semibold text-cyan-glow'
                  : 'border-void-400 text-slate-400 hover:border-void-300 hover:text-slate-200'
              }`}
            >
              <span>
                {isCurrent && <span aria-hidden="true">● </span>}
                {s.stepIndex}
              </span>
              <span className="whitespace-nowrap">{label}</span>
            </button>
          )
        })}
      </div>

      <StepDetail trace={trace} step={step} />

      <ProvenanceCard trace={trace} step={step} />

      {trace.terminalMeasurements.length > 0 && <TerminalMeasurements trace={trace} />}
    </div>
  )
}

function StepDetail({ trace, step }: { trace: ExecutionTraceResult; step: TraceStep }) {
  const labelled = isKnownBasisOrdering(trace.basisOrdering)
  const { provenance } = step.state

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-void-500 bg-void-950/60 p-3">
      <div>
        <p className="text-sm font-medium text-slate-100">
          {step.operation ? describeOperation(step.operation) : 'Initial state'}
        </p>
        <p className="mt-0.5 text-[11px] text-void-200">
          {step.operation && step.operationIndex !== null
            ? `Operation ${step.operationIndex} of your circuit, applied to the previous step's state.`
            : 'The backend’s state before any operation is applied.'}
        </p>
      </div>

      <p className="text-[11px] text-void-200">
        Statevector after this step — amplitudes as the backend returned them (real + imaginary).
      </p>

      <div className="max-h-64 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-void-200">
              <th className="pb-1.5 font-medium">{labelled ? 'basis state' : 'index'}</th>
              <th className="pb-1.5 font-medium">amplitude</th>
            </tr>
          </thead>
          <tbody>
            {step.state.value.map((amplitude, index) => (
              <tr
                key={index}
                className={`border-t border-void-600 ${displaysAsZero(amplitude) ? 'text-void-300' : 'text-slate-200'}`}
              >
                <td className="py-1.5 font-mono-qasm">
                  {labelled ? basisLabel(index, trace.numQubits) : index}
                </td>
                <td className="py-1.5">
                  <VerifiedValueInline quantum={toQuantumValue(amplitude, provenance)} render={formatAmplitude} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="font-mono-qasm text-[11px] text-void-200">{trace.basisOrdering}</p>
      {!labelled && (
        <p className="text-[11px] text-amber-glow">
          This basis ordering isn’t one the viewer knows how to label, so raw indices are shown.
        </p>
      )}
    </div>
  )
}

function ProvenanceCard({ trace, step }: { trace: ExecutionTraceResult; step: TraceStep }) {
  const { provenance } = step.state
  const isFinal = provenance.resultId === trace.finalResultId

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-void-500 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Provenance</span>
        <ProvenanceBadge provenance={provenance} />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono-qasm text-[11px] text-void-200">
        <dt>backend</dt>
        <dd className="text-slate-300">
          {provenance.backend} {provenance.backendVersion}
        </dd>
        <dt>result</dt>
        <dd className="truncate text-slate-300" title={provenance.resultId}>
          {provenance.resultId}
        </dd>
        <dt>execution</dt>
        <dd className="truncate text-slate-300" title={step.executionId}>
          {step.executionId}
        </dd>
        <dt>circuit</dt>
        <dd className="truncate text-slate-300" title={provenance.circuitHash}>
          {provenance.circuitHash}
        </dd>
        <dt>run status</dt>
        <dd className="text-slate-300">{provenance.verificationStatus}</dd>
        {isFinal && (
          <>
            <dt>trace</dt>
            <dd className="text-slate-300">final result</dd>
          </>
        )}
      </dl>

      <p className="text-[11px] leading-snug text-void-200">
        “Circuit” is the exact circuit the backend ran to produce this state: your circuit cut off after this step.
        Run status describes this backend execution only — it does not say your circuit is correct.
      </p>

      <details className="text-[11px] text-void-200">
        <summary className="cursor-pointer text-slate-400 hover:text-slate-200">Trace identity</summary>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono-qasm">
          <dt>submitted circuit</dt>
          <dd className="truncate text-slate-300" title={trace.circuitHash}>
            {trace.circuitHash}
          </dd>
          <dt>traced circuit</dt>
          <dd className="truncate text-slate-300" title={trace.tracedCircuitHash}>
            {trace.tracedCircuitHash}
          </dd>
          <dt>final result</dt>
          <dd className="truncate text-slate-300" title={trace.finalResultId}>
            {trace.finalResultId}
          </dd>
          <dt>method</dt>
          <dd className="text-slate-300">{trace.traceMethod}</dd>
        </dl>
      </details>
    </div>
  )
}

function TerminalMeasurements({ trace }: { trace: ExecutionTraceResult }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-violet-glow/30 bg-violet-dim/10 p-3">
      <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
        Terminal measurements
      </span>
      <ul className="flex flex-col gap-0.5 font-mono-qasm text-xs text-slate-200">
        {trace.terminalMeasurements.map((m) => (
          <li key={m.operationIndex}>
            op {m.operationIndex}: {describeOperation(m.operation)}
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-snug text-void-200">
        Not a step: the states above are the backend’s exact state before these measurements. A measurement’s
        outcome is a separate, random result — see shots mode — and no state is shown for it here.
      </p>
    </div>
  )
}
