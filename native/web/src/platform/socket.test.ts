import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSocketFactory, ErrorDataOutbox, headerlessWebSocket, PlatformWebSocket, ReplayGapTap } from './socket'

/** Records what a DOM-shaped constructor was called with. */
class RecordingSocket extends EventTarget {
  static calls: unknown[][] = []

  constructor(...args: unknown[]) {
    super()
    RecordingSocket.calls.push(args)
  }
}

afterEach(() => {
  RecordingSocket.calls = []
  vi.unstubAllGlobals()
})

describe('the browser socket', () => {
  it('passes the URL and the subprotocols, and drops the headers a browser cannot send', () => {
    const Impl = headerlessWebSocket(RecordingSocket as never)

    const socket = new Impl('ws://gateway.example.com/api/ws', ['hermes-gateway-v1', 'hermes-gateway-ticket.t1'], {
      headers: { 'x-ignored': '1' }
    })

    expect(socket).toBeInstanceOf(RecordingSocket)
    expect(RecordingSocket.calls).toEqual([
      ['ws://gateway.example.com/api/ws', ['hermes-gateway-v1', 'hermes-gateway-ticket.t1']]
    ])
  })

  it('dials through the factory with the armed plan, once', () => {
    const factory = createSocketFactory(undefined, headerlessWebSocket(RecordingSocket as never))

    factory.arm({
      url: 'ws://gateway.example.com/api/ws',
      protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t1']
    })
    factory.create('ws://gateway.example.com/api/ws')

    expect(RecordingSocket.calls).toHaveLength(1)
    expect(() => factory.create('ws://gateway.example.com/api/ws')).toThrow(/without an armed plan/u)
  })

  it('resolves the page’s WebSocket when it dials, not at import', () => {
    vi.stubGlobal('WebSocket', RecordingSocket)

    new PlatformWebSocket('ws://gateway.example.com/api/ws', ['hermes-gateway-v1'])

    expect(RecordingSocket.calls).toEqual([['ws://gateway.example.com/api/ws', ['hermes-gateway-v1']]])
  })
})

describe('the error data outbox', () => {
  class SendingSocket extends EventTarget {
    static sent: unknown[] = []

    send(data: unknown): void {
      SendingSocket.sent.push(data)
    }
  }

  afterEach(() => {
    SendingSocket.sent = []
  })

  const errorFrame = (id: string, code: number): string =>
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'passkey ceremony unavailable' } })

  const socketWith = (outbox: ErrorDataOutbox): SendingSocket =>
    new (headerlessWebSocket(SendingSocket as never, outbox))(
      'ws://gateway.example.com/api/ws'
    ) as unknown as SendingSocket

  it('adds the data to the one error frame it was named for, while it is being sent', () => {
    const outbox = new ErrorDataOutbox()
    const socket = socketWith(outbox)

    outbox.with('srq-1', 4040, { reason: 'no_credential' }, () => socket.send(errorFrame('srq-1', 4040)))
    socket.send(errorFrame('srq-1', 4040))

    expect(SendingSocket.sent.map(text => JSON.parse(text as string))).toEqual([
      {
        jsonrpc: '2.0',
        id: 'srq-1',
        error: { code: 4040, message: 'passkey ceremony unavailable', data: { reason: 'no_credential' } }
      },
      { jsonrpc: '2.0', id: 'srq-1', error: { code: 4040, message: 'passkey ceremony unavailable' } }
    ])
  })

  it('leaves every other frame as the string it was', () => {
    const outbox = new ErrorDataOutbox()
    const socket = socketWith(outbox)
    const other = errorFrame('srq-2', 4040)
    const otherCode = errorFrame('srq-1', -32601)
    const result = JSON.stringify({ jsonrpc: '2.0', id: 'srq-1', result: { ok: true } })

    outbox.with('srq-1', 4040, { reason: 'no_credential' }, () => {
      socket.send(other)
      socket.send(otherCode)
      socket.send(result)
      socket.send('not json')
    })

    expect(SendingSocket.sent).toEqual([other, otherCode, result, 'not json'])
  })

  it('forgets the entry when the send throws', () => {
    const outbox = new ErrorDataOutbox()

    expect(() =>
      outbox.with('srq-3', 4040, { reason: 'x' }, () => {
        throw new Error('gone')
      })
    ).toThrow('gone')
    expect(outbox.rewrite(errorFrame('srq-3', 4040))).toBe(errorFrame('srq-3', 4040))
  })
})

