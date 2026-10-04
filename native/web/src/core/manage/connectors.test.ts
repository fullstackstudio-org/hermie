/**
 * The connector readers and calls: a row is read from an open key set, the calls name an owner and never a
 * session, a frame older than one already seen is dropped rather than applied, and a flow ends by the target's
 * state, by the operation settling without it, or by the deadline.
 */
import { describe, expect, it } from 'vitest'

import { aConnectorsGateway } from '../../test-support/connectors-gateway'
import {
  CONNECT_POLL_INTERVAL_MS,
  CONNECT_TIMEOUT_MS,
  connectorState,
  createConnectorsClient,
  describeConnector,
  seqOf
} from './connectors'

describe('describeConnector', () => {
  it('prefers the vendor’s name, falls back to the slug, and reads the reason off the open key set', () => {
    expect(
      describeConnector({
        connector: 'gmail',
        name: 'Gmail',
        connected: true,
        enabled: true,
        statusReason: 'fine',
        connectionStatus: 'active'
      })
    ).toEqual({
      slug: 'gmail',
      label: 'Gmail',
      description: null,
      connected: true,
      enabled: true,
      connectionStatus: 'active',
      statusReason: 'fine'
    })
    expect(describeConnector({ connector: 'notion' })).toMatchObject({
      slug: 'notion',
      label: 'notion',
      connected: false,
      enabled: null
    })
    expect(describeConnector({ name: 'Only a name' })).toMatchObject({ slug: 'Only a name' })
    expect(describeConnector({})).toMatchObject({ slug: '' })
  })

  it('takes a row that did not say whether it is enabled as not off', () => {
    expect(connectorState(describeConnector({ connector: 'a' }))).toBe('notConnected')
    expect(connectorState(describeConnector({ connector: 'a', enabled: false }))).toBe('disabled')
    expect(connectorState(describeConnector({ connector: 'a', enabled: false, connected: true }))).toBe('connected')
  })

  it('reads a frame’s order only when it carries one', () => {
    expect(seqOf({ seq: 4 })).toBe(4)
    expect(seqOf({})).toBeNull()
    expect(seqOf(null)).toBeNull()
  })
})

describe('the client', () => {
  it('names the account as the owner on every call, and never a session', async () => {
    const gateway = aConnectorsGateway({ reads: 1 })
    const client = createConnectorsClient(gateway.transport.gateway, { wait: async () => undefined })
    const flow = await client.connect('notion', { profile: 'p', reconnect: false })

    await flow.done
    await client.list('p')

    for (const call of gateway.rpc) {
      expect(call.params.owner, call.method).toEqual({ type: 'account' })
      expect('session_id' in call.params, call.method).toBe(false)
    }
  })

  it('lists with `available` carried through, and drops a row it cannot name', async () => {
    expect(await createConnectorsClient(aConnectorsGateway({ unavailable: true }).transport.gateway).list('p')).toEqual(
      {
        available: false,
        connectors: []
      }
    )
    expect(
      (await createConnectorsClient(aConnectorsGateway().transport.gateway).list('p')).connectors.map(
        entry => entry.slug
      )
    ).toEqual(['gmail', 'notion', 'slack'])
  })

  it('drops a frame older than one it has already seen, so a connected target is not walked back', async () => {
    const gateway = aConnectorsGateway({ reads: 1000 })
    const request = gateway.transport.gateway.request as unknown as (
      m: string,
      p: unknown
    ) => Promise<Record<string, unknown>>
    let reads = 0

    gateway.transport.gateway.request = (async (method: string, params: unknown) => {
      const answer = await request(method, params)

      if (method === 'connectors.operation.status') {
        reads += 1

        // The first read is stale (an older seq) and says connected; the second is newer and says it failed.
        const target = (answer.targets as { state: string }[])[0]!

        return reads === 1
          ? { ...answer, seq: 0, targets: [{ ...target, state: 'connected' }] }
          : { ...answer, seq: 99, targets: [{ ...target, state: 'failed', detail: 'no' }] }
      }

      return answer
    }) as never

    const client = createConnectorsClient(gateway.transport.gateway, { wait: async () => undefined })
    const flow = await client.connect('notion', { profile: 'p', reconnect: false })

    expect(await flow.done).toEqual({ status: 'failed', reason: 'no' })
    expect(reads).toBe(2)
  })

  it('ends as skipped when the operation settles without the target, and as expired at the deadline', async () => {
    const gateway = aConnectorsGateway({ reads: 1000 })
    const request = gateway.transport.gateway.request as unknown as (
      m: string,
      p: unknown
    ) => Promise<Record<string, unknown>>

    gateway.transport.gateway.request = (async (method: string, params: unknown) => {
      const answer = await request(method, params)

      return method === 'connectors.operation.status' ? { ...answer, settled: true } : answer
    }) as never

    const skipped = await (
      await createConnectorsClient(gateway.transport.gateway, { wait: async () => undefined }).connect('notion', {
        profile: 'p',
        reconnect: false
      })
    ).done

    expect(skipped).toEqual({ status: 'skipped' })

    let clock = 0
    const slow = aConnectorsGateway({ reads: 1_000_000 })
    const client = createConnectorsClient(slow.transport.gateway, {
      now: () => clock,
      wait: async ms => {
        clock += ms * 100
      }
    })

    expect(await (await client.connect('notion', { profile: 'p', reconnect: false })).done).toEqual({
      status: 'expired'
    })
    expect(clock).toBeGreaterThan(CONNECT_TIMEOUT_MS)
    expect(CONNECT_POLL_INTERVAL_MS).toBe(1000)
  })

  it('wakes the operation with the same scope the status reads use, and ignores a wake that fails', async () => {
    const gateway = aConnectorsGateway({ reads: 1000 })
    const flow = await createConnectorsClient(gateway.transport.gateway, {
      wait: () => new Promise(() => undefined)
    }).connect('notion', {
      profile: 'p',
      reconnect: false
    })

    flow.wake()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(gateway.rpc.at(-1)).toEqual({
      method: 'connectors.operation.wake',
      params: { profile: 'p', owner: { type: 'account' }, op_id: 'op-1' }
    })

    gateway.transport.gateway.request = (async () => {
      throw new Error('UNKNOWN_OPERATION')
    }) as never
    expect(() => flow.wake()).not.toThrow()
  })
})
