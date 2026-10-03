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

/**
 * The `data` of a JSON-RPC error answer to a server request.
 *
 * The channel answers a server request with an error through
 * `ServerRequest.fail(code, message)`, which has no room for `data`, and the
 * confirm-passkey contract's 4040 carries its reason there (`data.reason`). The
 * channel is vendored and stays as it is, so the reason is attached on the way
 * out instead: a caller names the request id, code and data, calls `fail`, and
 * the socket adds `data` to that one error frame as it is sent. All of it is
 * synchronous (`fail` sends at once or not at all), and an entry is dropped right
 * after, sent or not, so nothing waits for a frame that never comes.
 *
 * Only an error frame for a named request id and code is ever touched, and only
 * while one is named; every other frame goes out as the string it was.
 */
export class ErrorDataOutbox {
  private readonly pending = new Map<string, { code: number; data: Record<string, unknown> }>()

  /** Run `send` (a `fail`) with `data` attached to the error frame it writes for `id`. */
  with(id: string, code: number, data: Record<string, unknown>, send: () => void): void {
    this.pending.set(id, { code, data })

    try {
      send()
    } finally {
      this.pending.delete(id)
    }
  }

  /** The frame as it goes out. */
  rewrite(text: string): string {
    if (this.pending.size === 0) {
      return text
    }

    let frame: unknown

    try {
      frame = JSON.parse(text)
    } catch {
      return text
    }

    const record = frame as { id?: unknown; error?: { code?: unknown; data?: unknown } } | null
    const entry = typeof record?.id === 'string' ? this.pending.get(record.id) : undefined

    if (!entry || !record?.error || record.error.code !== entry.code || record.error.data !== undefined) {
      return text
    }

    this.pending.delete(record.id as string)

    return JSON.stringify({ ...record, error: { ...record.error, data: entry.data } })
  }
}

/** Wrap a DOM-shaped constructor (the page's own, or a test's) as the factory's three-argument one. */
export function headerlessWebSocket(Impl: BrowserWebSocket, outbox?: ErrorDataOutbox): WebSocketConstructorLike {
  class HeaderlessWebSocket {
    constructor(url: string, protocols?: string | string[], _options?: { headers?: Record<string, string> }) {
      // `_options` is accepted and discarded: see the note above. Returning an
      // object from a constructor makes `new` evaluate to it.
      const socket = new Impl(url, protocols)

      if (outbox) {
        const send = socket.send.bind(socket)

        socket.send = data => send(typeof data === 'string' ? outbox.rewrite(data) : data)
      }

      return socket
    }
  }

  return HeaderlessWebSocket as unknown as WebSocketConstructorLike
}

/** The page's `WebSocket`, looked up when a socket is made. */
const PageWebSocket = class {
  constructor(url: string, protocols?: string | string[]) {
    return new WebSocket(url, protocols)
  }
} as unknown as BrowserWebSocket

/** The page's `WebSocket` as `DialPlanSocketFactory` wants it. Resolved when called, not at import. */
export const PlatformWebSocket: WebSocketConstructorLike = headerlessWebSocket(PageWebSocket)

/** A socket factory for one `GatewayConnection`, over the page's `WebSocket` unless told otherwise. */
export function createSocketFactory(
  onClose?: (info: SocketCloseInfo) => void,
  Impl: WebSocketConstructorLike = PlatformWebSocket
): DialPlanSocketFactory {
  return new DialPlanSocketFactory(Impl, onClose)
}

/** The page's `WebSocket`, with error `data` attached from `outbox` (see `ErrorDataOutbox`). */
export function createSocketFactoryWithOutbox(outbox: ErrorDataOutbox): DialPlanSocketFactory {
  return new DialPlanSocketFactory(headerlessWebSocket(PageWebSocket, outbox))
}
