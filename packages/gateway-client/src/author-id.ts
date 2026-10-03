/**
 * The reader's own author id, spelled exactly the way the gateway spells the
 * per-message author stamp (HERM-83).
 *
 * `/api/auth/me` answers with the provider's BARE `user_id` — `7f3a…` for an
 * OIDC subject, `alice` under basic auth — and `provider` as a separate field.
 * The stamp on a row is `"<provider>:<user_id>"`, built by the gateway's
 * `_transport_auth_user` (and by `pictures.identity_id`, the picture store's
 * key) as `f"{provider.strip()}:{user_id.strip()}"`: provider first, one colon,
 * Python's `str.strip()` on each half, and nothing else — no case folding, no
 * other separator. A client that compared the bare id with that stamp read
 * every one of the reader's own messages as somebody else's.
 *
 * So this mirrors that construction and nothing more. In particular there is
 * no `|| email` fallback: the gateway never stamps an email, so an id built
 * from one could only ever match nobody — or, worse, somebody. A missing or
 * blank `provider` or `user_id` is the gateway's own "no authenticated
 * identity" (`_is_authenticated_identity`), and the reader then has no author
 * id at all, so nothing counts as "own" by id.
 */

/**
 * The characters Python's `str.isspace()` is true for, which is what
 * `str.strip()` with no argument removes from each end.
 *
 * Spelled out rather than left to `String.prototype.trim`, because the two sets
 * differ at the edges: Python strips U+001C..U+001F and U+0085 and JavaScript
 * does not, and JavaScript strips U+FEFF and Python does not. An id that
 * differed from the gateway's by one invisible character would compare unequal
 * to the stamp, which is exactly the bug this file exists to prevent.
 */
const PY_SPACE =
  '\\t\\n\\u000b\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu')

/** Python's `str.strip()`. */
function pyStrip(value: string): string {
  return value.replace(PY_STRIP, '')
}

/**
 * `"<provider>:<user_id>"` for this `/api/auth/me` answer, or `undefined` when
 * either half is missing or blank.
 */
export function authorIdOf(identity: { provider: string; userId: string }): string | undefined {
  const provider = pyStrip(identity.provider ?? '')
  const userId = pyStrip(identity.userId ?? '')

  return provider && userId ? `${provider}:${userId}` : undefined
}

/**
 * The reader's own author, in the shape a stamped row carries it — `{ id, name }`,
 * where `name` is the display name the gateway mints the WS ticket with
 * (`sess.display_name`, stripped), omitted when there is none, exactly as
 * `row_author` omits it.
 */
export function ownAuthorOf(identity: {
  provider: string
  userId: string
  displayName: string
}): { id: string; name?: string } | undefined {
  const id = authorIdOf(identity)

  if (!id) {
    return undefined
  }

  const name = pyStrip(identity.displayName ?? '')

  return name ? { id, name } : { id }
}

/**
 * The agent that sent a row on somebody's behalf: `display_metadata.author.via`
 * (and `replayed_by.via`), the gateway's `{ kind, client }` marker.
 */
export interface AuthorVia {
  kind: string
  client: string
}

/** A stamped author, as a row carries it: the person, and `via` when an agent sent the row for them. */
export interface AuthorStamp {
  id: string
  name?: string
  via?: AuthorVia
}

/** The longest client name carried, in code points: the gateway cleans to the same cap. */
export const AUTHOR_VIA_CLIENT_LIMIT = 80

/** One line of plain text: format characters (bidi overrides, zero-width) gone, other controls a space. */
function cleanClient(value: string): string {
  const collapsed = value
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

  return Array.from(collapsed).slice(0, AUTHOR_VIA_CLIENT_LIMIT).join('').trim()
}

/**
 * `via` out of an author object: a non-empty string `kind` and a `client` that is a non-empty string
 * once cleaned. Keys it does not know are ignored; any other shape is no `via` at all. This is the same
 * rule `@hermie/transcript` applies to a history row (`authorViaOf`), so a client that reads a stamp
 * from somewhere else than a row reads it the same way.
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
 * A stamped author out of an untrusted value: a non-empty string `id`, a string `name` when there is
 * one, and `via` when it is well formed. A value without a usable `id`, or with a `name` of another type,
 * is no author (never half of one); an unusable `via` costs the marker only, and unknown keys are ignored.
 */
export function authorStampOf(value: unknown): AuthorStamp | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const { id, name, via } = value as Record<string, unknown>

  if (typeof id !== 'string' || !id || (name !== undefined && typeof name !== 'string')) {
    return undefined
  }

  const marker = authorViaOf(via)

  return { id, ...(name ? { name: name as string } : {}), ...(marker ? { via: marker } : {}) }
}
