/**
 * What each Settings category LOOKS like: its mark, its colour and the one
 * sentence that says what it is for.
 *
 * ## Why this is its own module
 *
 * The same three facts are needed in two places that cannot see each other. The
 * category LIST draws the mark beside every row, and a category PAGE draws the
 * same mark large on its header card — and a page is imported by `routes.tsx`,
 * so a page reaching into that registry for its own icon would be a cycle. This
 * is the cycle-free half, exactly as `route-meta.ts` is for titles: no page, no
 * registry, nothing but the route names it keys on.
 *
 * ## The colours are the accent set, and the set is narrower than it looks
 *
 * Every tint is a name out of `ACCENTS` — no new colour enters the app for this.
 * Three of them are deliberately never used here:
 *
 *  - **green** and **red** are what `ok` and `danger` mean. A green mark beside
 *    Memory would read as "Memory is fine" rather than as "Memory", and the one
 *    thing a status colour must not do is turn up as decoration.
 *  - **lime** is the studio's ring colour. White on its `fill` measures 1.18 : 1,
 *    so a white mark on it is a mark nobody can see, and its `bubble` form is a
 *    dark olive that reads as the green above.
 *
 * The amber of the `needs input` presence bead has no accent twin, so it needs no
 * exclusion: the accent called `orange` is `#B04C08`, a burnt orange, against a
 * bead at `#E09000`. They are not the same colour and they are not the same shape.
 *
 * `CATEGORY_TINTS` is that narrowing written down, and `settings-look.test.tsx`
 * holds this table to it — along with the rule that no two categories NEXT to
 * each other in the list share a tint, in every build (the list is shorter where
 * this platform has no voice, or where a release build drops Advanced).
 *
 * Every one of the eight is used, and none of them more than twice. That is not a
 * rule the test enforces — it is a budget, and a twelfth category will spend
 * the rest of it — but it is why the table looks arbitrary and is not: the second
 * use of a hue is always most of the list away from the first.
 *
 * ## The well is the accent's `bubble`, not its `fill`
 *
 * The mark is white on a saturated square, so the square is a background for
 * something that has to be seen. `fill` has no contrast floor of its own by
 * design — it is a ring, a swatch and a wash (see `contrast.ts`) — while
 * `bubble` is the one value in the swatch that `npm run contrast:check` already
 * measures white against, at 4.5 : 1, for every accent in the set. So the well
 * reads a colour the gate is already holding to a floor rather than inventing
 * one, and a category given any accent at all stays legible.
 */
import { WEB_GATEWAY_BASE_URL } from '../../../gateway/web-config'
import { strings } from '../../../i18n/strings'
import type { IconName } from '../../../ui/Icon'
import { ACCENTS, type AccentName } from '../../../ui/tokens'
import type { SettingsCategoryName } from './route-names'

export interface SettingsCategoryLook {
  icon: IconName
  /** A name out of `ACCENTS`. Never a hex, and never one of the status hues. */
  tint: AccentName
  /** One sentence: what this category is for. Called, so it follows the language. */
  blurb: () => string
}

/**
 * The accents a category may be given, in the order they were handed out.
 *
 * Written as a list rather than derived from `ACCENT_ORDER` minus three, because
 * the three that are missing are missing for three different reasons and the
 * module doc above is where they are argued.
 */
export const CATEGORY_TINTS = [
  'default',
  'indigo',
  'violet',
  'magenta',
  'orange',
  'teal',
  'graphite',
  'slate'
] as const satisfies readonly AccentName[]

const blurb = () => strings.settings.categories.blurb

export const SETTINGS_CATEGORY_LOOK: Record<SettingsCategoryName, SettingsCategoryLook> = {
  Account: { icon: 'person', tint: 'default', blurb: () => blurb().account },
  // Singular on Hermie Web: the server in front of it already fixed the
  // gateway, so there is no "others it knows about" to mention there.
  Gateways: { icon: 'server', tint: 'teal', blurb: () => (WEB_GATEWAY_BASE_URL ? blurb().gateway : blurb().gateways) },
  ChatsMessages: { icon: 'chats', tint: 'indigo', blurb: () => blurb().chats },
  Notifications: { icon: 'bell', tint: 'orange', blurb: () => blurb().notifications },
  Memory: { icon: 'book', tint: 'slate', blurb: () => blurb().memory },
  Appearance: { icon: 'contrast', tint: 'violet', blurb: () => blurb().appearance },
  Privacy: { icon: 'lock', tint: 'teal', blurb: () => blurb().privacy },
  Voice: { icon: 'mic', tint: 'orange', blurb: () => blurb().voice },
  Capabilities: { icon: 'bolt', tint: 'magenta', blurb: () => blurb().capabilities },
  Advanced: { icon: 'sliders', tint: 'graphite', blurb: () => blurb().advanced },
  About: { icon: 'info', tint: 'indigo', blurb: () => blurb().about }
}

/** The colour a category's mark is drawn ON. See the module doc for why `bubble`. */
export function categoryWell(name: SettingsCategoryName): string {
  return ACCENTS[SETTINGS_CATEGORY_LOOK[name].tint].bubble
}

/** Whether a route is one of the eleven categories, which is what earns a header card. */
export function isSettingsCategory(route: string): route is SettingsCategoryName {
  return route in SETTINGS_CATEGORY_LOOK
}
