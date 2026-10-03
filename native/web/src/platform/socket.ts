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

/** How many `session.events.since` calls `ReplayGapTap` waits on at once; one more forgets the oldest. */
const REPLAY_CALLS_LIMIT = 256

/**
 * Which `session.events.since` answers could not vouch for themselves.
 *
 * The connection replays every session it holds a watermark for by itself after a
 * reconnect (`@hermes/shared/json-rpc-gateway`, `fetchReplay`), and applies what
 * the answer carries, but it reads nothing else of the answer: a `truncated: true`
 * (the gateway's ring had already dropped an event after the watermark) passes
 * unseen, and the events it no longer holds are in no frame anybody will ever
 * send. That client is vendored and stays as it is, so the answer is read on the
 * way in instead, as `ErrorDataOutbox` writes on the way out: the tap notes the
 * id and session of every `session.events.since` call as it is sent, and when the
 * answer to one of them says `truncated: true` it names the session to whoever
 * listens (the chat controller reads that chat again in full,
 * `ChatController.noteReplayGap`).
 *
 * It hears the answers to the chat controller's own replays too; the controller
 * reads those itself, and a gap it is already handling is not handled twice.
 * Nothing is changed or held back: every frame goes on as it came, and a frame
 * the tap cannot read is not its business.
 */
export class ReplayGapTap {
  /** Request id → the session it asked about, oldest first. */
  private readonly asked = new Map<string, string>()
  private readonly listeners = new Set<(sessionId: string) => void>()

  /** Hear every session a replay answered `truncated: true` for. Returns the way to stop. */
  onGap(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  /** A frame as it goes out. */
  outgoing(text: string): void {
    if (!text.includes('session.events.since')) {
      return
    }

    const frame = parseFrame(text) as { id?: unknown; method?: unknown; params?: { session_id?: unknown } } | null

    if (
      frame?.method !== 'session.events.since' ||
      (typeof frame.id !== 'string' && typeof frame.id !== 'number') ||
      typeof frame.params?.session_id !== 'string' ||
      !frame.params.session_id
    ) {
      return
    }

    this.asked.set(String(frame.id), frame.params.session_id)

    if (this.asked.size > REPLAY_CALLS_LIMIT) {
      const oldest = this.asked.keys().next().value

      if (oldest !== undefined) {
        this.asked.delete(oldest)
      }
    }
  }

  /** A frame as it comes in. */
  incoming(data: unknown): void {
    // Every replay answer names `truncated`; a streamed delta does not, and is not parsed a second time.
    if (this.asked.size === 0 || typeof data !== 'string' || !data.includes('"truncated"')) {
      return
    }

    const frame = parseFrame(data) as { id?: unknown; result?: { truncated?: unknown } } | null

    if (!frame || (typeof frame.id !== 'string' && typeof frame.id !== 'number')) {
      return
    }

    const id = String(frame.id)
    const sessionId = this.asked.get(id)

    if (sessionId === undefined) {
      return
    }

    this.asked.delete(id)

    if (frame.result?.truncated !== true) {
      return
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(sessionId)
      } catch {
        // A listener's failure is its own; the frame goes on regardless.
      }
    }
  }
}

function parseFrame(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** What a page socket is wrapped with on the way out and in. */
export interface SocketTaps {
  outbox?: ErrorDataOutbox
  replayGaps?: ReplayGapTap
}

/** Wrap a DOM-shaped constructor (the page's own, or a test's) as the factory's three-argument one. */
export function headerlessWebSocket(
  Impl: BrowserWebSocket,
  taps: ErrorDataOutbox | SocketTaps = {}
): WebSocketConstructorLike {
  const { outbox, replayGaps } = taps instanceof ErrorDataOutbox ? { outbox: taps, replayGaps: undefined } : taps

  class HeaderlessWebSocket {
    constructor(url: string, protocols?: string | string[], _options?: { headers?: Record<string, string> }) {
      // `_options` is accepted and discarded: see the note above. Returning an
      // object from a constructor makes `new` evaluate to it.
      const socket = new Impl(url, protocols)

      if (outbox || replayGaps) {
        const send = socket.send.bind(socket)

        socket.send = data => {
          if (typeof data === 'string') {
            replayGaps?.outgoing(data)
          }

          send(typeof data === 'string' && outbox ? outbox.rewrite(data) : data)
        }
      }

      if (replayGaps) {
        // Added before the connection adds its own, so the tap has read an answer before it is applied.
        socket.addEventListener('message', event => replayGaps.incoming(event.data))
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

/**
 * The page's `WebSocket`, with error `data` attached from `outbox` (see `ErrorDataOutbox`), and the
 * replay answers read by `replayGaps` when one is given (see `ReplayGapTap`).
 */
export function createSocketFactoryWithOutbox(
  outbox: ErrorDataOutbox,
  replayGaps?: ReplayGapTap
): DialPlanSocketFactory {
  return new DialPlanSocketFactory(
    headerlessWebSocket(PageWebSocket, { outbox, ...(replayGaps ? { replayGaps } : {}) })
  )
}
