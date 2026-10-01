/**
 * The Classroom destination: join a class (as an anonymous learner) or teach one (as an instructor).
 *
 * No accounts and no personal data. A class has a short code that learners type; the server issues each learner a random token that
 * this browser keeps, and issues the instructor a key, shown once, that opens the class dashboard. This screen never decides who is
 * allowed to see what: it sends the code or the key and shows what the server answers.
 */
import { useState, type FormEvent } from 'react'
import { InstructorDashboard } from './InstructorDashboard'
import { syncLocalProgress, type SyncSummary } from './syncProgress'
import { useClassroomStore } from './store'
import type { TeachingClass } from './storage'

const CARD = 'rounded-xl border border-void-500 bg-void-900 p-5'
const H2 = 'font-sans-ui text-lg font-semibold text-slate-100'
const INPUT =
  'min-h-10 w-full rounded-md border border-void-400 bg-void-950 px-3 py-2 text-sm text-slate-100 placeholder:text-void-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-glow'
const BUTTON =
  'min-h-10 rounded-md px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-glow disabled:cursor-not-allowed disabled:opacity-40'
const PRIMARY = `${BUTTON} bg-slate-100 text-void-950 hover:bg-white`
const SECONDARY = `${BUTTON} border border-void-400 text-slate-200 hover:bg-void-700`

export function ClassroomScreen() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="font-sans-ui text-2xl font-semibold text-slate-100">Classroom</h1>
        <p className="mt-1.5 max-w-2xl font-serif-prose text-[15px] leading-relaxed text-slate-400">
          Join a class with its code, or run one. There are no accounts: learners are random tokens shown to the instructor as aliases, and nobody
          enters a name or an email address.
        </p>
      </header>
      <JoinPanel />
      <TeachPanel />
    </div>
  )
}

// --------------------------------------------------------------------------------------------------------------------- learner

function JoinPanel() {
  const membership = useClassroomStore((s) => s.membership)
  const busy = useClassroomStore((s) => s.busy)
  const error = useClassroomStore((s) => (s.errorScope === 'join' ? s.error : null))
  const join = useClassroomStore((s) => s.join)
  const leave = useClassroomStore((s) => s.leave)
  const clearError = useClassroomStore((s) => s.clearError)
  const persistence = useClassroomStore((s) => s.persistence)
  const [code, setCode] = useState('')
  const [countExisting, setCountExisting] = useState(true)
  const [summary, setSummary] = useState<SyncSummary | null>(null)
  const [left, setLeft] = useState(false)

  async function onJoin(e: FormEvent) {
    e.preventDefault()
    setLeft(false)
    setSummary(null)
    const joined = await join(code.trim())
    if (!joined) return
    setCode('')
    if (countExisting) setSummary(await syncLocalProgress())
  }

  async function onLeave() {
    setSummary(null)
    if (await leave()) setLeft(true)
  }

  return (
    <section aria-labelledby="join-h" className={CARD} data-testid="join-panel">
      <h2 id="join-h" className={H2}>
        {membership ? 'Your class' : 'Join a class'}
      </h2>

      {membership ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-slate-200" data-testid="membership">
            You are in <strong className="font-semibold">{membership.classTitle}</strong> (code{' '}
            <span className="font-mono-qasm tracking-wider">{membership.classCode}</span>) as{' '}
            <span className="font-mono-qasm">{membership.alias}</span>.
          </p>
          <p className="max-w-2xl text-[13px] leading-relaxed text-slate-400">
            Your instructor sees what you do in lessons, concept checks and challenges, and experiments you share, as the alias above and in
            counts with the rest of the class. Your name is never asked for. Your progress stays in this browser, and leaving the class does not
            delete any of it.
          </p>
          {summary && <SyncNote summary={summary} />}
          <div>
            <button type="button" className={SECONDARY} onClick={() => void onLeave()} disabled={busy !== 'idle'}>
              {busy === 'leaving' ? 'Leaving…' : 'Leave class'}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void onJoin(e)} className="mt-3 flex max-w-md flex-col gap-3" noValidate>
          {left && (
            <p role="status" data-testid="left-note" className="rounded-md border border-void-400 bg-void-800 p-2.5 text-[13px] text-slate-300">
              You left the class. Your progress in this browser is untouched, and joining again with the code brings back the same anonymous
              learner.
            </p>
          )}
          <div>
            <label htmlFor="class-code" className="mb-1 block text-[13px] font-medium text-slate-300">
              Class code
            </label>
            <input
              id="class-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase())
                if (error) clearError()
              }}
              placeholder="ABCD-2345"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={12}
              aria-describedby={error ? 'join-error' : 'join-help'}
              aria-invalid={error ? true : undefined}
              className={`${INPUT} font-mono-qasm tracking-wider`}
            />
            <p id="join-help" className="mt-1 text-xs text-slate-400">
              Eight letters and digits, from your instructor.
            </p>
          </div>
          <label className="flex items-start gap-2 text-[13px] text-slate-300">
            <input
              type="checkbox"
              checked={countExisting}
              onChange={(e) => setCountExisting(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-glow"
            />
            <span>Also count what I have already done in this browser (lessons started, concept-check answers). Nothing is deleted either way.</span>
          </label>
          {error && (
            <p id="join-error" role="alert" data-testid="join-error" className="rounded-md border border-danger-glow/40 bg-danger-dim/30 p-2.5 text-[13px] text-danger-glow">
              {error}
            </p>
          )}
          <div>
            <button type="submit" className={PRIMARY} disabled={busy !== 'idle' || code.trim() === ''}>
              {busy === 'joining' ? 'Joining…' : 'Join class'}
            </button>
          </div>
        </form>
      )}
      {persistence === 'session-only' && (
        <p role="status" className="mt-3 text-xs text-amber-glow">
          This browser is not letting Qentor save, so you will need to join again after reloading.
        </p>
      )}
    </section>
  )
}

