/**
 * Is this the browser build running inside the Hermie desktop shell?
 *
 * The shell (`apps/desktop`, ADR-0027) is a Tauri 2 window over one Hermie Web
 * instance, and the page it shows is this app — the same export a browser tab
 * gets, unmodified. What it adds is a bridge: a native menu it can draw from the
 * app's own shortcut table, OS notifications from the live connection, a dock
 * badge, a gateway picker. None of that exists in a tab, and the app must keep
 * working in a tab, so everything here is detected at RUN TIME and optional in
 * both directions.
 *
 * ## Nothing Tauri is imported
 *
 * Not `@tauri-apps/api`, not at module scope, not lazily. Two reasons:
 *
 *  - The Expo web export is the artefact a Hermie Web serves to browsers. A
 *    Tauri import would put the shell's client in every tab's bundle, and CI's
 *    `web:build` would have to resolve a dependency `expo/hermie` has no reason
 *    to own.
 *  - The bridge is reachable only where the shell granted it. The shell sets
 *    `withGlobalTauri`, so the API arrives as `window.__TAURI__` — a global to
 *    read, not a package to depend on.
 *
 * Everything below reads globals through `globalThis`, which exists on native
 * and in Jest as well as in a webview, so this module is safe to import from
 * shared code (`gateway/client.ts` does).
 *
 * ## Two questions, two answers
 *
 * `RUNS_IN_DESKTOP_SHELL` asks "is a Hermie shell hosting this page", and the
 * marker script the shell injects is what answers it. `desktopShell()` asks
 * "can I call the bridge", which additionally needs `window.__TAURI__`.
 *
 * They are separate because the first is useful without the second. The
 * lifecycle rule is the case that proves it: React Native Web reports AppState
 * `background` whenever `document.hidden`, so a hidden shell window would tear
 * its socket down — and the shell's window is meant to keep its connection while
 * hidden, exactly as the Mac build does (`gateway/client.ts::attachLifecycle`).
 * That decision needs only "am I in the shell", and a shell whose bridge this
 * page cannot reach — an older one, or a page the shell does not trust — is
 * still a desktop window whose socket should stay up.
 *
 * ## Version skew is permanent, in both directions
 *
 * An operator updates their Hermie Web on their own cadence and the shell
 * updates on its own, so "a newer app in an older shell" and "an older app in a
 * newer shell" are both normal forever. Hence: the marker carries a `version`,
 * the bridge carries a `bridge` number, every method is optional-chained, and
 * every call catches. A call that cannot be made answers "no" — never throws,
 * the way `setMenuBar` already reaches nothing on a phone.
 */
import type { MenuBarTitles, ShortcutEvent } from './desktop-shortcuts.shared'

/** Which desktop the shell is running on, in the marker's own spelling. */
export type DesktopPlatform = 'macos' | 'windows' | 'linux'

const PLATFORMS: readonly DesktopPlatform[] = ['macos', 'windows', 'linux']

/**
 * The marker the shell's initialization script sets on the top frame before any
 * page script runs. Its absence is what "not in the shell" means.
 */
export interface DesktopShellMarker {
  /** The marker's own shape version, `1` today. */
  version: number
  platform: DesktopPlatform
}

/** What `hermie_shell_info` reports. */
export interface DesktopShellInfo {
  /** The shell's version, which is the app's version — not the page's. */
  version: string
  platform: DesktopPlatform
  /** The bridge contract's version. `1` today. */
  bridge: number
  /** The shell's id and name for the Hermie Web this page came from. */
  gatewayId: string | null
  gatewayName: string | null
}

/** One OS notification, asked for by `features/push/desktop-notifier.ts`. */
export interface DesktopNotification {
  /** The transcript event id, so the shell can drop a repeat. */
  id: string
  title: string
  body?: string
  /** A `hermie://…` URL to deliver back when the notification is clicked. */
  link?: string
}

