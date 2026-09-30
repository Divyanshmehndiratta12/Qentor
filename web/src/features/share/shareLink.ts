/**
 * Read-only share links: the CIRCUIT, and nothing else, in the URL fragment (`#c=<base64url of canonical JSON>`).
 *
 * The fragment never reaches a server and a link carries no result, provenance or state: whoever opens it gets the circuit on the
 * canvas and runs it themselves, so every number they see is computed for them by the backend. A link is untrusted input, exactly
 * like any stored or network data: it is size-bounded, decoded defensively and validated with the canonical circuit schema, and
 * anything that fails is refused rather than partly loaded. (The size bound also caps the operation count: about a hundred gates.)
 */
import { CircuitSchema, type Circuit } from '@/circuit/types'

export const SHARE_PREFIX = '#c='
/** Longest encoded payload accepted (well under any browser limit, far more than any lesson or challenge circuit needs). */
export const MAX_ENCODED_LENGTH = 8000

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** The fragment (`#c=…`) for a circuit, or `null` when it is too large to share as a link (use the file export instead). */
export function encodeShareFragment(circuit: Circuit): string | null {
  const parsed = CircuitSchema.parse(circuit)
  const encoded = toBase64Url(JSON.stringify(parsed))
  return encoded.length <= MAX_ENCODED_LENGTH ? `${SHARE_PREFIX}${encoded}` : null
}

export type ShareDecode = { ok: true; circuit: Circuit } | { ok: false; reason: string }

/** The circuit in a fragment, or the reason it was refused. `null` when the fragment is not a share link at all. */
export function decodeShareFragment(fragment: string): ShareDecode | null {
  if (!fragment.startsWith(SHARE_PREFIX)) return null
  const encoded = fragment.slice(SHARE_PREFIX.length)
  if (encoded.length === 0) return { ok: false, reason: 'The link is empty.' }
  if (encoded.length > MAX_ENCODED_LENGTH) return { ok: false, reason: 'The link is too large to be a circuit.' }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: 'The link contains characters a circuit link never has.' }
  let json: unknown
  try {
    json = JSON.parse(fromBase64Url(encoded))
  } catch {
    return { ok: false, reason: 'The link could not be read.' }
  }
  const result = CircuitSchema.strict().safeParse(json)
  if (!result.success) return { ok: false, reason: 'The link does not contain a valid Qentor circuit.' }
  return { ok: true, circuit: result.data }
}

/** The full share URL for the current page, or `null` when the circuit is too large for a link. */
export function shareUrl(circuit: Circuit, location: Pick<Location, 'origin'> = window.location): string | null {
  const fragment = encodeShareFragment(circuit)
  return fragment === null ? null : `${location.origin}/${fragment}`
}
