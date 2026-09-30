/**
 * Challenges: pick a goal, build a circuit for it on the same canvas the Lab uses, and have the SERVER check it.
 *
 * The workspace is `useBuildStore` — the Lab's circuit, results, trace and tutor — so a learner can Run the circuit, step
 * through its trace and ask the tutor about it before submitting. Submitting sends the circuit and nothing else; the verdict
 * (`SubmissionPanel`) is the server's, computed from its own statevectors. Selecting a different challenge loads its starter
 * circuit into that workspace; the Lab's previous circuit is replaced, and the brief says so.
 */
import { useEffect, useRef, useState } from 'react'
import { CircuitCanvas } from '@/features/build/CircuitCanvas'
import { GatePalette } from '@/features/build/GatePalette'
import { ResultsPanel } from '@/features/build/ResultsPanel'
import { useBuildStore } from '@/features/build/store'
import { useAutoRun } from '@/features/build/useAutoRun'
import { useLearnStore } from '@/features/learn/store'
import { StateNotice } from '@/features/shell/StateNotice'
import { TutorPanel } from '@/features/tutor/TutorPanel'
import { ChallengeBrief } from './ChallengeBrief'
import { ChallengeList } from './ChallengeList'
import { SubmissionPanel } from './SubmissionPanel'
import { emptyRecord } from './challengeStorage'
import { useChallengeStore } from './store'

type Tab = 'check' | 'results'

/** Runs the Lab's debounced auto-run only while a challenge is open, so merely listing challenges executes nothing. */
function Workspace({ children }: { children: React.ReactNode }) {
  useAutoRun()
  return <>{children}</>
}

