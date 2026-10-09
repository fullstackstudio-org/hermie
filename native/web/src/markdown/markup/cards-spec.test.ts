/**
 * `hermie-cards`, held to the contract (`contract/markup/`): every valid example comes out as its normal form, every
 * invalid one is refused for the rule it names, the alert examples are what `readAlert` says, and the vocabulary has
 * what the SVG and the Apple apps both need.
 */
import { marked, type Tokens } from '@hermie/markdown/marked-compat'
import { describe, expect, it } from 'vitest'

import examplesSource from '../../../../../contract/markup/examples.json?raw'
import iconsSource from '../../../../../contract/markup/icons.json?raw'
import schemaSource from '../../../../../contract/markup/cards.schema.json?raw'
import { readAlert } from '../Alert'
import { CARDS_LIMITS, cardSpeech, decideCards, parseCards, type CardsSpec } from './cards-spec'
import { GENERIC_ICON, ICON_NAMES, iconFor } from './icons'

interface ValidExample {
  name: string
  block?: unknown
  source?: string
  padTo?: number
  expect: CardsSpec
}

interface InvalidExample {
  name: string
  rule: string
  key?: string
  block?: unknown
  source?: string
  padTo?: number
}

interface AlertExample {
  name: string
  markdown: string
  alert: string | null
  body?: string
}

const examples = JSON.parse(examplesSource) as {
  limits: Record<string, number>
  cards: { valid: ValidExample[]; invalid: InvalidExample[] }
  alerts: AlertExample[]
}

/** The block's text as an example gives it: the text itself, or an object written out, padded to a size. */
function textOf(entry: { block?: unknown; source?: string; padTo?: number }): string {
  const text = entry.source ?? JSON.stringify(entry.block)

  return entry.padTo === undefined ? text : text + ' '.repeat(entry.padTo - new TextEncoder().encode(text).length)
}

describe('the contract’s limits', () => {
  it('are the ones the validator holds', () => {
    expect(examples.limits).toEqual({
      maxSourceBytes: CARDS_LIMITS.maxSourceBytes,
      minCards: CARDS_LIMITS.minCards,
      maxCards: CARDS_LIMITS.maxCards,
      maxTitleLength: CARDS_LIMITS.maxTitleLength,
      maxCardTitleLength: CARDS_LIMITS.maxCardTitleLength,
      maxSubtitleLength: CARDS_LIMITS.maxSubtitleLength,
      maxTags: CARDS_LIMITS.maxTags,
      maxTagLength: CARDS_LIMITS.maxTagLength,
      maxNextLength: CARDS_LIMITS.maxNextLength,
      maxIconLength: CARDS_LIMITS.maxIconLength
    })
  })

  it('are the ones the schema states', () => {
    const schema = JSON.parse(schemaSource) as {
      properties: { title: { maxLength: number }; cards: { minItems: number; maxItems: number } }
      $defs: {
        card: { properties: Record<string, { maxLength?: number; maxItems?: number }> }
      }
    }
    const card = schema.$defs.card.properties

    expect(schema.properties.title.maxLength).toBe(CARDS_LIMITS.maxTitleLength)
    expect(schema.properties.cards.minItems).toBe(CARDS_LIMITS.minCards)
    expect(schema.properties.cards.maxItems).toBe(CARDS_LIMITS.maxCards)
    expect(card.title?.maxLength).toBe(CARDS_LIMITS.maxCardTitleLength)
    expect(card.subtitle?.maxLength).toBe(CARDS_LIMITS.maxSubtitleLength)
    expect(card.icon?.maxLength).toBe(CARDS_LIMITS.maxIconLength)
    expect(card.tags?.maxItems).toBe(CARDS_LIMITS.maxTags)
    expect(card.next?.maxLength).toBe(CARDS_LIMITS.maxNextLength)
  })

  it('has more than the minimum number of examples the plan asks for', () => {
    expect(examples.cards.valid.length).toBeGreaterThanOrEqual(8)
    expect(examples.cards.invalid.length).toBeGreaterThanOrEqual(12)
    expect(examples.alerts.length).toBeGreaterThanOrEqual(4)
  })
})

