/**
 * The marker a gateway puts on a turn an agent sent on a person's behalf
 * (`display_metadata.author.via`, and the same under `replayed_by`), and how
 * the engine words it.
 *
 * The identity of such a row stays the PERSON's: `author.id` and `author.name`
 * are who the agent works for, and `via` says it was an agent, and which one,
 * that actually sent it. A client never shows the person's name alone for a
 * row that carries one, so what it draws is one label, `<name> via <client>`
 * (`authorLabel`). The contract is `contract/gateway/mcp.md`.
 *
 * Everything read here is defensive in the way `identity.ts` is: a value of the
 * wrong type is absent, never half-trusted.
 */

import type { AuthorVia } from './types'

/** The longest client name the engine will carry, in code points. The gateway cleans to the same cap. */
export const AUTHOR_VIA_CLIENT_LIMIT = 80

/**
 * The English word that joins a name to the client it came through. The engine
 * words the label; a client that localises its own chrome may spell the join in
 * its own language, around the same two parts.
 */
export const AUTHOR_VIA_WORD = 'via'

/** Format characters: bidi overrides, zero-width space and joiners. They take no room, so they leave no gap. */
const FORMAT = /\p{Cf}/gu

/** One line of plain text: format characters gone, line breaks and other controls a space, held to the limit. */
function cleanClient(value: string): string {
  const collapsed = value
    .replace(FORMAT, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

  return Array.from(collapsed).slice(0, AUTHOR_VIA_CLIENT_LIMIT).join('').trim()
}

/**
 * `via` out of an `author` (or `replayed_by`) object: `{ kind, client }` with a
 * non-empty string `kind` and a `client` that is a non-empty string once
 * cleaned. Unknown keys are ignored (a later gateway may add some); a `via` of
 * any other shape is absent, and the author keeps what it has: dropping the
 * whole author for it would take the person's identity with the marker, and a
 * colleague's row in a group chat would then read as nobody's.
 */
export function authorViaOf(value: unknown): AuthorVia | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const { kind, client } = value as Record<string, unknown>

  if (typeof kind !== 'string' || !kind.trim() || typeof client !== 'string') {
    return undefined
  }

  const cleaned = cleanClient(client)

  return cleaned ? { kind: kind.trim(), client: cleaned } : undefined
}

/**
 * `<name> via <client>` for an author that carries `via`, else `name` as it is.
 *
 * Plain text, never Markdown: `via` is a word, not emphasis, and nothing here
 * escapes or wraps. A caller that puts the label into Markdown escapes the whole
 * line the way it escapes any other person's text. A blank `name` leaves
 * `via <client>`, so an agent's turn is never labelled as nobody's.
 */
export function authorLabel(author: { via?: AuthorVia } | undefined, name: string): string {
  const via = author?.via

  if (!via) {
    return name
  }

  const who = name.trim()

  return who ? `${who} ${AUTHOR_VIA_WORD} ${via.client}` : `${AUTHOR_VIA_WORD} ${via.client}`
}