/**
 * The events the shell sends the page, and what each one carries.
 *
 * The names are the shell's (`apps/desktop/src-tauri/src/bridge.rs::events`) and
 * must stay identical on both sides; there is no handshake that would catch a
 * rename, only silence.
 */
export interface DesktopShellEvents {
  /** A native menu item was activated. Collapsed against the keyboard path by
   *  `isDoubleFire`, exactly as the Mac's menu bar is. */
  'hermie://shortcut': ShortcutEvent
  /** A `hermie://…` deep link, from the OS or from a notification click. */
  'hermie://link': { url: string }
  /** The shell switched gateway; sent before it navigates. */
  'hermie://gateway': { id: string; name: string }
  /** The window regained focus. */
  'hermie://focus': Record<string, never>
}

/**
 * The bridge, as the app uses it.
 *
 * Every method answers rather than throws. The five that only ask the shell to
 * do something answer `true` when the shell accepted, and `false` for every
 * other outcome — refused, missing from this shell, or failed. The app never has
 * a different plan for those three.
 */
export interface DesktopShell {
  /** Which desktop, from the marker — available without a round trip. */
  platform: DesktopPlatform
  /** The shell's own description of itself, or `null` if it would not say. */
  info: () => Promise<DesktopShellInfo | null>
  /** Rebuild the native Chats menu from the app's own titles and chat names. */
  setMenu: (titles: MenuBarTitles, chats: readonly string[]) => Promise<boolean>
  notify: (notification: DesktopNotification) => Promise<boolean>
  /** A count for the dock badge / taskbar overlay, or `null` to clear it. */
  setBadge: (count: number | null) => Promise<boolean>
  /** Show the shell's gateway picker. */
  openGateways: () => Promise<boolean>
  /** Answer a `close` shortcut; `false` lets the shell hide the window. */
  closeHandled: (handled: boolean) => Promise<boolean>
  /** Listen for one of the shell's events. Returns an unsubscribe. */
  subscribe: <E extends keyof DesktopShellEvents>(
    event: E,
    listener: (payload: DesktopShellEvents[E]) => void
  ) => () => void
}

/** Every reply shape a `hermie_*` command can produce. */
type BridgeReply = { ok?: unknown; [key: string]: unknown }

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>
type Listen = (event: string, handler: (event: { payload?: unknown }) => void) => Promise<() => void>

function globalScope(): Record<string, unknown> {
  return typeof globalThis === 'undefined' ? {} : (globalThis as Record<string, unknown>)
}

function isPlatform(value: unknown): value is DesktopPlatform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)
}

/**
 * The marker, validated.
 *
 * Validated rather than trusted because the app has to survive a shell it does
 * not recognise: a marker with a platform this app has never heard of is not the
 * shell this code was written against, and answering "not in the shell" leaves
 * the app in its plain-browser behaviour — which works — instead of branching on
 * a value it cannot interpret.
 */
function readMarker(): DesktopShellMarker | null {
  try {
    const marker = globalScope().__HERMIE_DESKTOP__

    if (!marker || typeof marker !== 'object') {
      return null
    }

    const { version, platform } = marker as { version?: unknown; platform?: unknown }

    if (typeof version !== 'number' || !isPlatform(platform)) {
      return null
    }

    return { version, platform }
  } catch {
    // A getter that throws, a locked-down global object. Not in the shell.
    return null
  }
}

/**
 * Is a Hermie desktop shell hosting this page?
 *
 * A constant, not a hook, and for the same reason as `RUNS_IN_BROWSER` and
 * `RUNS_ON_MAC`: the answer cannot change while the page lives — the marker is
 * set before any page script runs — and the first render already needs it.
 */
export const RUNS_IN_DESKTOP_SHELL = readMarker() !== null

/**
 * Which desktop, or `null` in a tab and on native.
 *
 * Exported separately from `desktopShell()` because `desktop-shortcuts.web.ts`
 * needs it to decide whether `command` means ⌘ or Ctrl, and that decision is
 * made while matching a keydown — no place for a promise, and no reason to
 * require a reachable bridge for a fact the marker already carries.
 */
