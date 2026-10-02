/**
 * What a text field does about focus, which on every platform is now nothing
 * visible.
 *
 * ## The ring that was here, and why it went
 *
 * A browser rings the `<input>`, which is not the control: every editable thing
 * in this app is a TEXT BOX INSIDE A PILL, and the input's own box is the text
 * line — 20pt inside a 44pt search field. So the user agent's ring was a small
 * rectangle floating in the middle of the control it was supposed to be marking,
 * in the system accent, with square corners on a pill. This hook replaced it
 * with the app's own ring drawn on the pill.
 *
 * That was the right fix to the wrong question. **A text field is the one
 * control that says what it is without being ringed**: it has a box, a caret
 * blinking in it, and a keyboard aimed at it. The ring was a second and louder
 * announcement of something the caret had already made, on the element somebody
 * looks at for most of the time they spend in this app — and on the composer,
 * which is nearly always the focused element, it never went away. So the ring is
 * gone and the suppression stays: the user agent draws nothing, and neither do
 * we.
 *
 * ## What this is NOT
 *
 * It is not a decision about focus indication in general, and the difference
 * matters enough to state where somebody will read it before changing it back.
 * Every button, row, tab and link in the app still rings on `:focus-visible`
 * (`public/index.html`), because those have no caret and no other way to say
 * where the keyboard is. A build that dropped those would be one nobody could
 * drive without a mouse. The exemption is for inputs, and only inputs.
 *
 * ## Why the hook is still here
 *
 * Two things that are not a ring: it suppresses the user agent's own, which is
 * the half of the job that never stopped being necessary, and it reports whether
 * the field has focus, which a caller may want for something that is not an
 * outline.
 */
import { useCallback, useState } from 'react'
import type { TextStyle, ViewStyle } from 'react-native'

import { NO_USER_AGENT_FOCUS_RING } from '../platform/text-field-web'

export interface FocusRing {
  focused: boolean
  /** Spread onto the `TextInput`: tracks focus and suppresses any native ring. */
  fieldProps: {
    // Untyped events: a `TextInput`'s focus and blur events have different
    // shapes on the two platforms and neither half of this reads them.
    onBlur: () => void
    onFocus: () => void
    style: TextStyle
  }
  /**
   * What to put on the box that IS the control — the pill, not the input.
   *
   * Empty, on every platform and in both states. It is kept in the shape rather
   * than removed so a caller that spreads it keeps working, and so that the
   * place somebody would add a ring back is the place that explains why there
   * is not one.
   */
  ringStyle: ViewStyle
}

/** Nothing, and the same nothing every time, so no caller re-renders on it. */
const NO_RING: ViewStyle = {}

export function useFocusRing(): FocusRing {
  const [focused, setFocused] = useState(false)

  const onFocus = useCallback(() => setFocused(true), [])
  const onBlur = useCallback(() => setFocused(false), [])

  return {
    focused,
    fieldProps: { onBlur, onFocus, style: NO_USER_AGENT_FOCUS_RING },
    ringStyle: NO_RING
  }
}
