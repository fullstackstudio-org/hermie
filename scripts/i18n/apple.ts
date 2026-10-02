/**
 * `contract/i18n/catalogue.json` → the Apple apps' String Catalog and the
 * typed Swift API over it.
 *
 *   Localizable.xcstrings           every key, in en (the source), nl and de
 *   Strings.generated.swift         `Strings.App.Onboarding.stepCounter(current:total:)`
 *   StringSamples.generated.swift   the test fixture: every key through those accessors,
 *                                   next to what `render` says it should read
 *
 * How a template becomes catalog entries:
 *
 *  - A `select` is not something a String Catalog can say, so it is lifted
 *    into the Swift function: one catalog key per outcome
 *    (`app.layout.removeFolder#name-empty`, `…#name-nonempty`) and an `if` that
 *    picks between them. Tests that no language's text depends on are dropped.
 *  - A `plural` becomes a substitution with plural variations
 *    (`%#@count@`), which is what Xcode writes for "Vary by plural".
 *  - Every placeholder becomes a format argument: `%@` for text, `%lld` for a
 *    number, positional (`%2$@`) when an entry has more than one, so a
 *    language may use them in any order. A formatter (`upper`, `add`, `list`)
 *    is applied in Swift before the value is passed, so the catalog only ever
 *    sees finished values. A list's separators are words ("a, b or c"), so
 *    they are catalog keys of their own (`…#providers.separator`, `….last`).
 *
 * Plain strings are looked up without arguments and so are never treated as
 * format strings: "100%" is written as is. Entries with arguments escape a
 * literal `%` as `%%`.
 */
import { LOCALES, SOURCE_LOCALE, type Locale } from '../../expo/hermie/src/i18n/locales'
import type { Catalogue, Entry } from './export'
import {
  parseMessage,
  placeholderText,
  PLURAL_CATEGORIES,
  formatterText,
  messagesOf,
  type Formatter,
  type Param,
  type PluralCategory,
  render,
  type ArgValue,
  type Template,
  type Test
} from './template'

const TABLE = 'Localizable'

// ---------------------------------------------------------------------------
// Templates → catalog leaves
// ---------------------------------------------------------------------------

/** A template with every select resolved: a message, or a plural over messages. */
type Leaf = string | { kind: 'plural'; arg: string; forms: Partial<Record<PluralCategory, string>> }

const testId = (test: Test): string =>
  JSON.stringify(test.op === 'empty' ? [test.op, test.arg] : [test.op, test.left, test.right])

function testsIn(template: Template, out: Map<string, Test>): void {
  if (typeof template === 'string') {
    return
  }

  if (template.kind === 'select') {
    out.set(testId(template.test), template.test)
    testsIn(template.then, out)
    testsIn(template.else, out)

    return
  }

  for (const form of Object.values(template.forms)) {
    testsIn(form, out)
  }
}

function resolveLeaf(template: Template, outcomes: ReadonlyMap<string, boolean>, at: string): Leaf {
  if (typeof template === 'string') {
    return template
  }

  if (template.kind === 'select') {
    return resolveLeaf(outcomes.get(testId(template.test)) ? template.then : template.else, outcomes, at)
  }

  const forms: Partial<Record<PluralCategory, string>> = {}

  for (const category of PLURAL_CATEGORIES) {
    const form = template.forms[category]

    if (form === undefined) {
      continue
    }

    const resolved = resolveLeaf(form, outcomes, at)

    if (typeof resolved !== 'string') {
      throw new Error(`${at}: a plural inside a plural has no String Catalog form`)
    }

    forms[category] = resolved
  }

  return { kind: 'plural', arg: template.arg, forms }
}

function testLabel(test: Test, holds: boolean): string {
  if (test.op === 'empty') {
    return `${test.arg}-${holds ? 'empty' : 'nonempty'}`
  }

  return `${test.left}-${holds ? 'gte' : 'lt'}-${test.right}`
}

interface Branch {
  /** The outcome of every kept test, in `tests` order. */
  outcomes: boolean[]
  key: string
  leaves: Record<Locale, Leaf>
}

interface Plan {
  tests: Test[]
  branches: Branch[]
}

