/**
 * What a Return means in the composer, as one decision.
 *
 * The rule is the native apps' (`expo/hermie/src/chat-ui/send-key.ts`, whose
 * table is tested there), applied to a browser key event:
 *
 *  - anything but Return is not ours;
 *  - a Return that is part of an input method's composition never sends: it
 *    confirms the candidate the reader is choosing (a Japanese, Chinese or
 *    Korean keyboard, a dead-key accent, the iOS predictive bar). The event says
 *    so with `isComposing`, and some engines send the confirming Return after
 *    the composition has ended with the legacy key code 229, so both are read;
 *  - Command or Control sends, on every device;
 *  - Shift is the line break, always;
 *  - otherwise Return sends where a keyboard is attached and breaks the line on
 *    a touch device, where the key on the screen is the only way to write a
 *    second line and the Send button is the way to send.
 *
 * Pure: the caller reads the event and says whether a keyboard is likely there
 * (`platform/input-kind.ts`).
 */

/** The fields of a keyboard event this reads. */
export interface KeyInput {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  /** The event is part of an input method's composition. */
  isComposing?: boolean
  /** The legacy code some engines give the Return that ends a composition. */
  keyCode?: number
}

/**
 * `send`: submit what is typed.
 * `newline`: break the line (the browser inserts it; the composer does nothing).
 * `ignore`: not a key this decides anything about, or a Return that belongs to
 * the input method.
 */
export type SendDecision = 'send' | 'newline' | 'ignore'

export function decideKey(input: KeyInput, keyboardLikely = true): SendDecision {
  if (input.key !== 'Enter') {
    return 'ignore'
  }

  if (input.isComposing || input.keyCode === 229) {
    return 'ignore'
  }

  if (input.metaKey || input.ctrlKey) {
    return 'send'
  }

  if (input.shiftKey) {
    return 'newline'
  }

  return keyboardLikely ? 'send' : 'newline'
}
