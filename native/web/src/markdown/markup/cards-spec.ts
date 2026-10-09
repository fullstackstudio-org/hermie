/**
 * `hermie-cards`: a stack or a grid of cards (an icon, a title, a subtitle, tags, one highlighted card, labelled
 * connectors), as a bot returns it in a fenced block. The validator for `contract/markup/cards.schema.json`, whose
 * `README.md` section 3 is the order it works in and `examples.json` the cases it is held to.
 *
 * Strict on purpose, like every `hermie-*` block: a block that is not exactly the format is shown as the code
 * block it is, never repaired. The one lenient field is the icon name (decision D3): an icon is decoration, so a
 * name outside the vocabulary draws the generic glyph instead of refusing a picture over an ornament.
 *
 * Pure and total: no DOM, never throws. The drawing is `../Cards.tsx`.
 */
import { characters, isRecord, utf8Bytes } from './text'

export type CardsLayout = 'stack' | 'grid'
export type CardsConnector = 'arrow' | 'line' | 'none'

/** One card of a block that passed validation. */
export interface Card {
  title: string
  subtitle?: string
  /** A vocabulary name (lower case), or `generic`. Absent: no glyph. */
  icon?: string
  tags: string[]
  highlight: boolean
  /** The label on the connector to the next card. */
  next?: string
}

/** A block that passed validation: the normal form of `examples.json` (`expect`). */
export interface CardsSpec {
  title?: string
  layout: CardsLayout
  /** Absent with a grid. */
  connector?: CardsConnector
  cards: Card[]
}

export const CARDS_LANGUAGE = 'hermie-cards'

export const CARDS_LIMITS = {
  maxSourceBytes: 16 * 1024,
  minCards: 2,
  maxCards: 12,
  maxTitleLength: 120,
  maxCardTitleLength: 60,
  maxSubtitleLength: 140,
  maxTags: 6,
  maxTagLength: 24,
  maxNextLength: 40,
  maxIconLength: 32
} as const

export type CardsRule =
  | 'tooLarge'
  | 'notJSON'
  | 'notAnObject'
  | 'unknownKey'
  | 'missing'
  | 'wrongType'
  | 'unknownLayout'
  | 'unknownConnector'
  | 'connectorNeedsStack'
  | 'tooFewCards'
  | 'tooManyCards'
  | 'labelTooLong'
  | 'emptyLabel'
  | 'tooManyTags'
  | 'duplicateTag'
  | 'twoHighlights'
  | 'nextOnLastCard'
  | 'nextNeedsStack'

export interface CardsError {
  rule: CardsRule
  /** The key (or the unknown value, or the duplicate tag) the rule is about, where it has one. */
  key?: string
}

export type CardsResult = { ok: true; spec: CardsSpec } | { ok: false; error: CardsError }

class Refusal extends Error {
  constructor(readonly error: CardsError) {
    super(error.rule)
  }
}

const refuse = (rule: CardsRule, key?: string): never => {
  throw new Refusal(key === undefined ? { rule } : { rule, key })
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['title', 'layout', 'connector', 'cards'])
const CARD_KEYS: ReadonlySet<string> = new Set(['title', 'subtitle', 'icon', 'tags', 'highlight', 'next'])
const LAYOUTS: ReadonlySet<string> = new Set(['stack', 'grid'])
const CONNECTORS: ReadonlySet<string> = new Set(['arrow', 'line', 'none'])

/** Whether a fence's language names a cards block. Case does not matter: models capitalise. */
export function isCardsFence(language: string | undefined): boolean {
  return language?.toLowerCase() === CARDS_LANGUAGE
}

/**
 * Validate a block's body. `icons` is the vocabulary (lower-case names): a card's icon resolves against it, so the
 * validator holds no list of its own.
 */
export function parseCards(source: string, icons: ReadonlySet<string>): CardsResult {
  try {
    return { ok: true, spec: validated(source, icons) }
  } catch (error) {
    return { ok: false, error: error instanceof Refusal ? error.error : { rule: 'notJSON' } }
  }
}

/** The one decision the renderer makes: the cards, or `undefined` for the code block they came from. */
export function decideCards(
  language: string | undefined,
  source: string,
  icons: ReadonlySet<string>
): CardsSpec | undefined {
  if (!isCardsFence(language)) {
    return undefined
  }

  const result = parseCards(source, icons)

  return result.ok ? result.spec : undefined
}

function validated(source: string, icons: ReadonlySet<string>): CardsSpec {
  // A string longer than the cap in UTF-16 units is longer in bytes; only the unclear middle is encoded.
  if (source.length > CARDS_LIMITS.maxSourceBytes || utf8Bytes(source) > CARDS_LIMITS.maxSourceBytes) {
    refuse('tooLarge')
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(source)
  } catch {
    return refuse('notJSON')
  }

  if (!isRecord(parsed)) {
    return refuse('notAnObject')
  }

  const unknown = firstUnknownKey(parsed, TOP_LEVEL_KEYS)

  if (unknown !== undefined) {
    refuse('unknownKey', unknown)
  }

  const layout = choice(parsed.layout, 'layout', LAYOUTS, 'unknownLayout') ?? 'stack'
  const connector = choice(parsed.connector, 'connector', CONNECTORS, 'unknownConnector')

  if (layout === 'grid' && connector !== undefined) {
    refuse('connectorNeedsStack')
  }

  const title = optionalText(parsed.title, 'title', CARDS_LIMITS.maxTitleLength)

  if (parsed.cards === undefined || parsed.cards === null) {
    refuse('missing', 'cards')
  }

  if (!Array.isArray(parsed.cards)) {
    refuse('wrongType', 'cards')
  }

  const list = parsed.cards as unknown[]

  // Counted before any card is read.
  if (list.length < CARDS_LIMITS.minCards) {
    refuse('tooFewCards')
  }

  if (list.length > CARDS_LIMITS.maxCards) {
    refuse('tooManyCards')
  }

  const cards = list.map(item => card(item, icons))

  if (cards.filter(entry => entry.highlight).length > 1) {
    refuse('twoHighlights')
  }

  const withNext = cards.findIndex(entry => entry.next !== undefined)

  if (cards[cards.length - 1]?.next !== undefined) {
    refuse('nextOnLastCard')
  }

  if (layout === 'grid' && withNext !== -1) {
    refuse('nextNeedsStack')
  }

  return {
    ...(title === undefined ? {} : { title }),
    layout: layout as CardsLayout,
    ...(layout === 'grid' ? {} : { connector: (connector ?? 'arrow') as CardsConnector }),
    cards
  }
}

