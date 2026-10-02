import type { ChatGateway } from '../../src/gateway/link'

export interface RecordedCall {
  method: string
  params: Record<string, unknown>
}

type Responder = (params: Record<string, unknown>) => unknown

/**
 * A `ChatGateway` with no socket behind it.
 *
 * The controller is written against the interface rather than against
 * `GatewayConnection` precisely so a test can be this small: queue the replies,
 * drive the events by hand, and read back exactly which calls went out in which
 * order.
 */
export class FakeChatGateway implements ChatGateway {
  readonly calls: RecordedCall[] = []
  readonly responders = new Map<string, Responder>()
  restMessages: unknown[] | null = []
  /**
   * The whole conversation, oldest first, for a test about PAGING.
   *
   * When it is set it wins over `restMessages`, and this object answers the
   * route rather than replaying one canned list — which is the only way a test
   * can tell a second page from the same page fetched twice.
   */
  restPages: unknown[] | null = null
  readonly restCalls: { sessionId: string; limit: number; order: string; offset?: number }[] = []
  /** Requests answered with a JSON-RPC error, the way the channel declines one. */
  readonly declined: { id: string; method: string; code: number; message: string }[] = []

  private readonly answers = new Map<string, () => Record<string, unknown> | null>()

  private eventHandlers: ((event: unknown) => void)[] = []
  private requestHandlers: ((request: never) => boolean | void)[] = []
  private statusHandlers: ((status: never, error: never) => void)[] = []

  /** Answer `method` with `value`, or with whatever `value(params)` returns. */
  reply(method: string, value: unknown | Responder): this {
    this.responders.set(method, typeof value === 'function' ? (value as Responder) : () => value)

    return this
  }

  /** The params of the most recent call to `method`, if there was one. */
  lastCall(method: string): Record<string, unknown> | undefined {
    return [...this.calls].reverse().find(call => call.method === method)?.params
  }

  /**
   * Every call to `method`, oldest first.
   *
   * `lastCall` answers "what did it end up asking for" and `methodOrder`
   * answers "in what order did the methods go out". Neither can answer "which
   * session did the FIRST of the two renames address", which is the whole
   * question for a swap that has to happen in a particular order and roll back
   * when it cannot.
   */
  callsOf(method: string): Record<string, unknown>[] {
    return this.calls.filter(call => call.method === method).map(call => call.params)
  }

  methodOrder(): string[] {
    return this.calls.map(call => call.method)
  }

  request = (async (method: string, params: Record<string, unknown> = {}) => {
    this.calls.push({ method, params })

    const responder = this.responders.get(method)

    if (!responder) {
      throw new Error(`FakeChatGateway has no reply for ${method}`)
    }

    const result = responder(params)

    // The real channel replays a result's `open_requests` to the request
    // handlers BEFORE resolving the call, over the socket that owns them. A
    // fake that resolves first would never reproduce the window in which the
    // session those requests belong to is not bound yet.
    this.deliverOpenRequests(result)

    return result
  }) as ChatGateway['request']

  private deliverOpenRequests(result: unknown): void {
    const open = (result as { open_requests?: unknown } | null | undefined)?.open_requests

    if (!Array.isArray(open)) {
      return
    }

    for (const entry of open as { id?: unknown; method?: unknown; params?: unknown }[]) {
      if (typeof entry?.id === 'string' && typeof entry.method === 'string') {
        this.serverRequest(entry.id, entry.method, (entry.params ?? {}) as Record<string, unknown>, true)
      }
    }
  }

  on = ((_type: string, _handler: unknown) => () => undefined) as ChatGateway['on']

  onAny: ChatGateway['onAny'] = handler => {
    const wrapped = handler as unknown as (event: unknown) => void
    this.eventHandlers.push(wrapped)

    return () => {
      this.eventHandlers = this.eventHandlers.filter(entry => entry !== wrapped)
    }
  }

  onRequest: ChatGateway['onRequest'] = handler => {
    const wrapped = handler as unknown as (request: never) => boolean | void
    this.requestHandlers.push(wrapped)

    return () => {
      this.requestHandlers = this.requestHandlers.filter(entry => entry !== wrapped)
    }
  }

  onStatus: ChatGateway['onStatus'] = handler => {
    const wrapped = handler as unknown as (status: never, error: never) => void
    this.statusHandlers.push(wrapped)

    return () => {
      this.statusHandlers = this.statusHandlers.filter(entry => entry !== wrapped)
    }
  }

  fetchMessages: ChatGateway['fetchMessages'] = async (sessionId, options) => {
    this.restCalls.push({
      sessionId,
      limit: options.limit,
      order: options.order,
      ...(options.offset === undefined ? {} : { offset: options.offset })
    })

    if (this.restPages) {
      /*
        A paging fake, with the same arithmetic the real route was measured to
        use: `offset` skips from the end `order` names, and the page comes back
        oldest first either way. An offset past the end answers an empty list
        rather than an error.
      */
      const offset = options.offset ?? 0
      const end = Math.max(0, this.restPages.length - offset)

      return this.restPages.slice(Math.max(0, end - options.limit), end) as never
    }

    return this.restMessages as never
  }

  /** Publish one gateway event to every subscriber. */
  emit(event: { type: string; session_id?: string; seq?: number; payload?: unknown }): void {
    for (const handler of [...this.eventHandlers]) {
      handler(event)
    }
  }

  /**
   * Deliver one server→client request. `answer()` reads what the client
   * eventually replied, which for an approval is whenever the user taps.
   */
  serverRequest(
    id: string,
    method: string,
    params: Record<string, unknown>,
    replayed = false
  ): { accepted: boolean; answer: () => Record<string, unknown> | null } {
    let answer: Record<string, unknown> | null = null
    const request = {
      id,
      method,
      params,
      ...(replayed ? { replayed: true } : {}),
      respond: (result: Record<string, unknown>) => {
        answer = result
      },
      fail: (code: number, message: string) => {
        this.declined.push({ id, method, code, message })
      }
    }

    for (const handler of [...this.requestHandlers]) {
      if ((handler as unknown as (value: unknown) => boolean | void)(request) !== false) {
        this.answers.set(id, () => answer)

        return { accepted: true, answer: () => answer }
      }
    }

    // What the real channel does with a request nobody claims — and what makes
    // the gateway withdraw an approval instead of waiting for one.
    request.fail(-32601, `Method not found: ${method}`)

    return { accepted: false, answer: () => null }
  }

  /** What a request delivered earlier was eventually answered with. */
  answerFor(id: string): Record<string, unknown> | null {
    return this.answers.get(id)?.() ?? null
  }

  /** Announce a connection status change. */
  status(next: string): void {
    for (const handler of [...this.statusHandlers]) {
      ;(handler as unknown as (status: string, error: null) => void)(next, null)
    }
  }
}
