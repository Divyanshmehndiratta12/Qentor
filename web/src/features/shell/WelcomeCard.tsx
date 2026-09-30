/**
 * The entry point for a first visit: what Qentor is, the one rule it keeps, and the path through it. Shown on the Lab (the app's
 * home) only until the learner dismisses it or starts learning; the dismissal is remembered in this browser (best effort - a browser
 * that will not save simply shows it again). It makes no claim it cannot back: it says where the numbers come from.
 */
import { browserStorage } from '@/features/learn/browserStorage'

export const WELCOME_KEY = 'qentor.welcome.dismissed.v1'

export function welcomeDismissed(): boolean {
  try {
    return browserStorage()?.getItem(WELCOME_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberWelcomeDismissed(): void {
  try {
    browserStorage()?.setItem(WELCOME_KEY, '1')
  } catch {
    /* not saved: it will show again next time */
  }
}

const STEPS = ['Learn a concept', 'Check your understanding', 'Open its circuit in the Lab and run it', 'Step through the trace and ask the Tutor', 'Solve the challenge']

export function WelcomeCard({
  onStartLearning,
  onOpenChallenges,
  onDismiss,
}: {
  onStartLearning: () => void
  onOpenChallenges: () => void
  onDismiss: () => void
}) {
  return (
    <section aria-labelledby="welcome-heading" className="border-b border-void-500 bg-void-900 px-4 py-3" data-testid="welcome">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h2 id="welcome-heading" className="text-[15px] font-semibold text-slate-100">
            Learn quantum algorithms by building and running circuits
          </h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-snug text-slate-400">
            Every number you see was computed by a real simulator on the server, and it says which one. The Tutor explains those results; it never
            produces them, and it never decides whether you are right.
          </p>
          <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-300">
            {STEPS.map((step, i) => (
              <li key={step}>
                <span className="font-mono-qasm text-void-200">{i + 1}.</span> {step}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={onStartLearning}
            className="rounded-lg bg-slate-100 px-3.5 py-1.5 text-[13px] font-semibold text-void-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
          >
            Start learning
          </button>
          <button
            type="button"
            onClick={onOpenChallenges}
            className="rounded-lg border border-void-400 px-3.5 py-1.5 text-[13px] font-medium text-slate-200 hover:border-void-300 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
          >
            Try a challenge
          </button>
          <button type="button" onClick={onDismiss} className="px-2 py-1.5 text-[12px] text-void-200 hover:text-slate-200">
            Not now
          </button>
        </div>
      </div>
    </section>
  )
}
