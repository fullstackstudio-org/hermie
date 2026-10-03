import { afterEach, describe, expect, it } from 'vitest'

import { LOCALES, resetActiveLocale, setActiveLocale, TRANSLATED_LOCALES, type Locale } from './active-locale'
import { SHEET_STRINGS_SOURCE, sheetStrings } from './sheet-strings'
import { WEB_STRINGS_SOURCE, webStrings } from './web-strings'

afterEach(() => {
  resetActiveLocale()
})

/**
 * Leaves whose Dutch or German text is the English text on purpose: the same word
 * in that language, or a placeholder and nothing else. A leaf that is a silent
 * copy of the English and not listed here fails, which is how an untranslated
 * string is told from a string that needs no translation.
 */
const SAME_AS_ENGLISH: Readonly<Record<string, readonly Locale[]>> = {
  // "Version 0.2.0" is the German word too.
  'shell.version': ['de'],
  // `{name}, {time}` is the same two placeholders and a comma in every language.
  'chat.messageFrom': ['nl', 'de'],
  // "Details" and "Passkeys" are the Dutch and German words too.
  'sheets.passkeys.detailLabel': ['nl', 'de'],
  'passkeys.settings.title': ['nl', 'de'],
  // "Code" is the Dutch and German word too.
  'sheets.secureInput.fieldCode': ['nl', 'de'],
  // `{name}: {problem}` is the same two placeholders and a colon in every language.
  'attachments.problemAnnounced': ['nl', 'de']
}

type Source = Record<string, unknown>

const isLeaf = (node: unknown): node is Record<Locale, string | ((args: never) => string)> =>
  typeof node === 'object' && node !== null && LOCALES.every(locale => locale in node)

function leaves(
  node: Source,
  path = '',
  out: [string, Record<Locale, unknown>][] = []
): [string, Record<Locale, unknown>][] {
  for (const [name, child] of Object.entries(node)) {
    const key = path ? `${path}.${name}` : name

    if (isLeaf(child)) {
      out.push([key, child])
    } else {
      leaves(child as Source, key, out)
    }
  }

  return out
}

/** Both tables: the entry's, and the one only the sheets' chunk reads (`sheet-strings.ts`), under `sheets.`. */
const all = [
  ...leaves(WEB_STRINGS_SOURCE as unknown as Source),
  ...leaves(SHEET_STRINGS_SOURCE as unknown as Source, 'sheets')
]

/** Sample arguments for the function leaves: every parameter is a recognisable string. */
const MARKER = '/some/path/index.html'
const SAMPLE = {
  expected: MARKER,
  version: MARKER,
  name: MARKER,
  text: MARKER,
  time: MARKER,
  message: MARKER,
  count: MARKER,
  status: MARKER,
  host: MARKER,
  rp: MARKER,
  reason: MARKER,
  date: MARKER,
  code: MARKER,
  method: MARKER,
  done: MARKER,
  total: MARKER,
  detail: MARKER,
  problem: MARKER,
  query: MARKER,
  added: MARKER,
  removed: MARKER,
  lines: MARKER,
  longest: MARKER
}

describe('the web-only strings', () => {
  it('has strings', () => {
    expect(all.length).toBeGreaterThan(0)
  })

  it('says each thing in one table only, so the two cannot drift apart', () => {
    const entry = new Set(leaves(WEB_STRINGS_SOURCE as unknown as Source).map(([key]) => key))

    for (const [key] of leaves(SHEET_STRINGS_SOURCE as unknown as Source)) {
      expect(entry.has(key), key).toBe(false)
    }
  })

  it('has every leaf in every language, as the same kind of value', () => {
    for (const [key, leaf] of all) {
      for (const locale of LOCALES) {
        expect(typeof leaf[locale], `${key} [${locale}]`).toBe(typeof leaf.en)
      }
    }
  })

  it('has no empty text and no text that is just whitespace', () => {
    for (const [key, leaf] of all) {
      for (const locale of LOCALES) {
        const text =
          typeof leaf[locale] === 'function' ? (leaf[locale] as (a: unknown) => string)(SAMPLE) : leaf[locale]

        expect(String(text).trim().length, `${key} [${locale}]`).toBeGreaterThan(0)
      }
    }
  })

  it('does not paint the English sentence in another language unless that is listed', () => {
    for (const [key, leaf] of all) {
      for (const locale of TRANSLATED_LOCALES) {
        const text = (l: Locale): string =>
          typeof leaf[l] === 'function' ? (leaf[l] as (a: unknown) => string)(SAMPLE) : String(leaf[l])

        if (SAME_AS_ENGLISH[key]?.includes(locale)) {
          expect(text(locale), `${key} [${locale}] is listed as identical but differs`).toBe(text('en'))
        } else {
          expect(text(locale), `${key} [${locale}] is a copy of the English`).not.toBe(text('en'))
        }
      }
    }
  })

  it('uses its placeholders in every language of a function', () => {
    for (const [key, leaf] of all) {
      if (typeof leaf.en !== 'function') {
        continue
      }

      for (const locale of LOCALES) {
        expect((leaf[locale] as (a: unknown) => string)(SAMPLE), `${key} [${locale}]`).toContain(MARKER)
      }
    }
  })
})

describe('sheetStrings', () => {
  it('reads in the language that is active when it is read, like webStrings', () => {
    expect(sheetStrings.requests.skip).toBe('Skip')

    setActiveLocale('nl')
    expect(sheetStrings.requests.skip).toBe('Overslaan')
  })
})

describe('webStrings', () => {
  it('reads in the language that is active when it is read', () => {
    expect(webStrings.language.followBrowser).toBe('Follow browser')

    setActiveLocale('nl')
    expect(webStrings.language.followBrowser).toBe('Volg browser')

    setActiveLocale('de')
    expect(webStrings.language.followBrowser).toBe('Browser folgen')
  })

  it('takes its parameters by name', () => {
    expect(webStrings.basePath.misconfigured({ expected: '/x/index.html' })).toContain('/x/index.html')

    setActiveLocale('de')
    expect(webStrings.basePath.misconfigured({ expected: '/x/index.html' })).toContain('Öffne sie unter /x/index.html')
  })
})
