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
 * Hand-written, never touched: scripts/i18n/overrides.ts, and the second table
 * next to the catalog (Native.xcstrings) — which is read, and compiled into the
 * same `.lproj` directories as `Native.strings(dict)`.
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const check = process.argv.includes('--check')

const resources = join(repoRoot, 'native/apple/HermieKit/Sources/HermieUI/Resources')

const OUTPUTS = {
  catalogue: join(repoRoot, 'contract/i18n/catalogue.json'),
  xcstrings: join(resources, 'Localizable.xcstrings'),
  swift: join(repoRoot, 'native/apple/HermieKit/Sources/HermieUI/Generated/Strings.generated.swift'),
  samples: join(repoRoot, 'native/apple/HermieKit/Tests/HermieUITests/Generated/StringSamples.generated.swift')
}

/** The compiled `.lproj` files that are in the source tree now, as absolute paths. */
function compiledOnDisk(): string[] {
  return readdirSync(resources, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.lproj'))
    .flatMap(entry => readdirSync(join(resources, entry.name)).map(file => join(resources, entry.name, file)))
    .sort()
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
  const compiled = [
    ...compileXcstrings(JSON.parse(apple.xcstrings) as XcstringsFile, 'Localizable'),
    ...compileXcstrings(
      JSON.parse(readFileSync(join(resources, 'Native.xcstrings'), 'utf8')) as XcstringsFile,
      'Native'
    )
  ].map(([path, text]) => [join(resources, path), text] as const)

  for (const [path, text] of compiled) {
    files.set(path, text)
  }

  const perLocale = Object.entries(stats.perLocale)
    .map(([locale, counts]) => `${locale} ${counts.mechanical} probed + ${counts.override} by hand`)
    .join(', ')

  process.stdout.write(
    `i18n: ${stats.keys} keys per language (${stats.text} strings, ${stats.lists} lists, ${stats.functions} functions: ${perLocale}); ` +
      `${apple.catalogKeys} String Catalog keys in ${compiled.length} compiled files; ${apple.sampleCount} Swift samples.\n`
  )

  if (check) {
    const stale = [...files.keys()].filter(path => !existsSync(path) || readFileSync(path, 'utf8') !== files.get(path))
    const extra = compiledOnDisk().filter(path => !files.has(path))

    if (stale.length || extra.length) {
      process.stderr.write(
        `The native string export is out of date with the TypeScript catalogues:\n  ${[
          ...stale.map(path => `stale: ${relative(repoRoot, path)}`),
          ...extra.map(path => `extra: ${relative(repoRoot, path)}`)
        ].join('\n  ')}\nRun \`npm run i18n\` and commit the result.\n`
      )
      process.exit(1)
    }

    process.stdout.write('i18n: the native string export is current.\n')

    return
  }

  for (const path of compiledOnDisk()) {
    if (!files.has(path)) {
      rmSync(path)
    }
  }

  for (const [path, text] of files) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }

  process.stdout.write(
    'i18n: wrote the catalogue, the String Catalog and its compiled forms, the Swift accessors and their test fixture.\n'
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
