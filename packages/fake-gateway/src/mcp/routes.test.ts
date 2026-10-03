/**
 * The MCP page's two routes and its control surface, as `contract/gateway/mcp.md` defines them:
 * `GET /api/auth/mcp`, `POST /api/auth/mcp/grants/{id}/revoke`, `mcp.changed`, `/__fake/mcp/grants`,
 * the capability, and the `--mcp` flag. A gateway without `--mcp` keeps answering as it always did.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ALICE,
  BOB,
  bearerFor,
  closeAll,
  connect,
  cookieFor,
  post,
  startPasskeyGateway,
  type Harness,
  type Json
} from '../passkey/harness'
import { startFakeGateway, type FakeGatewayOptions } from '../server'
import { BODY_CAP, INSTRUCTIONS } from './routes'

afterEach(closeAll)

const PAGE = '/api/auth/mcp'
const GRANT_KEYS = [
  'client_id',
  'client_name',
  'created_at',
  'created_ip',
  'created_user_agent',
  'expires_at',
  'id',
  'last_used_at',
  'last_used_ip',
  'scopes'
]

/** A gateway with two accounts that serves the MCP page. */
const start = (options: FakeGatewayOptions = {}): Promise<Harness> =>
  startPasskeyGateway({ passkey: false, mcp: true, ...options })

const seed = async (h: Harness, body: Json = {}): Promise<Json> => {
  const response = await post(`${h.url}/__fake/mcp/grants`, body)

  expect(response.status).toBe(200)

  return ((await response.json()) as Json).grant
}

const as = async (h: Harness, who = ALICE): Promise<Record<string, string>> => ({
  cookie: await cookieFor(h, who),
  origin: h.url
})

const page = async (h: Harness, headers: Record<string, string>): Promise<{ status: number; body: Json }> => {
  const response = await fetch(`${h.url}${PAGE}`, { headers })

  return { status: response.status, body: (await response.json()) as Json }
}

const revoke = async (
  h: Harness,
  id: string,
  headers: Record<string, string>,
  body: unknown = {}
): Promise<{ status: number; body: Json; headers: Headers }> => {
  const response = await post(`${h.url}${PAGE}/grants/${id}/revoke`, body, headers)

  return { status: response.status, body: (await response.json()) as Json, headers: response.headers }
}

describe('a gateway without --mcp', () => {
  it('does not serve the page: unknown, as on any gateway without the fork’s endpoint', async () => {
    const h = await startPasskeyGateway({ passkey: false })
    const alice = await as(h)

    expect(h.gateway.mcp()).toBeNull()
    expect((await page(h, alice)).status).toBe(404)
    expect((await revoke(h, 'mcg_anything', alice)).status).toBeGreaterThanOrEqual(404)
  })

  it('does not advertise per_message_author_via, and has no control endpoint (409)', async () => {
    const h = await startPasskeyGateway({ passkey: false })
    const alice = await connect(h, { cookie: await cookieFor(h, ALICE) })

    expect(((await alice.call('gateway.capabilities')).result ?? {}).per_message_author_via).toBeUndefined()
    expect((await fetch(`${h.url}/__fake/mcp/grants`)).status).toBe(409)
    expect((await post(`${h.url}/__fake/mcp/grants`, {})).status).toBe(409)
  })

  it('can be told to serve it later: enableMcp, and the page is there', async () => {
    const h = await startPasskeyGateway({ passkey: false })
    const alice = await as(h)

    h.gateway.enableMcp()

    expect((await page(h, alice)).status).toBe(200)
  })
})

