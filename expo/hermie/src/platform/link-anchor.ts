/**
 * What a markdown link is, on a platform that has no anchors.
 *
 * On iOS and Android a link is a run of `Text` with an `onPress`: there is no
 * document, nothing to focus, and `Linking.openURL` is the only way out of the
 * app. That is what this file says, by saying nothing — `anchorProps` returns
 * `null` and `Inline.tsx` falls back to the press.
 *
 * The browser half is `link-anchor.web.ts`, and it is not a cosmetic
 * difference: a press handler on a `div` throws away keyboard focus,
 * middle-click, cmd-click, "copy link address", the URL in the status bar and
 * the referrer policy, all of which a real `<a href>` brings for free.
 */
import type { TextProps } from 'react-native'

/** Whether a link renders as a real anchor element on this platform. */
export const HAS_ANCHOR_LINKS = false

/**
 * The props that turn a `Text` into an anchor, or `null` where there is none.
 *
 * `null` means "render the press instead", which is the whole native story and
 * also the browser's answer for an href it must not navigate to.
 */
export function anchorProps(_href: string): Partial<TextProps> | null {
  return null
}
