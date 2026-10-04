/**
 * Text that must be shown EXACTLY as it is: the verbatim rules of `contract/requests/README.md` §6.2 and
 * §6.3, as the gateway's `request_text.verbatim_problem` applies them to a structured `confirm` field, a
 * path and (through `diff-hunks.ts`) every line of a diff.
 *
 * It returns why a text cannot be shown as it is, or `""`, and never rewrites anything. The character
 * classes are Unicode general categories as the runtime's database knows them (Unicode 14 or later, as the
 * contract asks); the default-ignorable table is the contract's own copy, not the platform's property.
 */

/** Hangul fillers, the blank Braille pattern, the musical null notehead and the Khitan filler (§6.2 item 4). */
const INVISIBLE_LETTERS = new Set(['ᅟ', 'ᅠ', 'ㅤ', 'ﾠ', '⠀', '\u{1d159}', '\u{16fe4}'])

/** `Default_Ignorable_Code_Point` as the contract lists it (§6.2 item 5), inclusive ranges. */
export const DEFAULT_IGNORABLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
]

export const MAX_COMBINING_MARKS = 4
export const MAX_SPACE_RUN = 16
export const MAX_INDENT = 32
export const MAX_BLANK_LINES = 3
export const MAX_LINE_CHARS = 2000

/** Every character Python's `str.isspace()` accepts (the contract's §6.1 measure of "whitespace"). */
export const PY_SPACE_CLASS =
  '\\t\\n\\u000b\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'

const PY_SPACE = new RegExp(`^[${PY_SPACE_CLASS}]$`)
const PY_TRAILING_SPACE = new RegExp(`[${PY_SPACE_CLASS}]+$`)

export const isPySpace = (ch: string): boolean => PY_SPACE.test(ch)

/** `str.rstrip()`: every `isspace` character off the end. */
export const pyRstrip = (text: string): string => text.replace(PY_TRAILING_SPACE, '')

/** Code points, not UTF-16 units. */
export const codePointLength = (text: string): number => [...text].length

export function defaultIgnorable(ch: string): boolean {
  const code = ch.codePointAt(0) as number

  return DEFAULT_IGNORABLE.some(([low, high]) => code >= low && code <= high)
}

const hex = (ch: string): string => (ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')

const UNASSIGNED = /^\p{Cn}$/u
const COMBINING = /^[\p{Mn}\p{Me}]$/u
const NOT_SHOWABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Zs}]$/u

/**
 * Why the spacing of `text` could hide part of it from the person (`MAX_SPACE_RUN`, `MAX_INDENT`,
 * `MAX_BLANK_LINES`, `MAX_LINE_CHARS`), or `""`. Tabs and every other whitespace were refused before this
 * runs, so only spaces and newlines count.
 */
export function layoutProblem(text: string): string {
  let blank = 0

  for (const [index, line] of text.split('\n').entries()) {
    const number = index + 1

    if (!/[^ ]/.test(line)) {
      blank += 1

      if (blank > MAX_BLANK_LINES) {
        return `line ${number - blank + 1} starts more than ${MAX_BLANK_LINES} blank lines in a row`
      }

      continue
    }

    blank = 0

    const length = codePointLength(line)

    if (length > MAX_LINE_CHARS) {
      return `line ${number} is ${length} characters (at most ${MAX_LINE_CHARS})`
    }

    const body = line.replace(/^ +/, '')
    const indent = line.length - body.length

    if (indent > MAX_INDENT) {
      return `line ${number} is indented ${indent} spaces (at most ${MAX_INDENT})`
    }

    for (const run of body.matchAll(/ +/g)) {
      if (run[0].length > MAX_SPACE_RUN) {
        return `line ${number} has ${run[0].length} spaces in a row (at most ${MAX_SPACE_RUN})`
      }
    }
  }

  return ''
}

/**
 * Why `text` cannot be shown VERBATIM (no cleaning at all), or `""`: a character a cleaner would drop or
 * rewrite (a control character other than a newline, a tab, a format, surrogate or private-use character,
 * a line or paragraph separator, whitespace other than a space, an invisible letter, more than
 * `MAX_COMBINING_MARKS` combining marks in a row), an unassigned code point, a default-ignorable one,
 * whitespace at the end of a line or of the text, or spacing that could push part of it out of view.
 */
export function verbatimProblem(text: string): string {
  let marks = 0

  for (const ch of text) {
    if (UNASSIGNED.test(ch) || defaultIgnorable(ch) || INVISIBLE_LETTERS.has(ch)) {
      return `character U+${hex(ch)} cannot be shown as it is`
    }

    if (COMBINING.test(ch)) {
      marks += 1

      if (marks > MAX_COMBINING_MARKS) {
        return 'too many combining marks on one character'
      }

      continue
    }

    marks = 0

    if (ch === '\n' || ch === ' ') {
      continue
    }

    if (NOT_SHOWABLE.test(ch) || isPySpace(ch)) {
      return `character U+${hex(ch)} cannot be shown as it is`
    }
  }

  if (text.split('\n').some(line => line !== pyRstrip(line)) || text !== pyRstrip(text)) {
    return 'whitespace at the end of a line or of the text cannot be seen'
  }

  const layout = layoutProblem(text)

  return layout ? `${layout}, which can put part of it out of view; present it without padding` : ''
}
