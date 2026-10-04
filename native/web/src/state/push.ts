/**
 * What this browser asked to be notified about, and what it holds to say so.
 *
 * Ported from the Expo app's `src/store/push.ts`, for one gateway per page. Two
 * halves, owned differently:
 *
 *  - **This browser's**: the switch, the types, the preview, the subscription's
 *    address and the key it was made with, the row's `updatedAt`, and its
 *    heartbeat. The switch, the types, the preview and the key are kept in the
 *    page's store under the person (`push.settings`, cleared on sign-out); the
 *    address is read from the browser on every launch, never stored.
 *  - **The person's**: the per-chat overrides (`perBot`), which follow the
 *    person to every device and are taken from the gateway's copy on every
 *    reconcile (`core/ui-meta-bridge.ts`). Every other device's row and heartbeat
 *    is held by the bridge, raw, and never here.
 *
 * The installation id is minted once per browser and gateway and kept across a
 * sign-out (`device.push.installation`): it is the key of this browser's row, and
 * a browser that minted a new one on every launch would leave a dead row behind
 * each time.
 *
 * **Nothing here writes to a gateway.** The bridge watches this store and puts
 * the row into the next write of the app section (`core/push/row.ts`). The
 * controller (`core/push/sync.ts`) is what moves it; it registers itself here so
 * a screen can reach it (`controller`) without the entry module importing it.
 *
 * A vanilla zustand store (`pushStore`, and `createPushStore` for tests).
 */
import {
  type PushSeenEntry,
  type PushType,
  type PushTypeOverrides,
  adoptedPushTypes,
  effectivePushTypes,
  noPushTypes,
  PUSH_TYPES
} from '@hermie/gateway-client/push'
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { WebPushAddress } from '../core/push/row'
import type { WebKeyValueStore } from '../platform/key-value-store'
import { randomHex } from '../platform/random'

/** Identity-bound: the switch, the types, the preview and the key of the subscription. */
export const PUSH_SETTINGS_KEY = 'push.settings'

/** Device-local: this browser's installation id on this gateway. */
export const PUSH_INSTALLATION_KEY = 'device.push.installation'

/** Every type on: a reader who turns notifications on hears about everything until they say otherwise. */
export const DEFAULT_PUSH_TYPES: Record<PushType, boolean> = {
  message: true,
  request: true,
  cron: true,
  cron_done: true,
  cron_failed: true,
  turn_done: true,
  turn_failed: true
}

/** Where the launch check is: the row the gateway holds for this browser is carried until it is `settled`. */
export type PushPhase = 'idle' | 'checking' | 'settled'

/** What a screen can ask the controller to do (`core/push/sync.ts`). */
export interface PushController {
  enable(): Promise<void>
  disable(): Promise<void>
  /** Unsubscribe, subscribe again with the advert's key and write a fresh row. */
  reregister(): Promise<void>
  /** Ask the plugin to send this browser a test notification (`push.test`). */
  sendTest(): Promise<PushTestOutcome>
}

/** What the test route answered, as a screen says it. */
export type PushTestOutcome =
  | { kind: 'sent' }
  | { kind: 'refused'; outcome: string }
  | { kind: 'not-registered' }
  | { kind: 'busy'; retryAfter: number }
  | { kind: 'failed'; status: number }

interface StoredPush {
  enabled: boolean
  types: Record<string, boolean>
  preview: boolean
  /** base64url: the key the subscription was made with, for a browser that does not report it. */
  subscribedKey: string
}

export interface PushState {
  loaded: boolean
  installationId: string
  /** `gatewayKeyOf` the page's gateway, written into the row; empty writes none. */
  gatewayKey: string
  /** The reader's switch. Independent of whether the browser agreed yet. */
  enabled: boolean
  types: Record<PushType, boolean>
  /** Off by default: a notification says which bot and what happened, not what was said. */
  preview: boolean
  /** The person's per-chat overrides, as the gateway holds them. */
  perBot: Record<string, PushTypeOverrides>
  /** The browser's subscription, read on this launch; `null` until then and while there is none. */
  address: WebPushAddress | null
  /** The key the subscription was made with, remembered for a browser that does not report it. */
  subscribedKey: string
  /** Unix seconds, on the gateway's clock where it is known: when the row was last written. */
  updatedAt: number
  /** This browser's heartbeat: which chat is on screen, and when it last said so. */
  seen: PushSeenEntry | null
  phase: PushPhase
  /** An operation of the controller is running. */
  busy: boolean
  /** Why the last attempt failed, in the browser's own words, cut short; `null` when it did not. */
  failure: string | null
  controller: PushController | null

