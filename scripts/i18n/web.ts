/**
 * `contract/i18n/catalogue.json` → what the web client reads
 * (`native/web/src/generated/`).
 *
 *   strings.ts          the typed tree: `strings.app.common.cancel`, and
 *                       `strings.app.onboarding.stepCounter({ current, total })`
 *   locales/<tag>.json  every key in that language, flat, one entry per line
 *
 * The tree is types only plus one line that builds it: what it says comes from
 * the locale data at the moment of the read, so a language switch is visible
 * without anything being rebuilt (native/web/src/i18n/catalogue.ts). English is
 * bundled with the client; Dutch and German are separate chunks, fetched when
 * a reader asks for them.
 *
 * A locale file maps the dotted key to
 *
 *   a string                       a plain string
 *   an array of strings            a list
 *   { "template": <Template> }     a string function, in the template language
 *                                  of scripts/i18n/template.ts
 *
 * so the shape of a value is its kind, and no second table has to say which keys
 * are functions. The web client renders a template with its own copy of
 * `render` (native/web/src/i18n/template.ts); `web.test.ts` holds that copy to
 * this reference over the whole argument grid.
 *
 * Everything is sorted (UTF-16 code units, like the rest of `contract/`) so the
 * output does not depend on the order the catalogues happened to be read in.
 */
import { canonical, compareKeys } from '../golden/canonical-json'
import type { Locale } from '../../expo/hermie/src/i18n/locales'
import type { Catalogue, Entry } from './export'
import type { Param, Template } from './template'

/** Where the files go, relative to `native/web/src/generated`. */
export const WEB_STRINGS_FILE = 'strings.ts'
export const WEB_LOCALES_DIR = 'locales'

/** The value a locale file holds for `entry` in `locale`. */
export type LocaleValue = string | string[] | { template: Template }

export function localeValue(entry: Entry, locale: Locale): LocaleValue {
  return entry.kind === 'template' ? { template: entry.values[locale] } : entry.values[locale]
}

interface Node {
  children: Map<string, Node>
  entry?: Entry
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

/** A property name as TypeScript writes it: bare when it can be, quoted when it cannot (`1h`). */
const propertyName = (segment: string): string => (IDENTIFIER.test(segment) ? segment : JSON.stringify(segment))

/** One line of doc comment: no line breaks, nothing that ends the comment. */
function docLine(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').replace(/\*\//gu, '* /').trim()

  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat
}

/** The English wording a template reads as, for the doc comment: its first message. */
function templateSummary(template: Template): string {
  if (typeof template === 'string') {
    return template
  }

  if (template.kind === 'select') {
    return templateSummary(template.else)
  }

  return templateSummary(template.forms.other)
}

const paramType = (param: Param): string => (param.type === 'string[]' ? 'readonly string[]' : param.type)

function functionType(params: readonly Param[]): string {
  if (params.length === 0) {
    return '() => string'
  }

  const fields = params.map(param => `${propertyName(param.name)}${param.optional ? '?' : ''}: ${paramType(param)}`)
  const optionalArguments = params.every(param => param.optional)

  return `(args${optionalArguments ? '?' : ''}: { ${fields.join('; ')} }) => string`
}

function buildTree(catalogue: Catalogue): Node {
  const root: Node = { children: new Map() }

  for (const key of Object.keys(catalogue.entries).sort(compareKeys)) {
    let node = root

    for (const segment of key.split('.')) {
      let child = node.children.get(segment)

      if (!child) {
        child = { children: new Map() }
        node.children.set(segment, child)
      }

      node = child
    }

    node.entry = catalogue.entries[key]
  }

  return root
}

function writeNode(node: Node, indent: string, path: string, keyed: ReadonlySet<string>, lines: string[]): void {
  const children = [...node.children].sort(([a], [b]) => compareKeys(a, b))

  for (const [segment, child] of children) {
    const childPath = path ? `${path}.${segment}` : segment
    const name = propertyName(segment)

    if (!child.entry) {
      lines.push(`${indent}readonly ${name}: {`)
      writeNode(child, `${indent}  `, childPath, keyed, lines)
      lines.push(`${indent}}`)
      continue
    }

    if (child.children.size) {
      throw new Error(`${childPath}: a key cannot be both a string and a branch`)
    }

    const { entry } = child

    if (entry.kind === 'text') {
      lines.push(`${indent}/** ${docLine(entry.values.en)} */`)
      lines.push(`${indent}readonly ${name}: string`)
    } else if (entry.kind === 'list') {
      lines.push(`${indent}/** ${docLine(entry.values.en.join(' | '))} */`)
      lines.push(`${indent}readonly ${name}: readonly string[]`)
    } else {
      lines.push(`${indent}/** ${docLine(templateSummary(entry.values.en))} */`)
      lines.push(`${indent}readonly ${name}: ${functionType(entry.params)}`)
    }
  }

  if (keyed.has(path)) {
    if (children.some(([, child]) => child.entry?.kind !== 'text')) {
      throw new Error(`${path}: a keyed table holds plain strings only`)
    }

    lines.push(
      `${indent}/** An entry for a key that arrives at run time, or undefined for one this table does not have. */`
    )
    lines.push(`${indent}readonly [key: string]: string | undefined`)
  }
}

/** `strings.ts`. */
function stringsModule(catalogue: Catalogue): string {
  const lines: string[] = []

  writeNode(buildTree(catalogue), '  ', '', new Set(catalogue.keyed), lines)

  return [
    '// Written by `npm run i18n` from contract/i18n/catalogue.json. Do not edit: change the',
    '// TypeScript catalogues in expo/hermie/src/i18n and run it again. See docs/i18n.md.',
    '',
    "import { createStrings } from '../i18n/catalogue'",
    '',
    '/** Every string the Expo app has, under the keys the Expo app uses. */',
    'export interface Strings {',
    ...lines,
    '}',
    '',
    '/**',
    ' * The strings in the language the reader is using. Each read resolves when it is made,',
    ' * so a screen that renders after a language switch says the new language.',
    ' */',
    'export const strings: Strings = createStrings<Strings>()',
    ''
  ].join('\n')
}

/** One locale file: one entry per line, keys in code-unit order. */
function localeFile(catalogue: Catalogue, locale: Locale): string {
  const lines = Object.keys(catalogue.entries)
    .sort(compareKeys)
    .map(key => `  ${JSON.stringify(key)}: ${canonical(localeValue(catalogue.entries[key]!, locale))}`)

  return `{\n${lines.join(',\n')}\n}\n`
}

/** Every generated web file, keyed by its path relative to `native/web/src/generated`. */
export function generateWeb(catalogue: Catalogue): Map<string, string> {
  const files = new Map<string, string>([[WEB_STRINGS_FILE, stringsModule(catalogue)]])

  for (const locale of catalogue.locales) {
    files.set(`${WEB_LOCALES_DIR}/${locale}.json`, localeFile(catalogue, locale))
  }

  return files
}