export function ChallengesScreen({
  route,
  onSelectionChange,
  onOpenLesson,
  onOpenLab,
  renderNextStep,
}: {
  /** What the address bar names (`/challenges/create-bell`); `n` changes on every Back/Forward. Applied once the catalog is here. */
  route: { challengeId: string | null; n: number }
  /** Keeps the address bar in step with the selection. */
  onSelectionChange?: (challengeId: string | null) => void
  onOpenLesson: (lessonId: string) => void
  onOpenLab: () => void
  /** Where to go after a solve. Supplied by the app from the deterministic recommendation. */
  renderNextStep?: (solvedChallengeId: string) => React.ReactNode
}) {
  const challenges = useChallengeStore((s) => s.challenges)
  const isLoading = useChallengeStore((s) => s.isLoading)
  const error = useChallengeStore((s) => s.error)
  const selectedId = useChallengeStore((s) => s.selectedId)
  const outcomes = useChallengeStore((s) => s.outcomes)
  const persistence = useChallengeStore((s) => s.persistence)
  const recovered = useChallengeStore((s) => s.outcomesRecovered)
  const submission = useChallengeStore((s) => s.submission)
  const isSubmitting = useChallengeStore((s) => s.isSubmitting)
  const submitError = useChallengeStore((s) => s.submitError)
  const submitErrorStatus = useChallengeStore((s) => s.submitErrorStatus)
  const fetchChallenges = useChallengeStore((s) => s.fetchChallenges)
  const selectChallenge = useChallengeStore((s) => s.selectChallenge)
  const revealHintsThrough = useChallengeStore((s) => s.revealHintsThrough)
  const submit = useChallengeStore((s) => s.submit)
  const circuit = useBuildStore((s) => s.circuit)
  const lessons = useLearnStore((s) => s.lessons)
  const fetchLessons = useLearnStore((s) => s.fetchLessons)
  const [tab, setTab] = useState<Tab>('check')

  useEffect(() => {
    if (challenges.length === 0 && !isLoading && !error) void fetchChallenges()
  }, [challenges.length, isLoading, error, fetchChallenges])

  // Lesson titles for the "Lesson: …" link; not needed to work, so a failure here is silent (the id is shown instead).
  useEffect(() => {
    if (lessons.length === 0) void fetchLessons()
  }, [lessons.length, fetchLessons])

  // The address bar picks the challenge once the catalog is here: a direct visit to /challenges/create-bell, or Back/Forward.
  // A bare /challenges reached by clicking the nav keeps whatever was selected (the learner's work), so only a NAMED id, or a
  // Back/Forward step (n > 0), changes the selection.
  useEffect(() => {
    if (challenges.length === 0) return
    if (route.challengeId !== null || route.n > 0) selectChallenge(route.challengeId)
  }, [challenges.length, route.challengeId, route.n, selectChallenge])

  // Keeps the address bar on the selection. Runs only when the selection changes (the callback is read through a ref, so a
  // re-render never re-pushes the path and breaks Back).
  const selectionChange = useRef(onSelectionChange)
  selectionChange.current = onSelectionChange
  useEffect(() => {
    selectionChange.current?.(selectedId)
  }, [selectedId])

  const challenge = challenges.find((c) => c.id === selectedId) ?? null
  const record = (challenge && outcomes.records[challenge.id]) || emptyRecord()
  const current = !!submission && submission.challengeId === challenge?.id && submission.circuit === circuit
  const lessonTitle = challenge ? (lessons.find((l) => l.id === challenge.lessonId)?.title ?? challenge.lessonId) : ''
  const solvedCount = Object.values(outcomes.records).filter((r) => r.solved).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside
          aria-label="Challenge list"
          className="flex w-full shrink-0 flex-col border-b border-void-500 bg-void-900 lg:w-72 lg:overflow-y-auto lg:border-r lg:border-b-0"
        >
          <div className="border-b border-void-500 px-4 py-3">
            <h1 className="text-lg font-semibold text-slate-100">Challenges</h1>
            <p className="mt-1 text-[13px] leading-snug text-slate-400">
              Build a circuit for a goal. The server checks it against the real quantum state — no guessing, no AI verdict.
            </p>
            {challenges.length > 0 && (
              <p className="mt-1.5 font-mono-qasm text-[11px] text-void-200" data-testid="solved-count">
                {solvedCount} of {challenges.length} solved
              </p>
            )}
            <p className="mt-1 text-[11px] text-void-200" data-testid="challenge-persistence" data-persistence={persistence}>
              {persistence === 'device'
                ? 'Saved on this device — in this browser only. There is no account.'
                : 'Session only — this browser isn’t letting Qentor save, so this is lost on reload.'}
            </p>
            {recovered && (
              <p role="status" className="mt-1 text-[11px] text-amber-glow">
                Saved challenge results on this device couldn’t be read, so they were set aside and you’re starting fresh.
              </p>
            )}
          </div>
          <div className="p-3">
            {isLoading && <StateNotice kind="loading" title="Loading challenges…" />}
            {error && !isLoading && (
              <StateNotice
                kind="error"
                title="Couldn’t load the challenges"
                detail={error}
                hint="No substitute list is shown."
                onRetry={() => void fetchChallenges()}
              />
            )}
            {!isLoading && !error && challenges.length === 0 && <StateNotice kind="empty" title="No challenges are available." />}
            {challenges.length > 0 && (
              <ChallengeList challenges={challenges} records={outcomes.records} selectedId={selectedId} onSelect={selectChallenge} />
            )}
          </div>
        </aside>

        {!challenge ? (
          <main id="main-content" tabIndex={-1} className="flex min-h-[16rem] flex-1 items-center justify-center p-6 outline-none">
            <StateNotice kind="empty" title={challenges.length > 0 ? 'Choose a challenge to begin.' : 'Challenges will appear here.'} />
          </main>
        ) : (
          <Workspace>
            <main id="main-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
              <ChallengeBrief
                challenge={challenge}
                hintsRevealed={record.hintsRevealed}
                onRevealNextHint={() => revealHintsThrough(challenge.id, record.hintsRevealed)}
                lessonTitle={lessonTitle}
                onOpenLesson={() => onOpenLesson(challenge.lessonId)}
              />
              <div className="relative h-[26rem] min-h-0 shrink-0 lg:h-auto lg:flex-1">
                <CircuitCanvas lockQubits />
                <GatePalette allowedGates={challenge.constraints.allowedGates} />
              </div>
              <p className="border-t border-void-500 bg-void-900 px-4 py-1.5 text-[11px] text-void-200">
                Starting a challenge replaces the Lab’s circuit with its starter. Displayed bitstrings read q[n-1] … q[0].
              </p>
            </main>

            <aside aria-label="Check and results" className="flex w-full shrink-0 flex-col bg-void-900 lg:w-96 lg:border-l lg:border-void-500">
              <div role="tablist" aria-label="Right panel" className="flex gap-1 border-b border-void-500 px-3 pt-2">
                {(
                  [
                    ['check', 'Check'],
                    ['results', 'Results & trace'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    role="tab"
                    id={`tab-${id}`}
                    aria-selected={tab === id}
                    aria-controls={`panel-${id}`}
                    type="button"
                    onClick={() => setTab(id)}
                    className={`rounded-t-md px-3 py-1.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow ${
                      tab === id ? 'bg-void-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div
                role="tabpanel"
                id={`panel-${tab}`}
                aria-labelledby={`tab-${tab}`}
                className="min-h-0 flex-1 lg:overflow-y-auto"
              >
                {tab === 'check' ? (
                  <SubmissionPanel
                    submission={submission && submission.challengeId === challenge.id ? submission.result : null}
                    isCurrent={current}
                    isSubmitting={isSubmitting}
                    error={submitError}
                    errorStatus={submitErrorStatus}
                    onSubmit={() => void submit()}
                    onRetry={() => void submit()}
                    canSubmit={circuit.ops.length > 0}
                    hintsLeft={record.hintsRevealed < challenge.hints.length}
                    onShowHint={() => {
                      const index = submission?.result.nextHintIndex
                      if (index !== null && index !== undefined) revealHintsThrough(challenge.id, index)
                    }}
                    nextStep={renderNextStep?.(challenge.id)}
                  />
                ) : (
                  <div className="h-[32rem] lg:h-full">
                    <ResultsPanel />
                  </div>
                )}
              </div>
              <div className="border-t border-void-500 px-4 py-2">
                <button
                  type="button"
                  onClick={onOpenLab}
                  className="text-[12px] text-cyan-glow underline decoration-cyan-glow/40 underline-offset-2 hover:decoration-cyan-glow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
                >
                  Open this circuit in the Lab
                </button>
              </div>
            </aside>
          </Workspace>
        )}
      </div>

      {challenge && (
        <footer aria-label="Tutor" className="h-72 shrink-0 border-t border-void-500 bg-void-900 lg:h-56">
          <TutorPanel />
        </footer>
      )}
    </div>
  )
}
