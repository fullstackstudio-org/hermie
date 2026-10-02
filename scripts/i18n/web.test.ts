/**
 * The proof that what the web client ships says what the catalogue says.
 *
 * `npm run i18n:check` already fails when `native/web/src/generated` is stale;
 * these tests add the two things a byte comparison cannot: that the locale
 * files hold exactly the catalogue's values, and that the client's own template
 * renderer (a copy, because the client may not import from `scripts/`) renders
 * every template of every language the way the reference renderer does, over the
 * whole argument grid.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { renderTemplate } from '../../native/web/src/i18n/template'
import { sampleArguments } from './convert'
import type { Catalogue } from './export'
import { render } from './template'
import { generateWeb, localeValue, WEB_LOCALES_DIR, WEB_STRINGS_FILE } from './web'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const catalogue = JSON.parse(readFileSync(join(repoRoot, 'contract/i18n/catalogue.json'), 'utf8')) as Catalogue
const generated = join(repoRoot, 'native/web/src/generated')

const files = generateWeb(catalogue)

describe('the generated web files', () => {
  it('are on disk exactly as the generator writes them, and nothing else is in the locales directory', () => {
    for (const [path, text] of files) {
      expect(existsSync(join(generated, path)), path).toBe(true)
      expect(readFileSync(join(generated, path), 'utf8') === text, `${path} is stale: run npm run i18n`).toBe(true)
    }

    const onDisk = readdirSync(join(generated, WEB_LOCALES_DIR)).map(name => `${WEB_LOCALES_DIR}/${name}`)

    expect(onDisk.sort()).toEqual([...files.keys()].filter(path => path !== WEB_STRINGS_FILE).sort())
  })

  it('write one locale file per language, each holding every key at the value the catalogue has', () => {
    const keys = Object.keys(catalogue.entries)

    for (const locale of catalogue.locales) {
      const parsed = JSON.parse(files.get(`${WEB_LOCALES_DIR}/${locale}.json`)!) as Record<string, unknown>

      expect(Object.keys(parsed).length, locale).toBe(keys.length)

      for (const key of keys) {
        expect(parsed[key], `${key} [${locale}]`).toEqual(localeValue(catalogue.entries[key]!, locale))
      }
    }
  })

  it('write the keys in code-unit order, one entry per line', () => {
    const text = files.get(`${WEB_LOCALES_DIR}/en.json`)!
    const lines = text.split('\n')
    const keys = Object.keys(JSON.parse(text) as object)

    expect(lines[0]).toBe('{')
    expect(lines.at(-2)).toBe('}')
    expect(lines).toHaveLength(keys.length + 3)
    expect(keys).toEqual([...keys].sort())
    expect(keys).toHaveLength(Object.keys(catalogue.entries).length)
  })

  it('declare a type for every key', () => {
    const source = files.get(WEB_STRINGS_FILE)!

    expect(source).toContain('export interface Strings {')
    expect(source).toContain('export const strings: Strings = createStrings<Strings>()')

    // a numeric-looking segment is quoted, a keyed table has its index signature,
    // a template takes one object, and an optional parameter is optional
    expect(source).toMatch(/readonly '?"?1h"?'?: string/u)
    expect(source).toContain('readonly [key: string]: string | undefined')
    expect(source).toContain('readonly stepCounter: (args: { current: number; total: number }) => string')
    expect(source).toContain('(args: { handle: string; directory?: string }) => string')
  })
})

describe('the client template renderer', () => {
  it('renders every template of every language exactly as the reference does', () => {
    let templates = 0
    let comparisons = 0

    for (const [key, entry] of Object.entries(catalogue.entries)) {
      if (entry.kind !== 'template') {
        continue
      }

      templates += 1

      for (const locale of catalogue.locales) {
        for (const args of sampleArguments(entry.params)) {
          expect(renderTemplate(entry.values[locale], args, locale), `${key} [${locale}] ${JSON.stringify(args)}`).toBe(
            render(entry.values[locale], args, locale)
          )
          comparisons += 1
        }
      }
    }

    expect(templates).toBeGreaterThan(150)
    expect(comparisons).toBeGreaterThan(templates * catalogue.locales.length * 3)
  })
})

describe('the typed tree of a small catalogue', () => {
  const small: Catalogue = {
    format: 1,
    sourceLocale: 'en',
    locales: ['en', 'nl', 'de'],
    keyed: ['t.keyed'],
    entries: {
      't.keyed.a': { kind: 'text', values: { en: 'A', nl: 'A', de: 'A' } },
      't.plain': { kind: 'text', values: { en: 'a */ b\nc', nl: 'x', de: 'y' } },
      't.names': { kind: 'list', values: { en: ['a', 'b'], nl: ['a', 'b'], de: ['a', 'b'] } },
      't.optional': {
        kind: 'template',
        params: [{ name: 'dir', type: 'string', optional: true }],
        values: { en: 'in {dir}', nl: 'in {dir}', de: 'in {dir}' }
      },
      't.list': {
        kind: 'template',
        params: [{ name: 'items', type: 'string[]', optional: false }],
        values: {
          en: '{items|list(", ", " or ")}',
          nl: '{items|list(", ", " of ")}',
          de: '{items|list(", ", " oder ")}'
        }
      }
    }
  }

  it('types lists, optional-only arguments and lists of arguments, and keeps a doc comment on one line', () => {
    const source = generateWeb(small).get(WEB_STRINGS_FILE)!

    expect(source).toContain('readonly names: readonly string[]')
    expect(source).toContain('readonly optional: (args?: { dir?: string }) => string')
    expect(source).toContain('readonly list: (args: { items: readonly string[] }) => string')
    expect(source).toContain('/** a * / b c */')
    expect(source).toContain('readonly [key: string]: string | undefined')
  })

  it('refuses a keyed table that holds anything but plain strings', () => {
    expect(() => generateWeb({ ...small, keyed: ['t'], entries: { ...small.entries } })).toThrow(
      /keyed table holds plain strings only/u
    )
  })
})
