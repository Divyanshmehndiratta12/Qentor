/**
 * One honest line about where the learner's progress lives, read from the store's `persistence` state:
 * saved in this browser (`device`) or existing for this page load only (`session-only`, because the browser refused to save).
 * It states the scope both ways — no account, not shared — and never says "synced" or "cloud". When the saved quiz results
 * could not be re-checked with the server after a load, it says that too (`regradeStatus === 'unverified'`).
 */
import { useClassroomStore } from '@/features/classroom/store'
import { useLearnStore } from './store'

export function PersistenceNote({ className = '' }: { className?: string }) {
  const persistence = useLearnStore((s) => s.persistence)
  const recovered = useLearnStore((s) => s.progressRecovered)
  const regradeStatus = useLearnStore((s) => s.regradeStatus)
  const inClass = useClassroomStore((s) => s.membership !== null)

  return (
    <>
      <p className={className} data-testid="persistence-note" data-persistence={persistence}>
        {persistence === 'device'
          ? inClass
            ? 'Saved on this device — in this browser only. There is no account. Because you are in a class, your lesson and challenge activity is also counted by your instructor under an anonymous alias.'
            : 'Saved on this device — in this browser only. There is no account and nothing is shared.'
          : 'Session only — this browser isn’t letting Qentor save, so progress is lost when you reload.'}
      </p>
      {recovered && (
        <p className={className} role="status" data-testid="progress-recovered">
          Saved progress on this device couldn’t be read, so it was set aside and you’re starting fresh.
        </p>
      )}
      {regradeStatus === 'unverified' && (
        <p className={className} role="status" data-testid="answers-unverified">
          Your saved quiz answers couldn’t be re-checked with the server just now, so their results are shown as last saved.
        </p>
      )}
    </>
  )
}
