/**
 * The MCP routes as the page calls them: the shape it reads (and what it drops), the cookie session on
 * every call, the empty body of a revoke, and how each refusal is told apart.
 */
import { describe, expect, it, vi } from 'vitest'

import { json } from '../../test-support/fake-fetch'
import { createMcpClient, grantOf, McpRouteError, statusOf } from './client'

const BASE = 'https://gw.example.test'

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: 'mcg_1',
  client_name: 'Claude Code',
  client_id: 'client-1',
  scopes: ['mcp'],
  created_at: 1_790_000_000,
  created_ip: '192.0.2.10',
  created_user_agent: 'Test Browser',
  last_used_at: null,
  last_used_ip: null,
  expires_at: 1_797_776_000,
  ...overrides
})

const body = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  enabled: true,
  endpoint_url: `${BASE}/mcp`,
  issuer: `${BASE}/mcp`,
  label: 'hermie-gw',
  claude_command: `claude mcp add --transport http hermie-gw ${BASE}/mcp`,
  config_json: '{\n  "mcpServers": {}\n}',
  instructions: 'Add it.',
  grants: [grant()],
  ...overrides
})

describe('statusOf', () => {
  it('reads the contract’s answer', () => {
    expect(statusOf(body())).toEqual({
      endpointUrl: `${BASE}/mcp`,
      issuer: `${BASE}/mcp`,
      label: 'hermie-gw',
      command: `claude mcp add --transport http hermie-gw ${BASE}/mcp`,
      configJson: '{\n  "mcpServers": {}\n}',
      instructions: 'Add it.',
      grants: [
        {
          id: 'mcg_1',
          clientName: 'Claude Code',
          clientId: 'client-1',
          scopes: ['mcp'],
          createdAt: 1_790_000_000,
          createdIp: '192.0.2.10',
          createdUserAgent: 'Test Browser',
          lastUsedAt: null,
          lastUsedIp: null,
          expiresAt: 1_797_776_000
        }
      ]
    })
  })

  it('ignores keys it does not know and grants that are not grants', () => {
    const read = statusOf(
      body({
        later: { anything: true },
        grants: [
          grant({ later: 1 }),
          grant({ id: 'has a space' }),
          grant({ id: 'x'.repeat(65) }),
          grant({ id: 'mcg_2', client_name: 7 }),
          grant({ id: 'mcg_3', created_at: 'yesterday' }),
          'mcg_4',
          null
        ]
      })
    )

    expect(read?.grants.map(each => each.id)).toEqual(['mcg_1'])
  })

  it('wants an enabled answer with the endpoint, the command and the config', () => {
    expect(statusOf(body({ enabled: false }))).toBeNull()
    expect(statusOf(body({ endpoint_url: undefined }))).toBeNull()
    expect(statusOf(body({ claude_command: 3 }))).toBeNull()
    expect(statusOf(body({ config_json: null }))).toBeNull()
    expect(statusOf([])).toBeNull()
    expect(statusOf(null)).toBeNull()
  })

  it('keeps no grants when the list is not a list', () => {
    expect(statusOf(body({ grants: 'none' }))?.grants).toEqual([])
  })
})

describe('grantOf', () => {
  it('treats a nullable field that is not the right type as null, and scopes that are not strings as absent', () => {
    expect(grantOf(grant({ created_ip: 7, last_used_at: 'x', scopes: ['a', 1, null] }))).toMatchObject({
      createdIp: null,
      lastUsedAt: null,
      scopes: ['a']
    })
  })
})

describe('the status call', () => {
  it('asks with the cookie session, never following a redirect, and reads the answer', async () => {
    const fetchImpl = vi.fn(async () => json(200, body()))
    const status = await createMcpClient(BASE, fetchImpl).status()

    expect(status.grants).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/api/auth/mcp`,
      expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual' })
    )
  })

  it.each([
    [404, { detail: 'No such API endpoint: /api/auth/mcp' }, 'not_offered'],
    [405, { detail: 'Method Not Allowed' }, 'not_offered'],
    [403, { error: 'no_identity', detail: 'No person.' }, 'no_identity'],
    [401, { detail: 'Not authenticated' }, 'no_identity'],
    [403, { error: 'origin_not_listed' }, 'refused'],
    [500, { detail: 'Boom' }, 'refused']
  ] as const)('%s %j is %s', async (status, answer, kind) => {
    const error = await createMcpClient(BASE, async () => json(status, answer))
      .status()
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(McpRouteError)
    expect(error).toMatchObject({ kind, status })
  })

  it('says bad_answer for a 200 that is not the shape, and transport when nothing answered', async () => {
    await expect(createMcpClient(BASE, async () => json(200, { enabled: true })).status()).rejects.toMatchObject({
      kind: 'bad_answer'
    })
    await expect(
      createMcpClient(BASE, async () => new Response('not json', { status: 200 })).status()
    ).rejects.toMatchObject({ kind: 'bad_answer' })
    await expect(
      createMcpClient(BASE, async () => {
        throw new TypeError('network down')
      }).status()
    ).rejects.toMatchObject({ kind: 'transport', message: 'network down' })
  })
})

describe('the revoke call', () => {
  it('posts an empty object to the grant’s own route with the cookie session', async () => {
    const fetchImpl = vi.fn(async () => json(200, { ok: true }))

    await expect(createMcpClient(BASE, fetchImpl).revoke('mcg_1')).resolves.toBe('revoked')
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/api/auth/mcp/grants/mcg_1/revoke`,
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }
      })
    )
  })

  it('takes "no such grant" as done, and every other 404 as "this gateway has no MCP"', async () => {
    await expect(
      createMcpClient(BASE, async () => json(404, { error: 'not_found', detail: 'No such grant.' })).revoke('mcg_1')
    ).resolves.toBe('gone')
    await expect(
      createMcpClient(BASE, async () => json(404, { detail: 'No such API endpoint' })).revoke('mcg_1')
    ).rejects.toMatchObject({ kind: 'not_offered' })
  })

  it('carries the refusal’s own word, and never asks for an id that is not shaped like one', async () => {
    await expect(
      createMcpClient(BASE, async () => json(403, { error: 'origin_not_listed' })).revoke('mcg_1')
    ).rejects.toMatchObject({ kind: 'refused', status: 403, error: 'origin_not_listed' })

    const fetchImpl = vi.fn(async () => json(200, { ok: true }))

    await expect(createMcpClient(BASE, fetchImpl).revoke('../x')).resolves.toBe('gone')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
