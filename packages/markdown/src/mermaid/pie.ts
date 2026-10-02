/**
 * A Mermaid `pie` → labelled slices, or `null`.
 *
 * ## The subset, stated up front
 *
 * `pie`, `pie title …` and `pie showData`, a `title …` line of its own, and any
 * number of `"Label" : 42` rows. Quotes around the label are optional here
 * although Mermaid asks for them, because a model that writes `Dogs : 386` meant
 * a slice and nothing else in the grammar can be confused with one.
 *
 * `showData` is accepted and changes nothing, and that is not the same as being
 * ignored: it asks for each slice's number to be visible, and the legend prints
 * every value and percentage whether it was written or not. There is no spelling
 * of this chart that hides the numbers, so there is nothing to honour separately.
 *
 * Anything else answers `null` and the caller shows the fenced source — including
 * a negative value, which has no arc, and a total of zero, which has no circle.
 *
 * ## Pure, and total
 *
 * No React, no theme, no platform, and it never throws. A pie whose first row has
 * arrived and whose second has not is a `null` and a fenced listing, which is what
 * every flush of a streaming reply needs it to be.
 */

import { cleanLabel } from './labels'

export interface PieSlice {
  label: string
  value: number
}

export interface PieChart {
  title?: string
  slices: PieSlice[]
}

/** Past this a pie is a table, and a table is what the source already is. */
const MAX_SLICES = 10
const MAX_SOURCE = 4000

/** `pie`, with the two things the header line is allowed to carry. */
const HEADER_RE = /^pie(?:\s+showData)?(?:\s+title\s+(.*))?$/iu

/** A `title` line of its own, which is the other place a title is written. */
const TITLE_RE = /^title\s+(.*)$/iu

/**
 * One slice.
 *
 * The label is everything before the LAST colon, so a label that contains one
 * (`"Cats: indoor" : 12`) still reads correctly, and the value is what follows.
 */
const SLICE_RE = /^(.*?)\s*:\s*([0-9]+(?:\.[0-9]+)?)$/u

/**
 * Parse one `pie` fence, or answer `null`.
 *
 * `null` means "show the source", never "show nothing". Every caller treats it
 * that way and the tests pin that they do.
 */
export function parsePie(source: string): PieChart | null {
  if (!source || source.length > MAX_SOURCE) {
    return null
  }

  const lines = source
    .split('\n')
    .map(line => line.replace(/%%.*$/u, '').trim())
    .filter(Boolean)

  const header = lines.shift()

  if (!header) {
    return null
  }

  const match = HEADER_RE.exec(header)

  if (!match) {
    return null
  }

  let title = cleanLabel(match[1])
  const slices: PieSlice[] = []

  for (const line of lines) {
    const titled = TITLE_RE.exec(line)

    if (titled) {
      // A second title is a diagram that says two things; the source says both.
      if (title || slices.length) {
        return null
      }

      title = cleanLabel(titled[1])

      continue
    }

    const slice = SLICE_RE.exec(line)

    if (!slice) {
      return null
    }

    const label = cleanLabel(slice[1])
    const value = Number(slice[2])

    if (!label || !Number.isFinite(value)) {
      return null
    }

    slices.push({ label, value })
  }

  if (!slices.length || slices.length > MAX_SLICES) {
    return null
  }

  // Every slice at zero has no circle to divide. The rows are still data, so the
  // source is the honest answer rather than an empty ring.
  if (slices.reduce((total, slice) => total + slice.value, 0) <= 0) {
    return null
  }

  return { slices, ...(title ? { title } : {}) }
}
