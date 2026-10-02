/**
 * Turning one TypeScript string function into a template, by calling it.
 *
 * Nothing here reads the function's source. It is called with sentinel
 * arguments — a private-use marker for a string, an unlikely number like 4037
 * for a count, three markers for a list — and wherever a sentinel comes back in
 * the output, that is where the placeholder goes. Behaviour that depends on the
 * VALUE of an argument is found by probing:
 *
 *  - every number is tried at 0 and 1; where the output is not the generic
 *    sentence with that number in it, the function has a `one` (or `zero`)
 *    form, and the result is a `plural`;
 *  - every string is tried empty; where `''` does not simply drop out of the
 *    sentence, the function tests it (`name || 'untitled'`), and the result is
 *    a `select` on `empty`.
 *
 * Whatever comes out is then checked against the function itself over a grid
 * of real arguments (`verify`). A function whose behaviour the probes cannot
 * express — two arguments compared with each other, say — fails that check and
 * has to be written by hand in `overrides.ts`, where the same check holds the
 * hand-written template to the function.
 */
import { canonical } from '../golden/canonical-json'
import {
  escapeText,
  parseMessage,
  placeholderText,
  render,
  writeMessage,
  type ArgValue,
  type Param,
  type Template
} from './template'

export type StringFunction = (...args: never[]) => unknown

export type Conversion = { ok: true; template: Template } | { ok: false; reason: string }

const MARK_OPEN = ''
const MARK_CLOSE = ''
const LEFTOVER = /[]/u

const stringSentinel = (index: number): string => `${MARK_OPEN}s${index}${MARK_CLOSE}`
const numberSentinel = (index: number): number => 4037 + 1000 * index
const listSentinel = (index: number): string[] => [0, 1, 2].map(item => `${MARK_OPEN}l${index}x${item}${MARK_CLOSE}`)

type Assignment = Record<string, ArgValue>

function call(fn: StringFunction, params: readonly Param[], args: Assignment): string {
  const out = (fn as (...values: ArgValue[]) => unknown)(...params.map(param => args[param.name]))

  if (typeof out !== 'string') {
    throw new Error(`returned ${typeof out}, not a string`)
  }

  return out
}

