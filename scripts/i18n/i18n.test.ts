/**
 * The proof that `contract/i18n/catalogue.json` says what the Expo app says.
 *
 * The checked-in catalogue is read as a port would read it, and every entry is
 * compared with the TypeScript table it came from, in every language: plain
 * strings by value, string functions by rendering the template and calling the
 * function with the same arguments over a grid that crosses the plural
 * boundaries, empty strings and lists of every length. `npm run i18n:check`
 * makes sure the file is current; this makes sure it is right.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../../expo/hermie/src/i18n/active-locale'
import { LOCALES, type Locale } from '../../expo/hermie/src/i18n/locales'
import { ENGLISH_TREES } from '../../expo/hermie/src/i18n/trees'
import { convert, sampleArguments, type StringFunction } from './convert'
import type { Catalogue } from './export'
import { parseMessage, render, type ArgValue, type Param, type Template } from './template'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const catalogue = JSON.parse(readFileSync(join(repoRoot, 'contract/i18n/catalogue.json'), 'utf8')) as Catalogue

afterEach(() => {
  resetActiveLocale()
})

function englishLeaves(): string[] {
  const out: string[] = []

  const walk = (node: Record<string, unknown>, path: string): void => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, `${path}.${key}`)
      } else {
        out.push(`${path}.${key}`)
      }
    }
  }

  for (const [tree, table] of Object.entries(ENGLISH_TREES)) {
    walk(table as Record<string, unknown>, tree)
  }

  return out
}

/** What a screen reads at `key` in `locale`, through the app's own proxy. */
function appValue(key: string, locale: Locale): unknown {
  setActiveLocale(locale)

  const [tree, ...path] = key.split('.')
  let node: unknown = ENGLISH_TREES[tree as keyof typeof ENGLISH_TREES]

  for (const step of path) {
    node = (node as Record<string, unknown>)[step]
  }

  return node
}

function call(fn: unknown, params: readonly Param[], args: Record<string, ArgValue>): unknown {
  return (fn as (...values: ArgValue[]) => unknown)(...params.map(param => args[param.name]))
}

describe('contract/i18n/catalogue.json', () => {
  const keys = englishLeaves()

  it('has every key of the English tables, in all three languages, and nothing else', () => {
    expect(keys.length).toBeGreaterThan(1000)
    expect(Object.keys(catalogue.entries).sort()).toEqual([...keys].sort())
    expect(catalogue.locales).toEqual([...LOCALES])

    for (const key of keys) {
      const entry = catalogue.entries[key]!

      for (const locale of LOCALES) {
        expect(entry.values[locale], `${key} [${locale}]`).toBeDefined()
      }
    }
  })

  it('holds every plain string and list exactly as the app reads it in each language', () => {
    for (const key of keys) {
      const entry = catalogue.entries[key]!

      if (entry.kind === 'template') {
        continue
      }

      for (const locale of LOCALES) {
        expect(entry.values[locale], `${key} [${locale}]`).toEqual(appValue(key, locale))
      }
    }
  })

  it('renders every string function exactly as the TypeScript function does, over the whole argument grid', () => {
    let functions = 0
    let comparisons = 0

    for (const key of keys) {
      const entry = catalogue.entries[key]!

      if (entry.kind !== 'template') {
        continue
      }

      functions += 1

      for (const locale of LOCALES) {
        const fn = appValue(key, locale)

        expect(typeof fn, `${key} [${locale}]`).toBe('function')

        for (const args of sampleArguments(entry.params)) {
          const expected = call(fn, entry.params, args)

          expect(render(entry.values[locale], args, locale), `${key} [${locale}] ${JSON.stringify(args)}`).toBe(
            expected
          )
          comparisons += 1
        }
      }
    }

    expect(functions).toBeGreaterThan(150)
    expect(comparisons).toBeGreaterThan(functions * LOCALES.length * 3)
  })

  it('covers the plural boundaries for every count it was given', () => {
    const counts = new Set(
      sampleArguments([{ name: 'n', type: 'number', optional: false }]).map(args => args.n as number)
    )

    for (const boundary of [0, 1, 2]) {
      expect(counts.has(boundary)).toBe(true)
    }
  })
})

describe('the template language', () => {
  it('escapes braces and parses formatters with JSON arguments', () => {
    expect(parseMessage('{{a}} {b|list(", ", " or ")} {c|upper} {d|add(1)}')).toEqual([
      { text: '{a} ' },
      { param: 'b', format: { name: 'list', separator: ', ', last: ' or ' } },
      { text: ' ' },
      { param: 'c', format: { name: 'upper' } },
      { text: ' ' },
      { param: 'd', format: { name: 'add', amount: 1 } }
    ])
    expect(() => parseMessage('a } b')).toThrow()
    expect(() => parseMessage('{a|nope}')).toThrow()
  })

  it('picks zero only where a template has it, then the CLDR category', () => {
    const template: Template = { kind: 'plural', arg: 'n', forms: { zero: 'none', one: 'one', other: '{n} more' } }

    expect([0, 1, 2].map(n => render(template, { n }, 'nl'))).toEqual(['none', 'one', '2 more'])
    expect(render({ kind: 'plural', arg: 'n', forms: { one: 'one', other: '{n}' } }, { n: 0 }, 'de')).toBe('0')
  })
})

describe('the mechanical conversion', () => {
  const string = (name: string, optional = false): Param => ({ name, type: 'string', optional })
  const number = (name: string): Param => ({ name, type: 'number', optional: false })

  it('recovers placeholders, plurals, empty-string tests and list joins', () => {
    const fn = ((name: string, count: number, items: string[]) =>
      `${name || 'Nobody'} has ${count === 1 ? 'one item' : `${count} items`}: ${items.join('; ')}`) as StringFunction
    const result = convert(
      fn,
      [string('name'), number('count'), { name: 'items', type: 'string[]', optional: false }],
      'en'
    )

    expect(result).toEqual({
      ok: true,
      template: {
        kind: 'select',
        test: { op: 'empty', arg: 'name' },
        then: {
          kind: 'plural',
          arg: 'count',
          forms: {
            one: 'Nobody has one item: {items|list("; ", "; ")}',
            other: 'Nobody has {count} items: {items|list("; ", "; ")}'
          }
        },
        else: {
          kind: 'plural',
          arg: 'count',
          forms: {
            one: '{name} has one item: {items|list("; ", "; ")}',
            other: '{name} has {count} items: {items|list("; ", "; ")}'
          }
        }
      }
    })
  })

  it('refuses what it cannot see, rather than guessing', () => {
    const compares = ((done: number, total: number) =>
      done >= total ? 'All done' : `${done} of ${total}`) as StringFunction
    const result = convert(compares, [number('done'), number('total')], 'en')

    expect(result.ok).toBe(false)
  })

  it('keeps an optional argument optional', () => {
    const fn = ((dir?: string) => (dir ? `in ${dir}` : 'here')) as StringFunction
    const result = convert(fn, [string('dir', true)], 'en')

    expect(result).toEqual({
      ok: true,
      template: { kind: 'select', test: { op: 'empty', arg: 'dir' }, then: 'here', else: 'in {dir}' }
    })
  })
})
