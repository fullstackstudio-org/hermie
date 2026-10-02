/**
 * The browser's own `WebSocket`, shaped as the constructor `GatewayConnection`
 * dials through. Ported from the Expo app's `src/platform/socket.web.ts`.
 *
 * A page cannot set request headers on a WebSocket upgrade: the DOM
 * constructor takes a URL and a subprotocol list and nothing else. That is why
 * the gateway's ticket subprotocol exists, and why `CookieSessionCredentials`
 * mints one per dial. `DialPlanSocketFactory` is typed against the three-
 * argument React Native constructor, so the third argument (`plan.headers`) is
 * accepted here and dropped rather than passed and silently ignored. The
 * session cookie rides on the upgrade by itself, because the page and the
 * gateway share one origin.
 */
import {
  DialPlanSocketFactory,
  type SocketCloseInfo,
  type WebSocketConstructorLike
} from '@hermie/gateway-client/socket-factory'

type BrowserWebSocket = new (url: string, protocols?: string | string[]) => WebSocket

/** Wrap a DOM-shaped constructor (the page's own, or a test's) as the factory's three-argument one. */
export function headerlessWebSocket(Impl: BrowserWebSocket): WebSocketConstructorLike {
  class HeaderlessWebSocket {
    constructor(url: string, protocols?: string | string[], _options?: { headers?: Record<string, string> }) {
      // `_options` is accepted and discarded: see the note above. Returning an
      // object from a constructor makes `new` evaluate to it.
      return new Impl(url, protocols)
    }
  }

  return HeaderlessWebSocket as unknown as WebSocketConstructorLike
}

/** The page's `WebSocket` as `DialPlanSocketFactory` wants it. Resolved when called, not at import. */
export const PlatformWebSocket: WebSocketConstructorLike = headerlessWebSocket(
  class {
    constructor(url: string, protocols?: string | string[]) {
      return new WebSocket(url, protocols)
    }
  } as unknown as BrowserWebSocket
)

/** A socket factory for one `GatewayConnection`, over the page's `WebSocket` unless told otherwise. */
export function createSocketFactory(
  onClose?: (info: SocketCloseInfo) => void,
  Impl: WebSocketConstructorLike = PlatformWebSocket
): DialPlanSocketFactory {
  return new DialPlanSocketFactory(Impl, onClose)
}
