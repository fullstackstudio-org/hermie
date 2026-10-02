/**
 * A String Catalog compiled the way Xcode's `xcstringstool compile` compiles it:
 * per language, `<lang>.lproj/<Table>.strings` for the plain entries and
 * `<lang>.lproj/<Table>.stringsdict` for the plural ones, both XML property
 * lists.
 *
 * Why this exists: SwiftPM only compiles an `.xcstrings` resource with its newer
 * build engine (the default from Swift 6.4). The native build system — the
 * default up to Swift 6.3, which CI's Xcode 26 runs — copies the catalog into
 * the bundle as an opaque file, so the bundle has no `.lproj` at all and every
 * lookup returns its key. Shipping the compiled forms ourselves makes the
 * bundle the same under every toolchain and in the Xcode app builds; the
 * catalogs stay in the source tree for Xcode's editor and are excluded from
 * the package's resources (`Package.swift`), so only one form is ever bundled.
 *
 * The subset compiled here is what the catalogs in this repository use, and
 * anything else is refused rather than guessed at:
 *
 *  - a `stringUnit` alone: a `.strings` entry;
 *  - a `stringUnit` with `substitutions` whose variations are `plural` (what
 *    `npm run i18n` writes): a `.stringsdict` entry, `%#@name@` made positional
 *    with the substitution's `argNum`, and `%arg` in the forms written as that
 *    argument's specifier;
 *  - top-level `variations.plural` (what Xcode writes for "Vary by plural" on a
 *    string with one count): a `.stringsdict` entry over a variable `value`,
 *    pointing at the one integer argument of the forms.
 *
 * Like Xcode, a unit in state `new` is left out (it has not been written yet),
 * and so is a key with no localization in a language.
 *
 * `i18n.test.ts` holds the output to `xcrun xcstringstool compile`, byte for
 * byte, wherever that tool exists.
 */

export interface StringUnit {
  state?: string
  value: string
}

interface PluralVariations {
  plural: Record<string, { stringUnit: StringUnit }>
}

export interface Localization {
  stringUnit?: StringUnit
  substitutions?: Record<string, { argNum: number; formatSpecifier: string; variations: PluralVariations }>
  variations?: PluralVariations
}

export interface XcstringsFile {
  sourceLanguage: string
  strings: Record<string, { localizations?: Record<string, Localization> } & Record<string, unknown>>
  version: string
}

type Plist = string | { [key: string]: Plist }

const usable = (unit: StringUnit | undefined): unit is StringUnit => unit !== undefined && unit.state !== 'new'

