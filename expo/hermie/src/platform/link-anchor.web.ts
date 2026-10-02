/**
 * The browser half of `link-anchor.ts`. Read that file first.
 *
 * React Native Web renders a `Text` that carries `href` as an `<a>` — the
 * element, not an imitation of one. `accessibilityRole="link"` does not: the
 * role table it maps through has `button` and `list` and no `link` at all, so
 * what shipped was a `role="link"` div with no `href`, which a keyboard cannot
 * reach, a middle click does not open, and "copy link address" does not see.
 *
 * `hrefAttrs` is how RNW passes `rel`, `target` and `download` through to the
 * element. It is not in React Native's `TextProps`, because the prop exists
 * only on this platform — hence the cast, which lives here, once, next to the
 * reason, exactly as `text-field-web.web.ts` does it for `rows`.
 *
 * ## Why `noreferrer` and not only `noopener`
 *
 * `Linking.openURL` already passed `noopener`, so the destination could never
 * reach back through `window.opener`. What it did not pass is `noreferrer`, so
 * the full URL of the page the link was read on travelled to the destination in
 * the `Referer` header. A transcript is a private conversation with an agent and
 * its URL names the chat; nothing outside this origin has any business learning
 * it. Both tokens go on every anchor.
 *
 * ## Why only `http(s)` opens a tab
 *
 * `target="_blank"` on a `mailto:` or a `tel:` hands the browser a navigation it
 * answers by launching a handler, and the tab it opened to do it stays behind
 * empty. Those two keep the current tab, where the handler takes over and the
 * page is untouched.
 */
import type { TextProps } from 'react-native'

export const HAS_ANCHOR_LINKS = true

/** Schemes that should leave the page rather than take it over. */
const NEW_TAB = /^https?:/i

export function anchorProps(href: string): Partial<TextProps> | null {
  const hrefAttrs = NEW_TAB.test(href)
    ? { rel: 'noopener noreferrer', target: '_blank' }
    : { rel: 'noopener noreferrer' }

  return { href, hrefAttrs } as unknown as Partial<TextProps>
}
