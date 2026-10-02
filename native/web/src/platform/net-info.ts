/**
 * "Is there a network", in a browser. Ported from the Expo app's
 * `src/platform/net-info.web.ts`, with the window and navigator injectable.
 *
 * `navigator.onLine` is a weak claim: it is false only when the operating
 * system says there is no interface at all, and stays true on a captive portal
 * or a dead VPN. That is enough for what the connection uses it for (not
 * burning the dial ladder while a laptop is offline); the ladder itself is what
 * discovers an unreachable gateway. Two DOM events, never a polling probe.
 */
import type { NetworkKind } from '@hermie/gateway-client'

export type { NetworkKind } from '@hermie/gateway-client'

export interface NetworkWatcher {
  /** Called once at once with the current answer, then on every change. Returns the unsubscribe. */
  subscribe(onChange: (online: boolean) => void): () => void
  /** Always `unknown` in a browser: see below. */
  kind(): Promise<NetworkKind>
}

/** What the watcher reads, so a test can hand in its own. */
export interface NetworkEnvironment {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  navigator: { readonly onLine?: boolean }
}

const pageEnvironment = (): NetworkEnvironment | null =>
  typeof window === 'undefined' ? null : { target: window, navigator: window.navigator }

/** `null` means "no window": online, and nothing to listen to. */
export function createNetworkWatcher(environment: NetworkEnvironment | null = pageEnvironment()): NetworkWatcher {
  return {
    subscribe(onChange) {
      if (!environment) {
        onChange(true)

        return () => {}
      }

      // Only an explicit `false` is offline; an unknown answer must not stop a dial.
      const report = () => onChange(environment.navigator.onLine !== false)

      environment.target.addEventListener('online', report)
      environment.target.addEventListener('offline', report)
      report()

      return () => {
        environment.target.removeEventListener('online', report)
        environment.target.removeEventListener('offline', report)
      }
    },

    /*
      Deliberately not `navigator.connection`: Safari and Firefox do not have it,
      and where it exists it is a fingerprinting surface with no other use here.
    */
    async kind(): Promise<NetworkKind> {
      return 'unknown'
    }
  }
}

/** The page's own watcher. */
export const networkWatcher: NetworkWatcher = createNetworkWatcher()
