/**
 * The plugin advert, with the members only the web client reads.
 *
 * `@hermie/gateway-client/plugin` reads the advert every client shares
 * (capabilities, modules, limits, relay origins). The plugin also publishes two
 * blocks about the browser (plan, "Plugin advert additions"):
 *
 * ```json
 * "web":     {"path": "/dashboard-plugins/hermie/app/index.html", "version": "0.2.0",
 *             "commit": "<12 hex>", "files": 37, "bytes": 1432211},
 * "webPush": {"publicKey": "<87 chars base64url: the uncompressed P-256 point>"}
 * ```
 *
 * with the capability strings `web.client` and `push.webpush.key` and the module
 * `web`. They are read here, on top of the package's reader and with its rules,
 * rather than in the package: the native apps never ask about them, and a
 * change to the package's readers changes the contract corpus the Swift port is
 * checked against (plan, Constraints).
 *
 * The rules, the package's plus two:
 *
 *  - An advert the package refuses (no object, a `v` this build does not know)
 *    is refused here too, whatever `web` it carries.
 *  - A member is read tolerantly: a malformed `web` or `webPush` is `null`, the
 *    rest of the advert stands. Readers ignore members they do not know.
 *  - A block counts only beside its capability. The plugin withdraws both as a
 *    unit (`web` with `web.client`, `webPush` with `push.webpush.key`), so a
 *    block without its string is a plugin in the middle of saying "no", and the
 *    answer is no.
 *  - `modules.web: "off"` is the operator switching the client off. The files
 *    may still be fetchable through the dashboard route; refusing to run then is
 *    a courtesy, not a boundary (plan, "Plugin config additions").
 */
import type { ProfileRow, ProfilesListResult } from '@hermes/shared/gateway-contract'
import {
  HERMIE_PLUGIN_KEY,
  hasPluginCapability,
  type PluginAdvert,
  pluginAdvertOf,
  pluginModuleOn
} from '@hermie/gateway-client/plugin'

/** The capability strings only the web client asks about. */
export const WEB_PLUGIN_CAPABILITIES = {
  /** The plugin carries a client build whose files match its manifest. */
  webClient: 'web.client',
  /** The plugin publishes the public half of the only VAPID key (plan W13). */
  pushWebPushKey: 'push.webpush.key'
} as const

/** The module the operator switches the bundled client on and off with. */
export const WEB_MODULE = 'web'

/** The `web` block: the client build the plugin carries, as it describes it. */
export interface WebClientAdvert {
  /** The document's path under the gateway, prefix not included. */
  path: string
  /** The client's own semver (plan W17). */
  version: string
  /** The source commit, abbreviated; empty when the plugin named none. */
  commit: string
  /** How many files the manifest lists; 0 when not stated. */
  files: number
  /** Their total size in bytes; 0 when not stated. */
  bytes: number
}

/** The `webPush` block. */
export interface WebPushAdvert {
  /** The VAPID public key: 87 characters of base64url, an uncompressed P-256 point. */
  publicKey: string
}

/** The shared advert, plus the two blocks; assignable wherever a `PluginAdvert` is read. */
export interface WebPluginAdvert extends PluginAdvert {
  web: WebClientAdvert | null
  webPush: WebPushAdvert | null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

/** 65 bytes in unpadded base64url are 87 characters; the first byte, 0x04, encodes as `B`. */
const VAPID_PUBLIC_KEY = /^B[A-Za-z0-9_-]{86}$/u

/** Read the `web` block, or `null`. */
export function webClientAdvertOf(value: unknown): WebClientAdvert | null {
  if (!isObject(value) || typeof value.path !== 'string' || !value.path.startsWith('/')) {
    return null
  }

  return {
    path: value.path,
    version: typeof value.version === 'string' ? value.version : '',
    commit: typeof value.commit === 'string' && /^[0-9a-f]{1,40}$/u.test(value.commit) ? value.commit : '',
    files: count(value.files),
    bytes: count(value.bytes)
  }
}

/** Read the `webPush` block, or `null` unless it holds a well-formed key. */
export function webPushAdvertOf(value: unknown): WebPushAdvert | null {
  if (!isObject(value) || typeof value.publicKey !== 'string' || !VAPID_PUBLIC_KEY.test(value.publicKey)) {
    return null
  }

  return { publicKey: value.publicKey }
}

/** Read one advert value, or `null`: the package's reading, plus the two blocks. */
export function webPluginAdvertOf(value: unknown): WebPluginAdvert | null {
  const advert = pluginAdvertOf(value)

  if (!advert || !isObject(value)) {
    return null
  }

  return { ...advert, web: webClientAdvertOf(value.web), webPush: webPushAdvertOf(value.webPush) }
}

/**
 * The advert off a roster, or `null`, chosen the way the package's
 * `pluginAdvert` chooses: every profile is looked at and the default one wins.
 * Repeated here rather than called, because the package returns the reading,
 * and the blocks have to come off the same row it picked.
 */
export function webPluginAdvert(
  roster: ProfilesListResult | readonly ProfileRow[] | null | undefined
): WebPluginAdvert | null {
  const rows: readonly ProfileRow[] = Array.isArray(roster)
    ? roster
    : Array.isArray((roster as ProfilesListResult | null)?.profiles)
      ? ((roster as ProfilesListResult).profiles ?? [])
      : []

  let found: WebPluginAdvert | null = null

  for (const row of rows) {
    const advert = webPluginAdvertOf(isObject(row?.ui_meta) ? row.ui_meta[HERMIE_PLUGIN_KEY] : null)

    if (!advert) {
      continue
    }

    if (row.is_default === true) {
      return advert
    }

    found = found ?? advert
  }

  return found
}

/**
 * The module's state as the operator set it: `on`, `off`, `planned`, or
 * `unknown` when the advert names no such module (an older plugin) or there is
 * no advert at all.
 */
export function webModuleState(advert: PluginAdvert | null): string {
  return advert?.modules[WEB_MODULE] ?? 'unknown'
}

/**
 * Has the operator switched this client off? Only an explicit `off` says so: a
 * plugin too old to know the module, or no plugin at all, is not a refusal.
 */
export function webClientSwitchedOff(advert: PluginAdvert | null): boolean {
  return webModuleState(advert) === 'off'
}

/** The client build the plugin vouches for: module on, capability claimed, block readable. */
export function bundledWebClient(advert: WebPluginAdvert | null): WebClientAdvert | null {
  if (
    !advert?.web ||
    !pluginModuleOn(advert, WEB_MODULE) ||
    !hasPluginCapability(advert, WEB_PLUGIN_CAPABILITIES.webClient)
  ) {
    return null
  }

  return advert.web
}

/** The key Web Push subscribes against, when the plugin publishes one beside its capability. */
export function webPushPublicKey(advert: WebPluginAdvert | null): string | null {
  if (!advert?.webPush || !hasPluginCapability(advert, WEB_PLUGIN_CAPABILITIES.pushWebPushKey)) {
    return null
  }

  return advert.webPush.publicKey
}
