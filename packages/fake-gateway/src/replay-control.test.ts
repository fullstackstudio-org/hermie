/**
 * `POST /__fake/truncate-next-replay`: a client in another process (the native
 * integration tests) can make the next `session.events.since` answer the way the
 * real ring does once it has evicted an event newer than the watermark.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway } from './server'

type Call = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

function callOn(socket: WebSocket): Call {
  let id = 0

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const frameId = `rpc-${(id += 1)}`
      const onMessage = (data: unknown) => {
        const frame = JSON.parse(String(data)) as {
          id?: string
          result?: Record<string, unknown>
          error?: { message?: string }
        }

        if (frame.id !== frameId) {
          return
        }

        socket.off('message', onMessage)

        if (frame.error) {
          reject(new Error(frame.error.message ?? 'rpc error'))

          return
        }

        resolve(frame.result ?? {})
      }

      socket.on('message', onMessage)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
    })
}

describe('truncate-next-replay', () => {
  it('marks the next replay answer, and only that one, as truncated', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })

      try {
        const call = callOn(socket)
        const params = { session_id: 'nobody', last_seen: 0 }

        expect(await call('session.events.since', params)).toMatchObject({ truncated: false })

        const control = await fetch(`${gateway.url}/__fake/truncate-next-replay`, { method: 'POST', body: '{}' })

        expect(control.status).toBe(200)
        expect(gateway.state.truncateNextReplay).toBe(true)
        expect(await call('session.events.since', params)).toMatchObject({ truncated: true })
        expect(await call('session.events.since', params)).toMatchObject({ truncated: false })
      } finally {
        socket.close()
      }
    } finally {
      await gateway.close()
    }
  })
})
