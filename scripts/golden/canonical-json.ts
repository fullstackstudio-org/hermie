/**
 * The one JSON encoding every file under `contract/` is written in, and the one
 * a port compares against.
 *
 * `contract/README.md` states these rules for the other side; this file is
 * their reference implementation. In short:
 *
 * - Only plain data crosses: `null`, booleans, finite numbers, strings, arrays
 *   and plain objects. Anything else (a function, a Map or Set, a Date, a class
 *   instance, a typed array, a symbol, a bigint, NaN or ±Infinity, a string
 *   holding a lone UTF-16 surrogate, a cycle) makes the value NOT JSON and the
 *   caller skips it with the reason `toJson` throws.
 * - An object property whose value is `undefined` is omitted, exactly as
 *   `JSON.stringify` omits it. An `undefined` array element becomes `null`.
 * - `-0` is written `0`.
 * - Object keys are sorted by UTF-16 code unit (JavaScript's default string
 *   order), at every depth.
 * - Numbers are written the way ECMAScript's `Number.prototype.toString` writes
 *   them; strings are escaped the way `JSON.stringify` escapes them.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Why a value could not be written as plain JSON. */
export type NotJsonReason =
  | 'function'
  | 'map'
  | 'set'
  | 'date'
  | 'class-instance'
  | 'typed-array'
  | 'symbol'
  | 'bigint'
  | 'non-finite-number'
  | 'lone-surrogate'
  | 'cycle'

export class NotJsonError extends Error {
  constructor(
    readonly reason: NotJsonReason,
    readonly at: string
  ) {
    super(`not JSON (${reason}) at ${at}`)
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

/**
 * A deep copy of `value` as plain JSON, keys sorted, or a `NotJsonError`.
 *
 * `undefined` at the top level returns `undefined`: the caller decides what an
 * absent value means where it stands (an omitted `result`, a trimmed argument).
 */
export function toJson(value: unknown, at = '$'): Json | undefined {
  return convert(value, at, new Set())
}

function convert(value: unknown, at: string, ancestors: Set<object>): Json | undefined {
  switch (typeof value) {
    case 'undefined':
      return undefined
    case 'boolean':
      return value
    case 'string':
      if (LONE_SURROGATE.test(value)) {
        throw new NotJsonError('lone-surrogate', at)
      }

      return value
    case 'number':
      if (!Number.isFinite(value)) {
        throw new NotJsonError('non-finite-number', at)
      }

      return Object.is(value, -0) ? 0 : value
    case 'function':
      throw new NotJsonError('function', at)
    case 'symbol':
      throw new NotJsonError('symbol', at)
    case 'bigint':
      throw new NotJsonError('bigint', at)
  }

  if (value === null) {
    return null
  }

  const object = value as object

  if (ancestors.has(object)) {
    throw new NotJsonError('cycle', at)
  }

  if (Array.isArray(object)) {
    ancestors.add(object)

    const out: Json[] = []

    for (let index = 0; index < object.length; index += 1) {
      const item = convert(object[index], `${at}[${index}]`, ancestors)

      out.push(item === undefined ? null : item)
    }

    ancestors.delete(object)

    return out
  }

  if (object instanceof Map) {
    throw new NotJsonError('map', at)
  }

  if (object instanceof Set) {
    throw new NotJsonError('set', at)
  }

  if (object instanceof Date) {
    throw new NotJsonError('date', at)
  }

  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    throw new NotJsonError('typed-array', at)
  }

  const proto = Object.getPrototypeOf(object)

  if (proto !== Object.prototype && proto !== null) {
    throw new NotJsonError('class-instance', at)
  }

  ancestors.add(object)

  const out: { [key: string]: Json } = {}

  for (const key of Object.keys(object).sort(compareKeys)) {
    if (LONE_SURROGATE.test(key)) {
      throw new NotJsonError('lone-surrogate', `${at}.${key}`)
    }

    const item = convert((object as Record<string, unknown>)[key], `${at}.${key}`, ancestors)

    if (item !== undefined) {
      out[key] = item
    }
  }

  ancestors.delete(object)

  return out
}

/** UTF-16 code unit order: what `Array.prototype.sort` does with no comparator. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The compact canonical text: no whitespace, keys sorted. Two values are equal
 * for the contract exactly when their canonical texts are equal.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(toJson(value) ?? null)
}

/**
 * The on-disk form: the same canonical value, two-space indented, LF line
 * endings, one trailing newline. Readers must parse it and compare canonical
 * texts; the indentation is for reviewers, not part of the contract.
 */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(toJson(value) ?? null, null, 2)}\n`
}
