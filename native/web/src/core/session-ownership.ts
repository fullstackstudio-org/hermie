/**
 * The gateway's refusal of a turn in a chat that another live Hermes process holds: JSON-RPC code 4090
 * with `data.reason == "SESSION_NOT_OWNED"`, and a message whose first line is the sentence for the
 * reader and whose second is `Details: session … opened by …` (the fork's `session_already_owned_message`).
 *
 * The gateway offers a client no way to take such a chat over: only a detached runtime in the gateway's
 * own process hands its lease on, and it does that by itself. The way out is a new chat here, and nothing
 * is ever sent again by itself. The native apps read it the same way (`SessionOwnership` in HermieCore).
 */

export const SESSION_NOT_OWNED = 'SESSION_NOT_OWNED'

/**
 * The `Details:` line of the refusal, without its label and on one line (empty when the gateway sent none),
 * or `null` when `error` is not this refusal.
 *
 * Read structurally rather than by class, so a refusal that crossed a module boundary still reads: it is
 * an error with a numeric `code` (a transport failure has none) and `data.reason`.
 */
export function ownedElsewhereDetails(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null
  }

  const { code, data } = error as { code?: unknown; data?: unknown }

  if (typeof code !== 'number' || typeof data !== 'object' || data === null) {
    return null
  }

  if ((data as { reason?: unknown }).reason !== SESSION_NOT_OWNED) {
    return null
  }

  const label = error.message.indexOf('Details:')

  if (label < 0) {
    return ''
  }

  // Every kind of line break (line feed, return, VT, FF, NEL, the line and paragraph separators) is one space.
  return error.message
    .slice(label + 'Details:'.length)
    .replace(/[\r\n\v\f\x85\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
}