function SyncNote({ summary }: { summary: SyncSummary }) {
  const a = summary.answers
  return (
    <p role="status" data-testid="sync-note" className="max-w-2xl rounded-md border border-cyan-glow/30 bg-cyan-dim/20 p-2.5 text-[13px] text-cyan-glow">
      Counted from this browser: {summary.lessonsStarted} lesson{summary.lessonsStarted === 1 ? '' : 's'} started
      {a ? `, ${a.recorded + a.duplicates} concept-check answer${a.recorded + a.duplicates === 1 ? '' : 's'} (the server graded each itself)` : ''}.
      {a === null && ' No saved concept-check answers were sent.'} Challenges you solved earlier count when you submit them again, because only the
      server’s verdict counts.
    </p>
  )
}

// ------------------------------------------------------------------------------------------------------------------ instructor

function TeachPanel() {
  const teaching = useClassroomStore((s) => s.teaching)
  const busy = useClassroomStore((s) => s.busy)
  const error = useClassroomStore((s) => (s.errorScope === 'teach' ? s.error : null))
  const createClass = useClassroomStore((s) => s.createClass)
  const deleteClass = useClassroomStore((s) => s.deleteClass)
  const forgetClass = useClassroomStore((s) => s.forgetClass)
  const [title, setTitle] = useState('')
  const [fresh, setFresh] = useState<TeachingClass | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    const made = await createClass(title)
    if (!made) return
    setTitle('')
    setFresh(made)
    setSelected(made.classCode)
  }

  const open = teaching.find((t) => t.classCode === selected) ?? null

  return (
    <section aria-labelledby="teach-h" className={CARD} data-testid="teach-panel">
      <h2 id="teach-h" className={H2}>
        Teach a class
      </h2>
      <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-400">
        Creating a class gives you a class code to share and an instructor key. The key is shown once and is kept in this browser; it is the only way
        back into the dashboard, so anyone who holds it can read this class’s anonymous numbers. There is no account to recover it from.
      </p>

      <form onSubmit={(e) => void onCreate(e)} className="mt-3 flex max-w-md flex-col gap-3" noValidate>
        <div>
          <label htmlFor="class-title" className="mb-1 block text-[13px] font-medium text-slate-300">
            Class name (optional)
          </label>
          <input
            id="class-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            placeholder="Period 3 physics"
            autoComplete="off"
            className={INPUT}
          />
        </div>
        <div>
          <button type="submit" className={PRIMARY} disabled={busy !== 'idle'}>
            {busy === 'creating' ? 'Creating…' : 'Create class'}
          </button>
        </div>
      </form>

      {error && busy === 'idle' && (
        <p role="alert" data-testid="teach-error" className="mt-3 rounded-md border border-danger-glow/40 bg-danger-dim/30 p-2.5 text-[13px] text-danger-glow">
          {error}
        </p>
      )}

      {fresh && <FreshClass cls={fresh} onDone={() => setFresh(null)} />}

      {teaching.length > 0 && (
        <div className="mt-5">
          <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Classes you created in this browser</h3>
          <ul className="mt-2 flex flex-col gap-2" data-testid="teaching-list">
            {teaching.map((t) => (
              <li key={t.classCode} className="flex flex-wrap items-center gap-2 rounded-lg border border-void-500 bg-void-800 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">{t.title}</p>
                  <p className="font-mono-qasm text-xs tracking-wider text-slate-400">{t.classCode}</p>
                </div>
                <button
                  type="button"
                  className={SECONDARY}
                  aria-pressed={selected === t.classCode}
                  onClick={() => setSelected(selected === t.classCode ? null : t.classCode)}
                >
                  {selected === t.classCode ? 'Hide dashboard' : 'Open dashboard'}
                </button>
                {confirmDelete === t.classCode ? (
                  <span className="flex flex-wrap items-center gap-2" role="group" aria-label={`Delete ${t.title}?`}>
                    <span className="text-xs text-slate-300">Delete this class and everything recorded in it?</span>
                    <button
                      type="button"
                      className={`${BUTTON} border border-danger-glow/60 text-danger-glow hover:bg-danger-dim/30`}
                      onClick={() => {
                        void deleteClass(t.classCode).then((ok) => {
                          if (ok) setSelected((cur) => (cur === t.classCode ? null : cur))
                          setConfirmDelete(null)
                        })
                      }}
                    >
                      Yes, delete
                    </button>
                    <button type="button" className={SECONDARY} onClick={() => setConfirmDelete(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <>
                    <button type="button" className={SECONDARY} onClick={() => setConfirmDelete(t.classCode)}>
                      Delete class
                    </button>
                    <button type="button" className={SECONDARY} onClick={() => forgetClass(t.classCode)} title="Remove the key from this browser. The class itself is kept.">
                      Forget key
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <div className="mt-5" data-testid="dashboard-region">
          <h3 className="font-sans-ui text-base font-semibold text-slate-100">Dashboard: {open.title}</h3>
          <div className="mt-3">
            <InstructorDashboard classCode={open.classCode} instructorKey={open.instructorKey} />
          </div>
        </div>
      )}
    </section>
  )
}

function FreshClass({ cls, onDone }: { cls: TeachingClass; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null)
  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
    } catch {
      setCopied(null) // clipboard unavailable: the value is on screen to copy by hand
    }
  }
  return (
    <div role="status" data-testid="fresh-class" className="mt-4 rounded-lg border border-cyan-glow/40 bg-cyan-dim/20 p-4 text-sm text-slate-200">
      <p className="font-semibold text-cyan-glow">Class created: {cls.title}</p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr] sm:gap-x-4">
        <dt className="text-slate-400">Class code (give this to learners)</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span data-testid="fresh-code" className="font-mono-qasm text-lg tracking-wider text-slate-100">
            {cls.classCode}
          </span>
          <button type="button" className={SECONDARY} onClick={() => void copy('code', cls.classCode)}>
            {copied === 'code' ? 'Copied' : 'Copy code'}
          </button>
        </dd>
        <dt className="text-slate-400">Instructor key (shown once, keep it private)</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span data-testid="fresh-key" className="font-mono-qasm text-xs break-all text-slate-100">
            {cls.instructorKey}
          </span>
          <button type="button" className={SECONDARY} onClick={() => void copy('key', cls.instructorKey)}>
            {copied === 'key' ? 'Copied' : 'Copy key'}
          </button>
        </dd>
      </dl>
      <p className="mt-2 text-xs text-slate-300">
        This browser has saved the key so you can return to the dashboard. Copy it somewhere safe if you want another device or browser to reach it.
      </p>
      <button type="button" className={`${SECONDARY} mt-3`} onClick={onDone}>
        I have saved the key
      </button>
    </div>
  )
}