  /** Read this browser's choices and installation id (minting one the first time). */
  hydrate: (storage: WebKeyValueStore) => void
  setGatewayKey: (key: string) => void
  setEnabled: (enabled: boolean) => void
  setType: (type: PushType, on: boolean) => void
  setPreview: (preview: boolean) => void
  /** Override one type for one chat, or (`null`) let it follow the global types again. */
  setBotType: (bot: string, type: PushType, on: boolean | null) => void
  resetBotTypes: (bot: string) => void
  /** The gateway's copy of the per-chat overrides. */
  applyRemote: (perBot: Record<string, PushTypeOverrides>) => void
  /** The subscription the browser holds, stamped `updatedAt`; `null` when it holds none. */
  setAddress: (address: WebPushAddress | null, updatedAt: number) => void
  beat: (bot: string, at: number) => void
  setPhase: (phase: PushPhase) => void
  setBusy: (busy: boolean) => void
  setFailure: (failure: string | null) => void
  bindController: (controller: PushController | null) => void
  /** Sign-out: this browser's registration goes, its choices are forgotten; the id stays. */
  retire: () => void
  /** Back to nothing, and forget the store (tests). */
  reset: () => void
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function readStored(storage: WebKeyValueStore): StoredPush | null {
  try {
    const raw = storage.getSync(PUSH_SETTINGS_KEY)
    const value: unknown = raw ? JSON.parse(raw) : null

    if (!isObject(value)) {
      return null
    }

    return {
      enabled: value.enabled === true,
      types: isObject(value.types) ? (value.types as Record<string, boolean>) : {},
      preview: value.preview === true,
      subscribedKey: typeof value.subscribedKey === 'string' ? value.subscribedKey : ''
    }
  } catch {
    return null
  }
}

/** A new installation id: `i` and 16 hex digits, the Expo app's shape. */
const newInstallationId = (): string => `i${randomHex(8)}`

export function createPushStore(): StoreApi<PushState> {
  let storage: WebKeyValueStore | null = null

  return createStore<PushState>((set, get) => {
    const save = (): void => {
      if (!storage) {
        return
      }

      const { enabled, types, preview, subscribedKey } = get()
      const stored: StoredPush = { enabled, types, preview, subscribedKey }

      try {
        storage.setSync(PUSH_SETTINGS_KEY, JSON.stringify(stored))
      } catch {
        // A choice that did not persist is asked again on the next launch.
      }
    }

    return {
      loaded: false,
      installationId: '',
      gatewayKey: '',
      enabled: false,
      types: noPushTypes(),
      preview: false,
      perBot: {},
      address: null,
      subscribedKey: '',
      updatedAt: 0,
      seen: null,
      phase: 'idle',
      busy: false,
      failure: null,
      controller: null,

      hydrate(next) {
        storage = next

        const stored = readStored(next)
        let installationId = ''

        try {
          installationId = next.getSync(PUSH_INSTALLATION_KEY) ?? ''
        } catch {
          installationId = ''
        }

        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(installationId)) {
          installationId = newInstallationId()

          try {
            next.setSync(PUSH_INSTALLATION_KEY, installationId)
          } catch {
            // Minted again next launch; the row it leaves behind is retired by the plugin.
          }
        }

        set({
          loaded: true,
          installationId,
          enabled: stored?.enabled === true,
          // A type that did not exist when the reader chose takes its default (`adoptedPushTypes`).
          types: stored ? adoptedPushTypes(stored.types, DEFAULT_PUSH_TYPES) : noPushTypes(),
          preview: stored?.preview === true,
          subscribedKey: stored?.subscribedKey ?? ''
        })
      },

      setGatewayKey(gatewayKey) {
        set({ gatewayKey })
      },

      setEnabled(enabled) {
        // On with nothing chosen would register a browser that asked about nothing.
        const types = enabled && PUSH_TYPES.every(type => !get().types[type]) ? { ...DEFAULT_PUSH_TYPES } : get().types

        set({ enabled, types, failure: null, ...(enabled ? {} : { address: null, updatedAt: 0 }) })
        save()
      },

      setType(type, on) {
        set({ types: { ...get().types, [type]: on } })
        save()
      },

      setPreview(preview) {
        set({ preview })
        save()
      },

      setBotType(bot, type, on) {
        const current: PushTypeOverrides = { ...(get().perBot[bot] ?? {}) }

        if (on === null) {
          delete current[type]
        } else {
          current[type] = on
        }

        const perBot = { ...get().perBot }

        if (Object.keys(current).length > 0) {
          perBot[bot] = current
        } else {
          delete perBot[bot]
        }

        set({ perBot })
      },

      resetBotTypes(bot) {
        if (!get().perBot[bot]) {
          return
        }

        const perBot = { ...get().perBot }

        delete perBot[bot]
        set({ perBot })
      },

      applyRemote(perBot) {
        set({ perBot })
      },

      setAddress(address, updatedAt) {
        const subscribedKey = address?.applicationServerKey ?? get().subscribedKey

        set({ address, updatedAt: address ? updatedAt : 0, subscribedKey, ...(address ? { failure: null } : {}) })
        save()
      },

      beat(bot, at) {
        set({ seen: { bot, at } })
      },

      setPhase(phase) {
        set({ phase })
      },

      setBusy(busy) {
        set({ busy })
      },

      setFailure(failure) {
        set({ failure })
      },

      bindController(controller) {
        set({ controller })
      },

      retire() {
        set({ enabled: false, address: null, updatedAt: 0, subscribedKey: '', seen: null, failure: null })
        save()
      },

      reset() {
        storage = null
        set({
          loaded: false,
          installationId: '',
          gatewayKey: '',
          enabled: false,
          types: noPushTypes(),
          preview: false,
          perBot: {},
          address: null,
          subscribedKey: '',
          updatedAt: 0,
          seen: null,
          phase: 'idle',
          busy: false,
          failure: null,
          controller: null
        })
      }
    }
  })
}

/** The page's store. */
export const pushStore: StoreApi<PushState> = createPushStore()

/** The global types with one chat's overrides folded in, by the rule the plugin decides with. */
export const botPushTypes = (state: Pick<PushState, 'types' | 'perBot'>, bot: string): Record<PushType, boolean> =>
  effectivePushTypes(state.types, state.perBot[bot])
