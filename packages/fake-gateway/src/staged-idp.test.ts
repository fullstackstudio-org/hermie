/**
 * The staged identity provider (`idp: 'staged'`): the native sign-in chain a real
 * gateway runs, with a provider shaped like the FullStack Studio one behind it.
 * Driven here with a small browser that keeps cookies and follows redirects by
 * hand, so every hop and every cookie is visible to the assertions.
 */
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from './server'

const live: FakeGateway[] = []

afterEach(async () => {
  await Promise.all(live.splice(0).map(gateway => gateway.close()))
})

async function gateway(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const started = await startFakeGateway({ port: 0, auth: 'native', idp: 'staged', ...options })
  live.push(started)

  return started
}

/** A browser with a cookie jar of its own, and every hop it took. */
class Browser {
  readonly jar = new Map<string, string>()
  readonly hops: string[] = []

  constructor(private readonly base: string) {}

  /** Requests `target` and follows redirects on this server; a redirect elsewhere is answered, not followed. */
  async go(target: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<Response> {
    let url = new URL(target, this.base)
    let method = init.method ?? 'GET'
    let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : undefined

    for (let hop = 0; hop < 12; hop += 1) {
      this.hops.push(`${method} ${url.pathname}`)

      const response = await fetch(url, {
        method,
        redirect: 'manual',
        headers: {
          cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
        },
        ...(body ? { body } : {})
      })

      for (const line of response.headers.getSetCookie()) {
        const [pair = ''] = line.split(';')
        const [name = '', ...rest] = pair.split('=')
        const value = rest.join('=')

        if (/Max-Age=0/i.test(line) || value === '') {
          this.jar.delete(name)
        } else {
          this.jar.set(name, value)
        }
      }

      const location = response.headers.get('location')

      if (response.status < 300 || response.status >= 400 || !location) {
        return response
      }

      const next = new URL(location, url)

      if (next.origin !== new URL(this.base).origin) {
        return response
      }

      url = next
      method = 'GET'
      body = undefined
    }

    throw new Error('too many redirects')
  }
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  return { verifier, challenge }
}

function authorizePath(challenge: string, state = 'client-state'): string {
  const params = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: 'http://127.0.0.1:50999/callback',
    state
  })

  return `/auth/native/authorize?${params}`
}

const login = { username: 'tester', password: 'hunter2' }

describe('the staged identity provider', () => {
  it('runs password, one-time code, provider callback and gateway callback to the loopback redirect', async () => {
    const on = await gateway()
    const browser = new Browser(on.url)
    const { verifier, challenge } = pkce()

    const loginPage = await browser.go(authorizePath(challenge))

    expect(loginPage.status).toBe(200)
    expect(await loginPage.text()).toContain('action="/__idp/login"')
    expect(browser.hops).toEqual(['GET /auth/native/authorize', 'GET /__idp/authorize', 'GET /__idp/login'])
    expect([...browser.jar.keys()].sort()).toEqual(['hermes_session_pkce', 'idp_next'])

    const verifyPage = await browser.go('/__idp/login', { method: 'POST', form: login })

    expect(await verifyPage.text()).toContain('action="/__idp/verify"')

    const done = await browser.go('/__idp/verify', { method: 'POST', form: { code: '246810' } })

    expect(done.status).toBe(302)
    expect(browser.hops.slice(-3)).toEqual(['POST /__idp/verify', 'GET /__idp/consent', 'GET /auth/callback'])

    const loopback = new URL(done.headers.get('location') ?? '')

    expect(loopback.origin).toBe('http://127.0.0.1:50999')
    expect(loopback.pathname).toBe('/callback')
    expect(loopback.searchParams.get('state')).toBe('client-state')
    // The gateway's PKCE cookie is spent; the provider's session stays.
    expect(browser.jar.has('hermes_session_pkce')).toBe(false)
    expect(browser.jar.has('idp_session')).toBe(true)

    const exchange = await fetch(`${on.url}/auth/native/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: loopback.searchParams.get('code'), code_verifier: verifier })
    })

    expect(exchange.status).toBe(200)
    expect(await exchange.json()).toMatchObject({ token_type: 'Bearer', provider: 'self-hosted' })
  })

  it('goes straight through for a browser already signed in at the provider', async () => {
    const on = await gateway()
    const browser = new Browser(on.url)

    await browser.go(authorizePath(pkce().challenge))
    await browser.go('/__idp/login', { method: 'POST', form: login })
    await browser.go('/__idp/verify', { method: 'POST', form: { code: '246810' } })

    browser.hops.length = 0

    const again = await browser.go(authorizePath(pkce().challenge, 'second'))

    expect(again.status).toBe(302)
    expect(new URL(again.headers.get('location') ?? '').searchParams.get('state')).toBe('second')
    expect(browser.hops).toEqual([
      'GET /auth/native/authorize',
      'GET /__idp/authorize',
      'GET /__idp/consent',
      'GET /auth/callback'
    ])
  })

  it('burns the code challenge on a wrong code: the next try goes back to the password form', async () => {
    const on = await gateway()
    const browser = new Browser(on.url)

    await browser.go(authorizePath(pkce().challenge))
    await browser.go('/__idp/login', { method: 'POST', form: login })

    const wrong = await browser.go('/__idp/verify', { method: 'POST', form: { code: '000000' } })

    expect(await wrong.text()).toContain('That code is not right.')

    const late = await browser.go('/__idp/verify', { method: 'POST', form: { code: '246810' } })

    expect(await late.text()).toContain('This sign-in expired.')
    expect((await browser.go('/__idp/verify')).url).toContain('/__idp/login')
    expect(browser.hops.slice(-2)).toEqual(['GET /__idp/verify', 'GET /__idp/login'])

    // Signing in again within the same attempt still finishes it.
    await browser.go('/__idp/login', { method: 'POST', form: login })

    const done = await browser.go('/__idp/verify', { method: 'POST', form: { code: '246810' } })

    expect(done.status).toBe(302)
    expect(new URL(done.headers.get('location') ?? '').origin).toBe('http://127.0.0.1:50999')
  })

  it('answers a callback without the gateway PKCE cookie with a 400, as the gateway does', async () => {
    const on = await gateway()
    const browser = new Browser(on.url)

    await browser.go(authorizePath(pkce().challenge))
    browser.jar.delete('hermes_session_pkce')
    await browser.go('/__idp/login', { method: 'POST', form: login })

    const done = await browser.go('/__idp/verify', { method: 'POST', form: { code: '246810' } })

    expect(done.status).toBe(400)
    expect(await done.json()).toEqual({ detail: 'Missing PKCE state cookie' })
  })

  it('sends a browser that lost the provider next cookie to the provider home, not back to the gateway', async () => {
    const on = await gateway()
    const browser = new Browser(on.url)

    await browser.go(authorizePath(pkce().challenge))
    browser.jar.delete('idp_next')
    await browser.go('/__idp/login', { method: 'POST', form: login })

    const done = await browser.go('/__idp/verify', { method: 'POST', form: { code: '246810' } })

    expect(done.status).toBe(200)
    expect(browser.hops.at(-1)).toBe('GET /__idp/home')
  })

  it('leaves the single-step approval alone when not staged', async () => {
    const on = await startFakeGateway({ port: 0, auth: 'native' })
    live.push(on)

    const page = await fetch(`${on.url}${authorizePath(pkce().challenge)}`, { redirect: 'manual' })

    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Approve as tester')
  })
})
