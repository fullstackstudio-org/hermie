/**
 * The slice of a connection the secure input model listens to, driven by hand:
 * server requests delivered as the channel delivers them (each handler in turn
 * until one takes it), `request.cancel` events, the connection's status, and the
 * chats' runtime sessions. Every reply a request gets is recorded, in order.
 */
import type { ServerRequest, ServerRequestHandler } from '@hermes/shared/json-rpc-channel'
import type { ConnectionStatus } from '@hermie/gateway-client'

import type { SecureInputGateway, SecureInputTimers } from '../core/requests/secure-input'

/** One reply a request got. */
export type Reply =
  { id: string; result: Record<string, unknown> } | { id: string; error: { code: number; message: string } }

export interface FakeSecureGateway {
  gateway: SecureInputGateway
  /** Every reply, in the order they went out; a request's second reply is not sent (the channel's guard). */
  replies: Reply[]
  /** Deliver a server request; true when a handler took it. */
  deliver(id: string, method: string, params: Record<string, unknown>, replayed?: boolean): boolean
  cancel(id: string, reason?: string): void
  status(status: ConnectionStatus): void
}

export function fakeSecureGateway(initial: ConnectionStatus = 'ready'): FakeSecureGateway {
  const requestHandlers: ServerRequestHandler[] = []
  const anyHandlers = new Set<(event: { type: string; payload?: unknown }) => void>()
  const statusHandlers = new Set<(status: ConnectionStatus, error: null) => void>()
  const replies: Reply[] = []
  let current = initial

  const gateway = {
    onRequest(handler: ServerRequestHandler) {
      requestHandlers.push(handler)

      return () => {
        const at = requestHandlers.indexOf(handler)

        if (at >= 0) {
          requestHandlers.splice(at, 1)
        }
      }
    },
    onAny(handler: (event: { type: string; payload?: unknown }) => void) {
      anyHandlers.add(handler)

      return () => anyHandlers.delete(handler)
    },
    onStatus(handler: (status: ConnectionStatus, error: null) => void) {
      statusHandlers.add(handler)
      handler(current, null)

      return () => statusHandlers.delete(handler)
    }
  } as unknown as SecureInputGateway

  return {
    gateway,
    replies,
    deliver(id, method, params, replayed = false) {
      let settled = false
      const request: ServerRequest = {
        id,
        method,
        params,
        replayed,
        respond: result => {
          if (!settled) {
            settled = true
            replies.push({ id, result })
          }
        },
        fail: (code, message) => {
          if (!settled) {
            settled = true
            replies.push({ id, error: { code, message } })
          }
        }
      }

      for (const handler of [...requestHandlers]) {
        if (handler(request) !== false) {
          return true
        }
      }

      return false
    },
    cancel(id, reason = 'interrupted') {
      for (const handler of anyHandlers) {
        handler({ type: 'request.cancel', payload: { id, reason } })
      }
    },
    status(status) {
      current = status

      for (const handler of statusHandlers) {
        handler(status, null)
      }
    }
  }
}

/** Timers a test moves by hand, on a clock it owns. */
export interface ManualTimers extends SecureInputTimers {
  now(): number
  /** Move the clock on, firing every timer that falls due, in order. */
  advance(ms: number): void
  pending(): number
}

export function manualTimers(start = 1_000_000): ManualTimers {
  let clock = start
  let serial = 0
  const timers = new Map<number, { at: number; callback: () => void }>()

  return {
    now: () => clock,
    setTimeout(callback, ms) {
      serial += 1
      timers.set(serial, { at: clock + ms, callback })

      return serial
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    advance(ms) {
      const end = clock + ms

      for (;;) {
        let next: [number, { at: number; callback: () => void }] | undefined

        for (const entry of timers) {
          if (entry[1].at <= end && (next === undefined || entry[1].at < next[1].at)) {
            next = entry
          }
        }

        if (!next) {
          break
        }

        timers.delete(next[0])
        clock = next[1].at
        next[1].callback()
      }

      clock = end
    },
    pending: () => timers.size
  }
}
