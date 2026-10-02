/**
 * Exports the Expo app's string catalogues for the native apps, or checks that
 * the checked-in export is current.
 *
 *   npm run i18n          # write contract/i18n/catalogue.json, then the Apple catalog and accessors
 *   npm run i18n:check    # build everything in memory; fail if any checked-in file differs
 *
 * Owned by this script, replaced wholesale:
 *   contract/i18n/catalogue.json
 *   native/apple/HermieKit/Sources/HermieUI/Resources/Localizable.xcstrings
 *   native/apple/HermieKit/Sources/HermieUI/Resources/<lang>.lproj/*   (compile-xcstrings.ts)
 *   native/apple/HermieKit/Sources/HermieUI/Generated/Strings.generated.swift
 *   native/apple/HermieKit/Tests/HermieUITests/Generated/StringSamples.generated.swift
 *   native/web/src/generated/strings.ts and locales/<lang>.json   (web.ts)
 * Hand-written, never touched: scripts/i18n/overrides.ts, and the second table
 * next to the catalog (Native.xcstrings) — which is read, and compiled into the
 * same `.lproj` directories as `Native.strings(dict)`.
 *
 * Also hand-written, and compiled the same way next to themselves: the catalogs
 * of the widget and share extensions and of the App Intents
 * (native/apple/Extensions/<Widgets|Share|Intents>/Resources/<Table>.xcstrings →
 * <lang>.lproj/<Table>.strings(dict)). Each is its own binary's table, so they
 * cannot live in HermieUI's bundle; the keys are the English text, which is what
 * SwiftUI and App Intents look up in a bundle's `Localizable` table, and the
 * Shortcuts phrases are in `AppShortcuts`, the table the system reads them from.
 *
 * The `.xcstrings` files are what Xcode shows; the package ships the compiled
 * `.lproj` files instead (see compile-xcstrings.ts for why).
 *
 * The TypeScript catalogues stay the source of truth for as long as the Expo app
 * lives (docs/i18n.md, "Native apps").
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prettyJson } from '../golden/canonical-json'
import { generateApple } from './apple'
import { compileXcstrings, type XcstringsFile } from './compile-xcstrings'
import { buildCatalogue } from './export'
import { generateWeb, WEB_LOCALES_DIR } from './web'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const check = process.argv.includes('--check')

const resources = join(repoRoot, 'native/apple/HermieKit/Sources/HermieUI/Resources')

/** The extensions' and the App Intents' resource directories (see the header). */
const EXTENSION_RESOURCES = ['Widgets', 'Share', 'Intents'].map(name =>
  join(repoRoot, 'native/apple/Extensions', name, 'Resources')
)

/** The web client's generated files (`web.ts`), next to the code that reads them. */
const webGenerated = join(repoRoot, 'native/web/src/generated')

const OUTPUTS = {
  catalogue: join(repoRoot, 'contract/i18n/catalogue.json'),
  xcstrings: join(resources, 'Localizable.xcstrings'),
  swift: join(repoRoot, 'native/apple/HermieKit/Sources/HermieUI/Generated/Strings.generated.swift'),
  samples: join(repoRoot, 'native/apple/HermieKit/Tests/HermieUITests/Generated/StringSamples.generated.swift')
}

/** The compiled `.lproj` files that are in the source tree now, as absolute paths. */
function compiledOnDisk(): string[] {
  return [resources, ...EXTENSION_RESOURCES]
    .filter(directory => existsSync(directory))
    .flatMap(directory =>
      readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.endsWith('.lproj'))
        .flatMap(entry => readdirSync(join(directory, entry.name)).map(file => join(directory, entry.name, file)))
    )
    .sort()
}

/** The locale files of the web client that are in the source tree now, as absolute paths. */
function webLocalesOnDisk(): string[] {
  const directory = join(webGenerated, WEB_LOCALES_DIR)

  return existsSync(directory)
    ? readdirSync(directory)
        .map(name => join(directory, name))
        .sort()
    : []
}

/** Every catalog in the extensions' resource directories, compiled next to itself. */
function compileExtensionCatalogs(): (readonly [string, string])[] {
  return EXTENSION_RESOURCES.filter(directory => existsSync(directory)).flatMap(directory =>
    readdirSync(directory)
      .filter(name => name.endsWith('.xcstrings'))
      .sort()
      .flatMap(name =>
        [
          ...compileXcstrings(
            JSON.parse(readFileSync(join(directory, name), 'utf8')) as XcstringsFile,
            name.slice(0, -'.xcstrings'.length)
          )
        ].map(([path, text]) => [join(directory, path), text] as const)
      )
  )
}

function main(): void {
  const { catalogue, stats } = buildCatalogue()
  const apple = generateApple(catalogue)
  const files = new Map<string, string>([
    [OUTPUTS.catalogue, prettyJson(catalogue)],
    [OUTPUTS.xcstrings, apple.xcstrings],
    [OUTPUTS.swift, apple.swift],
    [OUTPUTS.samples, apple.samples]
  ])
  const web = generateWeb(catalogue)

  for (const [path, text] of web) {
    files.set(join(webGenerated, path), text)
  }

  const compiled = [
    ...compileXcstrings(JSON.parse(apple.xcstrings) as XcstringsFile, 'Localizable'),
    ...compileXcstrings(
      JSON.parse(readFileSync(join(resources, 'Native.xcstrings'), 'utf8')) as XcstringsFile,
      'Native'
    )
  ]
    .map(([path, text]) => [join(resources, path), text] as const)
    .concat(compileExtensionCatalogs())

  for (const [path, text] of compiled) {
    files.set(path, text)
  }

  const perLocale = Object.entries(stats.perLocale)
    .map(([locale, counts]) => `${locale} ${counts.mechanical} probed + ${counts.override} by hand`)
    .join(', ')

  process.stdout.write(
    `i18n: ${stats.keys} keys per language (${stats.text} strings, ${stats.lists} lists, ${stats.functions} functions: ${perLocale}); ` +
      `${apple.catalogKeys} String Catalog keys in ${compiled.length} compiled files; ${apple.sampleCount} Swift samples; ${web.size} web files.\n`
  )

  if (check) {
    const stale = [...files.keys()].filter(path => !existsSync(path) || readFileSync(path, 'utf8') !== files.get(path))
    const extra = [...compiledOnDisk(), ...webLocalesOnDisk()].filter(path => !files.has(path))

    if (stale.length || extra.length) {
      process.stderr.write(
        `The string export is out of date with the TypeScript catalogues:\n  ${[
          ...stale.map(path => `stale: ${relative(repoRoot, path)}`),
          ...extra.map(path => `extra: ${relative(repoRoot, path)}`)
        ].join('\n  ')}\nRun \`npm run i18n\` and commit the result.\n`
      )
      process.exit(1)
    }

    process.stdout.write('i18n: the native and web string exports are current.\n')

    return
  }

  for (const path of [...compiledOnDisk(), ...webLocalesOnDisk()]) {
    if (!files.has(path)) {
      rmSync(path)
    }
  }

  for (const [path, text] of files) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }

  process.stdout.write(
    'i18n: wrote the catalogue, the String Catalog and its compiled forms, the Swift accessors and their test fixture, and the web client strings.\n'
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
