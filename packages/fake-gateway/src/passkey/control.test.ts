/**
 * The control surface of the passkey level (`/__fake/passkey/*`, the extended `/__fake/request` and
 * `/__fake/state`), the TypeScript handle, the CLI flags, and the guarantee that a gateway that does not
 * know the level keeps behaving as it always did.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { b64u, b64uDecode } from './encoding'
import {
  ALICE,
  BOB,
  closeAll,
  connect,
  cookieFor,
  post,
  startPasskeyGateway,
  stateOf,
  until,
  type Json
} from './harness'
import { startFakeGateway } from '../server'
import { SoftAuthenticator } from '../testing/soft-authenticator'

afterEach(closeAll)

const control = async (url: string, action: string, body: unknown = {}): Promise<{ status: number; body: Json }> => {
  const response = await post(`${url}/__fake/passkey/${action}`, body)

  return { status: response.status, body: (await response.json()) as Json }
}

const PREFIX = '/api/auth/passkeys'

describe('POST /__fake/passkey/enable', () => {
  it('makes a gateway that did not know the level know it, and answers with its public view', async () => {
    const h = await startPasskeyGateway({ passkey: false })

    expect(h.gateway.passkey()).toBeNull()
    expect((await stateOf(h)).passkey).toBeUndefined()

    const enabled = await control(h.url, 'enable')

    expect(enabled.status).toBe(200)
    expect(enabled.body).toMatchObject({
      v: 1,
      enabled: true,
      reason: '',
      base_urls: [h.url],
      accepted_base_urls: [h.url],
      allow_private_base_urls: true,
      native_rps: { 'confirm.hermie.dev': ['https://confirm.hermie.dev'] },
      user_invites: true,
      credentials: [],
      receipts: [],
      refusals: [],
      open: [],
      outcomes: [],
      windows: []
    })
    expect(b64uDecode(enabled.body.gateway_id)).toHaveLength(16)
    expect(h.gateway.passkey()).not.toBeNull()
    expect((await fetch(`${h.url}${PREFIX}`, { headers: { cookie: await cookieFor(h, ALICE) } })).status).toBe(200)
  })

  it('changes the operator’s settings of a gateway that knows it, and keeps its identity', async () => {
    const h = await startPasskeyGateway()
    const before = (await stateOf(h)).passkey.gateway_id
    const changed = await control(h.url, 'enable', {
      base_urls: ['HTTPS://GW.Example.invalid:443/alice/'],
      rps: { 'app.example.invalid': ['https://app.example.invalid'] },
      allow_private: false,
      user_invites: false
    })

    expect(changed.body).toMatchObject({
      enabled: true,
      base_urls: ['https://gw.example.invalid/alice'],
      accepted_base_urls: ['https://gw.example.invalid/alice'],
      allow_private_base_urls: false,
      user_invites: false,
      native_rps: { 'app.example.invalid': ['https://app.example.invalid'] },
      rp: { native: ['app.example.invalid'], web: [] }
    })
    expect(changed.body.gateway_id).toBe(before)
  })

  it('stages a gateway that knows the level and has it off, then on again', async () => {
    const h = await startPasskeyGateway({ passkey: { enabled: false } })

    expect((await stateOf(h)).passkey).toMatchObject({ enabled: false, reason: 'disabled', gateway_id: '' })
    expect((await control(h.url, 'enable', { enabled: true })).body).toMatchObject({ enabled: true, reason: '' })
  })

  it.each([
    ['a base URL that is not one', { base_urls: ['ftp://nope'] }, 'base_urls'],
    ['base URLs that are not a list', { base_urls: 'https://x.example' }, 'base_urls'],
    ['an RP with upper case', { rps: { 'App.example': ['https://app.example'] } }, 'rps'],
    ['an origin with a path', { rps: { 'app.example': ['https://app.example/x'] } }, 'rps'],
    ['an origin in the wrong spelling', { rps: { 'app.example': ['https://APP.example'] } }, 'rps'],
    ['an RP with no origin it can use', { rps: { 'app.example': ['nonsense'] } }, 'rps']
  ])('refuses %s with a 400', async (_name, body, field) => {
    const h = await startPasskeyGateway()
    const refused = await control(h.url, 'enable', body)

    expect(refused.status).toBe(400)
    expect(refused.body.detail).toContain(field)
  })
})

describe('the other control calls', () => {
  it('answers 409 until the gateway knows the level, and 404 for an action that does not exist', async () => {
    const h = await startPasskeyGateway({ passkey: false })

    for (const action of ['code', 'revoke', 'expire', 'changed']) {
      expect((await control(h.url, action)).status, action).toBe(409)
    }

    await control(h.url, 'enable')
    expect((await control(h.url, 'nonsense')).status).toBe(404)
  })

  it('mints an operator code, bound to a user by key, user id or username, or to nobody', async () => {
    const h = await startPasskeyGateway()
    const pattern = /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/u
    const loose = await control(h.url, 'code')

    expect(loose.body.code).toMatch(pattern)
    expect(loose.body.user_id).toBeNull()
    expect(loose.body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 890)

    for (const user of [ALICE.key, ALICE.userId, ALICE.username]) {
      expect((await control(h.url, 'code', { user })).body.user_id, user).toBe(ALICE.key)
    }

    expect((await control(h.url, 'code', { ttl: 3600 })).body.expires_at).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 3590
    )
    expect((await control(h.url, 'code', { ttl: 5 })).status).toBe(400)
    expect((await control(h.url, 'code', { ttl: 'soon' })).status).toBe(400)
    expect((await stateOf(h)).passkey.open_codes).toBe(5)
  })

  it('revokes by id prefix or for a whole user, and announces only when asked', async () => {
    const h = await startPasskeyGateway()
    const alice = { cookie: await cookieFor(h, ALICE), origin: h.url }
    const listening = await connect(h, alice)
    const enrol = async (): Promise<SoftAuthenticator> => {
      const auth = SoftAuthenticator.native()
      const opened = (await (
        await post(`${h.url}${PREFIX}/register/begin`, { rp_id: auth.rpId, base_url: h.url, name: 'Phone' }, alice)
      ).json()) as Json
      const code = (await control(h.url, 'code', { user: ALICE.key })).body.code

      await post(
        `${h.url}${PREFIX}/register/finish`,
        auth.register(
          {
            registrationId: opened.registration_id,
            baseUrl: h.url,
            gatewayId: b64uDecode(opened.gateway_id),
            userId: opened.user.id,
            name: opened.user.name,
            nonce: b64uDecode(opened.nonce)
          },
          code
        ),
        alice
      )

      return auth
    }
    const first = await enrol()
    const second = await enrol()
    const third = await enrol()

    expect((await control(h.url, 'revoke', {})).status).toBe(400)
    expect((await control(h.url, 'revoke', { credential_id: 'zzzz-nothing' })).body).toEqual({ revoked: [] })

    // By prefix: quiet, as the operator's CLI is another process.
    expect((await control(h.url, 'revoke', { credential_id: first.id.slice(0, 10) })).body.revoked).toEqual([
      { id: first.id, user_id: ALICE.key }
    ])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(listening.events('passkey.changed').filter(f => f.params?.payload?.change === 'revoked')).toEqual([])

    // For a user, with the announcement.
    const gone = await control(h.url, 'revoke', { user: ALICE.username, all: true, announce: true })

    expect(new Set(gone.body.revoked.map((r: Json) => r.id))).toEqual(new Set([second.id, third.id]))
    await until(
      'the announcements',
      () => listening.events('passkey.changed').filter(f => f.params?.payload?.change === 'revoked').length === 2
    )

    const state = (await stateOf(h)).passkey

    expect(state.credentials.every((c: Json) => c.active === false && c.revoked_by === 'operator')).toBe(true)
    expect((await (await fetch(`${h.url}${PREFIX}`, { headers: alice })).json()).credentials).toEqual([])
  })

  it('times things out: a request, the registrations, the codes, the window', async () => {
    const h = await startPasskeyGateway()
    const alice = { cookie: await cookieFor(h, ALICE), origin: h.url }
    const opened = (await (
      await post(
        `${h.url}${PREFIX}/register/begin`,
        { rp_id: 'confirm.hermie.dev', base_url: h.url, name: 'Phone' },
        alice
      )
    ).json()) as Json

    await control(h.url, 'code')
    await control(h.url, 'code')

    expect((await control(h.url, 'expire', { pending: true, codes: true })).body).toEqual({ pending: 1, codes: 2 })
    expect((await control(h.url, 'expire', { pending: true })).body).toEqual({ pending: 0 })
    expect((await stateOf(h)).passkey.open_codes).toBe(0)

    const refused = await post(
      `${h.url}${PREFIX}/register/finish`,
      { registration_id: opened.registration_id, code: 'x' },
      alice
    )

    expect(refused.status).toBe(410)
    expect((await control(h.url, 'expire', {})).body).toEqual({ requests: 0 })
    expect((await control(h.url, 'expire', { request_id: 'srq-nope' })).body).toEqual({ requests: 0 })
    expect((await control(h.url, 'expire', { window: true })).body).toEqual({ window: true })
  })

  it('emits `passkey.changed` to one user’s connections, with or without a change behind it', async () => {
    const h = await startPasskeyGateway()
    const alice = await connect(h, { cookie: await cookieFor(h, ALICE) })
    const bob = await connect(h, { cookie: await cookieFor(h, BOB) })
    const emitted = await control(h.url, 'changed', {
      user: ALICE.username,
      change: 'revoked',
      credential: { id: 'abc', name: 'Old phone', rp_id: 'confirm.hermie.dev' }
    })

    expect(emitted.body).toEqual({ delivered: 1, user_id: ALICE.key })

    const event = await alice.next(frame => frame.params?.type === 'passkey.changed', 'the event')

    expect(event.params).toEqual({
      type: 'passkey.changed',
      session_id: '',
      payload: {
        change: 'revoked',
        credential: { id: 'abc', name: 'Old phone', rp_id: 'confirm.hermie.dev' },
        at: expect.any(Number)
      }
    })
    expect(bob.events('passkey.changed')).toEqual([])
    // Defaults: the gateway's first account, an addition, a made-up credential.
    expect((await control(h.url, 'changed')).body).toEqual({ delivered: 1, user_id: ALICE.key })
    expect((await control(h.url, 'changed', { user: 'self-hosted:nobody@example.invalid' })).body.delivered).toBe(0)
  })
})

describe('GET /__fake/state', () => {
  it('lists credentials, receipts, refusals and outcomes, and never a key, a code or the text', async () => {
    const h = await startPasskeyGateway()
    const alice = { cookie: await cookieFor(h, ALICE), origin: h.url }
    const phone = SoftAuthenticator.native()
    const opened = (await (
      await post(`${h.url}${PREFIX}/register/begin`, { rp_id: phone.rpId, base_url: h.url, name: 'Phone' }, alice)
    ).json()) as Json
    const code = (await control(h.url, 'code', { user: ALICE.key })).body.code

    await post(
      `${h.url}${PREFIX}/register/finish`,
      phone.register(
        {
          registrationId: opened.registration_id,
          baseUrl: h.url,
          gatewayId: b64uDecode(opened.gateway_id),
          userId: opened.user.id,
          name: opened.user.name,
          nonce: b64uDecode(opened.nonce)
        },
        code
      ),
      alice
    )
    await post(`${h.url}${PREFIX}/register/finish`, { registration_id: 'nope', code }, alice)

    const text = JSON.stringify((await stateOf(h)).passkey)
    const state = JSON.parse(text) as Json

    expect(state.credentials).toEqual([
      expect.objectContaining({
        id: phone.id,
        user_id: ALICE.key,
        rp_id: 'confirm.hermie.dev',
        active: true,
        created_via: 'operator'
      })
    ])
    expect(state.refusals).toEqual([
      expect.objectContaining({ surface: 'register', reason: 'expired', user_id: ALICE.key, request_id: 'nope' })
    ])
    expect(text).not.toContain(code)
    expect(text).not.toContain(b64u(h.gateway.passkey()!.store.handleKey))
    expect(text).not.toContain(phone.privateKey.export({ format: 'jwk' }).d as string)
  })
})

describe('the TypeScript handle', () => {
  it('raises a confirm and resolves with what the agent would learn', async () => {
    const h = await startPasskeyGateway()
    const alice = { cookie: await cookieFor(h, ALICE), origin: h.url }
    const app = await connect(h, alice)

    await app.call('client.capabilities', { server_requests: true })
    await app.call('client.capabilities', { server_requests: true, confirm: ['plain'] })

    const raised = h.gateway.raiseConfirm({ summary: 'Do the thing', level: 'plain' })

    if (raised.kind !== 'open') {
      throw new Error(raised.reason)
    }

    const frame = await app.next(f => f.method === 'confirm', 'the frame')

    await app.call('request.answer', { id: String(frame.id), result: { decision: 'declined', method: 'tap' } })
    expect(await raised.done).toEqual({ outcome: 'declined', method: 'tap', verified: false, reason: '' })

    const refused = h.gateway.raiseConfirm({ summary: 'Do the thing', level: 'passkey' })

    expect(refused).toEqual({ kind: 'unavailable', reason: 'not_enrolled' })
    expect(
      await h.gateway.requestServerSide('confirm', { session_id: 'nobody', summary: 'x' }).catch(e => String(e))
    ).toContain('Unknown session')
  })

  it('says so when the gateway does not know the level', async () => {
    const h = await startPasskeyGateway({ passkey: false })

    expect(() => h.gateway.raiseConfirm({ summary: 'x' })).toThrow(/does not know the passkey level/u)
  })
})

describe('a gateway that does not know the level', () => {
  it('keeps the permissive confirm it always had: any level, any answer, and no passkey in the state', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const state = (await (await fetch(`${gateway.url}/__fake/state`)).json()) as Json

      expect(state).not.toHaveProperty('passkey')
      expect(gateway.passkey()).toBeNull()
      expect((await post(`${gateway.url}/__fake/passkey/code`, {})).status).toBe(409)
    } finally {
      await gateway.close()
    }
  })

  it('does not know it unless asked: `--auth none` with the option still names nobody', async () => {
    const gateway = await startFakeGateway({ port: 0, auth: 'none', passkey: true })

    try {
      const response = await fetch(`${gateway.url}${PREFIX}`)

      expect(response.status).toBe(403)
      expect(((await response.json()) as Json).error).toBe('no_identity')
    } finally {
      await gateway.close()
    }
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

  it('starts a gateway that knows the level with --passkey, and lists its own address', async () => {
    const started = await run(['--auth', 'cookie', '--passkey'])

    try {
      const url = /listening on (\S+)/u.exec(started.out)?.[1] ?? ''

      expect(started.out).toContain(`passkey    on; base URLs ${url}`)

      const status = (await (await fetch(`${url}/__fake/state`)).json()) as Json

      expect(status.passkey).toMatchObject({ enabled: true, base_urls: [url], allow_private_base_urls: true })
    } finally {
      started.stop()
    }
  }, 30_000)

  it('takes --passkey-base-url and --passkey-rp, and then leaves private base URLs off', async () => {
    const started = await run([
      '--auth',
      'native',
      '--passkey-base-url',
      'https://gw.example.invalid',
      '--passkey-rp',
      'app.example.invalid=https://app.example.invalid'
    ])

    try {
      const url = /listening on (\S+)/u.exec(started.out)?.[1] ?? ''
      const status = (await (await fetch(`${url}/__fake/state`)).json()) as Json

      expect(status.passkey).toMatchObject({
        base_urls: ['https://gw.example.invalid'],
        allow_private_base_urls: false,
        native_rps: { 'app.example.invalid': ['https://app.example.invalid'] },
        rp: { native: ['app.example.invalid'], web: ['gw.example.invalid'] }
      })
    } finally {
      started.stop()
    }
  }, 30_000)

  it('refuses --passkey where nobody can be signed in', async () => {
    const refused = await run(['--auth', 'none', '--passkey'])

    expect(refused.code).toBe(1)
    expect(refused.out).toContain('--passkey needs --auth cookie or native')
  }, 30_000)
})
