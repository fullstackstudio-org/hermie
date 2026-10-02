/**
 * What the gateway says is installed next to it.
 *
 * [ADR-0017's amendment](../../../docs/adr/0017-push-through-hermie-web.md)
 * moved push into a Hermes plugin, and the plugin publishes a small advert into
 * the gateway's own `ui_meta` under its own `hermie-plugin` key:
 *
 * ```json
 * {"v": 1, "version": "0.1.0",
 *  "capabilities": ["push.expo", "push.type.turn_done", "context.system_prompt"],
 *  "modules": {"push": "on", "context": "on", "presence": "planned"},
 *  "limits": {"payloadBytes": 3500, "contextChars": 1200},
 *  "updatedAt": 1790001453}
 * ```
 *
 * The plugin's own `contract.py` states the rules this module implements, and
 * all three are about a gateway nobody ever logs into again:
 *
 *  - **A capability is a string, not a version comparison.** Ask for
 *    `push.webpush`; never for `version >= "0.4.0"`. A newer plugin adds a
 *    string and an older app simply does not ask for it. `version` exists for
 *    one human-readable line in Settings and for nothing else.
 *  - **An advert whose `v` is newer than this reader understands yields
 *    nothing.** A shape you do not know is not a shape you guess at — the same
 *    rule `readSection` follows in `ui-meta.ts`.
 *  - **An absent advert means an absent plugin.** A plugin too old to write the
 *    key, a plugin that is installed but disabled, and no plugin at all are
 *    indistinguishable from here, and all three mean the same thing: do not
 *    offer the feature.
 *
 * The key is the PLUGIN's, never the app's. It carries its own compare-and-swap
 * revision, which no version of this app touches, so a write from the gateway
 * side can never make the app's next `hermie-app` write fail.
 */
import type { ProfileRow, ProfilesListResult } from '@hermes/shared/gateway-contract'

import { pushRelayOriginOf } from './push'

/** The `ui_meta` key the plugin publishes under. Read-only from here. */
export const HERMIE_PLUGIN_KEY = 'hermie-plugin'

/** The advert shape this build understands. Anything newer is ignored whole. */
export const PLUGIN_CONTRACT_VERSION = 1

/**
 * The capability strings this app asks about.
 *
 * Named here so a screen cannot invent one: a typo in a capability string is a
 * feature that is silently never offered, which is the one failure mode a
 * string-keyed contract has.
 */
export const PLUGIN_CAPABILITIES = {
  pushExpo: 'push.expo',
  pushWebPush: 'push.webpush',
  /**
   * The notifier can deliver to a `transport: "relay"` registration.
   *
   * What a native Apple build checks before it replaces its Expo row with a
   * relay row: a notifier without it drops the relay row as unreadable, so
   * writing one there would be a phone that silently stops buzzing. Without
   * it the existing Expo row stays and keeps working.
   */
  pushRelay: 'push.relay',
  pushPreview: 'push.preview',
  pushTurnDone: 'push.type.turn_done',
  pushTurnFailed: 'push.type.turn_failed',
  contextPrompt: 'context.system_prompt',
  contextPerBot: 'context.per_bot',
  /**
   * The plugin will take a claim naming which bot is about to submit a turn.
   *
   * `POST /api/plugins/hermie/context/turn` exists for a gateway shared by more
   * than one client: the socket carries a `profile` on `prompt.submit` already,
   * but a plugin watching the transcript from the OUTSIDE has no way to read
   * that field, so a shared chat's bot could not say who was actually sending.
   * The claim is a courtesy call the app makes right before the turn starts —
   * never for a slash command, which is not a turn, and never for a steer,
   * which folds into a turn already claimed.
   */
  contextTurnClaim: 'context.turn_claim',
  /**
   * The plugin reads `hermie-app:<user_id>` as well as the bare key.
   *
   * It gates only the PUSH half. The arrangement moves to the per-person key
   * whatever the plugin says, because nothing but this app ever reads it — but
   * a registration written somewhere the notifier does not look is a phone that
   * has silently stopped buzzing, so those stay on the legacy key until the
   * gateway says it can find them.
   */
  uiMetaPerUser: 'ui_meta.per_user',
  /** The heartbeat may say WHICH chat is on screen, not merely that one is. */
  pushSeenPerChat: 'push.seen.per_chat',
  /** A muted chat is not notified about. Without it, mute is app-side only. */
  pushMute: 'push.mute',
  /**
   * The memory browser's two halves, which are the only capabilities on this
   * list that name an HTTP surface rather than a hook.
   *
   * They are separate because a gateway may offer one and not the other, and
   * they are not independent: the plugin refuses to advertise `memory.edit`
   * without `memory.browse`, since an app that cannot list an entry cannot name
   * one to replace. So a page tests `memoryBrowse` to decide whether to exist
   * and `memoryEdit` to decide whether to be writable.
   */
  memoryBrowse: 'memory.browse',
  memoryEdit: 'memory.edit',
  /**
   * The plugin will write a profile's `display_name` for us.
   *
   * The one capability on this list that exists because CORE's answer was the
   * wrong one. `PATCH /api/profiles/{name}` is the only route that touches a
   * display name and it RENAMES the profile on every profile but `default` —
   * its directory, its wrapper script, its service and the active-profile
   * pointer — so a client that wanted to change what a bot is CALLED had
   * nowhere to send it and kept the name to itself. With this, the plugin's
   * `PATCH /api/plugins/hermie/profiles/{name}` takes `{"display_name": …}`,
   * writes it where `profiles.list` reads it, and every other client on that
   * gateway sees the name too.
   */
  profilesDisplayName: 'profiles.display_name'
} as const

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[keyof typeof PLUGIN_CAPABILITIES]

