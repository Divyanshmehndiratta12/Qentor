/**
 * The selected challenge's brief: goal, what counts as solved, the constraints (qubits, allowed gates, the fixed oracle when
 * there is one), and hints that appear only when asked for. All of it is what the server sent; nothing here is a verdict.
 */
import type { Challenge } from '@/api'
import { describeOperation } from '@/features/build/traceFormat'
import { DIFFICULTY_LABEL, DIFFICULTY_STYLE } from '@/features/learn/LessonCard'

export function ChallengeBrief({
  challenge,
  hintsRevealed,
  onRevealNextHint,
  lessonTitle,
  onOpenLesson,
}: {
  challenge: Challenge
  hintsRevealed: number
  onRevealNextHint: () => void
  /** Title of the related lesson when the lesson catalog is loaded; the id otherwise. */
  lessonTitle: string
  onOpenLesson: () => void
}) {
  const { constraints } = challenge
  const shown = challenge.hints.slice(0, hintsRevealed)
  const moreHints = hintsRevealed < challenge.hints.length

  return (
    <section aria-labelledby="challenge-title" className="border-b border-void-500 bg-void-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="challenge-title" className="text-base font-semibold text-slate-100">
          {challenge.title}
        </h2>
        <span className={`rounded-full border px-1.5 py-0.5 font-mono-qasm text-[10px] ${DIFFICULTY_STYLE[challenge.difficulty]}`}>
          {DIFFICULTY_LABEL[challenge.difficulty]}
        </span>
        <button
          type="button"
          onClick={onOpenLesson}
          className="text-[12px] text-cyan-glow underline decoration-cyan-glow/40 underline-offset-2 hover:decoration-cyan-glow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
        >
          Lesson: {lessonTitle}
        </button>
      </div>

      <p className="mt-1.5 text-[13px] leading-snug text-slate-300">{challenge.goal}</p>
      <p className="mt-1.5 text-[12px] text-slate-400">
        <span className="font-semibold text-slate-300">Solved when: </span>
        {challenge.successCondition}
      </p>

      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-slate-400">
        <div className="flex gap-1.5">
          <dt className="text-void-200">Qubits</dt>
          <dd className="font-mono-qasm text-slate-300">{constraints.numQubits}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-void-200">Gates</dt>
          <dd className="font-mono-qasm text-slate-300">{constraints.allowedGates.join(' ')}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-void-200">At most</dt>
          <dd className="font-mono-qasm text-slate-300">{constraints.maxOps} ops</dd>
        </div>
      </dl>

      {Object.keys(constraints.gateQubits).length > 0 && (
        <p className="mt-2 text-[12px] text-slate-400" data-testid="gate-qubit-rule">
          <span className="font-semibold text-slate-300">Only on certain qubits: </span>
          {Object.entries(constraints.gateQubits)
            .map(([gate, qubits]) => `${gate} acts only on ${qubits.map((q) => `q[${q}]`).join(', ')}`)
            .join('; ')}
        </p>
      )}

      {constraints.anchor.length > 0 && (
        <div className="mt-2 rounded-md border border-violet-glow/30 bg-violet-dim/20 px-3 py-2 text-[12px] text-slate-300">
          <p className="font-semibold text-violet-glow">The fixed {constraints.anchorName} — place these gates exactly, once, back to back:</p>
          <ol className="mt-1 list-decimal pl-5 font-mono-qasm text-slate-200">
            {constraints.anchor.map((op, i) => (
              <li key={i}>{describeOperation(op)}</li>
            ))}
          </ol>
          <p className="mt-1 text-slate-400">
            {constraints.anchorName === 'oracle'
              ? 'There is one oracle for this challenge. It is given, not something to design.'
              : `These ${constraints.anchorName} gates are given, not something to design.`}
          </p>
        </div>
      )}

      <div className="mt-2.5">
        {shown.length > 0 && (
          <ol aria-label="Hints" className="mb-2 flex list-decimal flex-col gap-1 pl-5 text-[12px] text-slate-300">
            {shown.map((hint, i) => (
              <li key={i}>{hint}</li>
            ))}
          </ol>
        )}
        {moreHints && (
          <button
            type="button"
            onClick={onRevealNextHint}
            className="rounded-md border border-void-400 px-2.5 py-1 text-[12px] font-medium text-slate-300 hover:border-void-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
          >
            {hintsRevealed === 0 ? 'Show a hint' : 'Show the next hint'}{' '}
            <span className="text-void-200">
              ({hintsRevealed}/{challenge.hints.length})
            </span>
          </button>
        )}
      </div>
    </section>
  )
}
