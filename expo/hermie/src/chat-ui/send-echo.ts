/**
 * Telling a report of the NEXT message from an echo of the one just sent.
 *
 * A controlled `TextInput` is two copies of the text, and a send clears only
 * one of them directly: the composer's `value`. The `UITextView` behind it is
 * cleared later, by React Native pushing that value across after the next
 * commit — and React Native keeps the two in step with an event counter that
 * lets the native side throw a push away. Every edit made in the view bumps its
 * count; JavaScript stamps each push with the newest count it has seen; the
 * view drops any push whose stamp is not its own current count
 * (`RCTTextInputComponentView -setTextAndSelection:`, and the same guard on
 * `-updateState:oldState:`). That is the right rule for a keystroke racing a
 * programmatic edit, and exactly the wrong one for a send:
 *
 *  - **A key lands before the clear renders.** Events reach JavaScript in
 *    groups, one task per group, and a group is rendered only after all of it
 *    has run. Return and the next key in one group — which is what a keyboard
 *    produces whenever the JavaScript thread is busy, as it is while a reply
 *    streams — hand the composer a change report the view made from the field
 *    as it stood BEFORE the send: `hello` + `n`.
 *  - **A key lands before the clear arrives.** The clear goes out stamped with
 *    the Return's count; a key typed while it is in flight moves the view's
 *    count on, the view drops the clear, and its next report is again
 *    `hello` + `n`.
 *
 * Either way the report is taken at face value, becomes the draft, and the sent
 * message is back in the field with the start of the next one stuck to it.
 *
 * ## The shape of an echo, exactly
 *
 * A view that dropped a push still holds the last text it reported, and the
 * composer rewrote that report to `expected`. So the view holds `sent +
 * expected`, and its next report is that plus ONE native edit — a key, a
 * Backspace, one paste. Anything else is not an echo, and this function says
 * so:
 *
 *  - the report must begin with the sent text, cut at a character boundary;
 *  - what is left after it must be one keystroke from `expected`;
 *  - and the report must NOT itself be one keystroke from `expected` —
 *    because one key on the field as it should be is the reader typing into a
 *    view that did clear, and that is never touched. This is what keeps the
 *    first key of the next message, even one that repeats the message before.
 *
 * "One keystroke" is one character in, out, or replaced — see `oneKeystroke`
 * for the keyboards that type by replacing.
 *
 * A paste into a field that did clear fails the second test outright: it is
 * one keystroke from `expected` only as a WHOLE, never after a prefix comes off. So
 * a wrong guess leaves text on screen rather than removing it — except for the
 * one shape this cannot tell apart from an echo: a single insertion that is the
 * sent text plus one more character, like QuickType's `Thanks ` right after
 * `Thanks` went. `Composer.tsx` closes that gap in TIME instead: see
 * `SEND_ECHO_WINDOW_MS`.
 *
 * ## Characters, not code units
 *
 * An edit is counted in user-perceived characters, approximately: a code point
 * together with whatever extends it — combining marks, variation selectors, a
 * skin-tone modifier, a zero-width joiner and the code point after it, emoji tag
 * characters, a pair of regional indicators (a flag), and the vowel and final
 * jamo of a decomposed Hangul syllable (iOS types precomposed syllables, so
 * that last one is for text that arrives some other way). One key can type
 * `👍🏽`, which is two code points, and counting it as two edits would read it
 * as a paste. Cutting the sent text off the front only at such a boundary is
 * what stops `👍` then `👍🏽` from leaving a lone `🏽` behind. `Intl.Segmenter`
 * would be the exact answer and is not something every engine this ships on
 * provides, so this is the small rule that covers what a keyboard produces.
 */

/**
 * How long after a send, or after the last echo it rewrote, a report can still
 * be an echo.
 *
 * Only edits already in flight can echo — keys the view took before it heard
 * about the send. That is roughly one frame of the UI thread after the clear is
 * committed, but the report of such a key reaches JavaScript only when the
 * JavaScript thread is next free, and on a chat screen it may be busy rendering
 * a streaming reply. Half a second covers any stall short of a visible freeze.
 *
 * It is also as short as that for the reader's sake: the one input that looks
 * exactly like an echo (the sent text plus one character, inserted in one go)
 * is only mistaken for one inside this window, and nobody sends a message and
 * then pastes or picks a suggestion starting with the whole of it inside half a
 * second. The deadline moves on with every echo it catches, because a fast
 * typist can beat each rewrite to the view the way they beat the clear.
 */
