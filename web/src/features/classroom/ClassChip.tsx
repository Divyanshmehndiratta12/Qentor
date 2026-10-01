/**
 * The shell's quiet classroom indicator, in the top bar. Not in a class: a plain "Class" link to the Classroom screen. In a class: the
 * class code with a small dot, so it is never a surprise that activity is being counted. It is a link to the screen where the learner can
 * see what is shared and leave. It decides nothing: it only reflects the membership the store holds (confirmed with the server on load).
 */
import { useClassroomStore } from './store'

export function ClassChip({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const membership = useClassroomStore((s) => s.membership)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      aria-label={membership ? `Classroom: you are in class ${membership.classCode}` : 'Classroom: join or teach a class'}
      data-testid="class-chip"
      data-in-class={membership ? 'true' : 'false'}
      title={membership ? `In class ${membership.classTitle} as ${membership.alias}` : 'Join or teach a class'}
      className={`order-2 flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow md:order-none ${
        membership ? 'border-cyan-glow/40 text-cyan-glow' : 'border-transparent text-slate-400 hover:bg-void-600 hover:text-slate-200'
      } ${active ? 'bg-void-500 text-slate-100' : ''}`}
    >
      {membership ? (
        <>
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-cyan-glow" />
          <span className="font-mono-qasm tracking-wider">{membership.classCode}</span>
        </>
      ) : (
        'Class'
      )}
    </button>
  )
}