export interface PluginAdvert {
  /** The plugin's release version. Shown; never compared against. */
  version: string
  capabilities: string[]
  /** Module name → `on`, `off` or `planned`. */
  modules: Record<string, string>
  /** Whatever the plugin chose to state, e.g. `payloadBytes`, `contextChars`. */
  limits: Record<string, unknown>
  /**
   * The relay origins the plugin's sender will post to: its allow-list, as it
   * publishes it (an additive field; an older plugin has none, read as `[]`).
   * Normalised, https only, duplicates dropped, in the plugin's order. A
   * native app registers with a relay on this list, because a relay row naming
   * any other origin is one the plugin will never send to.
   */
  relayOrigins: string[]
  /** Epoch seconds. A gateway killed rather than unloaded leaves a stale one. */
  updatedAt: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Read one advert value, or `null`. Exported so a test can say it directly. */
export function pluginAdvertOf(value: unknown): PluginAdvert | null {
  if (!isObject(value)) {
    return null
  }

  const version = value.v

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > PLUGIN_CONTRACT_VERSION) {
    return null
  }

  const capabilities = Array.isArray(value.capabilities)
    ? [...new Set(value.capabilities.filter((entry): entry is string => typeof entry === 'string'))].sort()
    : []

  const modules: Record<string, string> = {}

  for (const [name, state] of Object.entries(isObject(value.modules) ? value.modules : {})) {
    if (typeof state === 'string') {
      modules[name] = state
    }
  }

  return {
    version: typeof value.version === 'string' ? value.version : '',
    capabilities,
    modules,
    limits: isObject(value.limits) ? { ...value.limits } : {},
    relayOrigins: Array.isArray(value.relayOrigins)
      ? [...new Set(value.relayOrigins.map(pushRelayOriginOf).filter(Boolean))]
      : [],
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? Math.floor(value.updatedAt) : 0
  }
}

/**
 * The advert off a roster, or `null`.
 *
 * Every profile is looked at, with the default one winning. The plugin writes
 * the key on the profile it is loaded under and a gateway can have several;
 * insisting on the default profile would make "is the plugin installed" depend
 * on which bot happened to be default, which is not a question the reader has
 * any way to answer.
 */
export function pluginAdvert(
  roster: ProfilesListResult | readonly ProfileRow[] | null | undefined
): PluginAdvert | null {
  const rows: readonly ProfileRow[] = Array.isArray(roster)
    ? roster
    : Array.isArray((roster as ProfilesListResult | null)?.profiles)
      ? ((roster as ProfilesListResult).profiles ?? [])
      : []

  let found: PluginAdvert | null = null

  for (const row of rows) {
    const advert = pluginAdvertOf(isObject(row?.ui_meta) ? row.ui_meta[HERMIE_PLUGIN_KEY] : null)

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

/** Does this gateway's plugin offer that capability? `null` never does. */
export function hasPluginCapability(advert: PluginAdvert | null, capability: string): boolean {
  return advert?.capabilities.includes(capability) === true
}

/**
 * Is the push module actually switched on at this gateway?
 *
 * `modules.push` rather than a capability, because the two answer different
 * questions: the module says whether the operator turned it on, and the
 * capabilities say which transports survived the prerequisites once it was.
 * A module that is `planned` or `off` offers nothing however many capability
 * strings happen to be listed.
 */
export function pluginModuleOn(advert: PluginAdvert | null, module: string): boolean {
  return advert?.modules[module] === 'on'
}