function firstUnknownKey(object: Record<string, unknown>, known: ReadonlySet<string>): string | undefined {
  return Object.keys(object)
    .filter(key => !known.has(key))
    .sort()[0]
}

/** One of a few words. Absent or `null` is the default; a non-string is `wrongType`, any other word is `rule`. */
function choice(value: unknown, key: string, allowed: ReadonlySet<string>, rule: CardsRule): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'string') {
    return refuse('wrongType', key)
  }

  if (!allowed.has(value)) {
    return refuse(rule, value)
  }

  return value
}

/** A string, trimmed. Absent or `null` is none; an empty one is none too. */
function optionalText(value: unknown, key: string, limit: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'string') {
    return refuse('wrongType', key)
  }

  const trimmed = value.trim()

  if (characters(trimmed) > limit) {
    refuse('labelTooLong', key)
  }

  return trimmed === '' ? undefined : trimmed
}

function card(item: unknown, icons: ReadonlySet<string>): Card {
  if (!isRecord(item)) {
    return refuse('wrongType', 'cards')
  }

  const unknown = firstUnknownKey(item, CARD_KEYS)

  if (unknown !== undefined) {
    refuse('unknownKey', unknown)
  }

  if (item.title === undefined || item.title === null) {
    refuse('missing', 'title')
  }

  if (typeof item.title !== 'string') {
    refuse('wrongType', 'title')
  }

  const title = (item.title as string).trim()

  if (title === '') {
    refuse('emptyLabel', 'title')
  }

  if (characters(title) > CARDS_LIMITS.maxCardTitleLength) {
    refuse('labelTooLong', 'title')
  }

  const subtitle = optionalText(item.subtitle, 'subtitle', CARDS_LIMITS.maxSubtitleLength)
  const iconName = optionalText(item.icon, 'icon', CARDS_LIMITS.maxIconLength)
  const tags = tagList(item.tags)
  const next = optionalText(item.next, 'next', CARDS_LIMITS.maxNextLength)

  if (item.highlight !== undefined && item.highlight !== null && typeof item.highlight !== 'boolean') {
    refuse('wrongType', 'highlight')
  }

  const icon =
    iconName === undefined ? undefined : icons.has(iconName.toLowerCase()) ? iconName.toLowerCase() : 'generic'

  return {
    title,
    ...(subtitle === undefined ? {} : { subtitle }),
    ...(icon === undefined ? {} : { icon }),
    tags,
    highlight: item.highlight === true,
    ...(next === undefined ? {} : { next })
  }
}

function tagList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    return refuse('wrongType', 'tags')
  }

  const list = value as unknown[]

  // Counted before any tag is read.
  if (list.length > CARDS_LIMITS.maxTags) {
    refuse('tooManyTags')
  }

  const seen = new Set<string>()
  const tags: string[] = []

  for (const item of list) {
    if (typeof item !== 'string') {
      return refuse('wrongType', 'tags')
    }

    const tag = item.trim()

    if (tag === '') {
      refuse('emptyLabel', 'tags')
    }

    if (characters(tag) > CARDS_LIMITS.maxTagLength) {
      refuse('labelTooLong', 'tags')
    }

    if (seen.has(tag)) {
      refuse('duplicateTag', tag)
    }

    seen.add(tag)
    tags.push(tag)
  }

  return tags
}

/** The words of a card read aloud, in the reader's language. */
export interface CardsWords {
  /** "Card {n} of {total}, {title}" */
  card: (position: number, total: number, title: string) => string
  highlighted: string
  /** "tags {tags}" */
  tags: (tags: string) => string
  /** "then: {label}" */
  then: (label: string) => string
}

/**
 * One card as a screen reader says it: "Card 2 of 5, Gateway per klant, k3s eigen Postgres, highlighted, tags k3s,
 * Postgres, then: deployt naar". The same sentence as the native apps'.
 */
export function cardSpeech(spec: CardsSpec, index: number, words: CardsWords): string {
  const entry = spec.cards[index]

  if (!entry) {
    return ''
  }

  const parts = [words.card(index + 1, spec.cards.length, entry.title)]

  if (entry.subtitle !== undefined) {
    parts.push(entry.subtitle)
  }

  if (entry.highlight) {
    parts.push(words.highlighted)
  }

  if (entry.tags.length > 0) {
    parts.push(words.tags(entry.tags.join(', ')))
  }

  if (entry.next !== undefined) {
    parts.push(words.then(entry.next))
  }

  return parts.join(', ')
}
