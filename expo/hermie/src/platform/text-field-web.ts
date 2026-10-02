/**
 * The three things a `<textarea>` or an `<input>` does that a native field does
 * not, in one seam so the components stay one component.
 *
 * React Native Web renders a `TextInput` as a real form control, and a form
 * control arrives with a user-agent stylesheet attached. Every item here is a
 * browser default that contradicts a decision the design already made, rather
 * than a difference of opinion between platforms:
 *
 *  - **The focus ring.** A browser draws its own — on Safari a 1px auto outline
 *    in the system accent, drawn tight around the INPUT box and therefore
 *    entirely inside the pill that input lives in. It is the right idea and the
 *    wrong shape; the app draws its own on the pill instead.
 *  - **Two rows.** A `<textarea>` with no `rows` is two lines tall, and the
 *    composer's field is one line that grows. The native side has no such
 *    default, which is why the composer looked right on a phone and wrong in a
 *    tab.
 *  - **No growth.** A native multiline field sizes itself to its content; a
 *    textarea does not, so the growth has to be driven from the content height.
 *
 * Everything here is a no-op on iOS and Android — see the `.web.ts` sibling for
 * the implementations and the reasons the numbers are what they are.
 */
import type { TextInputProps, TextStyle } from 'react-native'

/** Whether this platform draws a focus ring the app has to replace. */
export const HAS_USER_AGENT_FOCUS_RING = false

/** Style that suppresses that ring. Empty where there is none. */
export const NO_USER_AGENT_FOCUS_RING: TextStyle = {}

/**
 * What to spread onto a multiline field that should start one line tall.
 *
 * Empty natively: nothing there has a row count and a `TextInput` sizes itself
 * from its content already.
 */
export const ONE_ROW: Partial<TextInputProps> = {}

/**
 * What to spread onto a field whose value has been rejected.
 *
 * Empty natively: neither platform has a "this control is invalid" flag a
 * screen reader reads, and the error text under the field is a sibling a reader
 * reaches by moving forward. The web does have one — see the `.web.ts` sibling.
 */
export const INVALID_FIELD: Partial<TextInputProps> = {}

/**
 * Resize a multiline field to its content, capped.
 *
 * A native `TextInput` does this by itself, so this is deliberately a no-op
 * rather than a re-implementation: driving the height from JavaScript on a
 * platform that already measures it is how a field ends up one frame behind
 * its own text.
 */
export function growToContent(_node: unknown, _maxHeight: number): void {
  // See above: the platform owns this.
}
