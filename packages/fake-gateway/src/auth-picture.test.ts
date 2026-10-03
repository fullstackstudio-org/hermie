/**
 * `GET /api/auth/picture?id=<provider>:<sub>` and `/api/auth/me`'s `picture_url`, as the fake serves them.
 *
 * The gateway keeps its own copy of the picture the identity provider sent and serves it behind the
 * same auth as everything else under `/api/auth`; an id it holds none for is a 404, and `/api/auth/me`
 * names the picture only when there is one to fetch.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from './server'

/** A 1x1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const gateways: FakeGateway[] = []

afterEach(async () => {
  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

const start = async (options: FakeGatewayOptions = {}): Promise<FakeGateway> => {
  const gateway = await startFakeGateway({ port: 0, auth: 'cookie', ...options })
  gateways.push(gateway)

  return gateway
}

const signIn = async (gateway: FakeGateway): Promise<string> => {
  const response = await fetch(`${gateway.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'hunter2' })
  })

  return (response.headers.get('set-cookie') ?? '').split(';')[0] as string
}

describe('/api/auth/picture', () => {
  it('serves the picture held under an id, as the image it is', async () => {
    const gateway = await start({ pictures: { 'authentik:robin': `data:image/png;base64,${PNG}` } })
    const cookie = await signIn(gateway)
    const response = await fetch(`${gateway.url}/api/auth/picture?id=${encodeURIComponent('authentik:robin')}`, {
      headers: { cookie }
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer()).toString('base64')).toBe(PNG)
    expect(gateway.state.pictureRequests).toEqual(['authentik:robin'])
  })

  it('answers 404 for an id it holds none for', async () => {
    const gateway = await start()
    const cookie = await signIn(gateway)
    const response = await fetch(`${gateway.url}/api/auth/picture?id=nobody%3A1`, { headers: { cookie } })

    expect(response.status).toBe(404)
  })

  it('is behind the gate: a visitor who is not signed in gets the 401', async () => {
    const gateway = await start({ pictures: { 'authentik:robin': PNG } })
    const response = await fetch(`${gateway.url}/api/auth/picture?id=authentik%3Arobin`)

    expect(response.status).toBe(401)
  })

  it('names an account’s own picture in /api/auth/me, and serves it under its id', async () => {
    const gateway = await start({
      accounts: [{ username: 'tester', password: 'hunter2', userId: 'sam-sub', picture: PNG }]
    })
    const cookie = await signIn(gateway)
    const me = (await fetch(`${gateway.url}/api/auth/me`, { headers: { cookie } }).then(response =>
      response.json()
    )) as Record<string, unknown>

    expect(me.picture_url).toBe('/api/auth/picture?id=self-hosted%3Asam-sub')

    const picture = await fetch(`${gateway.url}${me.picture_url as string}`, { headers: { cookie } })

    expect(picture.status).toBe(200)
  })

  it('leaves picture_url out when the gateway holds none', async () => {
    const gateway = await start()
    const cookie = await signIn(gateway)
    const me = (await fetch(`${gateway.url}/api/auth/me`, { headers: { cookie } }).then(response =>
      response.json()
    )) as Record<string, unknown>

    expect('picture_url' in me).toBe(false)
  })
})
