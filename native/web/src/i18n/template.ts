/**
 * Renders the templates of `src/generated/locales/*.json`.
 *
 * The template language is described at the top of `scripts/i18n/template.ts`,
 * and that file's `render` is the reference: `scripts/i18n/web.test.ts` renders
 * every template of the catalogue through both over the whole argument grid and
 * fails on the first difference. This copy exists because the client may not
 * import from `scripts/`, and it is kept to what rendering needs (no writer, no
 * list of the parameters a template reads).
 *
 *   Template = Message
 *            | { kind: 'plural', arg, forms }          zero? one? two? few? many? other
 *            | { kind: 'select', test, then, else }    test: { op: 'empty', arg } | { op: 'gte', left, right }
 *
 * A Message is text with `{param}` placeholders (`{{` and `}}` for literal
 * braces); a placeholder may name a formatter, `{x|upper}`, `{x|add(1)}`,
 * `{x|list(", ", " or ")}`. A plural picks `zero` for exactly 0 when it has one,
 * and otherwise the CLDR category of the count (`Intl.PluralRules`), falling
 * back to `other`.
 */

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export type Test = { op: 'empty'; arg: string } | { op: 'gte'; left: string; right: string }

export type Template =
  | string
  | { kind: 'plural'; arg: string; forms: Partial<Record<PluralCategory, Template>> & { other: Template } }
  | { kind: 'select'; test: Test; then: Template; else: Template }

export type ArgValue = string | number | readonly string[] | undefined

type Formatter = { name: 'upper' } | { name: 'add'; amount: number } | { name: 'list'; separator: string; last: string }

type Segment = { text: string } | { param: string; format?: Formatter }

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/uy

const parsed = new Map<string, readonly Segment[]>()

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

function parse(message: string): readonly Segment[] {
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

    if ((char === '{' || char === '}') && message[index + 1] === char) {
      text += char
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
      throw new Error(`placeholder {${name}... is not closed in ${JSON.stringify(message)}`)
    }

    index += 1
    flush()
    out.push(format ? { param: name, format } : { param: name })
  }

  flush()

  return out
}

function segmentsOf(message: string): readonly Segment[] {
  let segments = parsed.get(message)

  if (!segments) {
    segments = parse(message)
    parsed.set(message, segments)
  }

  return segments
}

/** `items` joined the way `{x|list(separator, last)}` joins them: "a, b or c". */
function joinList(items: readonly string[], separator: string, last: string): string {
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

const isEmpty = (value: ArgValue): boolean => value === undefined || value === ''

function testHolds(test: Test, args: Readonly<Record<string, ArgValue>>): boolean {
  return test.op === 'empty' ? isEmpty(args[test.arg]) : Number(args[test.left]) >= Number(args[test.right])
}

const pluralRules = new Map<string, Intl.PluralRules>()

function pluralCategory(locale: string, count: number): PluralCategory {
  let rules = pluralRules.get(locale)

  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }

  return rules.select(count) as PluralCategory
}

/** Render `template` in `locale` with these arguments. */
export function renderTemplate(template: Template, args: Readonly<Record<string, ArgValue>>, locale: string): string {
  if (typeof template === 'string') {
    return segmentsOf(template)
      .map(segment =>
        'text' in segment ? segment.text : formatValue(args[segment.param], segment.format, segment.param)
      )
      .join('')
  }

  if (template.kind === 'select') {
    return renderTemplate(testHolds(template.test, args) ? template.then : template.else, args, locale)
  }

  const count = Number(args[template.arg])
  const form =
    count === 0 && template.forms.zero !== undefined
      ? template.forms.zero
      : (template.forms[pluralCategory(locale, count)] ?? template.forms.other)

  return renderTemplate(form, args, locale)
}
