/**
 * One honest line about the language model, shown only when the SERVER says there is none (`GET /api/generate/status`, which is
 * available only when a model is configured in the server's own environment). Nothing here decides anything: the line is the server's
 * answer worded for a learner, and it appears nowhere when a model is configured or when the server could not be asked (unknown is
 * not the same as unavailable, so nothing is claimed either way).
 */
import { useEffect } from 'react'
import { useGenerateStore } from '@/features/generate/store'

export const AI_UNAVAILABLE_NOTE = 'Generative AI unavailable — grounded guidance remains available.'

export function AiStatusNote() {
  const availability = useGenerateStore((s) => s.availability)
  const checking = useGenerateStore((s) => s.checkingAvailability)
  const failed = useGenerateStore((s) => s.availabilityError)
  const checkAvailability = useGenerateStore((s) => s.checkAvailability)
  useEffect(() => {
    if (availability === null && !checking && !failed) void checkAvailability()
  }, [availability, checking, failed, checkAvailability])
  if (availability?.available !== false) return null
  return (
    <p role="note" data-testid="ai-unavailable-note" className="order-last basis-full text-[11px] leading-snug text-amber-glow sm:order-none sm:basis-auto sm:flex-1">
      {AI_UNAVAILABLE_NOTE}
    </p>
  )
}
