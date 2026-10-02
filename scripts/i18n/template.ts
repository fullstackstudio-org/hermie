/**
 * The neutral template language `contract/i18n/catalogue.json` writes a string
 * function in, and the one reference renderer for it.
 *
 * The Expo app's interpolating strings are TypeScript functions. A native app
 * cannot call them, so the export turns each one into data that says the same
 * thing:
 *
 *   Template = Message                                   "Step {current} of {total}"
 *            | { kind: 'plural', arg, forms }            forms: zero? one? two? few? many? other
 *            | { kind: 'select', test, then, else }      test: { op: 'empty', arg }
 *                                                              { op: 'gte', left, right }
 *
 * A Message is text with `{param}` placeholders; a literal brace is written
 * twice (`{{`, `}}`). A placeholder may name a formatter, with JSON arguments:
 *
 *   {handle|upper}                 the string, upper-cased
 *   {index|add(1)}                 the number plus one
 *   {parts|list(", ", " or ")}     an array joined: separator between items, the
 *                                  second one before the last ("a, b or c");
 *                                  zero items is "", one item is that item
 *
 * Numbers are written as plain decimal digits (`String(n)`), never grouped.
 * A plural picks `zero` for exactly 0 when the template has one, and otherwise
 * the CLDR category of the count in the template's language, falling back to
 * `other` — the rule Apple's String Catalog applies, and the one `count === 1`
 * in English, Dutch and German agrees with for every integer.
 *
 * `select` with `empty` is true for `undefined` and for `''`, which is what a
 * TypeScript `name || 'fallback'` or `description ? … : …` tests.
 */

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export type Test = { op: 'empty'; arg: string } | { op: 'gte'; left: string; right: string }

export type Template =
  | string
  | { kind: 'plural'; arg: string; forms: Partial<Record<PluralCategory, Template>> & { other: Template } }
  | { kind: 'select'; test: Test; then: Template; else: Template }

export type ParamType = 'string' | 'number' | 'string[]'

export interface Param {
  name: string
  type: ParamType
  /** `name?: string` or `string | undefined`: the argument may be left out. */
  optional: boolean
}

export type ArgValue = string | number | readonly string[] | undefined

export type Formatter =
  { name: 'upper' } | { name: 'add'; amount: number } | { name: 'list'; separator: string; last: string }

export type Segment = { text: string } | { param: string; format?: Formatter }

export const PLURAL_CATEGORIES: readonly PluralCategory[] = ['zero', 'one', 'two', 'few', 'many', 'other']

/** Escape literal text for a Message. */
export function escapeText(text: string): string {
  return text.replace(/\{/gu, '{{').replace(/\}/gu, '}}')
}

/** A formatter as it is written after the `|` in a placeholder. */
export function formatterText(format: Formatter): string {
  switch (format.name) {
    case 'upper':
      return 'upper'
    case 'add':
      return `add(${JSON.stringify(format.amount)})`
    case 'list':
      return `list(${JSON.stringify(format.separator)}, ${JSON.stringify(format.last)})`
  }
}

export function placeholderText(param: string, format?: Formatter): string {
  return format ? `{${param}|${formatterText(format)}}` : `{${param}}`
}