export const SEND_ECHO_WINDOW_MS = 500

const ZERO_WIDTH_JOINER = '\u200D'
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u
const EXTENDS_PREVIOUS = /^(?:\p{M}|\u200D|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]|[\u1160-\u11FF\uD7B0-\uD7FF])$/u

/** The text as user-perceived characters, approximately. See the module note. */
export function characters(text: string): string[] {
  const out: string[] = []
  let joinNext = false
  let flagOpen = false

  for (const point of text) {
    const last = out.length - 1
    const flag = REGIONAL_INDICATOR.test(point)

    if (last >= 0 && (joinNext || EXTENDS_PREVIOUS.test(point) || (flag && flagOpen))) {
      out[last] += point
      flagOpen = false
    } else {
      out.push(point)
      flagOpen = flag
    }

    joinNext = point === ZERO_WIDTH_JOINER
  }

  return out
}

/**
 * How many characters one contiguous edit replaces to turn `from` into `to`:
 * removed plus inserted, after the longest shared head and tail.
 */
export function editSize(from: string, to: string): number {
  const a = characters(from)
  const b = characters(to)
  const shorter = Math.min(a.length, b.length)
  let head = 0

  while (head < shorter && a[head] === b[head]) {
    head += 1
  }

  let tail = 0

  while (tail < shorter - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1
  }

  return a.length - head - tail + (b.length - head - tail)
}

/**
 * Could one key have turned `from` into `to`?
 *
 * One character in or out, and also one character REPLACED — the same count
 * on both sides, the last-typed one swapped for another. That second shape is
 * how some keyboards type rather than a correction: iOS's Korean keyboard
 * builds a syllable by rewriting the one before the caret (`ㄴ` then `ㅔ` is
 * `네`, not `ㄴㅔ` — React Native special-cases `ko-KR` for exactly this), and
 * the Japanese 12-key keyboard cycles `か` to `き` on a second tap and turns
 * `か` into `が` on the voiced-sound key. Counted as two edits, such a key read
 * as something other than typing, and a syllable the reader had just typed
 * could be taken for an echo and removed.
 *
 * Reading it as typing everywhere has one cost, on the safe side: a Backspace
 * inside an echo of a ONE-character message (`k` sent, `n` caught, Backspace
 * reports `k`) looks the same, and leaves the sent `k` on screen rather than
 * deleting anything.
 */
function oneKeystroke(from: string, to: string, { replacesSpace = true }: { replacesSpace?: boolean } = {}): boolean {
  const size = editSize(from, to)

  if (size <= 1) {
    return true
  }

  const a = characters(from)
  const b = characters(to)

  if (size !== 2 || a.length !== b.length) {
    return false
  }

  if (replacesSpace) {
    return true
  }

  const at = a.findIndex((character, index) => character !== b[index])

  return !/\s/u.test(a[at] ?? '') && !/\s/u.test(b[at] ?? '')
}

/**
 * The report with the sent text taken off the front, or `null` when it is the
 * reader's own edit and must be taken as it is.
 *
 * @param sent     What the field held when the message went.
 * @param expected What the field should hold now, as far as JavaScript knows.
 * @param report   What the text view just said it holds.
 */
export function withoutSentText(sent: string, expected: string, report: string): string | null {
  if (!sent || oneKeystroke(expected, report)) {
    return null
  }

  const head = characters(sent)
  const all = characters(report)

  if (all.length < head.length || head.some((character, index) => all[index] !== character)) {
    return null
  }

  const rest = all.slice(head.length).join('')

  /*
    A replaced character counts here only when neither side of it is a space.
    Taking text AWAY is the direction a mistake costs words in, and the one
    replacement that is not a Korean or kana key is QuickType finishing a word:
    `ok` sent, a fast `o` caught, then the suggestion turns `o` into `ok ` —
    which is the sent text plus a space where the `o` was. A syllable or a kana
    key never types a space, and a suggestion always ends with one.
  */
  return oneKeystroke(expected, rest, { replacesSpace: false }) ? rest : null
}
