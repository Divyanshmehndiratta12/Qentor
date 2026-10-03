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
 *  - Lab/Learn/Progress are all real navigation (see `App.tsx`). Progress is
 *    a learner dashboard over local session state; there is still no
 *    learner-progress backend.
 *  - The Lab-only toolbar (mode chips, adapter badge, Run) is hidden on the
 *    Learn and Progress screens: those actions operate on the Build circuit,
 *    which isn't what's on screen there.
 */
import { useBuildStore } from '@/features/build/store'
import { ClassChip } from '@/features/classroom/ClassChip'

export type Screen = 'lab' | 'learn' | 'challenges' | 'progress' | 'classroom' | 'shared'

const isMock = import.meta.env.VITE_USE_MOCK_API === 'true'

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-6 w-6 items-center justify-center rounded-full border-[2.5px] border-slate-200">
        <span className="absolute inset-x-[1px] top-[6px] h-[7px] rounded-full border-[1.5px] border-slate-200/45" />
        <span className="absolute -right-[3px] -bottom-[3px] h-2 w-2 rounded-full bg-cyan-glow shadow-[0_0_6px_1px_theme(colors.cyan-glow/70)]" />
      </span>
      <span className="hidden font-sans-ui text-[15px] font-semibold tracking-tight text-slate-100 sm:inline">Qentor</span>
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
        className={`min-h-9 flex-1 rounded-md px-1 py-1.5 text-center text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow md:min-h-0 md:flex-none md:px-2.5 ${
          active
            ? 'bg-void-500 text-slate-100 underline decoration-cyan-glow decoration-2 underline-offset-[7px]'
            : 'text-slate-400 hover:bg-void-600 hover:text-slate-200'
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

/** The top bar. The empty space between the navigation and the Lab toolbar is a flexible spacer that pushes the toolbar right. */
export function TopBar({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Screen) => void }) {
  const numQubits = useBuildStore((s) => s.circuit.num_qubits)
  const numOps = useBuildStore((s) => s.circuit.ops.length)
  const isExecuting = useBuildStore((s) => s.isExecuting)
  const runExecution = useBuildStore((s) => s.runExecution)

  // One row from `md` up. Below it the bar wraps into two: the logo, a spacer and Run on the first row and the four
  // destinations on a row of their own, each given an equal share (and a touch-sized height). On a phone the destinations and Run
  // used to share one row and Run sat on top of "Progress". Everything is a direct child of the header so that only CSS `order`
  // decides which row it is on; the DOM order (logo, navigation, Lab summary, spacer, Lab controls) is the reading order.
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 border-b border-void-500 bg-void-900 pt-1.5 pr-3.5 pl-4 md:h-[52px] md:flex-nowrap md:py-0">
      <Logo />
      <nav aria-label="Primary" className="order-4 -mx-4 flex basis-full gap-0.5 px-2 pt-1 pb-1.5 text-[13px] md:order-none md:mx-0 md:basis-auto md:p-0">
        <NavItem label="Lab" active={screen === 'lab'} onClick={() => onNavigate('lab')} />
        <NavItem label="Learn" active={screen === 'learn'} onClick={() => onNavigate('learn')} />
        <NavItem label="Challenges" active={screen === 'challenges'} onClick={() => onNavigate('challenges')} />
        <NavItem label="Progress" active={screen === 'progress'} onClick={() => onNavigate('progress')} />
      </nav>
      {screen === 'lab' && (
        <>
          <span className="hidden h-4.5 w-px bg-void-400 md:block" />
          <span className="hidden font-mono-qasm text-xs whitespace-nowrap text-slate-400 md:inline">
            lab / <span className="text-slate-200">{numQubits}q circuit · {numOps} op{numOps === 1 ? '' : 's'}</span>
          </span>
        </>
      )}

      <div aria-hidden="true" className="order-2 mx-1 h-10 min-w-4 flex-1 sm:mx-3 md:order-none md:h-full" />
      <ClassChip active={screen === 'classroom'} onOpen={() => onNavigate('classroom')} />

      {screen === 'lab' && (
        <div className="order-3 flex items-center gap-2.5 md:order-none">
          <div className="hidden items-center gap-1 rounded-lg border border-void-500 bg-void-950 p-[3px] text-xs font-medium lg:flex">
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
            className="hidden items-center gap-1.5 rounded-lg border border-void-400 px-2.5 py-1.5 font-mono-qasm text-xs font-medium whitespace-nowrap text-slate-200 lg:flex"
          >
            {isMock ? 'FIXTURE · mock' : 'Qentor backend'}
            <span className="text-void-200">▾</span>
          </span>

          <button
            type="button"
            onClick={() => void runExecution()}
            disabled={isExecuting || numOps === 0}
            className="flex min-h-9 items-center gap-2 rounded-lg bg-slate-100 px-3.5 py-1.5 text-[13px] font-semibold whitespace-nowrap text-void-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isExecuting ? 'Running…' : 'Run'}
            <span aria-hidden="true" className="hidden font-mono-qasm text-[11px] opacity-55 sm:inline">⌘↵</span>
          </button>

          <div
            title="Qentor has no accounts — progress is saved in this browser only"
            className="hidden h-[30px] w-[30px] place-items-center rounded-full bg-void-500 text-slate-400 lg:grid"
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