/** Which tests matter, and the leaf each language says under every combination of them. */
function plan(key: string, values: Record<Locale, Template>): Plan {
  const found = new Map<string, Test>()

  for (const locale of LOCALES) {
    testsIn(values[locale], found)
  }

  let tests = [...found.values()]

  const leavesFor = (kept: readonly Test[], outcomes: readonly boolean[]): Record<Locale, Leaf> => {
    const map = new Map(kept.map((test, index) => [testId(test), outcomes[index] ?? false]))

    return Object.fromEntries(LOCALES.map(locale => [locale, resolveLeaf(values[locale], map, key)])) as Record<
      Locale,
      Leaf
    >
  }

  // All-true first, counting down like a binary number: the first half of the
  // list is where the first test holds, which is the `if` arm in Swift.
  const combinations = (count: number): boolean[][] =>
    Array.from({ length: 2 ** count }, (_, n) =>
      Array.from({ length: count }, (_, bit) => ((n >> (count - 1 - bit)) & 1) === 0)
    )

  // Drop a test when no language's text depends on it. Since every test is
  // evaluated for every combination, "does not depend" means: flipping it
  // leaves every leaf the same under every setting of the others.
  for (let changed = true; changed;) {
    changed = false

    for (let index = 0; index < tests.length; index += 1) {
      const irrelevant = combinations(tests.length).every(outcomes => {
        const flipped = [...outcomes]

        flipped[index] = !flipped[index]

        return JSON.stringify(leavesFor(tests, outcomes)) === JSON.stringify(leavesFor(tests, flipped))
      })

      if (irrelevant) {
        tests = tests.filter((_, at) => at !== index)
        changed = true
        break
      }
    }
  }

  return {
    tests,
    branches: combinations(tests.length).map(outcomes => ({
      outcomes,
      key: tests.length ? `${key}#${tests.map((test, index) => testLabel(test, outcomes[index]!)).join('+')}` : key,
      leaves: leavesFor(tests, outcomes)
    }))
  }
}

// ---------------------------------------------------------------------------
// Format arguments
// ---------------------------------------------------------------------------

/**
 * How a placeholder is told apart from another. A list placeholder drops its
 * separators: those differ per language ("a, b or c", "a, b of c") and are
 * looked up from the catalog in Swift, so all three languages share one
 * argument, the joined list.
 */
function refId(param: string, format?: Formatter): string {
  return format?.name === 'list' ? `{${param}|list}` : placeholderText(param, format)
}

/** One value handed to the format string: a parameter, possibly through a formatter. */
interface Ref {
  id: string
  param: Param
  paramIndex: number
  format?: Formatter
}

function refsOf(leaf: Leaf, params: readonly Param[], at: string): Ref[] {
  const out: Ref[] = []

  const add = (name: string, format?: Formatter): void => {
    const paramIndex = params.findIndex(param => param.name === name)
    const param = params[paramIndex]

    if (!param) {
      throw new Error(`${at}: unknown parameter ${name}`)
    }

    out.push({ id: refId(name, format), param, paramIndex, format })
  }

  const visit = (message: string): void => {
    for (const segment of parseMessage(message)) {
      if ('param' in segment) {
        add(segment.param, segment.format)
      }
    }
  }

  if (typeof leaf === 'string') {
    visit(leaf)
  } else {
    add(leaf.arg)
    Object.values(leaf.forms).forEach(visit)
  }

  return out
}

