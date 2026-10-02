/**
 * Two of somebody's devices, one gateway, one set of module-level stores.
 *
 * ADR-0016's app-wide key holds ONE PERSON's settings and every device they sign
 * in on reads and writes it, so the questions worth asking about it are all of
 * the form "what happens on the second device". That needs two things a single
 * `UiMetaBridge` test does not: a gateway that KEEPS what it was told rather than
 * recording that it was told something, and a way to put one device away and
 * bring another one out.
 *
 * The stores are module-level singletons, so a second device is this suite's
 * first device with its memory and its disk wiped — `newDevice` — and the two are
 * therefore used one at a time rather than side by side. That is not a
 * simplification: the reports these harnesses exist for are about opening the
 * second device, which is exactly one at a time.
 */
import { namespace } from '../../src/gateway/namespace'
import { keyValueStore } from '../../src/platform/key-value-store'
import { APP_STAMP_KEY, useAppStampStore } from '../../src/store/app-stamp'
import { CHAT_LAYOUT_KEY, useChatLayoutStore } from '../../src/store/chat-layout'
import { useDeviceContextStore } from '../../src/store/device-context'
import { usePluginStore } from '../../src/store/plugin'
import { usePushStore } from '../../src/store/push'
import { CHAT_VIEW_KEY, useSettingsStore } from '../../src/store/settings'
import { UiMetaBridge, type HermieAppShape } from '../../src/store/ui-meta-bridge'

export const GATEWAY_ID = 'gd0d0d0d0d0d0d0d0'
export const NS = namespace(GATEWAY_ID)

/** An ungated gateway has no accounts, so it names the one person `owner`. */
export const OWNER = 'owner'

export const APP_KEY = `hermie-app:${OWNER}`

/** Long enough for a zero-millisecond debounce and the flush behind it. */
export const settled = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 5))

export interface HoldingGateway {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** The app-wide section as the gateway now holds it, or `undefined`. */
  app: () => HermieAppShape | undefined
  /** Re-date that section, for a case about a choice made an hour ago. */
  dateApp: (at: number) => void
}

/**
 * A gateway that keeps its `ui_meta`, revisions and all.
 *
 * `packages/fake-gateway` is the real stand-in and `packages/gateway-client`'s
 * own suite drives it over a socket. What is needed here is the layer above: the
 * two app stores against a gateway that remembers, with no socket in the way. So
 * this implements the two methods `UiMetaSync` names and the per-key
 * compare-and-swap they answer with, and nothing else.
 */
export function holdingGateway(): HoldingGateway {
  const meta: Record<string, Record<string, unknown>> = {
    researcher: {
      // Not ours, and the one key that must still be there afterwards: it is
      // what makes a profile show up as a bot at all.
      'hermes-bots': {},
      'hermie-plugin': {
        v: 1,
        version: '0.2.0',
        capabilities: ['ui_meta.per_user', 'push.seen.per_chat'],
        modules: { push: 'on' }
      }
    },
    writer: { 'hermes-bots': {} }
  }
  const revisions: Record<string, Record<string, number>> = { researcher: {}, writer: {} }
  const app = (): HermieAppShape | undefined => meta.researcher?.[APP_KEY] as HermieAppShape | undefined

  return {
    app,

    dateApp(at) {
      const section = app()

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
            // A copy, because a roster read is a wire message and a test that
            // mutated the gateway through one would prove nothing.
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

        for (const [key, value] of Object.entries(sections)) {
          const actual = counters[key] ?? 0

          // The per-key compare-and-swap: one section refused, the others in the
          // same request still applied.
          if (key in expected && expected[key] !== actual) {
            conflicts[key] = { expected: expected[key] as number, actual }
            continue
          }

          if (value === null) {
            // A section written as null is REMOVED, which is what the real
            // gateway does and what the fake was corrected to do.
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

/**
 * A device nobody has used yet: no memory, no disk.
 *
 * Every per-gateway key this round's stores read is cleared, because a value
 * left behind from the previous device is the previous device.
 */
export async function newDevice(): Promise<void> {
  await keyValueStore.delete(NS.key(CHAT_VIEW_KEY))
  await keyValueStore.delete(NS.key(APP_STAMP_KEY))
  await keyValueStore.delete(CHAT_LAYOUT_KEY)
  useSettingsStore.getState().reset()
  useAppStampStore.getState().reset()
  useChatLayoutStore.getState().reset()
  usePushStore.getState().reset()
  useDeviceContextStore.getState().reset()
  usePluginStore.getState().reset()
}

/** This gateway's disk reads, as the app makes them: all of them, at once. */
export function readDisk(): Promise<unknown> {
  return Promise.all([
    useSettingsStore.getState().hydrate(NS),
    useAppStampStore.getState().hydrate(NS),
    useChatLayoutStore.getState().load(GATEWAY_ID)
  ])
}

export interface Device {
  bridge: UiMetaBridge
  stop: () => void
  /**
   * Resolved once this device's disk read has landed AND the bridge is watching.
   *
   * A case about something the reader or the roster does to a live app has to
   * know that the watcher is there to see it, and the watcher starts behind the
   * disk read on purpose (`UiMetaBridgeOptions.ready`). Awaiting the read alone
   * is a coin toss: both are the same storage and the subscription is attached a
   * microtask behind it.
   */
  watching: Promise<unknown>
}

/**
 * Open the app on this device: read the disk, connect, watch.
 *
 * `ready` is handed the disk read rather than awaited first, deliberately. That
 * is the order the app has — the stores are read in one effect and the socket
 * comes up in another — and it is the order the theme report came out of, so a
 * harness that awaited the read before connecting would be testing a sequence
 * the app never performs.
 */
export function openApp(gateway: HoldingGateway): Device {
  const disk = readDisk()
  const bridge = new UiMetaBridge({ gateway, debounceMs: 0, ready: () => disk })

  bridge.setUser(OWNER)

  return { bridge, stop: bridge.start(), watching: disk.then(settled) }
}
