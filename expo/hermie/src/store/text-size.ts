/**
 * How big the words in a transcript are.
 *
 * ## It multiplies Dynamic Type; it does not replace it
 *
 * The platform already has a text size and the reader has already set it. What
 * this adds is a factor ON TOP of that, for the case Dynamic Type cannot
 * express: a reader who wants the app's chrome the size the system says and the
 * CONVERSATION bigger, because the conversation is the part they read for
 * minutes at a time. So the scale is applied to the transcript's type tokens and
 * to nothing else — the header pill, the composer, the chat list and every sheet
 * keep the size the system asked for.
 *
 * That is also why it is a multiplier rather than four absolute sizes. Absolute
 * sizes would be a second, competing accessibility setting, and the reader who
 * had already turned the system one up would get the app's idea of "Large"
 * instead of their own.
 *
 * ## The numbers
 *
 * Small is a step down rather than a squeeze — 15pt body instead of 17 — because
 * the one thing a reader asks for at the small end is more of the conversation
 * on screen, not smaller letters for their own sake. Extra large is where the
 * bubble's own maximum width starts doing the work instead, which is why the top
 * of the range stops at a third bigger rather than at double: past that the
 * transcript is a column of two-word lines and the setting has stopped helping.
 *
 * Line heights scale with the size rather than staying put, so the leading stays
 * proportional — a 22pt line at a 17pt body and a 22pt line at a 22pt body are
 * two different paragraphs.
 */

export type TextSize = 'small' | 'default' | 'large' | 'xlarge'

/** The order the pickers draw, smallest first. */
export const TEXT_SIZE_ORDER: readonly TextSize[] = ['small', 'default', 'large', 'xlarge']

export const DEFAULT_TEXT_SIZE: TextSize = 'default'

/** What each step multiplies the transcript's type tokens by. */
export const TEXT_SIZE_SCALE: Record<TextSize, number> = {
  small: 0.88,
  default: 1,
  large: 1.15,
  xlarge: 1.3
}

/**
 * Read one defensively: it arrives from disk AND from a gateway another build
 * wrote, and an unknown value is the reader's own default rather than an error.
 */
export function asTextSize(value: unknown): TextSize | undefined {
  return typeof value === 'string' && (TEXT_SIZE_ORDER as readonly string[]).includes(value)
    ? (value as TextSize)
    : undefined
}

/** The factor for a size, with the default's 1 for anything unrecognised. */
export function textSizeScale(size: TextSize | undefined): number {
  return TEXT_SIZE_SCALE[size ?? DEFAULT_TEXT_SIZE] ?? 1
}
