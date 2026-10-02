/**
 * What a team's Hermie Web asks its build to look like (ADR-0025, part 2).
 *
 * The service serves three optional fields in `/hermie/config.json` — a name,
 * an accent and a theme preset — and this is the whole of what the app does
 * with them. Two rules, and the second is the one that keeps the feature
 * honest:
 *
 *  1. **The name is a label, applied wherever the app names itself.** Nothing
 *     is stored: it is read from the bootstrap on every render, so an operator
 *     who changes it changes every tab on the next load.
 *  2. **The accent and the theme are a STARTING POINT, never an override.**
 *     They are applied once, to a reader who has not chosen for themselves, and
 *     never again. An operator's default that reached back in and undid
 *     somebody's choice would be a setting that fights its own reader — and it
 *     would do it silently, on a device the operator cannot see.
 *
 * "Has not chosen" is decided against what is on disk, not against what the
 * store happens to hold: the store is seeded with the app's defaults before the
 * hydrate finishes, so a check made against it would find "the default" for
 * every reader and re-apply the brand over a choice on every launch.
 *
 * Off the web this module is inert, because there is no service to be branded
 * by — `loadHermieWebConfig` answers `null` there and everything below reads
 * that as "no branding".
 */
import type { HermieWebBranding, HermieWebConfig } from '../../gateway/web-config'
import { strings } from '../../i18n/strings'
import { ACCENTS, type AccentName } from '../../ui/tokens'

/** The name this build calls itself, branded or not. */
export function brandName(branding: HermieWebBranding | null | undefined): string {
  const name = (branding?.name ?? '').trim()

  // A cap rather than trust: this string lands in a header and in a title, and
  // a service that sent a paragraph would push a chat's own name off the row.
  return name ? name.slice(0, 64) : strings.app.name
}

/** An accent the app actually has, or `null` for anything else. */
export function brandAccent(branding: HermieWebBranding | null | undefined): AccentName | null {
  const accent = (branding?.accent ?? '').trim()

  return accent && accent in ACCENTS ? (accent as AccentName) : null
}

/** A theme preset name, or `null`. The store validates the name itself. */
export function brandTheme(branding: HermieWebBranding | null | undefined): string | null {
  const theme = (branding?.theme ?? '').trim()

  return theme ? theme : null
}

/**
 * The accent a chat the reader has not coloured is drawn in.
 *
 * A module value rather than a store, and that is a deliberate exception worth
 * justifying: it is written EXACTLY once, from the bootstrap, before the chat
 * list has painted, and never again for the life of the tab. A store would add
 * a subscription to every row to carry a value that cannot change, and a prop
 * would have to be threaded through six components to reach `useChatAccent`.
 *
 * `null` is the app's own default, which is what every native build has and
 * what a web build with no branding has.
 */
let defaultAccent: AccentName | null = null

export function setDefaultAccent(accent: AccentName | null): void {
  defaultAccent = accent
}

/** The accent to draw a chat in, given whatever the reader chose. */
export function accentOrBrand(chosen: AccentName): AccentName {
  return chosen === 'default' && defaultAccent ? defaultAccent : chosen
}

export interface BrandingTarget {
  /** Whether this reader has a theme of their own on disk. */
  chosenTheme: boolean
  setTheme: (preset: string) => void
}

/**
 * Apply the service's defaults to a reader who has chosen nothing.
 *
 * Answers what it actually did, so a caller can say so and a test can assert
 * on it rather than on the absence of an effect.
 */
export function applyBranding(
  config: HermieWebConfig | null,
  target: BrandingTarget
): { accent: boolean; theme: boolean } {
  const branding = config?.branding ?? null
  const accent = brandAccent(branding)
  const theme = brandTheme(branding)
  const applied = { accent: false, theme: false }

  if (accent) {
    // The team's accent stands in for "no colour chosen", which is what every
    // chat starts as. A chat the reader HAS coloured is untouched, because
    // `accentOrBrand` only answers for `default`.
    setDefaultAccent(accent)
    applied.accent = true
  }

  if (theme && !target.chosenTheme) {
    target.setTheme(theme)
    applied.theme = true
  }

  return applied
}

/**
 * Whether a service feature is on for this deployment.
 *
 * An absent flag object is every Hermie Web too old to send one and every
 * platform that is not the web, and it reads as ON — a build must not lose a
 * feature because the thing in front of it has never heard of it.
 */
export function featureOn(config: HermieWebConfig | null, flag: 'userChats' | 'messageCache' | 'selfUpdate'): boolean {
  return config?.flags?.[flag] !== false
}
