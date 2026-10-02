import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { strings } from '../generated/strings'
import { resetActiveLocale, setActiveLocale, TRANSLATED_LOCALES, LOCALES, type Locale } from './active-locale'
import { catalogueKeys, loadCatalogue, loadedCatalogue, type CatalogueData, type CatalogueValue } from './catalogue'
import type { ArgValue, Template } from './template'

afterEach(() => {
  resetActiveLocale()
})

beforeAll(async () => {
  await Promise.all(LOCALES.map(locale => loadCatalogue(locale)))
})

const data = (locale: Locale): CatalogueData => loadedCatalogue(locale)!

const kindOf = (value: CatalogueValue): 'text' | 'list' | 'template' =>
  typeof value === 'string' ? 'text' : Array.isArray(value) ? 'list' : 'template'

/** Arguments a template can be rendered with: numbers for counts, a list for a list, text for the rest. */
function argsFor(template: Template, into: Record<string, ArgValue> = {}): Record<string, ArgValue> {
  if (typeof template === 'string') {
    for (const match of template.matchAll(/\{([A-Za-z_$][A-Za-z0-9_$]*)(?:\|([a-z]+))?/gu)) {
      const [, name, formatter] = match

      into[name!] ??= formatter === 'add' ? 2 : formatter === 'list' ? ['a', 'b', 'c'] : 'x'
    }

    return into
  }

  if (template.kind === 'select') {
    if (template.test.op === 'empty') {
      into[template.test.arg] ??= 'x'
    } else {
      into[template.test.left] = 2
      into[template.test.right] = 3
    }

    argsFor(template.then, into)

    return argsFor(template.else, into)
  }

  into[template.arg] = 2

  for (const form of Object.values(template.forms)) {
    argsFor(form, into)
  }

  return into
}

/** Every leaf under `node` as `dotted.key → value`, reading the getters the way a screen does. */
function leaves(node: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
    const key = path ? `${path}.${name}` : name

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      leaves(value, key, out)
    } else {
      out.set(key, value)
    }
  }

  return out
}

describe('the generated locale files', () => {
  const keys = catalogueKeys()

  it('hold the catalogue, and every language holds every key', () => {
    expect(keys.length).toBeGreaterThan(1000)

    for (const locale of LOCALES) {
      expect(Object.keys(data(locale)).sort(), locale).toEqual([...keys].sort())
    }
  })

  it('give every key the same kind in every language', () => {
    for (const key of keys) {
      const kind = kindOf(data('en')[key]!)

      for (const locale of TRANSLATED_LOCALES) {
        expect(kindOf(data(locale)[key]!), `${key} [${locale}]`).toBe(kind)
      }
    }
  })

  it('translate lists to the same length as the English', () => {
    for (const key of keys) {
      const english = data('en')[key]!

      if (Array.isArray(english)) {
        for (const locale of TRANSLATED_LOCALES) {
          expect((data(locale)[key] as readonly string[]).length, `${key} [${locale}]`).toBe(english.length)
        }
      }
    }
  })
})

describe('strings', () => {
  it('resolves every key in every language through the tree', () => {
    for (const locale of LOCALES) {
      setActiveLocale(locale)

      const tree = leaves(strings)

      expect([...tree.keys()].sort(), locale).toEqual([...catalogueKeys()].sort())

      for (const [key, value] of tree) {
        const entry = data(locale)[key]!

        if (kindOf(entry) === 'template') {
          expect(typeof value, `${key} [${locale}]`).toBe('function')

          const rendered = (value as (args: Record<string, ArgValue>) => string)(
            argsFor((entry as { template: Template }).template)
          )

          expect(typeof rendered, `${key} [${locale}]`).toBe('string')
        } else {
          expect(value, `${key} [${locale}]`).toEqual(entry)
        }
      }
    }
  })

  it('reads a plain string in the language that is active when it is read', () => {
    expect(strings.app.common.cancel).toBe('Cancel')

    setActiveLocale('nl')
    expect(strings.app.common.cancel).toBe('Annuleren')

    setActiveLocale('de')
    expect(strings.app.common.cancel).toBe('Abbrechen')
  })

  it('fills the named parameters of a template', () => {
    expect(strings.app.onboarding.stepCounter({ current: 2, total: 4 })).toBe('Step 2 of 4')

    setActiveLocale('nl')
    expect(strings.app.onboarding.stepCounter({ current: 2, total: 4 })).toBe('Stap 2 van 4')

    setActiveLocale('de')
    expect(strings.app.onboarding.stepCounter({ current: 2, total: 4 })).toBe('Schritt 2 von 4')
  })

  it('selects a plural form with the active language', () => {
    expect([0, 1, 2].map(count => strings.app.bots.conversations({ count }))).toEqual([
      '0 conversations',
      '1 conversation',
      '2 conversations'
    ])

    setActiveLocale('nl')
    expect([0, 1, 2].map(count => strings.app.bots.conversations({ count }))).toEqual([
      '0 gesprekken',
      '1 gesprek',
      '2 gesprekken'
    ])

    setActiveLocale('de')
    expect([0, 1, 2].map(count => strings.app.bots.conversations({ count }))).toEqual([
      '0 Unterhaltungen',
      '1 Unterhaltung',
      '2 Unterhaltungen'
    ])
  })

  it('treats an empty string like the TypeScript did, and joins a list the way the language does', () => {
    expect(strings.app.layout.removeFolder({ name: '' })).toBe('Delete the untitled folder')
    expect(strings.app.layout.removeFolder({ name: 'Work' })).toBe('Delete the Work folder')
    expect(strings.app.onboarding.address.signInRequired({ version: '', providers: ['a', 'b', 'c'] })).toBe(
      'Hermes gateway · sign-in required via a, b or c'
    )

    setActiveLocale('nl')
    expect(strings.app.onboarding.address.signInRequired({ version: '', providers: ['a', 'b', 'c'] })).toBe(
      'Hermes gateway · inloggen vereist via a, b of c'
    )
  })

  it('returns a list as a list', () => {
    expect(strings.cron.schedule.weekdayNames).toHaveLength(7)

    setActiveLocale('nl')
    expect(strings.cron.schedule.weekdayNames).toHaveLength(7)
    expect(strings.cron.schedule.weekdayNames).not.toEqual(data('en')['cron.schedule.weekdayNames'])
  })

  it('answers undefined for a key a keyed table does not have, and for nothing inherited', () => {
    expect(strings.chat.approval.choices.once).toBe('Allow once')
    expect(strings.chat.approval.choices['no-such-choice']).toBeUndefined()
    expect(strings.chat.approval.choices['constructor']).toBeUndefined()
    expect(strings.chat.approval.choices['toString']).toBeUndefined()
  })

  it('reads keys that are not identifiers with brackets', () => {
    expect(typeof strings.app.layout.muteFor['1h']).toBe('string')
  })
})

describe('loading a language', () => {
  it('shares one fetch between concurrent requests and is instant afterwards', async () => {
    const first = loadCatalogue('de')
    const second = loadCatalogue('de')

    expect(await first).toBe(await second)
    expect(await loadCatalogue('de')).toBe(data('de'))
    expect(await loadCatalogue('en')).toBe(data('en'))
  })
})
