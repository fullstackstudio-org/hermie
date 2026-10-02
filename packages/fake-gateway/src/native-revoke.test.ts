/**
 * `POST /auth/native/revoke` and the `native_revoke` flow that advertises it,
 * as our fork's `dashboard_auth/routes.py` and `web_routers/status.py` have them.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from './server'

const live: FakeGateway[] = []

afterEach(async () => {
  await Promise.all(live.splice(0).map(gateway => gateway.close()))
})

async function gateway(options: FakeGatewayOptions): Promise<FakeGateway> {
  const started = await startFakeGateway({ port: 0, ...options })
  live.push(started)

  return started
}

const flowsOf = async (on: FakeGateway): Promise<string[]> =>
  ((await (await fetch(`${on.url}/api/status`)).json()) as { auth_flows: string[] }).auth_flows

const revoke = (on: FakeGateway, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${on.url}/auth/native/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })

describe('the native_revoke flow', () => {
  it('is advertised after the others on a gated gateway, in either mode', async () => {
    expect(await flowsOf(await gateway({ auth: 'native' }))).toEqual(['cookie', 'native_pkce', 'native_revoke'])
    expect(await flowsOf(await gateway({ auth: 'cookie' }))).toEqual(['cookie', 'native_revoke'])
  })

  it('is not advertised by an ungated gateway, nor by one staged without the route', async () => {
    expect(await flowsOf(await gateway({ auth: 'none' }))).toEqual([])
    expect(await flowsOf(await gateway({ auth: 'native', nativeRevoke: false }))).toEqual(['cookie', 'native_pkce'])
  })
})

describe('POST /auth/native/revoke', () => {
  it('answers ok for any well-formed request, records it, and needs no bearer', async () => {
    const on = await gateway({ auth: 'native' })
    const answer = await revoke(on, { refresh_token: 'rt-unknown', provider: 'self-hosted' })

    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ ok: true })
    expect(on.state.revokeCalls).toEqual([
      { refreshToken: 'rt-unknown', provider: 'self-hosted', authorization: false }
    ])
  })

  it('notes a bearer a client sent anyway, so a test can refuse it', async () => {
    const on = await gateway({ auth: 'native' })

    await revoke(on, { refresh_token: 'rt-1', provider: 'self-hosted' }, { authorization: 'Bearer at-1' })

    expect(on.state.revokeCalls[0]?.authorization).toBe(true)
  })

  it.each([
    ['no refresh token', { provider: 'self-hosted' }],
    ['no provider', { refresh_token: 'rt-1' }],
    ['an empty provider', { refresh_token: 'rt-1', provider: '' }]
  ])('answers 400 for %s', async (_label, body) => {
    const on = await gateway({ auth: 'native' })

    expect((await revoke(on, body)).status).toBe(400)
  })

  it('is not there on a gateway staged without it', async () => {
    const on = await gateway({ auth: 'native', nativeRevoke: false })

    // Behind the gate like any path this gateway does not serve: never the ok.
    expect((await revoke(on, { refresh_token: 'rt-1', provider: 'self-hosted' })).status).toBe(401)
    expect(on.state.revokeCalls).toEqual([])
  })
})
