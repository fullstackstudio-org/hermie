/**
 * The chat layer's slice of the connection. The Expo app tests it only through
 * the controllers; the REST half is pinned here because the page's cookie
 * session is what carries it.
 */
import type { GatewayConnection } from '@hermie/gateway-client'
import { describe, expect, it, vi } from 'vitest'

import { chatGatewayFor } from './link'

function connectionAnswering(answer: () => Promise<unknown>) {
  const get = vi.fn((_path: string) => answer())
  const connection = {
    http: { get },
    request: vi.fn(async () => ({ ok: true })),
    on: vi.fn(() => () => undefined),
    onAny: vi.fn(() => () => undefined),
    onRequest: vi.fn(() => () => undefined),
    onStatus: vi.fn(() => () => undefined)
  }

  return { connection, get, gateway: chatGatewayFor(connection as unknown as GatewayConnection) }
}

describe('the REST transcript', () => {
  it('asks for the newest page, with no offset at zero and the offset after', async () => {
    const { gateway, get } = connectionAnswering(async () => ({ messages: [{ id: 1 }] }))

    await expect(gateway.fetchMessages('sess/1', { limit: 30, order: 'latest' })).resolves.toEqual([{ id: 1 }])
    await gateway.fetchMessages('sess/1', { limit: 30, order: 'latest', offset: 30 })

    expect(get.mock.calls.map(call => call[0])).toEqual([
      '/api/sessions/sess%2F1/messages?limit=30&order=latest',
      '/api/sessions/sess%2F1/messages?limit=30&order=latest&offset=30'
    ])
  })

  it('reads `rows` as well as `messages`, and an answer with neither as no rows', async () => {
    await expect(
      connectionAnswering(async () => ({ rows: [{ id: 2 }] })).gateway.fetchMessages('s', { limit: 1, order: 'oldest' })
    ).resolves.toEqual([{ id: 2 }])
    await expect(
      connectionAnswering(async () => ({})).gateway.fetchMessages('s', { limit: 1, order: 'oldest' })
    ).resolves.toEqual([])
  })

  it('answers null when the gateway has no REST transcript, so the caller falls back', async () => {
    const { gateway } = connectionAnswering(async () => {
      throw new Error('404')
    })

    await expect(gateway.fetchMessages('s', { limit: 1, order: 'latest' })).resolves.toBeNull()
  })
})

describe('the socket half', () => {
  it('is the connection’s own', async () => {
    const { gateway, connection } = connectionAnswering(async () => ({}))
    const handler = () => undefined

    await gateway.request('profiles.list', { include_sessions: true })
    gateway.onStatus(handler)

    expect(connection.request).toHaveBeenCalledWith('profiles.list', { include_sessions: true }, undefined)
    expect(connection.onStatus).toHaveBeenCalledWith(handler)
  })
})
