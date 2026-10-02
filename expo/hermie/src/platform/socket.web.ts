/**
 * The browser's own `WebSocket`.
 *
 * **A page cannot set request headers on a WebSocket upgrade.** The DOM
 * constructor takes a URL and a subprotocol list and nothing else — there is no
 * third argument, and `fetch`-style headers have no equivalent. That is not a
 * gap in this file; it is the reason the gateway's ticket subprotocol exists at
 * all, and the reason the browser build authenticates with cookies rather than
 * with `Authorization`.
 *
 * Two consequences the rest of the app has to live with, both documented in
 * docs/platform-notes.md:
 *
 *  - The extra headers an operator can configure for a gateway behind
 *    Cloudflare Access (`CF-Access-Client-Secret` and friends) never reach the
 *    socket. Hermie Web is meant to run INSIDE that perimeter, next to
 *    `hermes serve`, with the proxy in front of Hermie Web instead.
 *  - `plan.headers` is dropped here rather than passed and silently ignored, so
 *    that the shared dial code can keep one shape.
 *
 * The cookie the gateway set is sent by the browser on the upgrade on its own,
 * because Hermie Web serves the app and proxies the gateway on ONE origin.
 */
import type { WebSocketConstructorLike } from '@hermie/gateway-client'

type BrowserWebSocket = new (url: string, protocols?: string | string[]) => WebSocket

class HeaderlessWebSocket {
  constructor(url: string, protocols?: string | string[], _options?: { headers?: Record<string, string> }) {
    // `_options` is accepted and discarded: see the note above.
    return new (WebSocket as unknown as BrowserWebSocket)(url, protocols)
  }
}

export const PlatformWebSocket = HeaderlessWebSocket as unknown as WebSocketConstructorLike
