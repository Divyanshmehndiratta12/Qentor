/**
 * Challenge completion and recent activity, from the outcomes this browser saved (`features/challenges`). It is a report on ONE
 * learner: Qentor has no accounts and no server-side learner data, so there is no class, cohort or leaderboard to show - and none
 * is invented. "Solved" means the server once said an attempt passed; the attempt id is kept so the verdict can be traced.
 */
import type { Challenge } from '@/api'
import { challengeStatus } from '@/features/challenges/ChallengeList'
import type { ChallengeOutcomes } from '@/features/challenges/challengeStorage'

const SECTION_HEADING = 'text-[11px] font-semibold tracking-wider text-slate-400 uppercase'
const CARD = 'rounded-xl border border-void-500 bg-void-900 p-5'

const STATUS_LABEL = { solved: 'Solved', attempted: 'In progress', new: 'Not started' } as const

export function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function ChallengeProgress({
  challenges,
  outcomes,
  onOpenChallenge,
}: {
  challenges: readonly Challenge[]
  outcomes: ChallengeOutcomes
  onOpenChallenge?: (challengeId: string) => void
}) {
  if (challenges.length === 0) return null
  const solved = challenges.filter((c) => outcomes.records[c.id]?.solved).length
  const titleOf = (id: string) => challenges.find((c) => c.id === id)?.title ?? id
  const recent = [...outcomes.recent].reverse().slice(0, 8)

  return (
    <div className="grid gap-5 md:grid-cols-2" data-testid="challenge-progress">
      <section aria-labelledby="challenges-heading" className={CARD}>
        <h2 id="challenges-heading" className={SECTION_HEADING}>
          Challenges
        </h2>
        <p className="mt-3 font-mono-qasm text-3xl leading-none font-semibold text-slate-100" data-testid="challenges-solved">
          {solved} <span className="text-lg text-slate-400">of {challenges.length} solved</span>
        </p>
        <ul className="mt-3 flex flex-col gap-1.5">
          {challenges.map((c) => {
            const r = outcomes.records[c.id]
            const status = challengeStatus(r)
            return (
              <li key={c.id} className="flex items-center justify-between gap-2 text-[12px]" data-testid={`challenge-row-${c.id}`}>
                {onOpenChallenge ? (
                  <button
                    type="button"
                    onClick={() => onOpenChallenge(c.id)}
                    className="min-h-6 truncate text-left text-slate-200 underline decoration-void-400 underline-offset-2 hover:decoration-cyan-glow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
                  >
                    {c.title}
                  </button>
                ) : (
                  <span className="truncate text-slate-200">{c.title}</span>
                )}
                <span className="shrink-0 font-mono-qasm text-[10px] text-slate-400">
                  {STATUS_LABEL[status]}
                  {r && r.attempts > 0 ? ` · ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}` : ''}
                  {r && r.hintsRevealed > 0 ? ` · ${r.hintsRevealed} hint${r.hintsRevealed === 1 ? '' : 's'}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="recent-heading" className={CARD}>
        <h2 id="recent-heading" className={SECTION_HEADING}>
          Recent challenge activity
        </h2>
        {recent.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No challenge attempts yet.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-1.5" data-testid="recent-activity">
            {recent.map((e) => (
              <li key={e.attemptId} className="text-[12px] text-slate-300">
                <span className={e.passed ? 'text-cyan-glow' : 'text-slate-400'}>{e.passed ? 'Solved' : 'Tried'}</span> {titleOf(e.challengeId)}
                <span className="ml-2 font-mono-qasm text-[10px] text-void-200">{formatWhen(e.at)}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-[10px] leading-snug text-void-200" data-testid="progress-scope">
          This is one learner’s record, saved in this browser. Qentor has no accounts, so there is no class or cohort data, and none is made up.
        </p>
      </section>
    </div>
  )
}
