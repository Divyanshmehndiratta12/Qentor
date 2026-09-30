/**
 * One honest line about where the learner's progress lives, read from the store's `persistence` state:
 * saved in this browser (`device`) or existing for this page load only (`session-only`, because the browser refused to save).
 * It states the scope both ways — no account, not shared — and never says "synced" or "cloud".
 */
import { useLearnStore } from './store'

export function PersistenceNote({ className = '' }: { className?: string }) {
  const persistence = useLearnStore((s) => s.persistence)
  const recovered = useLearnStore((s) => s.progressRecovered)

  return (
    <>
      <p className={className} data-testid="persistence-note" data-persistence={persistence}>
        {persistence === 'device'
          ? 'Saved on this device — in this browser only. There is no account and nothing is shared.'
          : 'Session only — this browser isn’t letting Qentor save, so progress is lost when you reload.'}
      </p>
      {recovered && (
        <p className={className} role="status" data-testid="progress-recovered">
          Saved progress on this device couldn’t be read, so it was set aside and you’re starting fresh.
        </p>
      )}
    </>
  )
}
