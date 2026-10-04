import { type DialPlan, GatewayError } from './types'

/**
 * A dial URL as an error may say it: without the query or the fragment. On a
 * session-token gateway the token rides in `?token=`, and an error text ends up
 * in logs, notices and diagnostics where a credential must never be.
 */
export const withoutQuery = (url: string): string => url.split(/[?#]/u, 1)[0] ?? ''

/**
 * The 3-argument WebSocket constructor React Native ships (and the `ws` package
 * mirrors): `new WebSocket(url, protocols, { headers })`. Typed here rather than
 * imported so this package stays free of React Native.
 */
export type WebSocketConstructorLike = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> }
) => WebSocket

export interface SocketCloseInfo {
  code: number
  reason: string
}

/**
 * The `socketFactory` the vendored `JsonRpcGatewayClient` calls. That client
 * only passes a URL, but a gated gateway needs a single-use ticket in the
 * subprotocol list and a session-token gateway needs extra headers — so the
 * connection owner *arms* the factory with a freshly minted plan immediately
 * before calling `connect()`, and the factory refuses to build a socket it was
 * not armed for.
 */
export class DialPlanSocketFactory {
  private plan: DialPlan | null = null
  /** The socket whose close is the connection's verdict; see `release`. */
  private current: WebSocket | null = null
  private onClose: ((info: SocketCloseInfo) => void) | undefined

  constructor(
    private readonly WebSocketImpl: WebSocketConstructorLike,
    onClose?: (info: SocketCloseInfo) => void
  ) {
    this.onClose = onClose
  }

  /** Install the plan for the next (single) dial. */
  arm(plan: DialPlan): void {
    this.plan = plan
  }

  /** Forget the armed plan; a stale ticket must not be reused on a later dial. */
  disarm(): void {
    this.plan = null
  }

  get armed(): boolean {
    return this.plan !== null
  }

  /**
   * The socket built last is no longer the connection's: it closed it itself.
   * A close it reports later is not forwarded, because the connection reads the
   * last close code as the verdict on the dial in flight.
   */
  release(): void {
    this.current = null
  }

  /** Replace the close callback (the connection sets this once at construction). */
  setOnClose(onClose: (info: SocketCloseInfo) => void): void {
    this.onClose = onClose
  }

  create = (url: string): WebSocket => {
    const plan = this.plan

    if (!plan) {
      throw new GatewayError('protocol', 'The gateway socket factory was asked to dial without an armed plan.')
    }

    if (plan.url !== url) {
      throw new GatewayError(
        'protocol',
        `The gateway socket factory was armed for ${withoutQuery(plan.url)} but asked to dial ${withoutQuery(url)}.`
      )
    }

    // One plan, one dial: a ticket is single-use and lives 30 seconds.
    this.plan = null

    const socket = new this.WebSocketImpl(
      plan.url,
      plan.protocols,
      plan.headers && Object.keys(plan.headers).length > 0 ? { headers: plan.headers } : undefined
    )

    this.current = socket

    socket.addEventListener('close', event => {
      // Only the current socket's close is a verdict. One that was replaced or
      // released can report late, and a 4403 from it used to be read as the
      // answer to the next dial.
      if (socket !== this.current) {
        return
      }

      const closeEvent = event as CloseEvent
      this.onClose?.({ code: closeEvent.code ?? 0, reason: closeEvent.reason ?? '' })
    })

    return socket
  }
}