describe('GET /api/auth/mcp', () => {
  it('answers the whole page, with every field the contract lists', async () => {
    const h = await start()
    const alice = await as(h)
    const { status, body } = await page(h, alice)
    const endpoint = `${h.url}/mcp`

    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual([
      'claude_command',
      'config_json',
      'enabled',
      'endpoint_url',
      'grants',
      'instructions',
      'issuer',
      'label',
      'v'
    ])
    expect(body).toMatchObject({
      v: 1,
      enabled: true,
      endpoint_url: endpoint,
      issuer: endpoint,
      label: 'hermie-fake',
      claude_command: `claude mcp add --transport http hermie-fake ${endpoint}`,
      instructions: INSTRUCTIONS,
      grants: []
    })
    // The JSON config is text, to be copied as it is, and it is the `.mcp.json` fragment.
    expect(typeof body.config_json).toBe('string')
    expect(JSON.parse(body.config_json)).toEqual({ mcpServers: { 'hermie-fake': { type: 'http', url: endpoint } } })
  })

  it('takes its endpoint and label from the settings', async () => {
    const h = await start({ mcp: { endpointUrl: 'https://gw.example.invalid/mcp', label: 'hermie-gw' } })
    const { body } = await page(h, await as(h))

    expect(body.endpoint_url).toBe('https://gw.example.invalid/mcp')
    expect(body.claude_command).toBe('claude mcp add --transport http hermie-gw https://gw.example.invalid/mcp')
    expect(Object.keys(JSON.parse(body.config_json).mcpServers)).toEqual(['hermie-gw'])
  })

  it('lists a grant with every field, type and nullability of the contract', async () => {
    const h = await start()

    await seed(h, {
      id: 'mcg_full',
      client_id: 'mcc_full',
      client_name: 'Claude Code',
      scopes: ['mcp', 'bots'],
      created_at: 1_790_000_000,
      created_ip: '203.0.113.7',
      created_user_agent: 'claude-code/2.1',
      last_used_at: 1_790_000_500,
      last_used_ip: '203.0.113.8',
      expires_at: 1_797_776_000
    })

    const { body } = await page(h, await as(h))

    expect(body.grants).toEqual([
      {
        id: 'mcg_full',
        client_name: 'Claude Code',
        client_id: 'mcc_full',
        scopes: ['mcp', 'bots'],
        created_at: 1_790_000_000,
        created_ip: '203.0.113.7',
        created_user_agent: 'claude-code/2.1',
        last_used_at: 1_790_000_500,
        last_used_ip: '203.0.113.8',
        expires_at: 1_797_776_000
      }
    ])
  })

  it('says null for what the gateway never recorded, and the key is still there', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_bare', created_ip: null, created_user_agent: null })

    const [grant] = (await page(h, await as(h))).body.grants

    expect(Object.keys(grant).sort()).toEqual(GRANT_KEYS)
    expect(grant).toMatchObject({
      created_ip: null,
      created_user_agent: null,
      last_used_at: null,
      last_used_ip: null,
      scopes: ['mcp']
    })
    expect(Number.isInteger(grant.created_at)).toBe(true)
    expect(grant.expires_at).toBeGreaterThan(grant.created_at)
  })

  it('names the caller’s own grants only, newest first, and never one that is revoked or expired', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_old', created_at: 1_790_000_000 })
    await seed(h, { id: 'mcg_new', created_at: 1_790_000_900 })
    await seed(h, { id: 'mcg_bobs', user: BOB.username })
    await seed(h, { id: 'mcg_expired', created_at: 1_000_000_000, expires_at: 1_000_000_100 })
    await seed(h, { id: 'mcg_gone' })

    const alice = await as(h)

    expect((await revoke(h, 'mcg_gone', alice)).status).toBe(200)
    expect((await page(h, alice)).body.grants.map((grant: Json) => grant.id)).toEqual(['mcg_new', 'mcg_old'])
    expect((await page(h, await as(h, BOB))).body.grants.map((grant: Json) => grant.id)).toEqual(['mcg_bobs'])
  })

  it('never carries anything about the person, a token or a secret', async () => {
    const h = await start()

    await seed(h)

    expect(JSON.stringify((await page(h, await as(h))).body.grants)).not.toMatch(
      /user_id|token|secret|revoked|self-hosted/u
    )
  })

  it('is not cached', async () => {
    const h = await start()
    const response = await fetch(`${h.url}${PAGE}`, { headers: await as(h) })

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('answers a bearer (the native app) the same as a cookie', async () => {
    const h = await start({ auth: 'native' })

    await seed(h, { id: 'mcg_native' })

    const { status, body } = await page(h, { authorization: await bearerFor(h) })

    expect(status).toBe(200)
    expect(body.grants.map((grant: Json) => grant.id)).toEqual(['mcg_native'])
  })

  it('is 401 without a session, and 403 no_identity where nobody is signed in', async () => {
    const h = await start()

    expect((await fetch(`${h.url}${PAGE}`)).status).toBe(401)

    const open = await startFakeGateway({ port: 0, auth: 'none', mcp: true })

    try {
      const response = await fetch(`${open.url}${PAGE}`)

      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'no_identity' })
    } finally {
      await open.close()
    }
  })

  it('is 404 while the feature is switched off, and 405 for its write', async () => {
    const h = await start({ mcp: { enabled: false } })
    const alice = await as(h)
    const off = await fetch(`${h.url}${PAGE}`, { headers: alice })
    const write = await post(`${h.url}${PAGE}/grants/mcg_x/revoke`, {}, alice)

    expect(off.status).toBe(404)
    expect(write.status).toBe(405)

    h.gateway.enableMcp({ enabled: true })

    expect((await page(h, alice)).status).toBe(200)
  })

  it('refuses other methods with 405 and Allow', async () => {
    const h = await start()
    const alice = await as(h)
    const wrong = await post(`${h.url}${PAGE}`, {}, alice)
    const read = await fetch(`${h.url}${PAGE}/grants/mcg_x/revoke`, { headers: alice })

    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('GET')
    expect(read.status).toBe(405)
    expect(read.headers.get('allow')).toBe('POST')
  })
})

