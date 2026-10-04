/**
 * The MCP servers readers and calls: the config is joined to the cached state by name (a server with no row is
 * "unknown", never "failed"), a probe's `ok` is what says whether it worked, "needs authorising" is wanted and
 * not satisfied, the flow polls until it settles and is always ended at the gateway when it does not finish, an
 * address is only handed on when it is a web address, and the reload may refuse by answering.
 */
import { describe, expect, it } from 'vitest'

import { anMcpServersGateway, CALENDAR, FILES } from '../../test-support/mcp-servers-gateway'
import {
  createMcpServersClient,
  mergeServers,
  OauthCancelled,
  OAUTH_POLL_INTERVAL_MS,
  OAUTH_TIMEOUT_MS,
  openableUrl
} from './mcp-servers'

describe('mergeServers', () => {
  it('joins by name, and a server with no runtime row is unknown rather than failed', () => {
    const merged = mergeServers(
      [
        { name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: ['KEY'], enabled: true },
        {
          name: 'b',
          transport: 'http',
          url: 'https://b.test/mcp',
          args: [],
          env: [],
          auth: 'oauth',
          oauth_tokens_present: true,
          enabled: false
        }
      ],
      [{ name: 'a', transport: 'stdio', tools: 3, connected: true, disabled: false, status: 'connected' }]
    )

    expect(merged).toEqual([
      {
        name: 'a',
        transport: 'stdio',
        address: 'npx -y x',
        env: ['KEY'],
        auth: null,
        tokenPresent: null,
        enabled: true,
        runtime: 'connected',
        toolCount: 3
      },
      {
        name: 'b',
        transport: 'http',
        address: 'https://b.test/mcp',
        env: [],
        auth: 'oauth',
        tokenPresent: true,
        enabled: false,
        runtime: 'unknown',
        toolCount: null
      }
    ])
  })

  it('takes a status word it does not know as unknown, and drops a row with no name', () => {
    expect(
      mergeServers(
        [
          { name: 'a', transport: 'stdio', args: [], env: [], enabled: true },
          { name: '', transport: 'stdio', args: [], env: [], enabled: true }
        ],
        [{ name: 'a', transport: 'stdio', tools: 0, connected: false, disabled: false, status: 'exploding' as never }]
      ).map(server => [server.name, server.runtime])
    ).toEqual([['a', 'unknown']])
  })
})

describe('openableUrl', () => {
  it('lets a web address through and nothing else', () => {
    expect(openableUrl('https://auth.example.test/authorize?x=1')).toBe('https://auth.example.test/authorize?x=1')
    expect(openableUrl('http://localhost:8080/cb')).toBe('http://localhost:8080/cb')

    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'not a url',
      '',
      null,
      4
    ]) {
      expect(openableUrl(bad), String(bad)).toBeNull()
    }
  })
})

