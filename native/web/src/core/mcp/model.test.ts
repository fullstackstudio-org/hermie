/**
 * The MCP model with a hand-driven connection: idle until a page watches, one read per hint, only the
 * newest read applied, a revoke of its own is no news, and every refusal lands as the state the page
 * says in words.
 */
import type { GatewayEvent } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import type { Visibility } from '../../platform/visibility'
import { createMcpStore } from '../../state/mcp'
import { type McpClient, type McpGrant, McpRouteError, type McpStatus } from './client'
import { McpModel, problemOf } from './model'

const grant = (id: string, name = 'Claude Code'): McpGrant => ({
  id,
  clientName: name,
  clientId: `client-${id}`,
  scopes: ['mcp'],
  createdAt: 1_790_000_000,
  createdIp: null,
  createdUserAgent: null,
  lastUsedAt: null,
  lastUsedIp: null,
  expiresAt: null
})

const statusOf = (...grants: McpGrant[]): McpStatus => ({
  endpointUrl: 'https://gw.example.test/mcp',
  issuer: 'https://gw.example.test/mcp',
  label: 'hermie-gw',
  command: 'claude mcp add --transport http hermie-gw https://gw.example.test/mcp',
  configJson: '{}',
  instructions: '',
  grants
})

function handGateway() {
  const listeners: ((event: GatewayEvent) => void)[] = []

  return {
    gateway: {
      onAny: (listener: (event: GatewayEvent) => void) => {
        listeners.push(listener)

        return () => {
          listeners.splice(listeners.indexOf(listener), 1)
        }
      }
    },
    listeners,
    emit(type: string, payload: unknown) {
      for (const listener of [...listeners]) {
        listener({ type, payload } as unknown as GatewayEvent)
      }
    }
  }
}

function handVisibility() {
  const listeners: ((visibility: Visibility) => void)[] = []

  return {
    visibility: {
      subscribe: (listener: (visibility: Visibility) => void) => {
        listeners.push(listener)

        return () => undefined
      }
    },
    set(visibility: Visibility) {
      for (const listener of listeners) {
        listener(visibility)
      }
    }
  }
}

function build(client: Partial<McpClient> = {}) {
  const hand = handGateway()
  const sight = handVisibility()
  const store = createMcpStore()
  const status = vi.fn(async () => statusOf(grant('mcg_1')))
  const revoke = vi.fn(async (): Promise<'revoked' | 'gone'> => 'revoked')
  const model = new McpModel({
    gateway: hand.gateway,
    client: { status, revoke, ...client },
    visibility: sight.visibility,
    store
  })

  model.start()

  return { model, store, status, revoke, hand, sight }
}

const changed = (change: string, id: string, name = 'Claude Code') => ({
  change,
  grant: { id, client_name: name },
  at: 1_790_000_100
})

