/**
 * Where the learner is in the Lab's chain: Result → Trace → Analysis (the circuit itself is the canvas beside it). A few words per stage, read from the Lab's own state
 * (nothing is computed here), and each stage is a control that takes the learner there: Result and Analysis jump to
 * their place in the Results column, and Trace runs the trace when there is none yet or jumps to it when there is. The Results column
 * is long and the trace sits below the result, so without this a learner who presses "Run trace" sees nothing happen.
 */
import { useBuildStore } from './store'

export type FlowTarget = 'result' | 'trace' | 'verify'

export function LabFlow({ onReveal }: { onReveal: (target: FlowTarget) => void }) {
  const opCount = useBuildStore((s) => s.circuit.ops.length)
  const isExecuting = useBuildStore((s) => s.isExecuting)
  const executionError = useBuildStore((s) => s.executionError)
  const result = useBuildStore((s) => s.result)
  const isTracing = useBuildStore((s) => s.isTracing)
  const traceError = useBuildStore((s) => s.traceError)
  const trace = useBuildStore((s) => s.trace)
  const selectedStep = useBuildStore((s) => s.selectedTraceStep)
  const runTrace = useBuildStore((s) => s.runTrace)

  const resultState = isExecuting ? 'running' : executionError ? 'failed' : result ? (result.value.statevector ? 'statevector' : 'shots') : 'not run'
  const traceState = isTracing ? 'running' : traceError ? 'failed' : trace ? `step ${Math.min(selectedStep, trace.steps.length - 1) + 1} of ${trace.steps.length}` : 'not run'
  const canTrace = opCount > 0 && !isTracing

  const item = 'inline-flex min-h-6 items-center gap-1 rounded px-1.5 hover:bg-void-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow'
  const step = 'flex items-center gap-1'
  const tone = (state: string) => (state === 'failed' ? 'text-danger-glow' : state === 'not run' ? 'text-void-200' : 'text-slate-100')

  return (
    <nav aria-label="Lab flow" data-testid="lab-flow" className="border-b border-void-500 px-4 py-1.5 text-[11px]">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-void-200">
        <li className={step}>
          <button type="button" onClick={() => onReveal('result')} className={item} data-testid="flow-result" data-state={resultState}>
            Result <span className={tone(resultState)}>{resultState}</span>
          </button>
        </li>
        <li className={step}>
          <span aria-hidden="true">→</span>
          <button
            type="button"
            className={item}
            data-testid="flow-trace"
            data-state={trace ? 'ready' : traceState}
            disabled={!trace && !canTrace}
            onClick={() => {
              if (trace) onReveal('trace')
              else if (canTrace) void runTrace()
            }}
            aria-label={trace ? `Trace, ${traceState}. Show it.` : `Trace, ${traceState}${canTrace ? '. Run the trace.' : ''}`}
          >
            Trace <span className={tone(traceState)}>{traceState}</span>
          </button>
        </li>
        <li className={step}>
          <span aria-hidden="true">→</span>
          <button type="button" onClick={() => onReveal('verify')} className={item} data-testid="flow-analysis" aria-label="Analysis: verify and optimize. Show it.">
            Analysis
          </button>
        </li>
      </ol>
    </nav>
  )
}