describe('the client', () => {
  it('reads the probe from `ok`, and says "needs authorising" only for a token that is wanted and absent', async () => {
    const gateway = anMcpServersGateway({
      servers: [FILES, CALENDAR, { ...CALENDAR, name: 'authorised', tokens: true }]
    })
    const client = createMcpServersClient(gateway.transport.gateway)

    expect(await client.test('files', 'researcher')).toMatchObject({ ok: true, needsAuth: false, error: null })
    expect(await client.test('calendar', 'researcher')).toMatchObject({ ok: false, needsAuth: true })
    expect(await client.test('authorised', 'researcher')).toMatchObject({ ok: true, needsAuth: false })
  })

  it('polls until the flow is approved, waiting between asks, and never sends a client redirect', async () => {
    const gateway = anMcpServersGateway({ pending: 2 })
    const waits: number[] = []
    const client = createMcpServersClient(gateway.transport.gateway, { wait: async ms => void waits.push(ms) })
    const flow = await client.authorise('calendar', 'researcher')

    expect(flow.authUrl).toContain('https://calendar.example.test/authorize')
    expect(await flow.done).toMatchObject({ ok: true, tools: [{ name: 'list_events' }] })
    expect(waits).toEqual([OAUTH_POLL_INTERVAL_MS, OAUTH_POLL_INTERVAL_MS])
    expect(gateway.rpc.find(call => call.method === 'mcp.servers.oauth.start')?.params).toEqual({
      name: 'calendar',
      profile: 'researcher'
    })
    expect(gateway.rpc.some(call => call.method === 'mcp.servers.oauth.cancel')).toBe(false)
  })

  it('ends the flow at the gateway when it is refused or times out, and not when it is approved', async () => {
    const refused = anMcpServersGateway({ pending: 0, oauthEnds: 'error' })

    await expect(
      (await createMcpServersClient(refused.transport.gateway).authorise('calendar', 'p')).done
    ).rejects.toThrow('the sign-in was denied')
    expect(refused.rpc.some(call => call.method === 'mcp.servers.oauth.cancel')).toBe(true)

    let clock = 0
    const slow = anMcpServersGateway({ pending: 1_000_000 })
    const client = createMcpServersClient(slow.transport.gateway, {
      now: () => clock,
      wait: async ms => {
        clock += ms * 100
      }
    })

    await expect((await client.authorise('calendar', 'p')).done).rejects.toThrow('Timed out')
    expect(slow.rpc.some(call => call.method === 'mcp.servers.oauth.cancel')).toBe(true)
    expect(clock).toBeGreaterThan(OAUTH_TIMEOUT_MS)
  })

  it('stops polling when cancelled, and tells the gateway once', async () => {
    const gateway = anMcpServersGateway({ pending: 1_000_000 })
    let release: () => void = () => undefined
    const client = createMcpServersClient(gateway.transport.gateway, {
      wait: () => new Promise<void>(resolve => (release = resolve))
    })
    const flow = await client.authorise('calendar', 'p')

    await new Promise(resolve => setTimeout(resolve, 0))
    flow.cancel()
    release()

    await expect(flow.done).rejects.toBeInstanceOf(OauthCancelled)
    expect(gateway.rpc.filter(call => call.method === 'mcp.servers.oauth.cancel')).toHaveLength(1)
  })

  it('refuses a flow whose address is not a web address, before anything is polled', async () => {
    const gateway = anMcpServersGateway()
    const request = gateway.transport.gateway.request

    gateway.transport.gateway.request = (async (method: string, params: Record<string, unknown>) =>
      method === 'mcp.servers.oauth.start'
        ? { ok: true, session_id: 's', auth_url: 'javascript:alert(1)', flow: 'pkce' }
        : (request as (m: string, p: unknown) => unknown)(method, params)) as never

    await expect(createMcpServersClient(gateway.transport.gateway).authorise('calendar', 'p')).rejects.toThrow(
      'did not say where to send you'
    )
    expect(gateway.rpc.some(call => call.method === 'mcp.servers.oauth.poll')).toBe(false)
  })

  it('sends a preset by name, a url without a command, and a command with its arguments', async () => {
    const gateway = anMcpServersGateway()
    const client = createMcpServersClient(gateway.transport.gateway)

    await client.add('p', { kind: 'preset', name: 'time', preset: 'time' })
    await client.add('p', { kind: 'custom', name: 'hosted', url: 'https://x.test/mcp', bearerToken: 't' })
    await client.add('p', { kind: 'custom', name: 'local', command: 'npx', args: ['-y', 'x'] })

    expect(gateway.rpc.filter(call => call.method === 'mcp.servers.add').map(call => call.params)).toEqual([
      { profile: 'p', name: 'time', preset: 'time' },
      { profile: 'p', name: 'hosted', config: { url: 'https://x.test/mcp' }, bearer_token: 't' },
      { profile: 'p', name: 'local', config: { command: 'npx', args: ['-y', 'x'] } }
    ])
  })

  it('reads a reload that wants an answer as a question, and sends the confirmation when it is given', async () => {
    const gateway = anMcpServersGateway()
    const client = createMcpServersClient(gateway.transport.gateway)

    expect(await client.reload()).toEqual({ kind: 'confirm', message: 'Reloading invalidates the prompt cache.' })
    expect(await client.reload({ confirm: true })).toEqual({ kind: 'reloaded' })
  })
})