describe('POST /api/auth/mcp/grants/{id}/revoke', () => {
  it('revokes one of the caller’s own grants: {ok: true}, and it leaves the list', async () => {
    const h = await start()
    const grant = await seed(h, { id: 'mcg_mine' })
    const alice = await as(h)
    const done = await revoke(h, grant.id, alice)

    expect(done.status).toBe(200)
    expect(done.body).toEqual({ ok: true })
    expect(done.headers.get('cache-control')).toBe('no-store')
    expect((await page(h, alice)).body.grants).toEqual([])

    // The operator's view keeps it, and says who revoked.
    const listed = (await (await fetch(`${h.url}/__fake/mcp/grants`)).json()) as Json

    expect(listed.grants).toEqual([
      expect.objectContaining({
        id: 'mcg_mine',
        user_id: ALICE.key,
        revoked_by: 'user',
        revoked_at: expect.any(Number)
      })
    ])
  })

  it('answers 404 not_found, one body, for somebody else’s grant, an unknown id, a revoked one and a bad one', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_bobs', user: BOB.username })
    await seed(h, { id: 'mcg_once' })

    const alice = await as(h)

    expect((await revoke(h, 'mcg_once', alice)).status).toBe(200)

    const answers = await Promise.all(
      ['mcg_bobs', 'mcg_nobody', 'mcg_once', '..%2Fsomething', 'x'.repeat(65)].map(id => revoke(h, id, alice))
    )

    for (const answer of answers) {
      expect(answer.status).toBe(404)
      expect(answer.body).toEqual(answers[0]?.body)
    }

    expect(answers[0]?.body).toMatchObject({ error: 'not_found' })
    // Bob's grant is still his.
    expect((await page(h, await as(h, BOB))).body.grants.map((grant: Json) => grant.id)).toEqual(['mcg_bobs'])
  })

  it('does not revoke an expired grant either: it is not the caller’s to see', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_old', created_at: 1_000_000_000, expires_at: 1_000_000_100 })

    expect((await revoke(h, 'mcg_old', await as(h))).status).toBe(404)
  })

  it('wants an Origin the gateway trusts on a cookie write', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_one' })

    const cookie = await cookieFor(h, ALICE)
    const none = await revoke(h, 'mcg_one', { cookie })
    const foreign = await revoke(h, 'mcg_one', { cookie, origin: 'https://evil.example.invalid' })

    expect(none.status).toBe(403)
    expect(none.body).toMatchObject({ error: 'origin_not_listed' })
    expect(foreign.status).toBe(403)
    expect((await page(h, { cookie })).body.grants).toHaveLength(1)
    expect((await revoke(h, 'mcg_one', { cookie, origin: h.url })).status).toBe(200)
  })

  it('wants no Origin from a bearer: a browser never attaches one by itself', async () => {
    const h = await start({ auth: 'native' })

    await seed(h, { id: 'mcg_two' })

    expect((await revoke(h, 'mcg_two', { authorization: await bearerFor(h) })).status).toBe(200)
  })

  it('wants a JSON object of at most 16 KiB', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_one' })

    const alice = await as(h)

    expect((await revoke(h, 'mcg_one', alice, [])).status).toBe(400)
    expect((await revoke(h, 'mcg_one', alice, null)).status).toBe(400)
    expect((await revoke(h, 'mcg_one', alice, { pad: 'x'.repeat(BODY_CAP) })).status).toBe(413)

    const notJson = await fetch(`${h.url}${PAGE}/grants/mcg_one/revoke`, {
      method: 'POST',
      headers: { ...alice, 'content-type': 'application/json' },
      body: '{nope'
    })

    expect(notJson.status).toBe(400)
    // None of those revoked it.
    expect((await page(h, alice)).body.grants).toHaveLength(1)
  })

  it('ignores a body that names a user: the identity is the gate’s', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_bobs', user: BOB.username })

    expect((await revoke(h, 'mcg_bobs', await as(h), { user: BOB.key, user_id: BOB.userId })).status).toBe(404)
  })

  it('is 403 no_identity where nobody is signed in', async () => {
    const open = await startFakeGateway({ port: 0, auth: 'none', mcp: true })

    try {
      const response = await post(`${open.url}${PAGE}/grants/mcg_x/revoke`, {})

      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'no_identity' })
    } finally {
      await open.close()
    }
  })
})