export const DESKTOP_SHELL_PLATFORM: DesktopPlatform | null = readMarker()?.platform ?? null

function bridgeAccepted(reply: unknown): boolean {
  return Boolean(reply) && typeof reply === 'object' && (reply as BridgeReply).ok === true
}

/**
 * The shell's own API surface, or `null` where there is none.
 *
 * `null` rather than a facade of no-ops so that a caller has to acknowledge the
 * common case — `desktopShell()?.setBadge(3)` reads as what it is. Called per
 * use rather than cached: it is two property reads, and nothing may keep a
 * reference to the bridge across a navigation the shell may have made.
 */
export function desktopShell(): DesktopShell | null {
  const marker = readMarker()

  if (!marker) {
    return null
  }

  const tauri = globalScope().__TAURI__

  if (!tauri || typeof tauri !== 'object') {
    // In the shell, but without `withGlobalTauri` — an older shell, or one that
    // did not grant this page the bridge. The marker's answers still stand.
    return null
  }

  const core = (tauri as { core?: { invoke?: unknown } }).core
  const invoke = typeof core?.invoke === 'function' ? (core.invoke as Invoke) : null

  if (!invoke) {
    return null
  }

  const event = (tauri as { event?: { listen?: unknown } }).event
  const listen = typeof event?.listen === 'function' ? (event.listen as Listen) : null

  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    try {
      // `invoke` rejects when the shell's capability does not cover the command
      // at all (the ACL's answer, which is a rejection rather than a reply) and
      // resolves `{ ok: false, reason }` when the shell's own origin guard
      // refused. The app has nothing different to do about either.
      return await invoke!(command, args)
    } catch {
      return null
    }
  }

  async function ask(command: string, args?: Record<string, unknown>): Promise<boolean> {
    return bridgeAccepted(await call(command, args))
  }

  return {
    platform: marker.platform,

    info: async () => {
      const reply = await call('hermie_shell_info')

      if (!bridgeAccepted(reply)) {
        return null
      }

      const { version, platform, bridge, gatewayId, gatewayName } = reply as BridgeReply

      if (typeof version !== 'string' || !isPlatform(platform) || typeof bridge !== 'number') {
        return null
      }

      return {
        version,
        platform,
        bridge,
        gatewayId: typeof gatewayId === 'string' ? gatewayId : null,
        gatewayName: typeof gatewayName === 'string' ? gatewayName : null
      }
    },

    setMenu: (titles, chats) => ask('hermie_set_menu', { titles, chats: [...chats] }),

    notify: notification => ask('hermie_notify', { notification }),

    setBadge: count => ask('hermie_set_badge', { count }),

    openGateways: () => ask('hermie_open_gateways'),

    closeHandled: handled => ask('hermie_close_handled', { handled }),

    subscribe: (name, listener) => {
      if (!listen) {
        return () => undefined
      }

      /*
        Tauri's `listen` is asynchronous and the caller is a React effect, which
        is not: an effect that unsubscribes before the subscription resolved has
        to leave nothing behind. Hence the flag — without it, an unsubscribe
        that lost the race would be dropped and the listener would outlive the
        component that asked for it.
      */
      let unlisten: (() => void) | null = null
      let cancelled = false

      void listen(name, payload => {
        if (!cancelled) {
          listener(payload?.payload as DesktopShellEvents[typeof name])
        }
      })
        .then(stop => {
          if (cancelled) {
            stop()
          } else {
            unlisten = stop
          }
        })
        .catch(() => {
          // No permission to listen, or a shell that does not emit this event.
          // Silence is the same outcome as a listener that never fires.
        })

      return () => {
        cancelled = true

        try {
          unlisten?.()
        } catch {
          // Unsubscribing twice, or a shell that went away.
        }

        unlisten = null
      }
    }
  }
}
