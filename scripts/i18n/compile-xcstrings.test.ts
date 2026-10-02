/**
 * The compiled `.lproj` files HermieUI ships are what Xcode's own catalog
 * compiler would have made.
 *
 * Where `xcrun xcstringstool` exists (a Mac with Xcode, and the Native CI
 * workflow), both the generated `Localizable.xcstrings` and a catalog of every
 * shape the compiler accepts are compiled by both, and every file must be the
 * same byte for byte. Everywhere, the shapes it refuses are refused.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { compileXcstrings, type XcstringsFile } from './compile-xcstrings'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const resources = join(repoRoot, 'native/apple/HermieKit/Sources/HermieUI/Resources')

/** The extensions' and the App Intents' hand-written catalogs, as `[path, table]`. */
const extensionCatalogs = ['Widgets', 'Share', 'Intents'].flatMap(name => {
  const directory = join(repoRoot, 'native/apple/Extensions', name, 'Resources')

  return readdirSync(directory)
    .filter(file => file.endsWith('.xcstrings'))
    .map(file => [join(directory, file), file.slice(0, -'.xcstrings'.length)] as const)
})

const hasXcstringstool =
  process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'xcstringstool'], { encoding: 'utf8' }).status === 0

const unit = (value: string, state = 'translated') => ({ stringUnit: { state, value } })

/** Every shape `compileXcstrings` accepts, including the ones only a hand-kept table would use. */
const SHAPES: XcstringsFile = {
  sourceLanguage: 'en',
  version: '1.0',
  strings: {
    'native.plain': { localizations: { en: unit('A & <b> "q" 100%'), nl: unit('Een', 'needs_review') } },
    'native.unwritten': { localizations: { en: unit('Fresh', 'new') } },
    'native.sourceOnly': {},
    'native.count': {
      localizations: {
        en: { variations: { plural: { one: unit('One widget'), other: unit('%lld widgets') } } },
        de: { variations: { plural: { one: unit('Ein Widget'), other: unit('%lld Widgets') } } }
      }
    },
    'native.owner %@ %lld': {
      localizations: {
        en: { variations: { plural: { one: unit('%1$@ has one'), other: unit('%1$@ has %2$lld') } } }
      }
    },
    'native.substitution': {
      localizations: {
        nl: {
          ...unit('%#@bots@ voor %1$@ (50%%)'),
          substitutions: {
            bots: {
              argNum: 2,
              formatSpecifier: 'lld',
              variations: { plural: { zero: unit('geen'), one: unit('1 bot (%1$@)'), other: unit('%arg bots') } }
            }
          }
        }
      }
    }
  }
}

function filesUnder(dir: string): Map<string, string> {
  const out = new Map<string, string>()

  if (!existsSync(dir)) {
    return out
  }

  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)

      out.set(relative(dir, path), readFileSync(path, 'utf8'))
    }
  }

  return out
}

function xcodeCompiles(catalog: XcstringsFile | string, table: string): Map<string, string> {
  const scratch = mkdtempSync(join(tmpdir(), 'hermie-xcstrings-'))

  try {
    const source = typeof catalog === 'string' ? catalog : join(scratch, `${table}.xcstrings`)
    const out = join(scratch, 'out')

    if (typeof catalog !== 'string') {
      writeFileSync(source, JSON.stringify(catalog, null, 2))
    }

    const result = spawnSync('xcrun', ['xcstringstool', 'compile', source, '--output-directory', out], {
      encoding: 'utf8'
    })

    expect(result.status, result.stderr).toBe(0)

    return filesUnder(out)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe.skipIf(!hasXcstringstool)('compiled like xcstringstool', () => {
  it('compiles the generated Localizable.xcstrings to the same bytes', () => {
    const path = join(resources, 'Localizable.xcstrings')
    const ours = compileXcstrings(JSON.parse(readFileSync(path, 'utf8')) as XcstringsFile, 'Localizable')

    expect(new Map(ours)).toEqual(xcodeCompiles(path, 'Localizable'))
  })

  it("compiles the extensions' catalogs to the same bytes", () => {
    for (const [path, table] of extensionCatalogs) {
      const ours = compileXcstrings(JSON.parse(readFileSync(path, 'utf8')) as XcstringsFile, table)

      expect(new Map(ours), relative(repoRoot, path)).toEqual(xcodeCompiles(path, table))
    }
  })

  it('compiles every accepted shape to the same bytes', () => {
    const ours = compileXcstrings(SHAPES, 'Native')

    expect([...ours.keys()]).toEqual([
      'de.lproj/Native.stringsdict',
      'en.lproj/Native.strings',
      'en.lproj/Native.stringsdict',
      'nl.lproj/Native.strings',
      'nl.lproj/Native.stringsdict'
    ])
    expect(new Map(ours)).toEqual(xcodeCompiles(SHAPES, 'Native'))
  })

  it('compiles an empty catalog to nothing, as Xcode does', () => {
    const empty: XcstringsFile = { sourceLanguage: 'en', strings: {}, version: '1.0' }

    expect(compileXcstrings(empty, 'Native').size).toBe(0)
    expect(xcodeCompiles(empty, 'Native').size).toBe(0)
  })
})

describe('what the compiler refuses', () => {
  const catalog = (localization: object): XcstringsFile => ({
    sourceLanguage: 'en',
    version: '1.0',
    strings: { key: { localizations: { en: localization } } }
  })

  it('refuses device variations and an ambiguous top-level plural rather than guessing', () => {
    expect(() => compileXcstrings(catalog({ variations: { device: { iphone: unit('x') } } }), 'T')).toThrow()
    expect(() =>
      compileXcstrings(
        catalog({ variations: { plural: { one: unit('%lld of %lld'), other: unit('%1$lld of %2$lld') } } }),
        'T'
      )
    ).toThrow()
  })

  it('reads the checked-in Native table', () => {
    const native = JSON.parse(readFileSync(join(resources, 'Native.xcstrings'), 'utf8')) as XcstringsFile

    expect(() => compileXcstrings(native, 'Native')).not.toThrow()
  })

  it("reads the extensions' catalogs, in all three languages", () => {
    expect(extensionCatalogs.map(([, table]) => table).sort()).toEqual([
      'AppShortcuts',
      'Localizable',
      'Localizable',
      'Localizable'
    ])

    for (const [path, table] of extensionCatalogs) {
      const compiled = compileXcstrings(JSON.parse(readFileSync(path, 'utf8')) as XcstringsFile, table)

      for (const locale of ['en', 'nl', 'de']) {
        expect(
          [...compiled.keys()].some(file => file.startsWith(`${locale}.lproj/`)),
          `${path} ${locale}`
        ).toBe(true)
      }
    }
  })

  it('keeps the app name in every Shortcuts phrase, in every language', () => {
    for (const [path, table] of extensionCatalogs.filter(([, name]) => name === 'AppShortcuts')) {
      const catalog = JSON.parse(readFileSync(path, 'utf8')) as XcstringsFile

      for (const [key, entry] of Object.entries(catalog.strings)) {
        expect(key, `${table}: ${key}`).toContain('${applicationName}')

        for (const [locale, localization] of Object.entries(entry.localizations ?? {})) {
          expect(localization.stringUnit?.value, `${key} [${locale}]`).toContain('${applicationName}')
        }
      }
    }
  })
})