describe('the replay gap tap', () => {
  class TappedSocket extends EventTarget {
    static sent: unknown[] = []

    send(data: unknown): void {
      TappedSocket.sent.push(data)
    }

    /** A frame from the gateway, as the browser delivers it. */
    deliver(data: unknown): void {
      this.dispatchEvent(new MessageEvent('message', { data }))
    }
  }

  afterEach(() => {
    TappedSocket.sent = []
  })

  const ask = (id: string | number, sessionId: string): string =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'session.events.since',
      params: { session_id: sessionId, last_seen: 4 }
    })
  const answer = (id: string | number, truncated: boolean): string =>
    JSON.stringify({ jsonrpc: '2.0', id, result: { events: [], latest_seq: 9, truncated, epoch: 'e1' } })

  const tapped = (): { socket: TappedSocket; gaps: string[]; tap: ReplayGapTap } => {
    const tap = new ReplayGapTap()
    const gaps: string[] = []

    tap.onGap(sessionId => gaps.push(sessionId))

    const socket = new (headerlessWebSocket(TappedSocket as never, { replayGaps: tap }))(
      'ws://gateway.example.com/api/ws'
    ) as unknown as TappedSocket

    return { socket, gaps, tap }
  }

  it('names the session whose replay answered truncated, before the connection reads the answer', () => {
    const { socket, gaps } = tapped()
    const seenByConnection: string[][] = []

    socket.addEventListener('message', () => seenByConnection.push([...gaps]))
    socket.send(ask('r-1', 'rt-a'))
    socket.send(ask(2, 'rt-b'))
    socket.deliver(answer(2, true))
    socket.deliver(answer('r-1', false))

    expect(gaps).toEqual(['rt-b'])
    expect(seenByConnection).toEqual([['rt-b'], ['rt-b']])
    // Every frame went out as it was.
    expect(TappedSocket.sent).toEqual([ask('r-1', 'rt-a'), ask(2, 'rt-b')])
  })

  it('reads only the answers to replay calls, once each', () => {
    const { socket, gaps } = tapped()

    socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 'r-3', method: 'session.history', params: { session_id: 'rt-a' } })
    )
    socket.deliver(JSON.stringify({ jsonrpc: '2.0', id: 'r-3', result: { truncated: true } }))
    socket.send(ask('r-4', 'rt-a'))
    socket.deliver(answer('r-4', true))
    socket.deliver(answer('r-4', true))
    socket.deliver('not json')
    socket.deliver(new ArrayBuffer(2))

    expect(gaps).toEqual(['rt-a'])
  })

  it('keeps going when a listener throws, and stops telling one that left', () => {
    const tap = new ReplayGapTap()
    const heard: string[] = []

    tap.onGap(() => {
      throw new Error('not mine')
    })
    const stop = tap.onGap(sessionId => heard.push(sessionId))

    tap.outgoing(ask('r-5', 'rt-c'))
    tap.incoming(answer('r-5', true))
    stop()
    tap.outgoing(ask('r-6', 'rt-c'))
    tap.incoming(answer('r-6', true))

    expect(heard).toEqual(['rt-c'])
  })

  it('forgets the oldest call once too many wait', () => {
    const tap = new ReplayGapTap()
    const heard: string[] = []

    tap.onGap(sessionId => heard.push(sessionId))

    for (let index = 0; index <= 256; index += 1) {
      tap.outgoing(ask(`r-${index}`, `rt-${index}`))
    }

    tap.incoming(answer('r-0', true))
    tap.incoming(answer('r-256', true))

    expect(heard).toEqual(['rt-256'])
  })
})
