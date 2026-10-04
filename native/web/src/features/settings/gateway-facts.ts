/**
 * What "This gateway" says that takes a decision: whether the web client the plugin carries is the one
 * this page is running, and how the plugin's modules read.
 *
 * The plugin's advert (`core/advert.ts`) names the client build it carries (`web`: version and an
 * abbreviated commit). A page that was loaded before the plugin updated is still the old build, and
 * the advert is the only place that says so: there is no release feed to ask. So "is an update known"
 * is a comparison of two builds, never of two version numbers by order (the plugin may carry an older
 * build on purpose; the page says they differ and lets the reader reload).
 */
import type { WebPluginAdvert } from '../../core/advert'
import { bundledWebClient } from '../../core/advert'

/** What the plugin says about its web client, set against the page's own build. */
export type WebUpdate =
  /** No plugin, or one that does not say which client it carries (or switched the client off). */
  | { kind: 'unknown' }
  /** The plugin carries this very build. */
  | { kind: 'current' }
  /** The plugin carries another build; `carried` is how to name it (`0.3.0 (abc1234)`). */
  | { kind: 'differs'; carried: string }

export interface PageBuild {
  /** The client's own semver. */
  version: string
  /** The 40-character commit it was built from. */
  commit: string
}

/** A commit as the advert abbreviates it (up to 40 hex digits) against the page's full one. */
const sameCommit = (page: string, carried: string): boolean =>
  carried !== '' && page !== '' && (page.startsWith(carried) || carried.startsWith(page))

/** `0.3.0 (abc1234)`, or what there is of it. */
export function carriedLabel(version: string, commit: string): string {
  const short = commit.slice(0, 7)

  return version && short ? `${version} (${short})` : version || short
}

export function webUpdateOf(advert: WebPluginAdvert | null, page: PageBuild): WebUpdate {
  const carried = bundledWebClient(advert)

  if (!carried) {
    return { kind: 'unknown' }
  }

  // The commit settles it where the plugin gave one; a version number only where it did not.
  const same = carried.commit !== '' ? sameCommit(page.commit, carried.commit) : carried.version === page.version

  return same ? { kind: 'current' } : { kind: 'differs', carried: carriedLabel(carried.version, carried.commit) }
}

/** A module's state as the plugin wrote it, or `null` for a word this build has no translation for. */
export const MODULE_STATES = ['on', 'off', 'planned'] as const

export type ModuleState = (typeof MODULE_STATES)[number]

export const asModuleState = (value: string): ModuleState | null =>
  (MODULE_STATES as readonly string[]).includes(value) ? (value as ModuleState) : null