describe('a valid block', () => {
  for (const example of examples.cards.valid) {
    it(example.name, () => {
      const result = parseCards(textOf(example), ICON_NAMES)

      expect(result).toEqual({ ok: true, spec: example.expect })
    })
  }
})

describe('an invalid block is refused for the rule it breaks', () => {
  for (const example of examples.cards.invalid) {
    it(example.name, () => {
      const result = parseCards(textOf(example), ICON_NAMES)

      expect(result).toEqual({
        ok: false,
        error: example.key === undefined ? { rule: example.rule } : { rule: example.rule, key: example.key }
      })
    })
  }

  it('names every rule of the format at least once', () => {
    const rules = new Set(examples.cards.invalid.map(example => example.rule))

    for (const rule of [
      'tooLarge',
      'notJSON',
      'notAnObject',
      'unknownKey',
      'missing',
      'wrongType',
      'unknownLayout',
      'unknownConnector',
      'connectorNeedsStack',
      'tooFewCards',
      'tooManyCards',
      'labelTooLong',
      'emptyLabel',
      'tooManyTags',
      'duplicateTag',
      'twoHighlights',
      'nextOnLastCard',
      'nextNeedsStack'
    ]) {
      expect(rules.has(rule), rule).toBe(true)
    }
  })
})

describe('the decision the renderer makes', () => {
  const block = JSON.stringify({ cards: [{ title: 'A' }, { title: 'B' }] })

  it('is the cards for a cards fence that validates, in any case', () => {
    expect(decideCards('hermie-cards', block, ICON_NAMES)?.cards).toHaveLength(2)
    expect(decideCards('Hermie-Cards', block, ICON_NAMES)?.cards).toHaveLength(2)
  })

  it('is the code block for another language, for a fence with no language and for one that does not validate', () => {
    expect(decideCards('json', block, ICON_NAMES)).toBeUndefined()
    expect(decideCards(undefined, block, ICON_NAMES)).toBeUndefined()
    expect(decideCards('hermie-cards', '{"cards": []}', ICON_NAMES)).toBeUndefined()
    expect(decideCards('hermie-cards', block + 'x', ICON_NAMES)).toBeUndefined()
  })
})

describe('a hostile block never throws', () => {
  const hostile = [
    '',
    ' ',
    '{',
    '{"__proto__": {"x": 1}, "cards": []}',
    '{"constructor": 1}',
    '{"cards": [{"title": "A", "__proto__": 1}, {"title": "B"}]}',
    '{"cards": [null, null]}',
    '{"cards": [[], []]}',
    JSON.stringify({ cards: Array.from({ length: 5000 }, () => ({ title: 'x' })) }),
    '['.repeat(10_000),
    `{"cards": [{"title": "${'x'.repeat(70_000)}"}, {"title": "y"}]}`,
    '{"cards": [{"title": "A"}, {"title": "B"}], "layout": {"toString": 1}}',
    'null',
    '1e999'
  ]

  for (const [index, source] of hostile.entries()) {
    it(`case ${index}`, () => {
      expect(() => parseCards(source, ICON_NAMES)).not.toThrow()
      expect(parseCards(source, ICON_NAMES).ok).toBe(false)
    })
  }

  it('refuses a key called __proto__ as an unknown key, not as a prototype', () => {
    expect(parseCards('{"__proto__": {"x": 1}, "cards": [{"title": "A"}, {"title": "B"}]}', ICON_NAMES)).toEqual({
      ok: false,
      error: { rule: 'unknownKey', key: '__proto__' }
    })
  })
})

