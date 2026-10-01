/**
 * The streak card: current streak, longest streak, last activity and a
 * compact 7-day strip. Purely presentational over an `ActivitySummary`
 * (`learn/streak.ts`) — it computes nothing itself.
 *
 * Accessibility: every value is text (never a colour or shape alone); each
 * streak figure sits in a labelled group ("Current streak: 3 days"); the
 * 7-day strip is a labelled list whose items each say "active" or "no
 * activity" in text and use a filled-with-check vs. hollow shape, and a
 * one-line summary repeats the whole strip in words.
 */
import { addDays, type ActivitySummary, type DateKey } from '../learn/streak'

function pluralDays(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`
}

function weekdayShort(dateKey: DateKey): string {
  // Parse as UTC and format in UTC so the weekday never shifts with the
  // viewer's timezone — the key already *is* the local calendar date.
  return new Date(`${dateKey}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
}

/** "Today", "Yesterday" or the plain date, for the last-activity line. */
function describeLastActivity(lastActivityDate: DateKey | null, todayKey: DateKey): string {
  if (lastActivityDate === null) return 'No activity yet'
  if (lastActivityDate === todayKey) return `Today (${lastActivityDate})`
  if (lastActivityDate === addDays(todayKey, -1)) return `Yesterday (${lastActivityDate})`
  return lastActivityDate
}

export function StreakPanel({ summary, todayKey }: { summary: ActivitySummary; todayKey: DateKey }) {
  const activeRecent = summary.recentDays.filter((day) => day.active).length

  return (
    <section aria-labelledby="streak-heading" className="rounded-xl border border-void-500 bg-void-900 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="streak-heading" className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
          Streak
        </h2>
        <span className="font-mono-qasm text-[10px] text-void-200">this browser only</span>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3">
        <div role="group" aria-label={`Current streak: ${pluralDays(summary.currentStreak)}`}>
          <p className="font-mono-qasm text-4xl leading-none font-semibold text-cyan-glow">
            {summary.currentStreak}
          </p>
          <p className="mt-1.5 text-xs text-slate-400">
            {summary.currentStreak === 1 ? 'day' : 'days'} · current streak
          </p>
        </div>
        <div role="group" aria-label={`Longest streak: ${pluralDays(summary.longestStreak)}`}>
          <p className="font-mono-qasm text-2xl leading-none font-semibold text-violet-glow">
            {summary.longestStreak}
          </p>
          <p className="mt-1.5 text-xs text-slate-400">
            {summary.longestStreak === 1 ? 'day' : 'days'} · longest streak
          </p>
        </div>
        <div role="group" aria-label={`Last activity: ${describeLastActivity(summary.lastActivityDate, todayKey)}`}>
          <p className="font-mono-qasm text-sm leading-none font-medium text-slate-200">
            {describeLastActivity(summary.lastActivityDate, todayKey)}
          </p>
          <p className="mt-1.5 text-xs text-slate-400">last activity</p>
        </div>
      </div>

      <div className="mt-5">
        <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Last 7 days</h3>
        <ul aria-label="Activity over the last 7 days" className="mt-2 grid grid-cols-7 gap-1.5">
          {summary.recentDays.map((day) => {
            const isToday = day.date === todayKey
            return (
              <li
                key={day.date}
                title={`${day.date}: ${day.active ? 'active' : 'no activity'}`}
                className="flex flex-col items-center gap-1"
              >
                <span
                  aria-hidden="true"
                  className={`grid h-8 w-full place-items-center rounded-md border text-xs font-semibold ${
                    day.active
                      ? 'border-cyan-glow/60 bg-cyan-dim/50 text-cyan-glow'
                      : 'border-dashed border-void-400 text-void-200'
                  }`}
                >
                  {day.active ? '✓' : ''}
                </span>
                <span className="font-mono-qasm text-[10px] text-slate-400">
                  {isToday ? 'Today' : weekdayShort(day.date)}
                </span>
                <span className="sr-only">
                  {day.date}: {day.active ? 'active' : 'no activity'}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="mt-2 text-[11px] text-slate-400">
          Active on {activeRecent} of the last 7 days · {pluralDays(summary.totalActiveDays)} in total.
        </p>
      </div>

      <p className="mt-3 text-[10px] leading-snug text-void-200">
        A day counts when you submit a concept-check answer or complete a lesson, by this browser's local date. It's
        saved in this browser only — not an account, not shared, and not a global streak.
      </p>
    </section>
  )
}
