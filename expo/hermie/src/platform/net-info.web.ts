/**
 * "Is there a network" in a browser.
 *
 * `navigator.onLine` is a much weaker claim than NetInfo's: it is false only
 * when the operating system says there is no interface at all, and it stays
 * true on a captive portal, on a dead VPN and on a Wi-Fi network with no route
 * out. That is fine for what the connection uses it for — it stops the dial
 * ladder from burning battery while a laptop is closed, and the ladder itself
 * is what actually discovers an unreachable gateway.
 *
 * The listener is deliberately two DOM events rather than a polling probe: a
 * request made to find out whether requests work is a request made to a gateway
 * the user may not want touched on a schedule.
 */
import type { NetworkKind, NetworkWatcher } from './platform-contracts'

export type { NetworkKind, NetworkWatcher } from './platform-contracts'

export const networkWatcher: NetworkWatcher = {
  subscribe(onChange) {
    if (typeof window === 'undefined') {
      return () => {}
    }

    const report = () => onChange(navigator.onLine !== false)

    window.addEventListener('online', report)
    window.addEventListener('offline', report)
    report()

    return () => {
      window.removeEventListener('online', report)
      window.removeEventListener('offline', report)
    }
  },

  /*
    Always `unknown`, and deliberately not `navigator.connection`.

    The Network Information API is not implemented in Safari or Firefox, and
    where it IS implemented it is a fingerprinting surface the app has no other
    reason to touch. What it would buy is one sentence in a wizard the browser
    build does not even show — Hermie Web fixes the gateway to its own origin,
    so there is no address step to hint about.
  */
  async kind(): Promise<NetworkKind> {
    return 'unknown'
  }
}
