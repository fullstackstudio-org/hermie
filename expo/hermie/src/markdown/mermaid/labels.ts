/**
 * A label's characters, and the room they take.
 *
 * Three diagram kinds share this file — the flowchart, the sequence diagram and
 * the pie — and they share it for one reason: every box, column and legend row
 * in this folder is sized from a character count and a font size rather than
 * from a measurement. ADR-0020 is the record. A diagram that asked the platform
 * how wide its text was would only learn the answer after a layout pass, and a
 * row on an INVERTED list that changes size after it is laid out moves the
 * reader by exactly the change (`docs/platform-notes.md` has that measurement
 * for `Show more`). So the estimate is the design, not a shortcut: it is
 * slightly wrong in a way that is identical on every platform and stable from
 * the first frame.
 *
 * Pure, and total. No React, no theme, no platform, and nothing here throws.
 */

/**
 * A rough advance per character, as a fraction of em.
 *
 * One number for a proportional face, which is a lie in detail and close enough
 * in aggregate: `iiii` is narrower than this says and `WWWW` is wider, and a
 * label is a word rather than either. The consequence is visible and accepted —
 * a box is occasionally a few points wider than its text needs.
 */
export const CHARACTER_EM = 0.58

/** The size a diagram's own labels are set at, which is under the body's. */
export function diagramFontSize(bodyFontSize: number): number {
  return Math.max(10, bodyFontSize - 3)
}

/** How wide one run of characters is drawn, in diagram units. */
export function textWidth(text: string, fontSize: number): number {
  return Math.ceil([...text].length * fontSize * CHARACTER_EM)
}

/** How wide the widest of several lines is drawn. */
export function widestWidth(lines: readonly string[], fontSize: number): number {
  return lines.reduce((most, line) => Math.max(most, textWidth(line, fontSize)), 0)
}

/**
 * The same width with room for the estimate to be wrong.
 *
 * `CHARACTER_EM` is one number for a proportional face, so a label of wide
 * letters is a few per cent wider than it says. A box sized exactly to the
 * estimate would then WRAP the text it was made for, and a label that wraps
 * where the geometry did not expect it to overflows its own box. A little slack
 * costs a few points of drawing width — which the canvas scales away — and buys
 * the guarantee that a one-line label stays one line.
 */
export function labelBoxWidth(lines: readonly string[], fontSize: number, padding = 8): number {
  return Math.ceil(widestWidth(lines, fontSize) * 1.08) + padding
}

/** The leading a diagram sets its labels on. One rule, so every box agrees. */
export function diagramLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.35)
}

/**
 * A label broken so a box does not become a ribbon.
 *
 * An explicit `<br/>` — already a newline by the time this is called — is
 * honoured first, because the author asked for it. A long single line is broken
 * on word boundaries at the width the caller can afford; a single word longer
 * than that is left whole rather than cut mid-word, so a path or an identifier
 * overflows its box instead of becoming two unreadable halves.
 */
export function wrapToWidth(label: string, fontSize: number, maxTextWidth: number): string[] {
  const advance = fontSize * CHARACTER_EM
  const limit = Math.max(6, Math.floor(maxTextWidth / advance))

  return label.split('\n').flatMap(line => {
    const words = line.split(/\s+/u).filter(Boolean)

    if (!words.length) {
      return ['']
    }

    const out: string[] = []
    let current = ''

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word

      if (candidate.length <= limit || !current) {
        current = candidate

        continue
      }

      out.push(current)
      current = word
    }

    if (current) {
      out.push(current)
    }

    return out
  })
}

/**
 * A label as the reader should see it.
 *
 * Mermaid lets a label be quoted, carry `<br/>` as a line break and escape a
 * bracket with an entity. Only those three are honoured: anything else stays the
 * characters the author typed, which is what a diagram label almost always is.
 */
export function cleanLabel(raw: string | undefined): string {
  if (raw === undefined) {
    return ''
  }

  return raw
    .trim()
    .replace(/^"(.*)"$/su, '$1')
    .replace(/^'(.*)'$/su, '$1')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .trim()
}

/**
 * One piece of text, placed.
 *
 * Every diagram in this folder hands its labels to the renderer as boxes rather
 * than as SVG text, and this is the shape they arrive in. `react-native-svg`'s
 * own `Text` measures on the native side with metrics that differ per platform,
 * so a label inside the drawing would sit outside its box on one target and
 * inside it on another — and text inside an `Svg` is neither selectable nor
 * reachable by a screen reader, which a diagram's labels are the whole meaning
 * of.
 */
export interface DiagramText {
  x: number
  y: number
  width: number
  height: number
  lines: string[]
  align: 'left' | 'center' | 'right'
  /** `ink` is the body colour; `muted` is for a frame's keyword and a value. */
  tone: 'ink' | 'muted'
  /** The size this run is set at, which is not always the diagram's own. */
  size: number
  /**
   * Whether the text paints the block's own background behind itself.
   *
   * A message label sits on top of a lifeline, and a lifeline drawn through the
   * middle of a word is unreadable. A chip is cheaper and more robust than
   * clipping the line, which would need to know the text's real width.
   */
  chip?: boolean
}