describe('mcp.changed', () => {
  it('goes to the person’s own connections when a grant is revoked, and to nobody else', async () => {
    const h = await start()
    const alice = await connect(h, { cookie: await cookieFor(h, ALICE) })
    const otherTab = await connect(h, { cookie: await cookieFor(h, ALICE) })
    const bob = await connect(h, { cookie: await cookieFor(h, BOB) })
    const grant = await seed(h, { id: 'mcg_ping', client_name: 'Claude Code', announce: false })

    expect((await revoke(h, grant.id, await as(h))).status).toBe(200)

    const event = await alice.next(frame => frame.params?.type === 'mcp.changed', 'mcp.changed')

    expect(event.method).toBe('event')
    expect(event.params).toEqual({
      type: 'mcp.changed',
      session_id: '',
      payload: { change: 'revoked', grant: { id: 'mcg_ping', client_name: 'Claude Code' }, at: expect.any(Number) }
    })
    await otherTab.next(frame => frame.params?.type === 'mcp.changed', 'mcp.changed on the other tab')
    expect(bob.events('mcp.changed')).toEqual([])
  })

  it('reaches the native app’s connection when a bearer revokes', async () => {
    const h = await start({ auth: 'native' })
    const phone = await connect(h, { authorization: await bearerFor(h) })

    await seed(h, { id: 'mcg_ping', announce: false })
    expect((await revoke(h, 'mcg_ping', { authorization: await bearerFor(h) })).status).toBe(200)
    await phone.next(frame => frame.params?.type === 'mcp.changed', 'mcp.changed on the app')
  })

  it('does not go out for a revoke that found nothing', async () => {
    const h = await start()
    const alice = await connect(h, { cookie: await cookieFor(h, ALICE) })

    expect((await revoke(h, 'mcg_nobody', await as(h))).status).toBe(404)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(alice.events('mcp.changed')).toEqual([])
  })

  it('says granted when a grant is seeded, unless the seed asks for silence', async () => {
    const h = await start()
    const alice = await connect(h, { cookie: await cookieFor(h, ALICE) })

    const loud = await post(`${h.url}/__fake/mcp/grants`, { id: 'mcg_loud', client_name: 'Cursor' })

    expect(((await loud.json()) as Json).delivered).toBe(1)

    const event = await alice.next(frame => frame.params?.type === 'mcp.changed', 'granted')

    expect(event.params?.payload).toEqual({
      change: 'granted',
      grant: { id: 'mcg_loud', client_name: 'Cursor' },
      at: expect.any(Number)
    })

    const quiet = await post(`${h.url}/__fake/mcp/grants`, { id: 'mcg_quiet', announce: false })

    expect(((await quiet.json()) as Json).delivered).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(alice.events('mcp.changed')).toHaveLength(1)
  })
})

