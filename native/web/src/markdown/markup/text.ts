/**
 * What the `hermie-*` validators share: how long a label is, and the byte cap checked before a block is parsed.
 *
 * A length is counted in characters as a reader sees them (an extended grapheme cluster, which is what the native
 * validators' `String.count` is), not in UTF-16 units: a family emoji is one character, and a limit on a label is a
 * limit on what fits a card, not on how it is encoded.
 */

const SEGMENTER: Intl.Segmenter | undefined =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

/** An upper bound on a label that is never worth segmenting: more UTF-16 units than any cap allows for. */
const SEGMENT_CEILING = 4096

/** The number of characters a reader sees in `text`. */
export function characters(text: string): number {
  if (text.length === 0) {
    return 0
  }

  // A pure ASCII string (the common label) has one character per unit.
  if (/^[\x20-\x7e]*$/u.test(text)) {
    return text.length
  }

  // Past the ceiling the answer is "more than any limit"; counting it exactly would only cost time.
  if (text.length > SEGMENT_CEILING) {
    return text.length
  }

  if (SEGMENTER) {
    let count = 0

    for (const _segment of SEGMENTER.segment(text)) {
      count += 1
    }

    return count
  }

  // No segmenter: code points, which only over-counts a combined emoji (refusing a little early, never late).
  return Array.from(text).length
}

/** The UTF-8 size of `text` in bytes. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** A plain object (not an array, not null): what a JSON object parses to. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