function generic(params: readonly Param[]): Assignment {
  const args: Assignment = {}

  params.forEach((param, index) => {
    args[param.name] =
      param.type === 'number'
        ? numberSentinel(index)
        : param.type === 'string[]'
          ? listSentinel(index)
          : stringSentinel(index)
  })

  return args
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The output of a call made with sentinels, as a Message: literal text
 * escaped, every sentinel that came back replaced by its placeholder.
 */
function abstract(output: string, params: readonly Param[], args: Assignment): string {
  let message = escapeText(output)

  params.forEach((param, index) => {
    const value = args[param.name]

    if (param.type === 'string' && value === stringSentinel(index)) {
      message = message
        .split(value)
        .join(placeholderText(param.name))
        .split(value.toUpperCase())
        .join(placeholderText(param.name, { name: 'upper' }))
    }

    if (param.type === 'number' && value === numberSentinel(index)) {
      message = message
        .split(String(value))
        .join(placeholderText(param.name))
        .split(String(value + 1))
        .join(placeholderText(param.name, { name: 'add', amount: 1 }))
    }

    if (param.type === 'string[]' && Array.isArray(value) && value.length === 3) {
      const [a, b, c] = (value as string[]).map(escapeRegExp)
      const joined = new RegExp(`${a}(.*?)${b}(.*?)${c}`, 'gu')

      message = message.replace(joined, (_match, separator: string, last: string) =>
        placeholderText(param.name, {
          name: 'list',
          separator: unescapeText(separator),
          last: unescapeText(last)
        })
      )
    }
  })

  if (LEFTOVER.test(message)) {
    throw new Error(`an argument came back in a form the probes do not recognise: ${JSON.stringify(output)}`)
  }

  return message
}

function unescapeText(text: string): string {
  return text.replace(/\{\{/gu, '{').replace(/\}\}/gu, '}')
}

/** Replace every placeholder of `param` in a template by the text it renders to for `value`. */
function substitute(template: Template, param: string, value: ArgValue, locale: string): Template {
  if (typeof template === 'string') {
    return writeMessage(
      parseMessage(template).map(segment =>
        'param' in segment && segment.param === param
          ? { text: render(placeholderText(segment.param, segment.format), { [param]: value }, locale) }
          : segment
      )
    )
  }

  if (template.kind === 'select') {
    return {
      ...template,
      then: substitute(template.then, param, value, locale),
      else: substitute(template.else, param, value, locale)
    }
  }

  const forms: typeof template.forms = { other: substitute(template.forms.other, param, value, locale) }

  for (const [category, form] of Object.entries(template.forms)) {
    if (category !== 'other' && form !== undefined) {
      forms[category as keyof typeof forms] = substitute(form, param, value, locale)
    }
  }

  return { ...template, forms }
}

const same = (a: Template, b: Template): boolean => canonical(a) === canonical(b)

/** The template for one fixed choice of which strings are empty: a message, or a plural on one count. */
function countTree(fn: StringFunction, params: readonly Param[], args: Assignment, locale: string): Template {
  const base = abstract(call(fn, params, args), params, args)
  const plural: { arg: string; forms: Record<string, Template> }[] = []

  for (const param of params) {
    if (param.type !== 'number') {
      continue
    }

    const forms: Record<string, Template> = {}

    for (const [category, count] of [
      ['one', 1],
      ['zero', 0]
    ] as const) {
      const probe = { ...args, [param.name]: count }
      const output = call(fn, params, probe)

      if (render(base, probe, locale) !== output) {
        forms[category] = abstract(output, params, probe)
      }
    }

    if (Object.keys(forms).length) {
      plural.push({ arg: param.name, forms })
    }
  }

  if (plural.length > 1) {
    throw new Error(`more than one count changes the wording (${plural.map(p => p.arg).join(', ')})`)
  }

  const [only] = plural

  if (!only) {
    return base
  }

  return { kind: 'plural', arg: only.arg, forms: { ...only.forms, other: base } }
}

/** A template for `fn`, or why the probes could not find one. Verified before it is returned. */
export function convert(fn: StringFunction, params: readonly Param[], locale: string): Conversion {
  if (params.length === 0) {
    return { ok: false, reason: 'takes no arguments' }
  }

  try {
    const strings = params.filter(param => param.type === 'string')

    const tree = (index: number, args: Assignment): Template => {
      const param = strings[index]

      if (!param) {
        return countTree(fn, params, args, locale)
      }

      const present = tree(index + 1, args)
      const empty = tree(index + 1, { ...args, [param.name]: '' })

      return same(substitute(present, param.name, '', locale), empty)
        ? present
        : { kind: 'select', test: { op: 'empty', arg: param.name }, then: empty, else: present }
    }

    const template = tree(0, generic(params))
    const problem = verify(fn, params, template, locale)

    return problem ? { ok: false, reason: problem } : { ok: true, template }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The values each parameter takes in the grid a template is checked over. */
export const SAMPLE_VALUES: Readonly<Record<Param['type'], readonly ArgValue[]>> = {
  // 0, 1 and 2 are the plural boundaries; the rest catch a rule that is not `=== 1`.
  number: [0, 1, 2, 3, 5, 11, 21, 100, 101, 1000],
  // A value with a percent sign and braces, so a port that formats text through
  // printf or a template engine shows it.
  string: ['Ada', '', 'x {y} 100% %@'],
  'string[]': [[], ['a'], ['a', 'b'], ['a', 'b', 'c']]
}

function* grid(params: readonly Param[], at = 0, args: Assignment = {}): Generator<Assignment> {
  const param = params[at]

  if (!param) {
    yield args
    return
  }

  const values = param.optional ? [...SAMPLE_VALUES[param.type], undefined] : SAMPLE_VALUES[param.type]

  for (const value of values) {
    yield* grid(params, at + 1, { ...args, [param.name]: value })
  }
}

/** Every argument combination a template is checked with. */
export function sampleArguments(params: readonly Param[]): Assignment[] {
  return [...grid(params)]
}

/**
 * Does `template` say what `fn` says, for every argument in the grid?
 * Undefined when it does; otherwise the first difference.
 */
export function verify(
  fn: StringFunction,
  params: readonly Param[],
  template: Template,
  locale: string
): string | undefined {
  for (const args of grid(params)) {
    let expected: string

    try {
      expected = call(fn, params, args)
    } catch (error) {
      return `the function throws for ${JSON.stringify(args)}: ${String(error)}`
    }

    let actual: string

    try {
      actual = render(template, args, locale)
    } catch (error) {
      return `the template does not render for ${JSON.stringify(args)}: ${String(error)}`
    }

    if (actual !== expected) {
      return `for ${JSON.stringify(args)} the function says ${JSON.stringify(expected)}, the template ${JSON.stringify(actual)}`
    }
  }

  return undefined
}