describe('/__fake/mcp/grants', () => {
  it('seeds a grant for the first account by default, with the defaults the page shows', async () => {
    const h = await start()
    const grant = await seed(h)

    expect(grant).toMatchObject({
      client_name: 'Claude Code',
      scopes: ['mcp'],
      user_id: ALICE.key,
      last_used_at: null,
      last_used_ip: null
    })
    expect(grant.id).toMatch(/^mcg_/u)
    expect(grant.client_id).toMatch(/^mcc_/u)
    expect(grant.expires_at - grant.created_at).toBe(90 * 24 * 60 * 60)
  })

  it('names the person by username, user id or key', async () => {
    const h = await start()

    for (const user of [BOB.username, BOB.userId, BOB.key]) {
      expect((await seed(h, { user })).user_id).toBe(BOB.key)
    }
  })

  it('lists every grant with the operator’s fields, revoked ones included', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_a' })
    await seed(h, { id: 'mcg_b', user: BOB.username })
    await revoke(h, 'mcg_a', await as(h))

    const listed = (await (await fetch(`${h.url}/__fake/mcp/grants`)).json()) as Json

    expect(listed.enabled).toBe(true)
    expect(listed.grants.map((grant: Json) => [grant.id, grant.user_id, grant.revoked_by])).toEqual([
      ['mcg_a', ALICE.key, 'user'],
      ['mcg_b', BOB.key, null]
    ])
    expect(Object.keys(listed.grants[0]).sort()).toEqual([...GRANT_KEYS, 'revoked_at', 'revoked_by', 'user_id'].sort())
  })

  it('refuses what it cannot seed: 400 with a reason', async () => {
    const h = await start()

    await seed(h, { id: 'mcg_dup' })

    for (const body of [
      { id: 'mcg_dup' },
      { scopes: 'mcp' },
      { scopes: [1] },
      { client_name: '  ' },
      { user: 7 as unknown as string, client_name: '' }
    ]) {
      const response = await post(`${h.url}/__fake/mcp/grants`, body)

      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(((await response.json()) as Json).detail).toEqual(expect.any(String))
    }
  })
})

describe('the capability', () => {
  it('says per_message_author_via where the gateway serves MCP, and not where it is switched off', async () => {
    const h = await start()
    const alice = await connect(h, { cookie: await cookieFor(h, ALICE) })

    expect((await alice.call('gateway.capabilities')).result).toMatchObject({ per_message_author_via: true })

    h.gateway.enableMcp({ enabled: false })

    expect(((await alice.call('gateway.capabilities')).result ?? {}).per_message_author_via).toBeUndefined()
  })

  it('can be forced either way with perMessageAuthorVia', async () => {
    const h = await startPasskeyGateway({ passkey: false, perMessageAuthorVia: true })
    const alice = await connect(h, { cookie: await cookieFor(h, ALICE) })

    expect((await alice.call('gateway.capabilities')).result).toMatchObject({ per_message_author_via: true })
  })
})

describe('the CLI', () => {
  const entry = fileURLToPath(new URL('../cli.ts', import.meta.url))

  const run = (args: string[]): Promise<{ code: number | null; out: string; stop: () => void }> =>
    new Promise(resolve => {
      const child = spawn(process.execPath, ['--import', 'tsx', entry, '--port', '0', ...args], {
        cwd: fileURLToPath(new URL('../../../..', import.meta.url))
      })
      let out = ''
      const done = (code: number | null) => resolve({ code, out, stop: () => child.kill('SIGTERM') })

      child.stdout.on('data', chunk => {
        out += String(chunk)

        if (out.includes('inject     curl')) {
          done(null)
        }
      })
      child.stderr.on('data', chunk => {
        out += String(chunk)
      })
      child.on('exit', code => done(code))
    })

  it('serves the page with --mcp, under the label --mcp-label gives', async () => {
    const started = await run(['--auth', 'cookie', '--mcp', '--mcp-label', 'hermie-cli'])

    try {
      const url = /listening on (\S+)/u.exec(started.out)?.[1] ?? ''

      expect(started.out).toContain(`mcp        on; ${url}/mcp`)

      const login = await post(`${url}/auth/password-login`, { username: 'tester', password: 'hunter2' })
      const cookie = /hermes_session_at=[^;]+/u.exec(login.headers.get('set-cookie') ?? '')?.[0] ?? ''
      const answer = (await (await fetch(`${url}${PAGE}`, { headers: { cookie } })).json()) as Json

      expect(answer).toMatchObject({ v: 1, enabled: true, label: 'hermie-cli', grants: [] })
    } finally {
      started.stop()
    }
  }, 30_000)

  it('refuses --mcp where nobody can be signed in', async () => {
    const started = await run(['--auth', 'none', '--mcp'])

    expect(started.code).toBe(1)
    expect(started.out).toContain('--mcp needs --auth cookie or native')
  }, 30_000)

  it('does not serve the page without --mcp', async () => {
    const started = await run(['--auth', 'cookie'])

    try {
      const url = /listening on (\S+)/u.exec(started.out)?.[1] ?? ''
      const login = await post(`${url}/auth/password-login`, { username: 'tester', password: 'hunter2' })
      const cookie = /hermes_session_at=[^;]+/u.exec(login.headers.get('set-cookie') ?? '')?.[0] ?? ''

      expect((await fetch(`${url}${PAGE}`, { headers: { cookie } })).status).toBe(404)
    } finally {
      started.stop()
    }
  }, 30_000)
})
