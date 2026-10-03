/**
 * `connection.respond`, checked as strictly as the gateway's contract
 * (`tui_gateway/contracts/connectors_operation.py`, every params model
 * `extra="forbid"`): exactly `{profile, owner, op_id, result}`, the owner a
 * `ConnectorOwner`, a row `{name, status: approved|skipped, detail?, env?}`. An
 * accepted answer moves the open operation and is announced as `connection.update`.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway } from './server'

interface Frame {
  id?: string
  method?: string
  params?: { type?: string; payload?: Record<string, unknown> }
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

function client(socket: WebSocket) {
  let id = 0
  const events: Frame['params'][] = []

  socket.on('message', data => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const frame = JSON.parse(line) as Frame

      if (frame.method === 'event') {
        events.push(frame.params)
      }
    }
  })

  const call = (method: string, params: Record<string, unknown>): Promise<Frame> =>
    new Promise(resolve => {
      const frameId = `rpc-${(id += 1)}`
      const onMessage = (data: unknown) => {
        for (const line of String(data).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as Frame

          if (frame.id === frameId) {
            socket.off('message', onMessage)
            resolve(frame)
          }
        }
      }

      socket.on('message', onMessage)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
    })

  return { call, events }
}

const answer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  profile: 'researcher',
  owner: { type: 'session', session_id: 'rt-1' },
  op_id: 'op-1',
  result: { targets: [{ name: 'github', status: 'skipped' }] },
  ...over
})

async function withGateway(
  body: (gateway: Awaited<ReturnType<typeof startFakeGateway>>, socket: WebSocket) => Promise<void>
) {
  const gateway = await startFakeGateway({ port: 0 })

  try {
    const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    gateway.state.connectorOps.set('op-1', {
      opId: 'op-1',
      sessionId: 'rt-1',
      seq: 1,
      deadlineAt: Math.floor(Date.now() / 1000) + 300,
      settled: false,
      settledBy: null,
      reads: 0,
      woken: false,
      targets: [
        {
          name: 'github',
          kind: 'connector',
          action: 'authorize',
          state: 'pending',
          connectUrl: null,
          detail: null,
          resolvesTo: 'connected'
        },
        {
          name: 'linear',
          kind: 'connector',
          action: 'authorize',
          state: 'pending',
          connectUrl: null,
          detail: null,
          resolvesTo: 'connected'
        }
      ]
    })

    try {
      await body(gateway, socket)
    } finally {
      socket.close()
    }
  } finally {
    await gateway.close()
  }
}

describe('connection.respond', () => {
  it('refuses a key the contract does not list, anywhere, and applies nothing', async () => {
    await withGateway(async (gateway, socket) => {
      const { call } = client(socket)

      for (const params of [
        answer({ session_id: 'rt-1' }),
        answer({ owner: { type: 'session', session_id: 'rt-1', extra: 1 } }),
        answer({ result: { targets: [], settled_by: 'continue', note: 'x' } }),
        answer({ result: { targets: [{ name: 'github', status: 'skipped', state: 'skipped' }] } }),
        answer({ result: { targets: [{ name: 'github', status: 'connected' }] } }),
        answer({ owner: { type: 'session' } }),
        answer({ owner: undefined }),
        answer({ op_id: '' }),
        answer({ result: { settled_by: 'later' } })
      ]) {
        const frame = await call('connection.respond', JSON.parse(JSON.stringify(params)) as Record<string, unknown>)

        expect(frame.error?.code, JSON.stringify(params)).toBe(4000)
      }

      expect(gateway.state.connectionResponses).toEqual([])
      expect(gateway.state.connectorOps.get('op-1')?.targets.map(target => target.state)).toEqual([
        'pending',
        'pending'
      ])
    })
  })

  it('takes the contract’s shape, records it, moves the operation and announces the update', async () => {
    await withGateway(async (gateway, socket) => {
      const { call, events } = client(socket)

      const skipped = await call('connection.respond', answer())

      expect(skipped.result).toEqual({ status: 'ok', settled: false })
      expect(gateway.state.connectionResponses).toEqual([answer()])

      const settled = await call(
        'connection.respond',
        answer({
          result: {
            settled_by: 'continue',
            targets: [{ name: 'linear', status: 'approved', detail: null, env: { TOKEN: 'x' } }]
          }
        })
      )

      expect(settled.result).toEqual({ status: 'ok', settled: true })
      await expect.poll(() => events.filter(event => event?.type === 'connection.update').length).toBe(2)

      const [first, second] = events.filter(event => event?.type === 'connection.update')

      expect(first?.payload).toMatchObject({
        op_id: 'op-1',
        settled: false,
        owner: { type: 'session', session_id: 'rt-1' }
      })
      expect((first?.payload?.targets as { state: string }[]).map(target => target.state)).toEqual([
        'skipped',
        'pending'
      ])
      expect(second?.payload).toMatchObject({ op_id: 'op-1', settled: true, settled_by: 'continue' })

      // A settled operation takes no more answers.
      expect((await call('connection.respond', answer())).error?.code).toBe(4004)
    })
  })
})
