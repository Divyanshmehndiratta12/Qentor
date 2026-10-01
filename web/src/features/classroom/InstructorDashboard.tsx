/**
 * The instructor's view of one class. Every figure on it is a count the SERVER made from events it recorded for learners who joined
 * this class; this component adds up nothing but the plain totals in the overview (sums of those counts), invents no learner and no
 * average, and shows the sample size next to every group. Learners are aliases (`Learner 4F2A`): no name, account or personal data
 * exists anywhere in this data. With nobody in the class it says so, in the same words every time, and shows no tables.
 *
 * Access is by the instructor key the server issued when the class was created; this component only sends it.
 */
import { useCallback, useEffect, useState } from 'react'
import { BackendUnavailableError, ClassroomRejectedError, getApiClient, type ClassDashboard } from '@/api'
import { classroomMessage } from './store'

export const EMPTY_CLASS_TEXT = 'No learners have joined this class yet.'

const SECTION = 'rounded-xl border border-void-500 bg-void-900 p-4'
const H2 = 'text-[11px] font-semibold tracking-wider text-slate-400 uppercase'
const TH = 'px-2 py-1.5 text-left text-[11px] font-semibold tracking-wide text-slate-400 uppercase'
const TD = 'px-2 py-1.5 align-top text-[13px] text-slate-200'

const EVENT_LABEL: Record<string, string> = {
  joined_class: 'joined the class',
  lesson_started: 'started a lesson',
  lesson_completed: 'completed a lesson',
  concept_check_submitted: 'answered a concept check',
  concept_check_corrected: 'corrected a concept check',
  concept_check_synced: 'brought an earlier concept-check answer',
  challenge_started: 'started a challenge',
  challenge_solved: 'solved a challenge',
  challenge_failed: 'tried a challenge (not yet solved)',
  experiment_shared: 'shared an experiment',
}

