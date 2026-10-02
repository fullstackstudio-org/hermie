/**
 * The one-time move of a single gateway's things into its own namespace.
 *
 * Before the registry there was one gateway and therefore one of everything:
 * one `hermie.gateway.config`, one `hermie.auth.access_token`, one cached
 * roster. All of it is still on disk under those bare names when this build
 * starts for the first time, and none of it is where the app now looks.
 *
 * So this runs exactly once, on the launch that mints the first gateway's id,
 * and carries every one of those across. It runs BEFORE the configuration is
 * read, because the configuration is one of the things being moved.
 *
 * **It never throws.** A move that fails leaves the app on the wizard with an
 * empty cache, which is bad; a move that fails and takes the launch down with
 * it leaves the app on the splash screen, which is worse. Every step is
 * independent and each one is allowed to fail on its own.
 *
 * **Two of the keys are split rather than moved**, and both splits are the same
 * observation: the old blob held something that was never about a gateway.
 * `hermie.chat.view` carried the light/dark choice, and `hermie.push` carried
 * the installation id. Each goes to a device-level key of its own; see
 * `namespace.ts` for the list and the reasons.
 */
import { keyValueStore } from '../platform/key-value-store'
import { migrateChatCacheNamespace } from '../platform/chat-cache'
import { secretStore } from '../platform/secret-store'
import { CHAT_LAYOUT_KEY } from '../store/chat-layout'
import { BOT_LAST_SEEN_KEY } from '../store/bots'
import { INSTALLATION_KEY, PUSH_KEY } from '../store/push'
import { APPEARANCE_KEY, CHAT_VIEW_KEY } from '../store/settings'
import { AUTH_TIMELINE_KEY } from './auth-timeline'
import { CONFIG_KEY, SECRET_KEYS } from './config'
import type { GatewayNamespace } from './namespace'

/**
 * Keys whose whole value belongs to one gateway and moves across unchanged.
 *
 * Deliberately a list rather than a sweep over everything the app has ever
 * written: a sweep would also carry the app lock and the registry itself, and
 * "move whatever is there" is exactly the rule that quietly adopts the next key
 * somebody adds for a different purpose.
 */
const MOVED_KEYS: readonly string[] = [CONFIG_KEY, AUTH_TIMELINE_KEY, BOT_LAST_SEEN_KEY]

async function move(from: string, to: string): Promise<void> {
  const raw = await keyValueStore.get(from)

  if (raw === null) {
    return
  }

  await keyValueStore.set(to, raw)
  await keyValueStore.delete(from)
}

/** The settings blob, minus the one field that was never about a gateway. */
async function moveSettings(ns: GatewayNamespace): Promise<void> {
  const stored = await keyValueStore.getJson<Record<string, unknown>>(CHAT_VIEW_KEY)

  if (!stored) {
    return
  }

  const { appearance, ...rest } = stored

  await keyValueStore.setJson(ns.key(CHAT_VIEW_KEY), rest)

  if (typeof appearance === 'string') {
    await keyValueStore.setJson(APPEARANCE_KEY, { appearance })
  }

  await keyValueStore.delete(CHAT_VIEW_KEY)
}

/** The push blob, minus the installation id, which is this DEVICE's. */
async function movePush(ns: GatewayNamespace): Promise<void> {
  const stored = await keyValueStore.getJson<Record<string, unknown>>(PUSH_KEY)

  if (!stored) {
    return
  }

  const { installationId, ...rest } = stored

  await keyValueStore.setJson(ns.key(PUSH_KEY), rest)

  if (typeof installationId === 'string' && installationId) {
    await keyValueStore.setJson(INSTALLATION_KEY, { installationId })
  }

  await keyValueStore.delete(PUSH_KEY)
}

/**
 * The chat arrangement, which was already keyed by gateway — by ADDRESS.
 *
 * ADR-0012 keyed it that way because an address was the only name a gateway
 * had. Now it has an id, and the id is the better key for the reason
 * `registry.ts` gives: an address is a thing a reader edits, and an arrangement
 * that fell back to an empty list because somebody corrected a port would be an
 * arrangement nobody trusts. So the one entry under the old address moves to
 * the id, and any other entry — there can only be one, but a blob is a blob —
 * is left alone.
 */
async function moveLayout(ns: GatewayNamespace, address: string): Promise<void> {
  const all = await keyValueStore.getJson<Record<string, unknown>>(CHAT_LAYOUT_KEY)
  const mine = all?.[address]

  if (!all || mine === undefined) {
    return
  }

  const { [address]: _moved, ...rest } = all

  await keyValueStore.setJson(CHAT_LAYOUT_KEY, { ...rest, [ns.id]: mine })
}

/** The six keychain items. One at a time: a keychain refusal is per item. */
async function moveSecrets(ns: GatewayNamespace): Promise<void> {
  for (const key of Object.values(SECRET_KEYS)) {
    try {
      const value = await secretStore.get(key)

      if (value === null) {
        continue
      }

      await secretStore.set(ns.secretKey(key), value)
      await secretStore.delete(key)
    } catch {
      // A keychain that refuses one item is a sign-in to do again, not a
      // launch to fail. The others still move.
    }
  }
}

/**
 * Carry the single configured gateway's storage into its namespace.
 *
 * `address` is the one the registry entry was built from, because the chat
 * arrangement was keyed by it and there is nothing else on disk that says which
 * entry in that blob was this gateway's.
 */
export async function migrateGatewayStorage(ns: GatewayNamespace, address: string): Promise<void> {
  const steps: Promise<void>[] = [
    ...MOVED_KEYS.map(key => move(key, ns.key(key))),
    moveSettings(ns),
    movePush(ns),
    moveLayout(ns, address),
    moveSecrets(ns),
    migrateChatCacheNamespace(ns.id)
  ]

  // `allSettled`, so one refused key cannot take the rest of the move with it.
  await Promise.allSettled(steps)
}
