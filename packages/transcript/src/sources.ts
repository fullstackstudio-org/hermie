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
 * - **`url`** is `http` or `https` with a host, no user info and no whitespace, at most 2048 characters, as the
 *   tool returned it. It is read as it comes and never normalised: a view shows the host beside the title, and
 *   opens the address only on the person's own tap.
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
  /** `http` or `https`, with a host. The address as the tool returned it. */
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

/** The schema's own pattern for `url`: a scheme in either case, a host with no `@`, and no whitespace anywhere. */
const URL_RE = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s@/?#]+(?:[/?#][^\s]*)?$/u

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
