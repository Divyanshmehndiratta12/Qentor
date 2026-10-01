/**
 * Where the API client learns this browser's anonymous learner token, if it has one. The classroom store registers a source when it
 * loads; with none registered (or no token) requests simply carry no header, and the server records nothing for them.
 *
 * The token is a random bearer secret the server issued: it identifies no one, is sent only as the `X-Qentor-Learner` header and
 * only to this server, and is never put in a URL, a log line or a shared page.
 */
export const LEARNER_HEADER = 'X-Qentor-Learner'

let source: () => string | null = () => null

export function setLearnerTokenSource(next: () => string | null): void {
  source = next
}

/** `{ 'X-Qentor-Learner': token }` when this browser has joined a class, otherwise `{}`. */
export function learnerHeaders(): Record<string, string> {
  let token: string | null = null
  try {
    token = source()
  } catch {
    token = null
  }
  return token ? { [LEARNER_HEADER]: token } : {}
}