describe('the MCP model', () => {
  it('asks nothing until a page watches', async () => {
    const { status, hand, sight } = build()

    hand.emit('mcp.changed', changed('granted', 'mcg_9'))
    sight.set('visible')
    await Promise.resolve()

    expect(status).not.toHaveBeenCalled()
  })

  it('reads when a page opens, and is let go of when it closes', async () => {
    const { model, store, status, hand } = build()
    const release = model.watch()

    await vi.waitFor(() => expect(store.getState().loaded).toBe(true))
    expect(status).toHaveBeenCalledTimes(1)
    expect(store.getState().status?.grants.map(each => each.id)).toEqual(['mcg_1'])

    release()
    release()
    hand.emit('mcp.changed', changed('granted', 'mcg_9'))
    await Promise.resolve()

    expect(status).toHaveBeenCalledTimes(1)
  })

  it('reads again on mcp.changed and keeps what changed, for the page to say', async () => {
    const { model, store, status, hand } = build()

    model.watch()
    await vi.waitFor(() => expect(store.getState().loaded).toBe(true))

    hand.emit('mcp.changed', changed('granted', 'mcg_2', 'Another Agent'))

    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(store.getState().change).toEqual({ id: 1, change: 'granted', clientName: 'Another Agent' })

    // A frame that is not an object still means "something changed".
    hand.emit('mcp.changed', 'surprise')
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3))
    expect(store.getState().change).toEqual({ id: 2, change: '', clientName: '' })
  })

  it('reads again when the tab comes back, not when it leaves', async () => {
    const { model, status, sight } = build()

    model.watch()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1))

    sight.set('hidden')
    await Promise.resolve()
    expect(status).toHaveBeenCalledTimes(1)

    sight.set('visible')
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2))
  })

  it('applies only the newest read', async () => {
    const answers: ((value: McpStatus) => void)[] = []
    const { model, store } = build({
      status: () =>
        new Promise<McpStatus>(resolve => {
          answers.push(resolve)
        })
    })

    model.watch()
    void model.refresh()
    await Promise.resolve()

    // The newest answers first; the older one arrives late and is dropped.
    answers[1]?.(statusOf(grant('new')))
    await vi.waitFor(() => expect(store.getState().loaded).toBe(true))
    answers[0]?.(statusOf(grant('old')))
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().status?.grants.map(each => each.id)).toEqual(['new'])
  })

  it('revokes, reads the list again, and does not call its own revoke news', async () => {
    let grants = [grant('mcg_1'), grant('mcg_2')]
    const { model, store, hand } = build({
      status: async () => statusOf(...grants),
      revoke: async () => {
        grants = grants.filter(each => each.id !== 'mcg_1')

        return 'revoked'
      }
    })

    model.watch()
    await vi.waitFor(() => expect(store.getState().status?.grants).toHaveLength(2))

    await expect(model.revoke('mcg_1')).resolves.toBe('revoked')
    expect(store.getState().status?.grants.map(each => each.id)).toEqual(['mcg_2'])

    // The gateway's frame for it arrives after: a read, but nothing to announce.
    hand.emit('mcp.changed', changed('revoked', 'mcg_1'))
    await Promise.resolve()
    expect(store.getState().change).toBeNull()

    // The same word for somebody else's revoke is news.
    hand.emit('mcp.changed', changed('revoked', 'mcg_2'))
    expect(store.getState().change).toMatchObject({ change: 'revoked' })
  })

  it('treats "gone" as done and still reads the list', async () => {
    const { model, status } = build({ revoke: async () => 'gone' })

    model.watch()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1))

    await expect(model.revoke('mcg_1')).resolves.toBe('gone')
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('throws a refused revoke and keeps its frame as news', async () => {
    const refusal = new McpRouteError('refused', 'origin', 403, 'origin_not_listed')
    const { model, store, status, hand } = build({
      revoke: async () => {
        throw refusal
      }
    })

    model.watch()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1))

    await expect(model.revoke('mcg_1')).rejects.toBe(refusal)
    expect(status).toHaveBeenCalledTimes(1)

    hand.emit('mcp.changed', changed('revoked', 'mcg_1'))
    expect(store.getState().change).not.toBeNull()
  })

  it('shows nothing of an earlier list once the gateway says it has no MCP, and keeps it across a blip', async () => {
    let next: () => Promise<McpStatus> = async () => statusOf(grant('mcg_1'))
    const { model, store } = build({ status: () => next() })

    model.watch()
    await vi.waitFor(() => expect(store.getState().status).not.toBeNull())

    next = async () => {
      throw new McpRouteError('transport', 'offline')
    }
    await model.refresh()
    expect(store.getState()).toMatchObject({ problem: { kind: 'failed', message: 'offline' } })
    expect(store.getState().status?.grants).toHaveLength(1)

    next = async () => {
      throw new McpRouteError('not_offered', 'gone', 404)
    }
    await model.refresh()
    expect(store.getState()).toMatchObject({ problem: { kind: 'not_offered' }, status: null, loaded: true })

    next = async () => statusOf(grant('mcg_1'))
    await model.refresh()
    expect(store.getState()).toMatchObject({ problem: null })
  })

  it('maps what a failed call says', () => {
    expect(problemOf(new McpRouteError('not_offered', 'x', 404))).toEqual({ kind: 'not_offered' })
    expect(problemOf(new McpRouteError('no_identity', 'x', 403, 'no_identity'))).toEqual({ kind: 'sign_in' })
    expect(problemOf(new McpRouteError('refused', 'HTTP 500', 500))).toEqual({ kind: 'failed', message: 'HTTP 500' })
    expect(problemOf('plain')).toEqual({ kind: 'failed', message: 'plain' })
  })

  it('stops listening and forgets everything, once', async () => {
    const { model, store, status, hand } = build()

    model.watch()
    await vi.waitFor(() => expect(store.getState().loaded).toBe(true))

    model.stop()
    model.stop()
    hand.emit('mcp.changed', changed('granted', 'mcg_9'))
    await model.refresh()

    expect(hand.listeners).toHaveLength(0)
    expect(status).toHaveBeenCalledTimes(1)
    expect(store.getState()).toMatchObject({ status: null, loaded: false })
  })
})
