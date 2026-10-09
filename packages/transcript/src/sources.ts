/**
 * The pages a reply used: `sources` on a `message.complete` and `display_metadata.sources` on its row.
 *
 * The contract is `contract/sources/` (a byte-identical copy of the fork's): the gateway builds the list from the
 * results of the turn's own web tools, never from the model's words. One entry is `{url, title, via}`, nothing else:
 * `via` is `read` (a page `web_extract` fetched) or `found` (a result `web_search` returned). This module is the
 * strict reader of the list, the way `outbox.ts` is of the attachments: what does not satisfy the schema is dropped,
 * never repaired, because a source is a link the person may follow under a name they will read.
 *
 * - **A key the contract does not have** (a `favicon`, say) drops the entry: the schema says
 *   `additionalProperties: false`, and `contract/sources/examples.json` lists it as invalid.
 * - **`url`** is `http` or `https` with a host, no user info, no white space and no control or format character, at
 *   most 2048 characters. The gateway stores the scheme and the host in lower-case ASCII (punycode for a name that
 *   is not), so an upper-case or Unicode host is not an entry. The reader takes the address as it comes and never
 *   normalises it: a view shows the host beside the title exactly as stored, and opens the address only on the
 *   person's own tap.
 * - **`title`** is text, at most 160 characters, and may be empty. A title over the cap is not shortened: the entry
 *   is not one the gateway sends, so it goes.
 * - **The list** keeps at most 24 entries, the first of each `url`, in the order given. It is not sorted again (the
 *   gateway lists every `read` entry first) and nothing is added to it. An empty result is `[]`: a reply with no
 *   sources has no `sources` at all.
 *
 * Nothing in this module touches a network, and nothing it returns is a request: no favicon, no preview.
 */

export type SourceVia = 'read' | 'found'

/** One page a reply used, as the wire carries it. */
export interface Source {
  /** `http` or `https`, with a host in lower-case ASCII (punycode for a name that is not). */
  url: string
  /** The page's own title, cleaned by the gateway. May be empty. Text only. */
  title: string
  /** `read`: the bot fetched the page. `found`: a search result it may not have opened. */
  via: SourceVia
}

/** The most entries a reply keeps (`maxItems` of the schema). */
export const SOURCES_MAX_COUNT = 24

/** The longest `url`, in characters (`maxLength` of the schema). */
export const SOURCE_URL_MAX_CHARS = 2048

/** The longest `title`, in characters (`maxLength` of the schema). */
export const SOURCE_TITLE_MAX_CHARS = 160

const KEYS = new Set(['url', 'title', 'via'])

/**
 * The schema's own pattern for `url` (`contract/sources/schema.json`): the scheme and the host in lower-case ASCII (a name
 * that is not ASCII arrives as punycode), an IPv6 address in brackets, an optional port, then a path, a query and a
 * fragment with no white space, no control character (C0 or C1) and none of the invisible format characters the schema
 * lists. An upper-case host or scheme is not a source the gateway sends, so it is not one here.
 */
const URL_RE =
  // eslint-disable-next-line no-control-regex -- the schema's own pattern names the control characters it refuses
  /^https?:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?(?:[/?#][^\s\u0000-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]*)?$/u

/** What the contract's prose adds to the pattern: no character of Unicode category `Cf` anywhere, and no lone surrogate. */
const FORMAT_RE = /\p{Cf}/u
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u

/** The port of an address, when it has one: the digits after the host's last colon, outside the brackets of an IPv6 address. */
const PORT_RE = /^https?:\/\/(?:[^/?#]*\])?[^/?#\]]*:([0-9]{1,5})(?:[/?#]|$)/u

/** Whether the address names a port outside 0 to 65535 (the pattern only says it has one to five digits). */
const portOutOfRange = (url: string): boolean => {
  const port = PORT_RE.exec(url)?.[1]

  return port !== undefined && Number(port) > 65_535
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Characters as JSON Schema counts them: code points, not UTF-16 units. */
const lengthOf = (text: string): number => Array.from(text).length

/** One source as the wire carries it, or `null` when it is not one. */
export function parseSource(value: unknown): Source | null {
  if (!isObject(value) || Object.keys(value).some(key => !KEYS.has(key))) {
    return null
  }

  const { url, title, via } = value

  if (
    typeof url !== 'string' ||
    url.length < 1 ||
    lengthOf(url) > SOURCE_URL_MAX_CHARS ||
    !URL_RE.test(url) ||
    FORMAT_RE.test(url) ||
    LONE_SURROGATE_RE.test(url) ||
    portOutOfRange(url) ||
    typeof title !== 'string' ||
    lengthOf(title) > SOURCE_TITLE_MAX_CHARS ||
    (via !== 'read' && via !== 'found')
  ) {
    return null
  }

  return { url, title, via }
}

/**
 * The `sources` of a frame or a row: the valid entries, in order, each address once, at most 24.
 * Anything else (absent, not a list, `[]`) is no sources.
 */
export function parseSources(value: unknown): Source[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const kept: Source[] = []

  for (const entry of value) {
    const source = parseSource(entry)

    if (!source || seen.has(source.url)) {
      continue
    }

    seen.add(source.url)
    kept.push(source)

    if (kept.length >= SOURCES_MAX_COUNT) {
      break
    }
  }

  return kept
}

/**
 * The `sources` a row's `display_metadata` holds: an object, or the JSON text of one, as either transport ships it.
 * Anything that is not that reads as no sources.
 */
export function sourcesOfMetadata(metadata: unknown): Source[] {
  if (typeof metadata === 'string') {
    try {
      return sourcesOfMetadata(JSON.parse(metadata))
    } catch {
      return []
    }
  }

  return isObject(metadata) ? parseSources(metadata.sources) : []
}