/** The arguments a catalog key is formatted with: every ref any language uses, in parameter order. */
function argumentsFor(branch: Branch, params: readonly Param[], at: string): Ref[] {
  const unique = new Map<string, Ref>()

  for (const locale of LOCALES) {
    for (const ref of refsOf(branch.leaves[locale], params, at)) {
      unique.set(ref.id, ref)
    }
  }

  return [...unique.values()].sort((a, b) => a.paramIndex - b.paramIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function isNumberRef(ref: Ref, at: string): boolean {
  const { param, format } = ref

  if (!format) {
    if (param.type === 'string[]') {
      throw new Error(`${at}: ${param.name} is a list and needs a list() formatter`)
    }

    return param.type === 'number'
  }

  const fits =
    (format.name === 'add' && param.type === 'number') ||
    (format.name === 'upper' && param.type === 'string') ||
    (format.name === 'list' && param.type === 'string[]')

  if (!fits) {
    throw new Error(`${at}: ${formatterText(format)} does not apply to ${param.name} (${param.type})`)
  }

  return format.name === 'add'
}

function specifier(refs: readonly Ref[], ref: Ref, at: string): string {
  const type = isNumberRef(ref, at) ? 'lld' : '@'

  return refs.length === 1 ? `%${type}` : `%${refs.indexOf(ref) + 1}$${type}`
}

/** One message as a format string. `pluralArg` is written `%arg`, as a substitution's own value. */
function formatString(message: string, refs: readonly Ref[], at: string, pluralArg?: string): string {
  if (!refs.length) {
    return parseMessage(message)
      .map(segment => ('text' in segment ? segment.text : ''))
      .join('')
  }

  return parseMessage(message)
    .map(segment => {
      if ('text' in segment) {
        return segment.text.replace(/%/gu, '%%')
      }

      if (segment.param === pluralArg && !segment.format) {
        return '%arg'
      }

      const ref = refs.find(candidate => candidate.id === refId(segment.param, segment.format))

      return specifier(refs, ref!, at)
    })
    .join('')
}

// ---------------------------------------------------------------------------
// The String Catalog
// ---------------------------------------------------------------------------

type Json = string | number | boolean | Json[] | { [key: string]: Json }

const unit = (value: string): Json => ({ stringUnit: { state: 'translated', value } })

function localization(leaf: Leaf, refs: readonly Ref[], at: string): Json {
  if (typeof leaf === 'string') {
    return unit(formatString(leaf, refs, at))
  }

  const ref = refs.find(candidate => candidate.id === refId(leaf.arg))!
  const plural: Record<string, Json> = {}

  for (const [category, form] of Object.entries(leaf.forms)) {
    plural[category] = unit(formatString(form, refs, at, leaf.arg))
  }

  return {
    ...(unit(`%#@${leaf.arg}@`) as Record<string, Json>),
    substitutions: {
      [leaf.arg]: {
        argNum: refs.indexOf(ref) + 1,
        formatSpecifier: 'lld',
        variations: { plural }
      }
    }
  }
}

function catalogEntry(localizations: Record<Locale, Json>): Json {
  return { extractionState: 'manual', localizations }
}

/** Xcode's own layout: two-space indent, `"key" : value`, keys sorted. */
function writeXcstringsJson(value: Json, indent = ''): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  const inner = `${indent}  `

  if (Array.isArray(value)) {
    return value.length
      ? `[\n${value.map(item => `${inner}${writeXcstringsJson(item, inner)}`).join(',\n')}\n${indent}]`
      : '[\n\n]'
  }

  const keys = Object.keys(value).sort()

  return keys.length
    ? `{\n${keys.map(key => `${inner}${JSON.stringify(key)} : ${writeXcstringsJson(value[key]!, inner)}`).join(',\n')}\n${indent}}`
    : '{\n\n}'
}

export function emptyCatalog(): string {
  return `${writeXcstringsJson({ sourceLanguage: SOURCE_LOCALE, strings: {}, version: '1.0' })}\n`
}

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

const SWIFT_KEYWORDS = new Set(
  (
    'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator ' +
    'private precedencegroup protocol public rethrows static struct subscript typealias var break case catch ' +
    'continue default defer do else fallthrough for guard if in repeat return throw switch where while Any as ' +
    'await false is nil self Self super throws true try'
  ).split(' ')
)

/** Type names a nested type may not take, or must not take without breaking the file. */
const RESERVED_TYPE_NAMES = new Set(['Type', 'Self', 'Protocol', 'Any', 'Swift', 'Foundation', 'HermieStringsLookup'])

function words(segment: string): string[] {
  return segment.split(/[^A-Za-z0-9_]+/u).filter(Boolean)
}

function memberName(segment: string): string {
  const [first = '_', ...rest] = words(segment)
  let name = first + rest.map(word => word[0]!.toUpperCase() + word.slice(1)).join('')

  if (/^[0-9]/u.test(name)) {
    name = `_${name}`
  }

  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name
}

function typeName(segment: string): string {
  const bare = memberName(segment).replace(/`/gu, '')
  const name = bare[0]!.toUpperCase() + bare.slice(1)

  return RESERVED_TYPE_NAMES.has(name) ? `${name}_` : name
}

function swiftString(text: string): string {
  let out = ''

  for (const char of text) {
    const code = char.codePointAt(0)!

    if (char === '\\') out += '\\\\'
    else if (char === '"') out += '\\"'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`
    else out += char
  }

  return `"${out}"`
}

function swiftType(param: Param): string {
  switch (param.type) {
    case 'string':
      return param.optional ? 'Swift.String?' : 'Swift.String'
    case 'number':
      return 'Swift.Int'
    case 'string[]':
      return '[Swift.String]'
  }
}

/** The catalog keys a list's separators live under. */
const separatorKeys = (key: string, param: string): { separator: string; last: string } => ({
  separator: `${key}#${param}.separator`,
  last: `${key}#${param}.last`
})

/**
 * The separators every language joins `param` with in `values`, looked for
 * anywhere in its template. A language that never lists it borrows English's.
 */
function listSeparators(
  key: string,
  values: Record<Locale, Template>,
  param: string
): Record<Locale, { separator: string; last: string }> {
  const found = {} as Record<Locale, { separator: string; last: string }>

  for (const locale of LOCALES) {
    const formats = new Set<string>()

    for (const message of messagesOf(values[locale])) {
      for (const segment of parseMessage(message)) {
        if ('param' in segment && segment.param === param && segment.format?.name === 'list') {
          formats.add(JSON.stringify([segment.format.separator, segment.format.last]))
        }
      }
    }

    if (formats.size > 1) {
      throw new Error(`${key} [${locale}]: ${param} is listed with two different separators`)
    }

    const [only] = [...formats]

    if (only) {
      const [separator, last] = JSON.parse(only) as [string, string]

      found[locale] = { separator, last }
    }
  }

  const fallback = found[SOURCE_LOCALE]

  for (const locale of LOCALES) {
    if (!found[locale]) {
      if (!fallback) {
        throw new Error(`${key}: ${param} is listed in another language but not in English`)
      }

      found[locale] = fallback
    }
  }

  return found
}

function refExpression(ref: Ref, key: string): string {
  const name = memberName(ref.param.name)

  if (!ref.format) {
    return ref.param.type === 'string' && ref.param.optional ? `${name} ?? ""` : name
  }

  switch (ref.format.name) {
    case 'upper':
      return ref.param.optional ? `(${name} ?? "").uppercased()` : `${name}.uppercased()`
    case 'add':
      return `${name} + ${ref.format.amount}`
    case 'list': {
      const keys = separatorKeys(key, ref.param.name)

      return `hermieJoinList(${name}, ${lookup(keys.separator)}, ${lookup(keys.last)})`
    }
  }
}

function testExpression(test: Test, params: readonly Param[]): string {
  if (test.op === 'empty') {
    const param = params.find(candidate => candidate.name === test.arg)!

    return param.optional ? `(${memberName(param.name)} ?? "").isEmpty` : `${memberName(param.name)}.isEmpty`
  }

  return `${memberName(test.left)} >= ${memberName(test.right)}`
}

const lookup = (key: string): string =>
  `Swift.String(localized: ${swiftString(key)}, table: "${TABLE}", bundle: HermieStringsLookup.bundle)`

/**
 * `defaultValue` for a lookup with arguments. Its interpolations ARE the
 * arguments, in order, so it can only read as the English sentence when that
 * sentence uses each of them once and in parameter order; otherwise it is just
 * the arguments.
 */
function defaultValue(leaf: Leaf, refs: readonly Ref[], key: string): string {
  const english = typeof leaf === 'string' ? leaf : leaf.forms.other
  const segments = english === undefined ? [] : parseMessage(english)
  const used = segments.flatMap(segment => ('param' in segment ? [refId(segment.param, segment.format)] : []))

  if (english !== undefined && used.length === refs.length && used.every((id, index) => refs[index]?.id === id)) {
    let next = 0

    return `"${segments
      .map(segment =>
        'text' in segment ? swiftString(segment.text).slice(1, -1) : `\\(${refExpression(refs[next++]!, key)})`
      )
      .join('')}"`
  }

  return `"${refs.map(ref => `\\(${refExpression(ref, key)})`).join(' ')}"`
}

/** `entryKey` is the TypeScript key, which list separators hang off; `key` is this branch's catalog key. */
const lookupWith = (key: string, leaf: Leaf, refs: readonly Ref[], entryKey: string): string =>
  refs.length
    ? `Swift.String(localized: ${swiftString(key)}, defaultValue: ${defaultValue(leaf, refs, entryKey)}, table: "${TABLE}", bundle: HermieStringsLookup.bundle)`
    : lookup(key)

interface Node {
  segment: string
  children: Map<string, Node>
  key?: string
  entry?: Entry
}

/** The output of one `generate` run. */
export interface AppleOutput {
  xcstrings: string
  swift: string
  /** The test fixture: every key through the generated accessors, with what the template renders. */
  samples: string
  catalogKeys: number
  sampleCount: number
}

export function generateApple(catalogue: Catalogue): AppleOutput {
  const strings: Record<string, Json> = {}
  const root: Node = { segment: '', children: new Map() }
  const functionBodies = new Map<string, { signature: string; body: string[] }>()

  for (const key of Object.keys(catalogue.entries).sort()) {
    const entry = catalogue.entries[key]!
    let node = root

    for (const segment of key.split('.')) {
      let child = node.children.get(segment)

      if (!child) {
        child = { segment, children: new Map() }
        node.children.set(segment, child)
      }

      node = child
    }

    node.key = key
    node.entry = entry

    if (entry.kind === 'text') {
      strings[key] = catalogEntry(
        Object.fromEntries(LOCALES.map(locale => [locale, unit(entry.values[locale])])) as Record<Locale, Json>
      )
      continue
    }

    if (entry.kind === 'list') {
      const length = entry.values[SOURCE_LOCALE].length

      if (LOCALES.some(locale => entry.values[locale].length !== length)) {
        throw new Error(`${key}: every language must have as many items as English`)
      }

      for (let index = 0; index < length; index += 1) {
        strings[`${key}[${index}]`] = catalogEntry(
          Object.fromEntries(LOCALES.map(locale => [locale, unit(entry.values[locale][index]!)])) as Record<
            Locale,
            Json
          >
        )
      }

      continue
    }

    const { tests, branches } = plan(key, entry.values)
    const lookups = branches.map(branch => {
      const refs = argumentsFor(branch, entry.params, branch.key)

      strings[branch.key] = catalogEntry(
        Object.fromEntries(
          LOCALES.map(locale => [locale, localization(branch.leaves[locale], refs, `${branch.key} [${locale}]`)])
        ) as Record<Locale, Json>
      )

      return lookupWith(branch.key, branch.leaves[SOURCE_LOCALE], refs, key)
    })

    for (const param of entry.params.filter(candidate => candidate.type === 'string[]')) {
      const separators = listSeparators(key, entry.values, param.name)
      const keys = separatorKeys(key, param.name)

      strings[keys.separator] = catalogEntry(
        Object.fromEntries(LOCALES.map(locale => [locale, unit(separators[locale].separator)])) as Record<Locale, Json>
      )
      strings[keys.last] = catalogEntry(
        Object.fromEntries(LOCALES.map(locale => [locale, unit(separators[locale].last)])) as Record<Locale, Json>
      )
    }

    const body: string[] = []

    const emit = (depth: number, from: number, to: number, indent: string): void => {
      if (depth === tests.length) {
        body.push(`${indent}${lookups[from]}`)
        return
      }

      const middle = (from + to) / 2

      body.push(`${indent}if ${testExpression(tests[depth]!, entry.params)} {`)
      emit(depth + 1, from, middle, `${indent}  `)
      body.push(`${indent}} else {`)
      emit(depth + 1, middle, to, `${indent}  `)
      body.push(`${indent}}`)
    }

    emit(0, 0, branches.length, '')

    const parameters = entry.params
      .map(param => `${memberName(param.name)}: ${swiftType(param)}${param.optional ? ' = nil' : ''}`)
      .join(', ')

    functionBodies.set(key, { signature: parameters, body })
  }

  const keyed = new Set(catalogue.keyed)
  const lines: string[] = []

  const writeNode = (node: Node, indent: string, path: string): void => {
    const names = new Map<string, string>()
    const claim = (name: string, what: string): void => {
      const bare = name.replace(/`/gu, '')
      const previous = names.get(bare)

      if (previous) {
        throw new Error(`${path}: ${what} and ${previous} both become ${bare} in Swift`)
      }

      names.set(bare, what)
    }

    const children = [...node.children.values()].sort((a, b) =>
      a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0
    )

    for (const child of children) {
      const childPath = path ? `${path}.${child.segment}` : child.segment

      if (!child.entry) {
        const name = typeName(child.segment)

        claim(name, childPath)
        lines.push(`${indent}public enum ${name} {`)
        writeNode(child, `${indent}  `, childPath)
        lines.push(`${indent}}`)
        continue
      }

      const name = memberName(child.segment)
      const entry = child.entry
      const key = child.key!

      claim(name, childPath)

      if (entry.kind === 'text') {
        lines.push(`${indent}/// ${swiftDoc(entry.values[SOURCE_LOCALE])}`)
        lines.push(`${indent}public static var ${name}: Swift.String { ${lookup(key)} }`)
      } else if (entry.kind === 'list') {
        lines.push(`${indent}public static var ${name}: [Swift.String] {`)
        lines.push(`${indent}  [`)
        entry.values[SOURCE_LOCALE].forEach((_, index) => {
          lines.push(`${indent}    ${lookup(`${key}[${index}]`)},`)
        })
        lines.push(`${indent}  ]`)
        lines.push(`${indent}}`)
      } else {
        const { signature, body } = functionBodies.get(key)!

        lines.push(`${indent}/// ${swiftDoc(templateSummary(entry.values[SOURCE_LOCALE]))}`)
        lines.push(`${indent}public static func ${name}(${signature}) -> Swift.String {`)
        body.forEach(line => lines.push(`${indent}  ${line}`))
        lines.push(`${indent}}`)
      }
    }

    if (keyed.has(path)) {
      const texts = children.filter(child => child.entry?.kind === 'text')

      lines.push(`${indent}/// The entry for a key that arrives at run time, or nil for one this table does not have.`)
      lines.push(`${indent}public static subscript(key: Swift.String) -> Swift.String? {`)
      lines.push(`${indent}  switch key {`)
      texts.forEach(child => lines.push(`${indent}  case ${swiftString(child.segment)}: ${memberName(child.segment)}`))
      lines.push(`${indent}  default: nil`)
      lines.push(`${indent}  }`)
      lines.push(`${indent}}`)
    }
  }

  writeNode(root, '  ', '')

  const swift = [
    '// Written by `npm run i18n` from contract/i18n/catalogue.json. Do not edit: change the',
    '// TypeScript catalogues in expo/hermie/src/i18n and run it again. See docs/i18n.md.',
    '',
    'import Foundation',
    '',
    '/// Every string the Expo app has, as typed accessors over `Localizable.xcstrings`.',
    '///',
    '/// The hierarchy mirrors the TypeScript keys: `strings.onboarding.stepCounter(1, 3)` in the',
    '/// `app` table is `Strings.App.Onboarding.stepCounter(current: 1, total: 3)` here. Each read',
    '/// resolves when it is made, in the language the system picked for the app.',
    'public enum Strings {',
    ...lines,
    '}',
    '',
    '/// Where the accessors look their text up. A test reads another language by binding a',
    "/// localization's own bundle (`nl.lproj`) for the duration of a call.",
    'enum HermieStringsLookup {',
    '  @TaskLocal static var bundle: Foundation.Bundle = .module',
    '}',
    '',
    '/// `list(separator, last)` from the template language: "a, b or c".',
    'private func hermieJoinList(_ items: [Swift.String], _ separator: Swift.String, _ last: Swift.String) -> Swift.String {',
    '  guard items.count > 1, let final = items.last else { return items.first ?? "" }',
    '  return items.dropLast().joined(separator: separator) + last + final',
    '}',
    ''
  ].join('\n')

  const xcstrings = `${writeXcstringsJson({ sourceLanguage: SOURCE_LOCALE, strings, version: '1.0' })}\n`
  const { samples, sampleCount } = generateSamples(catalogue)

  return { xcstrings, swift, samples, catalogKeys: Object.keys(strings).length, sampleCount }
}

// ---------------------------------------------------------------------------
// The Swift test fixture
// ---------------------------------------------------------------------------

/**
 * The arguments each function is called with in the Swift fixture: the plural
 * boundaries, an empty string, and a value carrying `%` and braces so a
 * placeholder that leaked into a format string shows. Smaller than the grid
 * the TypeScript side is verified over (`SAMPLE_VALUES` in convert.ts), since
 * every combination becomes a line of Swift.
 */
const SWIFT_SAMPLE_VALUES: Readonly<Record<Param['type'], readonly ArgValue[]>> = {
  number: [0, 1, 2, 5, 21],
  string: ['Ada', '', 'x {y} 100% %@'],
  'string[]': [[], ['a'], ['a', 'b', 'c']]
}

function* sampleGrid(
  params: readonly Param[],
  at = 0,
  args: Record<string, ArgValue> = {}
): Generator<Record<string, ArgValue>> {
  const param = params[at]

  if (!param) {
    yield args
    return
  }

  const values = param.optional ? [...SWIFT_SAMPLE_VALUES[param.type], undefined] : SWIFT_SAMPLE_VALUES[param.type]

  for (const value of values) {
    yield* sampleGrid(params, at + 1, { ...args, [param.name]: value })
  }
}

function swiftLiteral(value: ArgValue): string {
  if (value === undefined) {
    return 'nil'
  }

  if (typeof value === 'number') {
    return String(value)
  }

  if (typeof value === 'string') {
    return swiftString(value)
  }

  return `[${value.map(swiftString).join(', ')}]`
}

function accessor(key: string): string {
  const segments = key.split('.')
  const leaf = segments.pop()!

  return ['Strings', ...segments.map(typeName), memberName(leaf)].join('.')
}

function generateSamples(catalogue: Catalogue): { samples: string; sampleCount: number } {
  const byTree = new Map<string, string[]>()
  let sampleCount = 0

  const add = (key: string, call: string, expected: Record<Locale, string>): void => {
    const tree = key.split('.')[0]!
    const lines = byTree.get(tree) ?? []

    lines.push(
      `    StringSample(${swiftString(call)}, { ${call} }, en: ${swiftString(expected.en)}, nl: ${swiftString(expected.nl)}, de: ${swiftString(expected.de)}),`
    )
    byTree.set(tree, lines)
    sampleCount += 1
  }

  for (const key of Object.keys(catalogue.entries).sort()) {
    const entry = catalogue.entries[key]!
    const call = accessor(key)

    if (entry.kind === 'text') {
      add(key, call, entry.values)
    } else if (entry.kind === 'list') {
      entry.values[SOURCE_LOCALE].forEach((_, index) =>
        add(
          key,
          `${call}[${index}]`,
          Object.fromEntries(LOCALES.map(locale => [locale, entry.values[locale][index]!])) as Record<Locale, string>
        )
      )
    } else {
      for (const args of sampleGrid(entry.params)) {
        const list = entry.params.map(
          param => `${memberName(param.name).replace(/`/gu, '')}: ${swiftLiteral(args[param.name])}`
        )

        add(
          key,
          `${call}(${list.join(', ')})`,
          Object.fromEntries(LOCALES.map(locale => [locale, render(entry.values[locale], args, locale)])) as Record<
            Locale,
            string
          >
        )
      }
    }
  }

  const trees = [...byTree.keys()].sort()
  const samples = [
    '// Written by `npm run i18n` from contract/i18n/catalogue.json. Do not edit.',
    '//',
    '// Every key of the catalogue read through the generated accessors, next to what the',
    '// TypeScript reference renders for the same arguments (scripts/i18n/template.ts, which',
    "// the TypeScript tests hold equal to the Expo app's own string functions).",
    '',
    '@testable import HermieUI',
    '',
    'enum StringSamples {',
    ...trees.flatMap(tree => [`  static let ${memberName(tree)}: [StringSample] = [`, ...byTree.get(tree)!, '  ]', '']),
    `  static let all: [StringSample] = ${trees.map(memberName).join(' + ')}`,
    '}',
    ''
  ].join('\n')

  return { samples, sampleCount }
}

function swiftDoc(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** The English `other` reading of a template, for a doc comment. */
function templateSummary(template: Template): string {
  if (typeof template === 'string') {
    return template
  }

  if (template.kind === 'select') {
    return templateSummary(template.else)
  }

  return templateSummary(template.forms.other)
}
