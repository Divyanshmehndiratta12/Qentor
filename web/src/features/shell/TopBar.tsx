/**
 * App shell top bar, restyled from the finalized Qentor design (Claude
 * Design canvas "Qentor Workspace"). Visual chrome only — every piece here
 * either reuses an existing store action or degrades honestly instead of
 * fabricating state:
 *
 *  - Run wires directly to `useBuildStore.runExecution`, the same call the
 *    debounced auto-execute in BuildScreen already makes.
 *  - The provenance-class control (Simulator/Recorded/Live) reflects what
 *    the backend can actually produce today per docs/BUILD_STATE.md — only
 *    Aer simulation exists, so Recorded/Live are shown but disabled with a
 *    "soon" tag, the same honest-degradation pattern TutorPanel already uses
 *    for missing capabilities.
 *  - The adapter indicator is read-only: it reports which `ApiClient`
 *    `getApiClient()` actually selected (real backend vs. the explicit
 *    `VITE_USE_MOCK_API=true` FIXTURE adapter), not a live switch — there is
 *    no runtime adapter-swap capability in api/index.ts, and adding one is
 *    out of scope for a visual pass.
 *  - Lab/Learn are real navigation (see `App.tsx`); Progress remains an inert
 *    "soon" placeholder — no progress backend or screen exists yet.
 *  - The Lab-only toolbar (mode chips, adapter badge, Run) is hidden on the
 *    Learn screen: those actions operate on the Build circuit, which isn't
 *    what's on screen there.
 */
import { useBuildStore } from '@/features/build/store'

export type Screen = 'lab' | 'learn'

const isMock = import.meta.env.VITE_USE_MOCK_API === 'true'

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-6 w-6 items-center justify-center rounded-full border-[2.5px] border-slate-200">
        <span className="absolute inset-x-[1px] top-[6px] h-[7px] rounded-full border-[1.5px] border-slate-200/45" />
        <span className="absolute -right-[3px] -bottom-[3px] h-2 w-2 rounded-full bg-cyan-glow shadow-[0_0_6px_1px_theme(colors.cyan-glow/70)]" />
      </span>
      <span className="font-sans-ui text-[15px] font-semibold tracking-tight text-slate-100">Qentor</span>
    </div>
  )
}

function NavItem({
  label,
  active,
  soon,
  onClick,
}: {
  label: string
  active?: boolean
  soon?: boolean
  onClick?: () => void
}) {
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={`rounded-md px-2.5 py-1.5 text-[13px] font-medium ${
          active ? 'bg-void-500 text-slate-100' : 'text-slate-400 hover:bg-void-600 hover:text-slate-200'
        }`}
      >
        {label}
      </button>
    )
  }

  return (
    <span
      title={soon ? `${label} isn't built yet` : undefined}
      className={`rounded-md px-2.5 py-1.5 text-[13px] font-medium ${
        soon ? 'cursor-not-allowed text-void-200' : 'cursor-default text-slate-400'
      }`}
    >
      {label}
    </span>
  )
}

export function TopBar({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Screen) => void }) {
  const numQubits = useBuildStore((s) => s.circuit.num_qubits)
  const numOps = useBuildStore((s) => s.circuit.ops.length)
  const isExecuting = useBuildStore((s) => s.isExecuting)
  const runExecution = useBuildStore((s) => s.runExecution)

  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-void-500 bg-void-900 py-0 pr-3.5 pl-4">
      <div className="flex min-w-0 items-center gap-4">
        <Logo />
        <nav className="flex gap-0.5 text-[13px]">
          <NavItem label="Lab" active={screen === 'lab'} onClick={() => onNavigate('lab')} />
          <NavItem label="Learn" active={screen === 'learn'} onClick={() => onNavigate('learn')} />
          <NavItem label="Progress" soon />
        </nav>
        {screen === 'lab' && (
          <>
            <span className="h-4.5 w-px bg-void-400" />
            <span className="font-mono-qasm text-xs whitespace-nowrap text-slate-400">
              lab / <span className="text-slate-200">{numQubits}q circuit · {numOps} op{numOps === 1 ? '' : 's'}</span>
            </span>
          </>
        )}
      </div>

      {screen === 'lab' && (
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1 rounded-lg border border-void-500 bg-void-950 p-[3px] text-xs font-medium">
            <ModeChip label="Simulator" dotClassName="bg-void-200" active />
            <ModeChip label="Recorded" dotClassName="bg-violet-glow" soon />
            <ModeChip label="Live QPU" dotClassName="bg-void-300" soon />
          </div>

          <span
            title={
              isMock
                ? 'VITE_USE_MOCK_API=true — FIXTURE adapter, fixed at build time'
                : 'Real backend adapter (server/qentor/execution/) — fixed at build time'
            }
            className="flex items-center gap-1.5 rounded-lg border border-void-400 px-2.5 py-1.5 font-mono-qasm text-xs font-medium whitespace-nowrap text-slate-200"
          >
            {isMock ? 'FIXTURE · mock' : 'Qentor backend'}
            <span className="text-void-200">▾</span>
          </span>

          <button
            type="button"
            onClick={() => void runExecution()}
            disabled={isExecuting || numOps === 0}
            className="flex items-center gap-2 rounded-lg bg-slate-100 px-3.5 py-1.5 text-[13px] font-semibold whitespace-nowrap text-void-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isExecuting ? 'Running…' : 'Run'}
            <span className="font-mono-qasm text-[11px] opacity-55">⌘↵</span>
          </button>

          <div
            title="local session — Qentor has no accounts"
            className="grid h-[30px] w-[30px] place-items-center rounded-full bg-void-500 text-slate-400"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.6" />
              <path d="M4 20c1.6-4 5-6 8-6s6.4 2 8 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      )}
    </header>
  )
}

function ModeChip({
  label,
  dotClassName,
  active,
  soon,
}: {
  label: string
  dotClassName: string
  active?: boolean
  soon?: boolean
}) {
  return (
    <span
      title={soon ? `${label} isn't available — only Aer simulation is implemented today` : undefined}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 whitespace-nowrap ${
        active ? 'bg-void-500 text-slate-100' : soon ? 'cursor-not-allowed text-void-200' : 'text-slate-400'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClassName}`} />
      {label}
      {soon && (
        <span className="rounded border border-void-400 px-1 font-mono-qasm text-[10px] font-medium text-void-200">
          soon
        </span>
      )}
    </span>
  )
}
