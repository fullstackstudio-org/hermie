import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { catalogueRead, isRead, pathsReadIn, pathsReadUnder } from '../../native/web/scripts/catalogue-reads.mjs'

const IMPORT = "import { strings } from '../generated/strings'\n"
const read = (body: string, name = 'a.tsx'): string[] | null => pathsReadIn(name, IMPORT + body)

describe('pathsReadIn', () => {
  it('follows a read through every static property access after the import', () => {
    expect(read('const a = strings.app.common.cancel; const b = strings?.chat.tool["failed"]!')).toEqual([
      'app.common.cancel',
      'chat.tool.failed'
    ])
  })

  it('stops at a call, a computed key or an alias, which keep the subtree they reach', () => {
    expect(
      read(
        [
          'strings.app.onboarding.stepCounter({ current: 1, total: 2 })',
          'const label = strings.chat.approval.choices[id]',
          'const errors = strings.app.errors',
          'f((strings.cron.schedule as unknown) satisfies unknown)'
        ].join('\n')
      )
    ).toEqual(['app.errors', 'app.onboarding.stepCounter', 'chat.approval.choices', 'cron.schedule'])
  })

  it('reads JSX the same way', () => {
    expect(read('export const A = () => <p title={strings.app.app.name}>{strings.app.chat.pickBot}</p>')).toEqual([
      'app.app.name',
      'app.chat.pickBot'
    ])
  })

  it('follows an aliased import, and a namespace import into its `strings`', () => {
    expect(pathsReadIn('a.ts', "import { strings as s } from './generated/strings'\ns.app.common.retry")).toEqual([
      'app.common.retry'
    ])
    expect(pathsReadIn('a.ts', "import * as g from '../../generated/strings'\ng.strings.chat.replying")).toEqual([
      'chat.replying'
    ])
  })

  it('keeps everything when the tree itself is handed on, destructured, re-exported or imported dynamically', () => {
    expect(read('f(strings)')).toBeNull()
    expect(read('const o = { strings }')).toBeNull()
    expect(read('const { app } = strings')).toBeNull()
    expect(read('strings[key].x')).toBeNull()
    expect(read('export { strings }')).toBeNull()
    expect(pathsReadIn('a.ts', "export { strings } from './generated/strings'")).toBeNull()
    expect(pathsReadIn('a.ts', "void import('./generated/strings')")).toBeNull()
    expect(pathsReadIn('a.ts', 'void import(somewhere)')).toBeNull()
    expect(pathsReadIn('a.ts', "import * as g from './generated/strings'\nf(g)")).toBeNull()
  })

  it('counts nothing in a type position, nor a name that is not a read', () => {
    expect(
      read(
        [
          'type T = typeof strings.app',
          'const o = { strings: 1 }',
          'o.strings',
          "import type { Strings } from '../generated/strings'"
        ].join('\n')
      )
    ).toEqual([])
  })

  it('ignores a file that does not import the tree', () => {
    expect(pathsReadIn('a.ts', 'const strings = { a: 1 }\nf(strings)')).toEqual([])
  })
})

describe('isRead and catalogueRead', () => {
  const catalogue = {
    'app.common.cancel': 'Cancel',
    'app.common.retry': 'Retry',
    'app.errors.incompatible': 'Too old',
    'app.errors.offline': 'Offline',
    'cron.title': 'Cron'
  }

  it('keeps a key a path names, a key under a path, and a key a path runs past', () => {
    expect(isRead('app.common.cancel', ['app.common.cancel'])).toBe(true)
    expect(isRead('app.errors.offline', ['app.errors'])).toBe(true)
    expect(isRead('app.common.cancel', ['app.common.cancel.length'])).toBe(true)
    expect(isRead('app.common.cancelled', ['app.common.cancel'])).toBe(false)
  })

  it('cuts a locale file down to what is read, in its own order, or keeps it whole', () => {
    expect(Object.keys(catalogueRead(catalogue, ['app.errors', 'app.common.cancel']))).toEqual([
      'app.common.cancel',
      'app.errors.incompatible',
      'app.errors.offline'
    ])
    expect(catalogueRead(catalogue, null)).toEqual(catalogue)
  })
})

describe('the web client', () => {
  const src = join(import.meta.dirname, '../../native/web/src')
  const english = JSON.parse(readFileSync(join(src, 'generated/locales/en.json'), 'utf8')) as Record<string, unknown>

  it('reads the catalogue in a way the rule can follow, so the build bundles only part of it', () => {
    const paths = pathsReadUnder(src)

    expect(paths).not.toBeNull()
    expect(Object.keys(catalogueRead(english, paths)).length).toBeLessThan(Object.keys(english).length / 2)
  })

  it('reads no path that matches no key (a misspelt path would keep nothing)', () => {
    const keys = Object.keys(english)

    for (const path of pathsReadUnder(src) ?? []) {
      expect(
        keys.some(key => isRead(key, [path])),
        path
      ).toBe(true)
    }
  })
})