export function eventLabel(kind: string): string {
  return EVENT_LABEL[kind] ?? kind.replaceAll('_', ' ')
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function noun(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

type Load = { state: 'loading' } | { state: 'error'; message: string; denied: boolean } | { state: 'ready'; dashboard: ClassDashboard }

export function InstructorDashboard({ classCode, instructorKey }: { classCode: string; instructorKey: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  const refresh = useCallback(async () => {
    setLoad({ state: 'loading' })
    try {
      const dashboard = await getApiClient().getClassDashboard(classCode, instructorKey)
      setLoad({ state: 'ready', dashboard })
    } catch (err) {
      const denied = err instanceof ClassroomRejectedError && (err.status === 403 || err.status === 401)
      setLoad({
        state: 'error',
        denied,
        message: denied
          ? 'The server did not accept this instructor key for this class. It may have been deleted.'
          : err instanceof BackendUnavailableError || err instanceof ClassroomRejectedError
            ? classroomMessage(err)
            : `The dashboard could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }, [classCode, instructorKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (load.state === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-400" data-testid="dashboard-loading">
        Loading the class dashboard…
      </p>
    )
  }
  if (load.state === 'error') {
    return (
      <div role="alert" className="rounded-lg border border-danger-glow/40 bg-danger-dim/30 p-3 text-sm text-danger-glow" data-testid="dashboard-error">
        <p>{load.message}</p>
        {!load.denied && (
          <button type="button" onClick={() => void refresh()} className="mt-2 rounded-md border border-danger-glow/50 px-2.5 py-1 text-xs font-medium">
            Try again
          </button>
        )}
      </div>
    )
  }

  const d = load.dashboard
  const lessons = d.lessons.filter((l) => l.started > 0 || l.completed > 0 || l.assessmentAnswered > 0)
  const challenges = d.challenges.filter((c) => c.started > 0 || c.attempts > 0)
  const lessonCompletions = d.lessons.reduce((sum, l) => sum + l.completed, 0)
  const challengeSolves = d.challenges.reduce((sum, c) => sum + c.solvedLearners, 0)

  return (
    <div className="flex flex-col gap-4" data-testid="instructor-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400" data-testid="dashboard-data-note">
          {d.dataNote}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="min-h-9 rounded-md border border-void-400 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-void-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
        >
          Refresh
        </button>
      </div>

      <section aria-labelledby="overview-h" className={SECTION}>
        <h3 id="overview-h" className={H2}>
          Class overview
        </h3>
        <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="class-overview">
          <Stat label="Class code" value={d.classCode} mono />
          <Stat label="Anonymous learners" value={String(d.learnersInClass)} testId="stat-learners" />
          <Stat label={`Active in the last ${d.activeWindowDays} days`} value={String(d.activeLearners)} testId="stat-active" />
          <Stat label="Lessons completed (learner-lessons)" value={String(lessonCompletions)} testId="stat-lessons" />
          <Stat label="Challenges solved (learner-challenges)" value={String(challengeSolves)} testId="stat-challenges" />
        </dl>
        {d.learnersLeft > 0 && (
          <p className="mt-2 text-xs text-slate-400">
            {noun(d.learnersLeft, 'learner')} left this class; they are not counted above.
          </p>
        )}
      </section>

      {d.empty ? (
        <p role="status" data-testid="dashboard-empty" className="rounded-lg border border-void-400 bg-void-800 p-4 text-sm text-slate-300">
          {EMPTY_CLASS_TEXT}
          <span className="mt-1 block text-xs text-slate-400">
            Give learners the class code {d.classCode}. They choose “Join class” and enter it; nothing appears here until they do.
          </span>
        </p>
      ) : (
        <>
          <section aria-labelledby="lessons-h" className={SECTION}>
            <h3 id="lessons-h" className={H2}>
              Lesson progress
            </h3>
            {lessons.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">No lesson activity yet.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse" data-testid="lessons-table">
                  <caption className="sr-only">Lesson progress for this class. Counts are learners.</caption>
                  <thead>
                    <tr className="border-b border-void-500">
                      <th scope="col" className={TH}>Lesson</th>
                      <th scope="col" className={TH}>Started</th>
                      <th scope="col" className={TH}>Completed</th>
                      <th scope="col" className={TH}>Still developing</th>
                      <th scope="col" className={TH}>Concept-check answers correct</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lessons.map((l) => (
                      <tr key={l.lessonId} className="border-b border-void-600 last:border-0">
                        <th scope="row" className={`${TD} font-medium`}>{l.title}</th>
                        <td className={TD}>{l.started}</td>
                        <td className={TD}>{l.completed}</td>
                        <td className={TD}>{l.developing}</td>
                        <td className={TD}>{l.assessmentAnswered === 0 ? '—' : `${l.assessmentCorrect} of ${l.assessmentAnswered}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="misc-h" className={SECTION}>
            <h3 id="misc-h" className={H2}>
              Common misconceptions
            </h3>
            {d.misconceptions.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">None recorded: no learner has answered a concept check incorrectly or failed a challenge check yet.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2" data-testid="misconceptions">
                {d.misconceptions.map((m) => (
                  <li key={`${m.kind}|${m.lessonId}|${m.challengeId ?? ''}|${m.category}`} className="rounded-lg border border-void-500 bg-void-800 p-3 text-sm">
                    <p className="font-medium text-slate-100">{m.category}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {m.kind === 'concept' ? 'Concept check' : 'Challenge check'} · {d.lessons.find((l) => l.lessonId === m.lessonId)?.title ?? m.lessonId}
                    </p>
                    <p className="mt-1 text-slate-300">
                      {m.learnersAffected} of {noun(m.sampleSize, 'learner')} affected
                      {m.stillIncorrect !== null ? `; ${m.stillIncorrect} still incorrect on their latest answer` : ''}.
                    </p>
                    {m.explanation && <p className="mt-1 text-xs text-slate-400">{m.explanation}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="challenges-h" className={SECTION}>
            <h3 id="challenges-h" className={H2}>
              Challenges
            </h3>
            {challenges.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">No challenge activity yet.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse" data-testid="challenges-table">
                  <caption className="sr-only">Challenge attempts for this class. Counts are learners or attempts as labelled.</caption>
                  <thead>
                    <tr className="border-b border-void-500">
                      <th scope="col" className={TH}>Challenge</th>
                      <th scope="col" className={TH}>Learners attempting</th>
                      <th scope="col" className={TH}>Attempts</th>
                      <th scope="col" className={TH}>Learners solved</th>
                      <th scope="col" className={TH}>Where attempts fail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {challenges.map((c) => (
                      <tr key={c.challengeId} className="border-b border-void-600 last:border-0">
                        <th scope="row" className={`${TD} font-medium`}>{c.title}</th>
                        <td className={TD}>{c.attemptingLearners}</td>
                        <td className={TD}>{c.attempts}</td>
                        <td className={TD}>{c.solvedLearners}</td>
                        <td className={TD}>
                          {c.failurePatterns.length === 0 ? (
                            '—'
                          ) : (
                            <ul className="flex flex-col gap-0.5">
                              {c.failurePatterns.map((p) => (
                                <li key={p.checkId}>
                                  {p.label}: {noun(p.count, 'attempt')} ({noun(p.learners, 'learner')})
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="recent-h" className={SECTION}>
            <h3 id="recent-h" className={H2}>
              Recent activity
            </h3>
            {d.recent.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">No activity recorded yet.</p>
            ) : (
              <ol className="mt-2 flex flex-col divide-y divide-void-600" data-testid="recent-activity">
                {d.recent.map((e, i) => (
                  <li key={`${e.createdAt}|${e.alias}|${e.kind}|${e.subjectId}|${i}`} className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-[13px]">
                    <span className="font-mono-qasm text-slate-100">{e.alias}</span>{' '}
                    <span className="text-slate-300">
                      {eventLabel(e.kind)}
                      {e.subjectLabel && e.subjectLabel !== 'Class' ? `: ${e.subjectLabel}` : ''}
                      {e.outcome ? ` (${e.outcome})` : ''}
                    </span>
                    <time dateTime={e.createdAt} className="ml-auto text-xs text-slate-400">
                      {when(e.createdAt)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, mono, testId }: { label: string; value: string; mono?: boolean; testId?: string }) {
  return (
    <div className="rounded-lg border border-void-500 bg-void-800 p-3">
      <dt className="text-[11px] leading-snug text-slate-400">{label}</dt>
      <dd data-testid={testId} className={`mt-1 text-xl font-semibold text-slate-100 ${mono ? 'font-mono-qasm tracking-wider' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