/** UTF-16 code unit order, which is how Xcode's property list writer orders keys. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function escapeXml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

function writeDict(dict: Record<string, Plist>, depth: number): string[] {
  const tabs = '\t'.repeat(depth)
  const lines = [`${'\t'.repeat(depth - 1)}<dict>`]

  for (const key of Object.keys(dict).sort(byCodeUnit)) {
    const value = dict[key]!

    lines.push(`${tabs}<key>${escapeXml(key)}</key>`)

    if (typeof value === 'string') {
      lines.push(`${tabs}<string>${escapeXml(value)}</string>`)
    } else {
      lines.push(...writeDict(value, depth + 1))
    }
  }

  lines.push(`${'\t'.repeat(depth - 1)}</dict>`)

  return lines
}

export function writePlist(dict: Record<string, Plist>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    ...writeDict(dict, 1),
    '</plist>',
    ''
  ].join('\n')
}

function pluralRule(
  valueType: string,
  forms: Record<string, { stringUnit: StringUnit }>,
  at: string,
  rewrite = (text: string) => text
): Record<string, Plist> {
  const rule: Record<string, Plist> = {
    NSStringFormatSpecTypeKey: 'NSStringPluralRuleType',
    NSStringFormatValueTypeKey: valueType
  }

  for (const [category, form] of Object.entries(forms)) {
    if (!form.stringUnit) {
      throw new Error(`${at}: the ${category} form has no stringUnit (nested variations are not supported)`)
    }

    rule[category] = rewrite(form.stringUnit.value)
  }

  if (!('other' in rule)) {
    throw new Error(`${at}: a plural needs an "other" form`)
  }

  return rule
}

/** Every printf specifier in a format string, with its position (explicit, or by order). */
function specifiers(format: string): { position: number; conversion: string }[] {
  const out: { position: number; conversion: string }[] = []
  const pattern = /%(?:(\d+)\$)?[-+ #0]*\d*(?:\.\d+)?(hh|h|ll|l|q|z|t|j|L)?([@dDiuUxXoOfeEgGcCsSpaA%])/gu
  let next = 1

  for (const match of format.matchAll(pattern)) {
    if (match[3] === '%') {
      continue
    }

    const position = match[1] ? Number(match[1]) : next

    next = position + 1
    out.push({ position, conversion: `${match[2] ?? ''}${match[3]}` })
  }

  return out
}

function compileEntry(
  key: string,
  locale: string,
  localization: Localization
): { strings?: string; plural?: Record<string, Plist> } | undefined {
  const at = `${key} [${locale}]`
  const { stringUnit, substitutions, variations, ...rest } = localization

  if (Object.keys(rest).length) {
    throw new Error(`${at}: unsupported localization fields ${Object.keys(rest).join(', ')}`)
  }

  if (variations) {
    if (stringUnit || substitutions || Object.keys(variations).some(kind => kind !== 'plural')) {
      throw new Error(`${at}: only plural variations, on their own, are supported`)
    }

    const forms = variations.plural
    const integers = new Map<number, string>()

    for (const form of Object.values(forms)) {
      for (const { position, conversion } of specifiers(form.stringUnit.value)) {
        if (/[diuDUoOxX]$/u.test(conversion)) {
          integers.set(position, conversion)
        }
      }
    }

    const counted = [...integers.entries()]

    if (counted.length !== 1) {
      throw new Error(`${at}: a top-level plural must have exactly one integer argument; use a substitution`)
    }

    const [[position, conversion]] = counted as [[number, string]]
    const arguments_ = new Set(
      Object.values(forms).flatMap(form => specifiers(form.stringUnit.value).map(s => s.position))
    )

    return {
      plural: {
        NSStringLocalizedFormatKey: arguments_.size > 1 || position > 1 ? `%${position}$#@value@` : '%#@value@',
        value: pluralRule(conversion, forms, at)
      }
    }
  }

  if (!usable(stringUnit)) {
    return undefined
  }

  if (!substitutions) {
    return { strings: stringUnit.value }
  }

  const plural: Record<string, Plist> = {
    NSStringLocalizedFormatKey: stringUnit.value.replace(/%#@([A-Za-z_][A-Za-z0-9_]*)@/gu, (whole, name: string) => {
      const substitution = substitutions[name]

      if (!substitution) {
        throw new Error(`${at}: ${whole} has no substitution`)
      }

      return `%${substitution.argNum}$#@${name}@`
    })
  }

  for (const [name, substitution] of Object.entries(substitutions)) {
    const kinds = Object.keys(substitution.variations)

    if (kinds.length !== 1 || kinds[0] !== 'plural') {
      throw new Error(`${at}: substitution ${name} varies by ${kinds.join(', ')}; only plural is supported`)
    }

    const specifier = `%${substitution.argNum}$${substitution.formatSpecifier}`

    plural[name] = pluralRule(substitution.formatSpecifier, substitution.variations.plural, `${at} ${name}`, text =>
      text.replace(/%arg/gu, specifier)
    )
  }

  return { plural }
}

/**
 * The compiled files of one catalog, as `<lang>.lproj/<table>.strings(dict)` →
 * contents. A language with nothing in one of the two gets no file for it.
 */
export function compileXcstrings(catalog: XcstringsFile, table: string): Map<string, string> {
  const strings = new Map<string, Record<string, Plist>>()
  const plurals = new Map<string, Record<string, Plist>>()

  for (const [key, entry] of Object.entries(catalog.strings)) {
    for (const [locale, localization] of Object.entries(entry.localizations ?? {})) {
      const compiled = compileEntry(key, locale, localization)

      if (compiled?.strings !== undefined) {
        const dict = strings.get(locale) ?? {}

        dict[key] = compiled.strings
        strings.set(locale, dict)
      }

      if (compiled?.plural) {
        const dict = plurals.get(locale) ?? {}

        dict[key] = compiled.plural
        plurals.set(locale, dict)
      }
    }
  }

  const files = new Map<string, string>()

  for (const [locale, dict] of strings) {
    files.set(`${locale}.lproj/${table}.strings`, writePlist(dict))
  }

  for (const [locale, dict] of plurals) {
    files.set(`${locale}.lproj/${table}.stringsdict`, writePlist(dict))
  }

  return new Map([...files.entries()].sort(([a], [b]) => byCodeUnit(a, b)))
}
