/**
 * The challenge catalog as a list: one real button per challenge with its state (solved / attempted / not started), read from
 * this browser's saved outcomes. Nothing here is a verdict — "Solved" means the server once said an attempt passed.
 */
import type { Challenge } from '@/api'
import { DIFFICULTY_LABEL, DIFFICULTY_STYLE } from '@/features/learn/LessonCard'
import type { ChallengeRecord } from './challengeStorage'

export function challengeStatus(record: ChallengeRecord | undefined): 'solved' | 'attempted' | 'new' {
  if (record?.solved) return 'solved'
  return record && record.attempts > 0 ? 'attempted' : 'new'
}

const STATUS_LABEL = { solved: 'Solved', attempted: 'In progress', new: 'Not started' } as const

export function ChallengeList({
  challenges,
  records,
  selectedId,
  onSelect,
}: {
  challenges: readonly Challenge[]
  records: Readonly<Record<string, ChallengeRecord>>
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <nav aria-label="Challenges">
      <ol className="flex flex-col gap-2">
        {challenges.map((challenge, index) => {
          const record = records[challenge.id]
          const status = challengeStatus(record)
          const selected = challenge.id === selectedId
          return (
            <li key={challenge.id}>
              <button
                type="button"
                onClick={() => onSelect(challenge.id)}
                aria-current={selected ? 'true' : undefined}
                aria-label={`${index + 1}. ${challenge.title} — ${STATUS_LABEL[status]}`}
                className={`flex w-full flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow ${
                  selected ? 'border-cyan-glow/50 bg-cyan-dim/30' : 'border-void-500 bg-void-800 hover:border-void-300'
                }`}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className={`text-sm font-medium ${selected ? 'text-cyan-glow' : 'text-slate-200'}`}>
                    {index + 1}. {challenge.title}
                  </span>
                  <span
                    data-testid={`status-${challenge.id}`}
                    className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                      status === 'solved'
                        ? 'border-cyan-glow/40 bg-cyan-dim/40 text-cyan-glow'
                        : status === 'attempted'
                          ? 'border-violet-glow/40 text-violet-glow'
                          : 'border-void-400 text-void-200'
                    }`}
                  >
                    {status === 'solved' ? '✓ ' : ''}
                    {STATUS_LABEL[status]}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 font-mono-qasm text-[10px] text-void-200">
                  <span className={`rounded-full border px-1.5 py-0.5 ${DIFFICULTY_STYLE[challenge.difficulty]}`}>
                    {DIFFICULTY_LABEL[challenge.difficulty]}
                  </span>
                  {challenge.fixedOracle && <span>fixed oracle</span>}
                  {record && record.attempts > 0 && (
                    <span>
                      · {record.attempts} attempt{record.attempts === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
