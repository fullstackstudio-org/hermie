/**
 * What a Return means, as one decision instead of two.
 *
 * The composer asks twice, from two places that cannot be merged: `onKeyPress`,
 * where a platform that reports modifiers hands them over and the insertion has
 * already been accepted, and `onSubmitEditing`, where `submitBehavior: 'submit'`
 * suppressed the insertion and the modifier has to be asked for separately. The
 * two sites ACT differently — one lets the platform insert the newline, the
 * other has to insert it by hand — but they must never DECIDE differently, and
 * before this they each held their own copy of the rule.
 *
 * The rule, in the order it is applied:
 *
 *  - anything but Return is not ours;
 *  - Command or Control sends, on every platform, because only a physical
 *    keyboard can produce a modifier and that chord means send everywhere;
 *  - Shift is the newline, always — this is the branch the owner's stuck-Shift
 *    report is about, and it is only ever as right as the `shift` handed in;
 *  - with no hardware keyboard a bare Return is a newline, because on a phone
 *    the key on the software keyboard is the one that breaks a line;
 *  - otherwise it sends.
 *
 * Pure, and deliberately unaware of where `shift` came from. On iOS a text
 * field's key event carries no modifier state at all (see
 * `src/platform/keyboard-modifiers.ts`), so the answer arrives from the keyboard
 * seam — and a seam that lies is a bug in the seam, not in this table.
 */

export interface KeyModifiers {
  shift?: boolean
  /** Command on a Mac, Windows/Super elsewhere. */
  meta?: boolean
  ctrl?: boolean
  /** Whether a physical keyboard is attached at all. */
  hardwareKeyboard?: boolean
}

/**
 * `send` — submit the draft.
 * `newline` — break the line, however this caller has to do that.
 * `ignore` — not a key this decides anything about.
 */
export type SendDecision = 'send' | 'newline' | 'ignore'

export function shouldSend(key: string, modifiers: KeyModifiers = {}): SendDecision {
  if (key !== 'Enter') {
    return 'ignore'
  }

  if (modifiers.meta || modifiers.ctrl) {
    return 'send'
  }

  if (modifiers.shift) {
    return 'newline'
  }

  return modifiers.hardwareKeyboard ? 'send' : 'newline'
}
