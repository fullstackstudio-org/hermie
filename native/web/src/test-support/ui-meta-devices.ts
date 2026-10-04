/*
  Two of somebody's pages, one gateway that remembers, each page with its own
  stores and its own disk.

  Ported from the Expo app's `__tests__/support/ui-meta-devices.ts`. The Expo
  stores were module singletons, so its "second device" was the first one with
  its memory and disk wiped and the two ran one at a time. Here every store is
  made per page (`createLayoutStore` and friends), so a `Page` is a whole page's
  worth of state and two can run side by side against one gateway; a page that
  is opened again on the same `disk` is the same browser coming back.
*/
import { createKeyValueStore, type WebKeyValueStore } from '../platform/key-value-store'
import { type AppStampState, createAppStampStore } from '../state/app-stamp'
import { type ChatLayoutState, createLayoutStore } from '../state/layout'
import { createPushStore, type PushState } from '../state/push'
import { createTextSizeStore, type TextSizeState } from '../state/text-size'
import type { StoreApi } from 'zustand/vanilla'

import { UiMetaBridge, type UiMetaBridgeOptions } from '../core/ui-meta-bridge'

/** A gateway with no accounts names its one person `owner`; the cookie fake names `tester@example.invalid`. */
export const OWNER = 'owner'

export const APP_KEY = `hermie-app:${OWNER}`

/** The plugin advert of a gateway whose notifier reads the per-person key. */
export const PER_USER_ADVERT = {
  v: 1,
  version: '0.2.0',
  capabilities: ['ui_meta.per_user', 'push.seen.per_chat'],
  modules: { push: 'on' }
}

/** Long enough for a zero-millisecond debounce and the flush behind it. */
export const settled = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 5))

export interface HoldingGateway {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** The whole `ui_meta` bag of one profile, as the gateway holds it. */
  meta: (profile: string) => Record<string, unknown>
  /** The app-wide section as the gateway holds it, or `undefined`. */
  app: (key?: string) => Record<string, unknown> | undefined
  /** Re-date that section, for a case about a choice made an hour ago. */
  dateApp: (at: number) => void
  /** Every `profiles.configure` it was sent, in order. */
  writes: { name: string; ui_meta: Record<string, unknown>; expected: Record<string, number> }[]
}

/**
 * A gateway that keeps its `ui_meta`, revisions and all: the two methods
 * `UiMetaSync` names and the per-key compare-and-swap they answer with. A
 * section written as `null` is removed, which is what the real gateway does.
 */
export function holdingGateway(options: { advert?: Record<string, unknown> | null } = {}): HoldingGateway {
  const advert = options.advert === undefined ? PER_USER_ADVERT : options.advert
  const meta: Record<string, Record<string, unknown>> = {
    researcher: {
      // Not ours, and the one key that must still be there afterwards: it is
      // what makes a profile show up as a bot at all.
      'hermes-bots': {},
      ...(advert ? { 'hermie-plugin': advert } : {})
    },
    writer: { 'hermes-bots': {} }
  }
  const revisions: Record<string, Record<string, number>> = { researcher: {}, writer: {} }
  const writes: HoldingGateway['writes'] = []

  return {
    writes,
    meta: profile => meta[profile] ?? {},
    app: (key = APP_KEY) => meta.researcher?.[key] as Record<string, unknown> | undefined,

    dateApp(at) {
      const section = meta.researcher?.[APP_KEY] as Record<string, unknown> | undefined

      if (section) {
        section.updatedAt = at
      }
    },

    async request(method, params) {
      if (method === 'profiles.list') {
        return {
          profiles: Object.keys(meta).map(name => ({
            name,
            // `researcher` is the default one, so the app-wide key lives on it.
            is_default: name === 'researcher',
            // A copy: a roster read is a wire message.
            ui_meta: JSON.parse(JSON.stringify(meta[name])) as Record<string, unknown>,
            ui_meta_revisions: { ...revisions[name] }
          }))
        }
      }

      if (method === 'profiles.configure') {
        const name = String(params?.name ?? '')
        const sections = (params?.ui_meta ?? {}) as Record<string, unknown>
        const expected = (params?.ui_meta_expected_revisions ?? {}) as Record<string, number>
        const conflicts: Record<string, { expected: number; actual: number }> = {}
        const bag = meta[name]
        const counters = revisions[name]

        if (!bag || !counters) {
          throw new Error(`no such profile: ${name}`)
        }

        writes.push({ name, ui_meta: JSON.parse(JSON.stringify(sections)) as Record<string, unknown>, expected })

        for (const [key, value] of Object.entries(sections)) {
          const actual = counters[key] ?? 0

          if (key in expected && expected[key] !== actual) {
            conflicts[key] = { expected: expected[key] as number, actual }
            continue
          }

          if (value === null) {
            delete bag[key]
          } else {
            bag[key] = JSON.parse(JSON.stringify(value)) as unknown
          }

          counters[key] = actual + 1
        }

        return {
          ok: true,
          applied: {
            ui_meta: Object.keys(conflicts).length === 0,
            ui_meta_revisions: { ...counters },
            ...(Object.keys(conflicts).length ? { ui_meta_conflicts: conflicts } : {})
          }
        }
      }

      return {}
    }
  }
}

/** A browser profile nobody has used yet. */
export const newDisk = (): WebKeyValueStore => createKeyValueStore({ namespace: 'test', storage: null })

export interface Page {
  bridge: UiMetaBridge
  layout: StoreApi<ChatLayoutState>
  textSize: StoreApi<TextSizeState>
  appStamp: StoreApi<AppStampState>
  push: StoreApi<PushState>
  disk: WebKeyValueStore
  stop: () => void
  /** Resolved once the stores' disk reads are in AND the bridge is watching. */
  watching: Promise<unknown>
}

/**
 * Open the app on this page: read the disk, connect, watch. `ready` is handed
 * the disk read rather than awaited first, which is the order the app has.
 */
export function openPage(
  gateway: Pick<HoldingGateway, 'request'>,
  options: { disk?: WebKeyValueStore; user?: string } & Partial<Omit<UiMetaBridgeOptions, 'gateway'>> = {}
): Page {
  const { disk: given, user, ...bridgeOptions } = options
  const disk = given ?? newDisk()
  const layout = createLayoutStore()
  const textSize = createTextSizeStore()
  const appStamp = createAppStampStore()
  const push = createPushStore()
  const read = (async () => {
    textSize.getState().hydrate(disk)
    await Promise.all([layout.getState().load(disk), appStamp.getState().hydrate(disk)])
  })()
  const bridge = new UiMetaBridge({
    gateway,
    stores: { layout, textSize, appStamp, push },
    ready: () => read,
    storage: disk,
    debounceMs: 0,
    ...bridgeOptions
  })

  bridge.setUser(user ?? OWNER)

  const stop = bridge.start()

  return { bridge, layout, textSize, appStamp, push, disk, stop, watching: read.then(settled) }
}