describe('what a screen reader says for a card', () => {
  const words = {
    card: (position: number, total: number, title: string): string => `Card ${position} of ${total}, ${title}`,
    highlighted: 'highlighted',
    tags: (tags: string): string => `tags ${tags}`,
    then: (label: string): string => `then: ${label}`
  }

  it('is one sentence with the position, the words, the highlight, the tags and the connector label', () => {
    const result = parseCards(
      JSON.stringify({
        cards: [
          {
            title: 'Gateway per klant',
            subtitle: 'k3s, eigen Postgres',
            tags: ['k3s', 'Postgres'],
            highlight: true,
            next: 'deployt naar'
          },
          { title: 'Website' }
        ]
      }),
      ICON_NAMES
    )

    expect(result.ok).toBe(true)

    if (result.ok) {
      expect(cardSpeech(result.spec, 0, words)).toBe(
        'Card 1 of 2, Gateway per klant, k3s, eigen Postgres, highlighted, tags k3s, Postgres, then: deployt naar'
      )
      expect(cardSpeech(result.spec, 1, words)).toBe('Card 2 of 2, Website')
      expect(cardSpeech(result.spec, 2, words)).toBe('')
    }
  })
})

describe('the icon vocabulary', () => {
  const table = JSON.parse(iconsSource) as {
    generic: { name: string; sfSymbol: string; svg: string }
    icons: { name: string; sfSymbol: string; svg: string }[]
  }

  it('has about forty-eight names, each with an SF Symbol and an outline', () => {
    expect(table.icons.length).toBe(48)

    for (const icon of table.icons) {
      expect(icon.name, icon.name).toMatch(/^[a-z]+$/u)
      expect(icon.sfSymbol, icon.name).toMatch(/^[a-z0-9.]+$/u)
      expect(icon.svg.length, icon.name).toBeGreaterThan(10)
    }
  })

  it('has unique names and unique SF Symbols', () => {
    expect(new Set(table.icons.map(icon => icon.name)).size).toBe(table.icons.length)
    expect(new Set(table.icons.map(icon => icon.sfSymbol)).size).toBe(table.icons.length)
  })

  it('is path data and nothing else: no markup, no script, no reference', () => {
    for (const icon of [table.generic, ...table.icons]) {
      expect(icon.svg, icon.name).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/u)
    }
  })

  it('is what the web resolves a name against, and the generic glyph for anything else', () => {
    expect(ICON_NAMES.size).toBe(table.icons.length)
    expect(iconFor('server').svg).toBe(table.icons.find(icon => icon.name === 'server')?.svg)
    expect(iconFor('generic')).toBe(GENERIC_ICON)
    expect(iconFor('rocket')).toBe(GENERIC_ICON)
  })

  it('has the names the plan lists', () => {
    for (const name of [
      'people',
      'device',
      'server',
      'database',
      'cloud',
      'globe',
      'lock',
      'key',
      'mail',
      'calendar',
      'clock',
      'chart',
      'document',
      'folder',
      'code',
      'terminal',
      'gear',
      'bolt',
      'flag',
      'star',
      'heart',
      'check',
      'warning',
      'question',
      'pin',
      'map',
      'car',
      'home',
      'shop',
      'money',
      'cart',
      'bell',
      'camera',
      'image',
      'music',
      'phone',
      'chat',
      'link',
      'search',
      'filter',
      'tag',
      'box',
      'truck',
      'plane',
      'leaf',
      'flame',
      'sun',
      'moon'
    ]) {
      expect(ICON_NAMES.has(name), name).toBe(true)
    }
  })
})

describe('the alert examples', () => {
  /** The first quote of a Markdown source, as the block renderer meets it. */
  function quoteOf(markdown: string): Tokens.Blockquote | undefined {
    return marked.lexer(markdown).find((token): token is Tokens.Blockquote => token.type === 'blockquote')
  }

  for (const example of examples.alerts) {
    it(example.name, () => {
      const quote = quoteOf(example.markdown)

      if (!quote) {
        // Not a quote at all: nothing to be an alert.
        expect(example.alert).toBeNull()

        return
      }

      const alert = readAlert(quote)

      expect(alert?.kind ?? null).toBe(example.alert)

      if (alert && example.body !== undefined) {
        expect(
          alert.body
            .map(token => token.raw)
            .join('')
            .trim()
        ).toBe(example.body.trim())
      }
    })
  }
})