/** Write segments back as a Message. */
export function writeMessage(segments: readonly Segment[]): string {
  return segments.map(s => ('text' in s ? escapeText(s.text) : placeholderText(s.param, s.format))).join('')
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/uy

/** Parse a Message into text and placeholder segments. Throws on a malformed one. */
export function parseMessage(message: string): Segment[] {
  const out: Segment[] = []
  let text = ''
  let index = 0

  const flush = (): void => {
    if (text) {
      out.push({ text })
      text = ''
    }
  }

  while (index < message.length) {
    const char = message[index]!

    if (char === '{' && message[index + 1] === '{') {
      text += '{'
      index += 2
      continue
    }

    if (char === '}' && message[index + 1] === '}') {
      text += '}'
      index += 2
      continue
    }

    if (char === '}') {
      throw new Error(`unescaped "}" at ${index} in ${JSON.stringify(message)}`)
    }

    if (char !== '{') {
      text += char
      index += 1
      continue
    }

    IDENT.lastIndex = index + 1
    const name = IDENT.exec(message)?.[0]

    if (!name) {
      throw new Error(`placeholder without a name at ${index} in ${JSON.stringify(message)}`)
    }

    index += 1 + name.length

    let format: Formatter | undefined

    if (message[index] === '|') {
      IDENT.lastIndex = index + 1
      const formatter = IDENT.exec(message)?.[0]

      if (!formatter) {
        throw new Error(`formatter without a name at ${index} in ${JSON.stringify(message)}`)
      }

      index += 1 + formatter.length

      let args: unknown[] = []

      if (message[index] === '(') {
        const end = closingParen(message, index)

        args = JSON.parse(`[${message.slice(index + 1, end)}]`) as unknown[]
        index = end + 1
      }

      format = formatterFrom(formatter, args, message)
    }

    if (message[index] !== '}') {
      throw new Error(`placeholder {${name}… is not closed in ${JSON.stringify(message)}`)
    }

    index += 1
    flush()
    out.push(format ? { param: name, format } : { param: name })
  }

  flush()

  return out
}

/** The index of the `)` that closes the `(` at `open`, skipping JSON strings. */
function closingParen(message: string, open: number): number {
  let inString = false

  for (let index = open + 1; index < message.length; index += 1) {
    const char = message[index]

    if (inString) {
      if (char === '\\') {
        index += 1
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
    } else if (char === ')') {
      return index
    }
  }

  throw new Error(`formatter arguments are not closed in ${JSON.stringify(message)}`)
}

function formatterFrom(name: string, args: unknown[], message: string): Formatter {
  if (name === 'upper' && args.length === 0) {
    return { name: 'upper' }
  }

  if (name === 'add' && args.length === 1 && Number.isInteger(args[0])) {
    return { name: 'add', amount: args[0] as number }
  }

  if (name === 'list' && args.length === 2 && args.every(arg => typeof arg === 'string')) {
    return { name: 'list', separator: args[0] as string, last: args[1] as string }
  }

  throw new Error(`unknown formatter ${name}(${JSON.stringify(args)}) in ${JSON.stringify(message)}`)
}

/** `items` joined the way `{x|list(separator, last)}` joins them. */
export function joinList(items: readonly string[], separator: string, last: string): string {
  if (items.length <= 1) {
    return items[0] ?? ''
  }

  return `${items.slice(0, -1).join(separator)}${last}${items[items.length - 1]}`
}

function formatValue(value: ArgValue, format: Formatter | undefined, at: string): string {
  if (!format) {
    if (Array.isArray(value)) {
      throw new Error(`${at}: an array placeholder needs a list formatter`)
    }

    return value === undefined ? '' : String(value)
  }

  switch (format.name) {
    case 'upper':
      return (typeof value === 'string' ? value : '').toUpperCase()
    case 'add':
      if (typeof value !== 'number') {
        throw new Error(`${at}: add() needs a number`)
      }

      return String(value + format.amount)
    case 'list':
      if (!Array.isArray(value)) {
        throw new Error(`${at}: list() needs an array`)
      }

      return joinList(value as readonly string[], format.separator, format.last)
  }
}

function isEmpty(value: ArgValue): boolean {
  return value === undefined || value === ''
}

export function testHolds(test: Test, args: Readonly<Record<string, ArgValue>>): boolean {
  switch (test.op) {
    case 'empty':
      return isEmpty(args[test.arg])
    case 'gte':
      return Number(args[test.left]) >= Number(args[test.right])
  }
}

const pluralRules = new Map<string, Intl.PluralRules>()

export function pluralCategory(locale: string, count: number): PluralCategory {
  let rules = pluralRules.get(locale)

  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }

  return rules.select(count) as PluralCategory
}

/** Render a template in `locale` with these arguments. The reference every port is compared with. */
export function render(template: Template, args: Readonly<Record<string, ArgValue>>, locale: string): string {
  if (typeof template === 'string') {
    return parseMessage(template)
      .map(segment =>
        'text' in segment ? segment.text : formatValue(args[segment.param], segment.format, segment.param)
      )
      .join('')
  }

  if (template.kind === 'select') {
    return render(testHolds(template.test, args) ? template.then : template.else, args, locale)
  }

  const count = Number(args[template.arg])
  const form =
    count === 0 && template.forms.zero !== undefined
      ? template.forms.zero
      : (template.forms[pluralCategory(locale, count)] ?? template.forms.other)

  return render(form, args, locale)
}

/** Every Message in a template, depth first. */
export function messagesOf(template: Template): string[] {
  if (typeof template === 'string') {
    return [template]
  }

  if (template.kind === 'select') {
    return [...messagesOf(template.then), ...messagesOf(template.else)]
  }

  return PLURAL_CATEGORIES.flatMap(category => {
    const form = template.forms[category]

    return form === undefined ? [] : messagesOf(form)
  })
}

/** Every parameter name a template reads, through placeholders, plurals or tests. */
export function paramsRead(template: Template): Set<string> {
  const out = new Set<string>()

  const visit = (node: Template): void => {
    if (typeof node === 'string') {
      for (const segment of parseMessage(node)) {
        if ('param' in segment) {
          out.add(segment.param)
        }
      }

      return
    }

    if (node.kind === 'select') {
      if (node.test.op === 'empty') {
        out.add(node.test.arg)
      } else {
        out.add(node.test.left)
        out.add(node.test.right)
      }

      visit(node.then)
      visit(node.else)

      return
    }

    out.add(node.arg)

    for (const category of PLURAL_CATEGORIES) {
      const form = node.forms[category]

      if (form !== undefined) {
        visit(form)
      }
    }
  }

  visit(template)

  return out
}
