/**
 * The entry point for a first visit: what Qentor is, the one rule it keeps, and the path through it. Shown on the Lab (the app's
 * home) only until the learner dismisses it or starts learning; the dismissal is remembered in this browser (best effort - a browser
 * that will not save simply shows it again). It makes no claim it cannot back: it says where the numbers come from.
 *
 * Laid out to be read at a glance: the name and one line on what it is, the headline, the two actions that matter, then three short
 * points (build, verify, ask Qubi). The Lab's workflow and the five-step learning path are one click away under "How Qentor works",
 * closed by default so they do not sit permanently between the learner and the circuit.
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

export const LEARNING_PATH = ['Learn a concept', 'Check your understanding', 'Open its circuit in the Lab and run it', 'Step through the trace and ask the Tutor', 'Solve the challenge']
/** The Lab, in the order a learner uses it. */
export const LAB_FLOW = ['Circuit', 'Gates', 'Code', 'Run', 'Results', 'Tutor']

const POINTS: ReadonlyArray<{ title: string; text: string }> = [
  { title: 'Build', text: 'Place gates on the canvas or write OpenQASM 3. Both stay in sync.' },
  { title: 'Verify', text: 'Every number is computed by a real simulator on the server, and says which one.' },
  { title: 'Ask Qubi', text: 'The AI Tutor explains results. It never produces them, and it never decides whether you are right.' },
]

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
    <section aria-labelledby="welcome-heading" className="border-b border-void-500 bg-void-900 px-4 py-2.5" data-testid="welcome">
      <div className="mx-auto flex max-w-5xl flex-col gap-2">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-wider text-cyan-glow uppercase">Qentor · Interactive quantum learning</p>
            <h2 id="welcome-heading" className="text-[15px] font-semibold text-slate-100">
              Learn quantum algorithms by building and running circuits
            </h2>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              data-qubi-avoid
              onClick={onStartLearning}
              className="rounded-lg bg-slate-100 px-3.5 py-1.5 text-[13px] font-semibold text-void-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow"
            >
              Start learning
            </button>
            <button
              type="button"
              data-qubi-avoid
              onClick={onOpenChallenges}
              className="rounded-lg border border-void-400 px-3.5 py-1.5 text-[13px] font-medium text-slate-200 hover:border-void-300 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow"
            >
              Try a challenge
            </button>
            <button type="button" onClick={onDismiss} className="px-2 py-1.5 text-[12px] text-void-200 hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow">
              Not now
            </button>
          </div>
        </div>

        <ul className="grid gap-x-6 gap-y-0.5 text-[11px] leading-snug text-slate-400 md:grid-cols-3 md:text-[12px]" aria-label="What Qentor does">
          {POINTS.map((p) => (
            <li key={p.title}>
              <span className="font-semibold text-slate-200">{p.title}</span> · {p.text}
            </li>
          ))}
        </ul>

        <details className="group text-[12px]" data-testid="how-it-works">
          <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded text-slate-300 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow [&::-webkit-details-marker]:hidden">
            How Qentor works
            <span aria-hidden="true" className="text-void-200 transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>
          <div className="mt-2 flex flex-col gap-2.5 border-l border-void-400 pl-3 text-slate-300">
            <ol aria-label="The Lab, in order" className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {LAB_FLOW.map((name, i) => (
                <li key={name} className="flex items-center gap-1.5">
                  {i > 0 && (
                    <span aria-hidden="true" className="text-void-200">
                      →
                    </span>
                  )}
                  <span className="rounded-md bg-void-700 px-1.5 py-0.5 font-medium text-slate-100">{name}</span>
                </li>
              ))}
            </ol>
            <ol aria-label="Learning path" className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
              {LEARNING_PATH.map((step, i) => (
                <li key={step}>
                  <span className="font-mono-qasm text-void-200">{i + 1}.</span> {step}
                </li>
              ))}
            </ol>
          </div>
        </details>
      </div>
    </section>
  )
}
