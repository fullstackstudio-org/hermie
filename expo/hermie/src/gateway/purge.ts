/**
 * Everything one gateway left on this device, removed.
 *
 * "Remove" in the gateways list is the only destructive act in the feature, so
 * it has to actually be destructive: a removal that took the row out of the
 * list and left the keychain items, the cached transcripts and the settings
 * behind would leave a credential on the device with nothing on any screen
 * saying it was there.
 *
 * The mirror image of `migrate.ts`, and deliberately written against the same
 * list of keys: a key that is namespaced but not named here is a key that
 * outlives the gateway it belongs to for ever, because nothing else will ever
 * have a reason to look at it again.
 *
 * **It never throws.** A removal that failed halfway would leave a row the
 * reader has already been told is gone. Each step is independent.
 */
import { OWN_AUTHOR_KEY } from '../features/chats/own-author'
import { chatCacheFor } from '../platform/chat-cache'
import { keyValueStore } from '../platform/key-value-store'
import { BOT_LAST_SEEN_KEY } from '../store/bots'
import { CHAT_LAYOUT_KEY } from '../store/chat-layout'
import { PUSH_KEY } from '../store/push'
import { CHAT_VIEW_KEY } from '../store/settings'
import { AUTH_TIMELINE_KEY } from './auth-timeline'
import { clearGateway } from './config'
import type { GatewayNamespace } from './namespace'

/** The namespaced key-value keys, besides the configuration `clearGateway` takes. */
const NAMESPACED_KEYS: readonly string[] = [
  AUTH_TIMELINE_KEY,
  BOT_LAST_SEEN_KEY,
  CHAT_VIEW_KEY,
  OWN_AUTHOR_KEY,
  PUSH_KEY
]

/**
 * Drop this gateway's entry from the arrangement blob.
 *
 * Read-modify-write for the reason `chat-layout.ts` gives about it: one key
 * holding every gateway's arrangement needs no second index to say which keys
 * exist, and this is the price — the removal has to go through the whole map.
 */
async function forgetLayout(ns: GatewayNamespace): Promise<void> {
  const all = await keyValueStore.getJson<Record<string, unknown>>(CHAT_LAYOUT_KEY)

  if (!all || !(ns.id in all)) {
    return
  }

  const { [ns.id]: _removed, ...rest } = all

  await keyValueStore.setJson(CHAT_LAYOUT_KEY, rest)
}

/**
 * Forget one gateway: its address, its credentials, its caches and its
 * settings.
 *
 * The push registration is NOT removed here and cannot be: taking a device out
 * of the section is a write over that gateway's socket, and by the time this
 * runs there is no socket to the gateway being removed. The caller retires it
 * first where there was one — see `removeGateway` in `GatewayProvider` — and
 * where there was not, the row is left behind knowingly: the daemon's own
 * receipts retire an address nothing answers, and the alternative is a removal
 * that has to sign in to a gateway in order to leave it.
 */
export async function purgeGatewayStorage(ns: GatewayNamespace): Promise<void> {
  const steps: Promise<unknown>[] = [
    clearGateway(ns),
    ...NAMESPACED_KEYS.map(key => keyValueStore.delete(ns.key(key))),
    forgetLayout(ns),
    chatCacheFor(ns.id).clear()
  ]

  await Promise.allSettled(steps)
}
