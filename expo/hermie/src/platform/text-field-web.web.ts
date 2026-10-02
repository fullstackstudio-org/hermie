/**
 * The browser half of `text-field-web.ts`. Read that file first; this one is
 * only the three answers.
 */
import type { TextInputProps, TextStyle } from 'react-native'

export const HAS_USER_AGENT_FOCUS_RING = true

/**
 * `outline-style: none`, and nothing else.
 *
 * Suppressing a focus ring is only defensible when something replaces it, so
 * this is deliberately not exported as a convenience: `useFocusRing` is what
 * callers reach for, and it hands back both halves together.
 *
 * `outlineWidth: 0` would be the type-safe spelling, and it does not work: a
 * user agent's ring is `outline-style: auto`, and with `auto` the browser picks
 * the width itself and ignores `outline-width`. The style has to remove the
 * STYLE. React Native's own `outlineStyle` type has no `'none'` — the property
 * arrived for a platform where a ring is always drawn — hence the cast, which
 * is the one place the web's wider value set is admitted.
 */
export const NO_USER_AGENT_FOCUS_RING = { outlineStyle: 'none' } as unknown as TextStyle

/**
 * One row.
 *
 * React Native Web maps `rows` straight onto the `<textarea>`, and with nothing
 * passed the browser's own default of 2 applies — which is why the composer's
 * field was 54px tall in a tab and 32 on a phone, holding one line of text in
 * both.
 *
 * It is a prop BAG rather than a number because `rows` is not in React Native's
 * `TextInputProps` at all: the prop exists only on this platform, so the cast
 * that admits it lives here, once, next to the reason.
 */
export const ONE_ROW = { rows: 1 } as unknown as Partial<TextInputProps>

/**
 * `aria-invalid`, which is the whole of it.
 *
 * A field the gateway rejected was marked by turning its hairline the danger
 * colour, and that is the entire message: someone who cannot tell the red from
 * the grey is told nothing at all. The attribute is not in React Native's
 * `TextInputProps` — the property exists only on this platform — hence the
 * cast, next to the reason, as `ONE_ROW` does it for `rows`.
 */
export const INVALID_FIELD = { 'aria-invalid': true } as unknown as Partial<TextInputProps>

/**
 * Grow a `<textarea>` to its content, up to `maxHeight`.
 *
 * `scrollHeight` only reports the content when the box is not already big
 * enough to hold it, so the height is zeroed first and then read. Both the
 * element and the reader are border-box here (React Native Web sets it), so
 * `scrollHeight` already includes the padding and the two numbers are directly
 * comparable.
 *
 * It takes whatever a `TextInput` ref holds rather than a typed element: on
 * this platform that ref IS the DOM node, and the duck-typing keeps the
 * contract in the shared file free of DOM types.
 */
export function growToContent(node: unknown, maxHeight: number): void {
  const element = node as { scrollHeight?: number; style?: { height: string } } | null

  if (!element || typeof element.scrollHeight !== 'number' || !element.style) {
    return
  }

  element.style.height = '0px'
  element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
}
