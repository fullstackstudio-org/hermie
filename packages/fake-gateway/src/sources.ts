/**
 * The pages a reply used, and the blocks a connection draws, as the fake gateway has them: `contract/sources/` and
 * the `markup` key of `client.capabilities` (the fork's `tui_gateway/sources.py` and `tui_gateway/client_markup.py`).
 *
 * The real gateway builds the list from the results of the turn's own `web_search` / `web_extract` calls. This fake
 * has no tools that search, so a scenario reply names the list it ends with (`ScenarioReply.sources`: a sample, or
 * the entries themselves), and the fake does what the gateway does with a list: it sends it as `sources` on
 * `message.complete` and writes it on the reply's row as `display_metadata.sources`, so a reload and the REST
 * transcript show the same list. A reply that names none carries no key at all, and never `[]`.
 */

/** One entry, as the wire carries it (`contract/sources/schema.json`). */
export interface WireSource {
  url: string
  title: string
  via: 'read' | 'found'
}

/** The lists a scenario can name instead of writing them out. */
export const SOURCE_SAMPLES = {
  /** The contract's own message example: one page read, one only found (and no title). */
  guide: [
    { url: 'https://example.org/guide/install', title: 'Installing the gateway', via: 'read' },
    { url: 'https://docs.example.com/a?b=c#d', title: '', via: 'found' }
  ],
  /** A title that names a place the address does not go to: a client shows the domain beside every title. */
  misleading: [
    { url: 'https://phish.example.net/login', title: 'Your bank - secure sign in', via: 'read' },
    { url: 'https://www.example.com/news/2026/ai', title: 'Reuters: markets calm', via: 'found' }
  ],
  /** A turn that read two pages and found six more. */
  search: [
    { url: 'https://example.org/guide/install', title: 'Installing the gateway', via: 'read' },
    { url: 'https://docs.example.com/reference', title: 'Reference · Example Docs', via: 'read' },
    { url: 'https://news.example.net/story-1', title: 'Gateways, explained', via: 'found' },
    { url: 'https://blog.example.io/post', title: 'Running your own gateway', via: 'found' },
    { url: 'https://forum.example.org/t/42', title: 'How do I update the gateway?', via: 'found' },
    { url: 'https://github.com/example/gateway', title: 'example/gateway', via: 'found' },
    { url: 'https://wiki.example.org/Gateway', title: '', via: 'found' },
    { url: 'https://xn--bcher-kva.example/', title: 'Bücher', via: 'found' }
  ]
} satisfies Record<string, WireSource[]>

export type SourceSampleName = keyof typeof SOURCE_SAMPLES

/** What a scenario reply may say about its sources: a sample's name, or the entries. */
export type ScenarioSources = SourceSampleName | WireSource[]

export function sourcesOf(value: ScenarioSources): WireSource[] {
  return typeof value === 'string' ? SOURCE_SAMPLES[value].map(entry => ({ ...entry })) : value
}

/** The block names this gateway has a guide for (`client_markup.VOCABULARY`). */
export const MARKUP_VOCABULARY: readonly string[] = ['alerts', 'cards', 'chart']

const MARKUP_MAX_NAMES = 16
const MARKUP_MAX_NAME_LENGTH = 32
const MARKUP_NAME = /^[a-z][a-z-]*$/u

/**
 * The names of `value` this gateway accepts (`client_markup.accepted_names`): none unless `value` is a list of at
 * most 16 well-formed names (a malformed one makes it none, and never fails the call), then the known ones, sorted.
 */
export function acceptedMarkup(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MARKUP_MAX_NAMES) {
    return []
  }

  const names: string[] = []

  for (const name of value) {
    if (typeof name !== 'string' || name.length > MARKUP_MAX_NAME_LENGTH || !MARKUP_NAME.test(name)) {
      return []
    }

    names.push(name)
  }

  return [...new Set(names)].filter(name => MARKUP_VOCABULARY.includes(name)).sort()
}
