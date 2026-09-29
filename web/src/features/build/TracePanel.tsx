/**
 * The "Trace" action for the Build screen's Results panel: a Run button plus
 * the `TraceViewer`, connected to `useBuildStore`'s trace fields.
 *
 * Runs `useBuildStore.runTrace`, which sends the CURRENT circuit to
 * POST /api/execute/trace and stores the backend's response in state that is
 * separate from the normal execution result, verification, optimization,
 * multi-input test and tutor turns — clicking Run trace reads the circuit and
 * writes none of them. Like Optimize and Test, it doesn't need an execution
 * `result` to exist: the backend traces the circuit itself, and if a circuit
 * can't be traced the backend's own structured refusal is what's shown.
 */
import { useBuildStore } from './store'
import { TraceViewer } from './TraceViewer'

export function TracePanel() {
  const isTracing = useBuildStore((s) => s.isTracing)
  const trace = useBuildStore((s) => s.trace)
  const traceError = useBuildStore((s) => s.traceError)
  const runTrace = useBuildStore((s) => s.runTrace)
  // Selection lives in the store (not in the viewer) so the tutor knows which
  // step the learner is on; choosing a step writes only that one field.
  const selectedTraceStep = useBuildStore((s) => s.selectedTraceStep)
  const selectTraceStep = useBuildStore((s) => s.selectTraceStep)

  return (
    <section aria-labelledby="trace-heading" className="mt-4 flex flex-col gap-3 border-t border-void-500 pt-4">
      <div className="flex items-center justify-between">
        <h3 id="trace-heading" className="text-[13px] font-semibold text-slate-100">
          Trace
        </h3>
        <button
          type="button"
          onClick={() => void runTrace()}
          disabled={isTracing}
          className="rounded-md border border-cyan-glow/40 bg-cyan-dim/20 px-2.5 py-1 text-xs font-medium text-cyan-glow hover:bg-cyan-dim/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isTracing ? 'Tracing…' : 'Run trace'}
        </button>
      </div>

      <TraceViewer
        trace={trace}
        isLoading={isTracing}
        error={traceError}
        selectedStep={selectedTraceStep}
        onSelectStep={selectTraceStep}
      />
    </section>
  )
}
