/**
 * The files a bot shares: `attachments` on a `message.complete` and on a history row.
 *
 * The contract is `contract/outbox/` (a byte-identical copy of the fork's): one attachment is
 * `{id, name, mime, kind, size, sha256, created_at, url}`, nothing else, and the bytes are fetched from
 * `url` (`GET /api/files/outbox/<id>/<name>`) with the person's own credentials. This module is the
 * strict reader of one: what does not satisfy the schema is dropped, never repaired, because an
 * attachment is a link the person may follow and a name they will read.
 *
 * - **A key the contract does not have** (a server path, say) drops the attachment: the schema says
 *   `additionalProperties: false`, and `contract/outbox/examples.json` lists it as invalid.
 * - **`kind`** is one of `image`, `video`, `audio`, `pdf`, `file`. A kind a newer gateway may add is shown as
 *   a `file` (a download the person opens deliberately), which the contract allows a client to do instead
 *   of ignoring it. A `kind` that is not a string at all is not an attachment.
 * - **`url` has exactly one shape**: `/api/files/outbox/<id>/<name percent-encoded>`, the same `id` and the
 *   same `name`. A url that points anywhere else is dropped, so what a view builds a request from is
 *   always a place on the gateway's outbox route and never a path the sender chose.
 * - **`name` is text.** One component of 1 to 180 characters with no control character, `/` or `\`, and not
 *   `.` or `..`. Views render it as text and never as markup.
 *
 * A gateway whose reply names no files sends no `attachments`; `[]` says the reply named files and none
 * could be shared (the reply's text then carries the note). Both read as no attachments.
 */

export type OutboxKind = 'image' | 'video' | 'audio' | 'pdf' | 'file'

/** One file a bot shared, as the transcript keeps it (`created_at` as `createdAt`). */
export interface OutboxAttachment {
  /** The token: 32 characters of `A-Z a-z 0-9 _ -`. */
  id: string
  /** The file's base name as the bot named it. Plain text. */
  name: string
  /** The type the gateway recorded. */
  mime: string
  /** How to show it. An unknown kind from the wire is `file`. */
  kind: OutboxKind
  /** Bytes. */
  size: number
  /** SHA-256 of the bytes: 64 lower-case hex characters. */
  sha256: string
  /** Unix seconds. */
  createdAt: number
  /** Where the bytes are, relative to the gateway's origin; the name percent-encoded. */
  url: string
}

/** The kinds a client shows inline, by the gateway's own name for them. */
export const OUTBOX_KINDS: readonly OutboxKind[] = ['image', 'video', 'audio', 'pdf', 'file']

/** The most attachments one reply keeps (the gateway shares at most 20 a turn by default). */
export const OUTBOX_MAX_COUNT = 100

const KEYS = new Set(['id', 'name', 'mime', 'kind', 'size', 'sha256', 'created_at', 'url'])
const ID_RE = /^[A-Za-z0-9_-]{32}$/u
const SHA_RE = /^[0-9a-f]{64}$/u
const NAME_MAX_CHARS = 180
const URL_PREFIX = '/api/files/outbox/'
/** A control character (C0, DEL, C1) in a name. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function validName(name: unknown): name is string {
  if (typeof name !== 'string' || name === '.' || name === '..' || /[/\\]/u.test(name) || CONTROL_RE.test(name)) {
    return false
  }

  const length = Array.from(name).length

  return length >= 1 && length <= NAME_MAX_CHARS
}

/** Whether `url` is the outbox route of exactly this `id` and `name`. */
function urlNames(url: string, id: string, name: string): boolean {
  const head = `${URL_PREFIX}${id}/`

  if (!url.startsWith(head)) {
    return false
  }

  const segment = url.slice(head.length)

  // One path segment, with nothing after it: a query or a fragment is somebody else's addition.
  if (segment === '' || /[/\\?#]/u.test(segment)) {
    return false
  }

  try {
    return decodeURIComponent(segment) === name
  } catch {
    return false
  }
}

/** One attachment as the wire carries it, or `null` when it is not one. */
export function parseOutboxAttachment(value: unknown): OutboxAttachment | null {
  if (!isObject(value) || Object.keys(value).some(key => !KEYS.has(key))) {
    return null
  }

  const { id, name, mime, kind, size, sha256, created_at: createdAt, url } = value

  if (
    typeof id !== 'string' ||
    !ID_RE.test(id) ||
    !validName(name) ||
    typeof mime !== 'string' ||
    typeof kind !== 'string' ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof sha256 !== 'string' ||
    !SHA_RE.test(sha256) ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    typeof url !== 'string' ||
    !urlNames(url, id, name)
  ) {
    return null
  }

  return {
    id,
    name,
    mime,
    kind: (OUTBOX_KINDS as readonly string[]).includes(kind) ? (kind as OutboxKind) : 'file',
    size,
    sha256,
    createdAt,
    url
  }
}

/**
 * The `attachments` of a frame or a row: the valid ones, in order, each token once.
 * Anything else (absent, not a list, `[]`) is no attachments.
 */
export function parseOutboxAttachments(value: unknown): OutboxAttachment[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const kept: OutboxAttachment[] = []

  for (const entry of value) {
    const attachment = parseOutboxAttachment(entry)

    if (attachment && !seen.has(attachment.id)) {
      seen.add(attachment.id)
      kept.push(attachment)

      if (kept.length === OUTBOX_MAX_COUNT) {
        break
      }
    }
  }

  return kept
}
