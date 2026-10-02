/**
 * Exports the Expo app's string catalogues for the native apps, or checks that
 * the checked-in export is current.
 *
 *   npm run i18n          # write contract/i18n/catalogue.json, then the Apple catalog and accessors
 *   npm run i18n:check    # build all three in memory; fail if any checked-in file differs
 *
 * Owned by this script, replaced wholesale:
 *   contract/i18n/catalogue.json
 *   native/apple/HermieKit/Sources/HermieUI/Resources/Localizable.xcstrings
 *   native/apple/HermieKit/Sources/HermieUI/Generated/Strings.generated.swift
 *   native/apple/HermieKit/Tests/HermieUITests/Generated/StringSamples.generated.swift
 * Hand-written, never touched: scripts/i18n/overrides.ts, and the second table
 * next to the catalog (Native.xcstrings).
 *
 * The TypeScript catalogues stay the source of truth for as long as the Expo app
 * lives (docs/i18n.md, "Native apps").
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prettyJson } from '../golden/canonical-json'
import { generateApple } from './apple'
import { buildCatalogue } from './export'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const check = process.argv.includes('--check')

const OUTPUTS = {
  catalogue: join(repoRoot, 'contract/i18n/catalogue.json'),
  xcstrings: join(repoRoot, 'native/apple/HermieKit/Sources/HermieUI/Resources/Localizable.xcstrings'),
  swift: join(repoRoot, 'native/apple/HermieKit/Sources/HermieUI/Generated/Strings.generated.swift'),
  samples: join(repoRoot, 'native/apple/HermieKit/Tests/HermieUITests/Generated/StringSamples.generated.swift')
}

function main(): void {
  const { catalogue, stats } = buildCatalogue()
  const apple = generateApple(catalogue)
  const files: Record<keyof typeof OUTPUTS, string> = {
    catalogue: prettyJson(catalogue),
    xcstrings: apple.xcstrings,
    swift: apple.swift,
    samples: apple.samples
  }

  const perLocale = Object.entries(stats.perLocale)
    .map(([locale, counts]) => `${locale} ${counts.mechanical} probed + ${counts.override} by hand`)
    .join(', ')

  process.stdout.write(
    `i18n: ${stats.keys} keys per language (${stats.text} strings, ${stats.lists} lists, ${stats.functions} functions: ${perLocale}); ` +
      `${apple.catalogKeys} String Catalog keys; ${apple.sampleCount} Swift samples.\n`
  )

  if (check) {
    const stale = (Object.keys(OUTPUTS) as (keyof typeof OUTPUTS)[]).filter(
      name => !existsSync(OUTPUTS[name]) || readFileSync(OUTPUTS[name], 'utf8') !== files[name]
    )

    if (stale.length) {
      process.stderr.write(
        `The native string export is out of date with the TypeScript catalogues:\n  ${stale
          .map(name => relative(repoRoot, OUTPUTS[name]))
          .join('\n  ')}\nRun \`npm run i18n\` and commit the result.\n`
      )
      process.exit(1)
    }

    process.stdout.write('i18n: the native string export is current.\n')

    return
  }

  for (const name of Object.keys(OUTPUTS) as (keyof typeof OUTPUTS)[]) {
    mkdirSync(dirname(OUTPUTS[name]), { recursive: true })
    writeFileSync(OUTPUTS[name], files[name])
  }

  process.stdout.write('i18n: wrote the catalogue, the String Catalog, the Swift accessors and their test fixture.\n')
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
