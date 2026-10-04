import { afterEach, describe, expect, it } from 'vitest'

import { LOCALES, resetActiveLocale, setActiveLocale, TRANSLATED_LOCALES, type Locale } from './active-locale'
import { CRON_STRINGS_SOURCE, cronWebStrings } from './cron-strings'
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
  // "MCP" is the protocol's name in every language.
  'mcp.settings.title': ['nl', 'de'],
  // "Code" is the Dutch and German word too.
  'sheets.secureInput.fieldCode': ['nl', 'de'],
  // `{name}: {problem}` is the same two placeholders and a colon in every language.
  'attachments.problemAnnounced': ['nl', 'de'],
  // "Chats in {name}" is the Dutch and the German way too.
  'sheets.settings.chatList.folderMembers': ['nl', 'de'],
  // "Update", "Build"-like loan words and the same word in Dutch and German.
  'sheets.settings.gateway.update': ['nl', 'de'],
  // "Commit" is the word in every language.
  'sheets.settings.about.commit': ['nl', 'de'],
  // "Later" is the Dutch word too.
  'sheets.interactive.later': ['nl'],
  // "YOLO" is the mode's name in every language.
  'chat.yolo.badge': ['nl', 'de'],
  // "Minimal" is the German word too; "Max" and "Ultra" are the same word in all three.
  'sheets.chatSettings.reasoning.minimal': ['de'],
  'sheets.chatSettings.reasoning.max': ['nl', 'de'],
  'sheets.chatSettings.reasoning.ultra': ['nl', 'de'],
  // `{action}: {name}` is the same two placeholders and a colon in every language.
  'cron.actionFor': ['nl', 'de'],
  // "Name" is the German word too; "Toolsets" and "Skills" are loan words in Dutch and German.
  'sheets.botProfile.nameHeading': ['de'],
  'sheets.botProfile.toolsetsHeading': ['nl', 'de'],
  'sheets.botProfile.skillsHeading': ['nl', 'de'],
  // "Gateway", "Provider" and the dash are the same in all three; "Model" and "Session" in two.
  'sheets.botProfile.gatewayVersion': ['nl', 'de'],
  'sheets.botProfile.provider': ['nl', 'de'],
  'sheets.botProfile.unknown': ['nl', 'de'],
  'sheets.botProfile.model': ['nl'],
  'sheets.botProfile.session': ['de'],
  // `Details: {details}` is the same word in Dutch and German.
  'sheets.composer.ownedElsewhere.details': ['nl', 'de'],
  // "{count} tools" is Dutch too.
  'sheets.botProfile.toolCount': ['nl']
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
  ...leaves(SHEET_STRINGS_SOURCE as unknown as Source, 'sheets'),
  ...leaves(CRON_STRINGS_SOURCE as unknown as Source, 'cron')
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
  outcome: MARKER,
  seconds: MARKER,
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
  longest: MARKER,
  address: MARKER,
  until: MARKER,
  index: MARKER,
  folder: MARKER,
  carried: MARKER,
  // The interactive sheets: a form's limits and zones, a file request's sizes.
  currency: MARKER,
  decimals: MARKER,
  zone: MARKER,
  offset: MARKER,
  value: MARKER,
  step: MARKER,
  from: MARKER,
  size: MARKER,
  max: MARKER,
  min: MARKER,
  current: MARKER,
  what: MARKER,
  line: MARKER,
  title: MARKER,
  // A diff review: which hunk, and how many of them are decided which way.
  n: MARKER,
  approved: MARKER,
  rejected: MARKER,
  undecided: MARKER,
  // The Crons and Activity pages: a schedule's words, an action named for its cron.
  days: MARKER,
  day: MARKER,
  when: MARKER,
  action: MARKER
}

describe('the web-only strings', () => {
  it('has strings', () => {
    expect(all.length).toBeGreaterThan(0)
  })

  it('says each thing in one table only, so the two cannot drift apart', () => {
    const entry = new Set(leaves(WEB_STRINGS_SOURCE as unknown as Source).map(([key]) => key))

    for (const [key] of [
      ...leaves(SHEET_STRINGS_SOURCE as unknown as Source),
      ...leaves(CRON_STRINGS_SOURCE as unknown as Source)
    ]) {
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

describe('cronWebStrings', () => {
  it('reads in the language that is active when it is read', () => {
    expect(cronWebStrings.schedule.everyDayAt({ time: '09:00' })).toBe('Every day at 09:00')

    setActiveLocale('nl')
    expect(cronWebStrings.schedule.everyDayAt({ time: '09:00' })).toBe('Elke dag om 09:00')

    setActiveLocale('de')
    expect(cronWebStrings.schedule.everyDayAt({ time: '09:00' })).toBe('Jeden Tag um 09:00')
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
