/**
 * The dashboard's static route for a plugin, as the fake serves it, and the gate
 * and bootstrap pages around it.
 *
 * `GET /dashboard-plugins/{plugin_name}/{file_path:path}`
 * (`hermes_cli/web_routers/dashboard_ui.py::serve_plugin_asset`) is what a
 * built web client is served by on a real gateway, so these cases pin the
 * route's own rules rather than a friendlier one: an allow-list of suffixes, no
 * answer for a directory, no SPA fallback, `no-store` on everything, and a
 * redirect to `/login` for a visitor who is not signed in on a gated gateway.
 * A client that works against a more forgiving fake would break the first time
 * it met a gateway.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from './server'
import { isSafeNextPath, loginUrlFor, quoteComponent } from './plugin-assets'

let root: string
let outside: string
const gateways: FakeGateway[] = []

beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), 'fake-gateway-outside-'))
  root = mkdtempSync(join(tmpdir(), 'fake-gateway-assets-'))
  mkdirSync(join(root, 'app', 'assets'), { recursive: true })
  mkdirSync(join(root, 'app', 'icons'))
  writeFileSync(join(root, 'app', 'index.html'), '<!doctype html><title>Client</title>')
  writeFileSync(join(root, 'app', 'assets', 'index-AbC123xy.js'), 'export const ready = true\n')
  writeFileSync(join(root, 'app', 'assets', 'index-AbC123xy.css'), 'body{margin:0}')
  writeFileSync(join(root, 'app', 'assets', 'index-AbC123xy.js.map'), '{"version":3}')
  writeFileSync(join(root, 'app', 'manifest.json'), '{"name":"Hermie"}')
  writeFileSync(join(root, 'app', 'manifest.webmanifest'), '{"name":"not on the allow-list"}')
  writeFileSync(join(root, 'app', 'notes.txt'), 'not on the allow-list')
  writeFileSync(join(root, 'app', 'icons', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(root, 'plugin_api.py'), 'SECRET = 1\n')
  writeFileSync(join(root, '..hidden.json'), '{"dots":true}')
  writeFileSync(join(outside, 'secret.json'), '{"secret":true}')
  symlinkSync(join(outside, 'secret.json'), join(root, 'app', 'linked.json'))
})

afterEach(async () => {
  while (gateways.length) {
    await gateways.pop()?.close()
  }

  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const start = async (options: FakeGatewayOptions = {}): Promise<FakeGateway> => {
  const gateway = await startFakeGateway({ port: 0, pluginAssets: root, ...options })
  gateways.push(gateway)

  return gateway
}

const get = (gateway: FakeGateway, path: string, init: RequestInit = {}) =>
  fetch(`${gateway.url}${path}`, { redirect: 'manual', ...init })

const signIn = async (gateway: FakeGateway): Promise<string> => {
  const response = await fetch(`${gateway.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'hunter2' })
  })

  return (response.headers.get('set-cookie') ?? '').split(';')[0] as string
}

describe('GET /dashboard-plugins/hermie/<path>', () => {
  it('serves the client document with the route’s headers and nothing else of its own', async () => {
    const gateway = await start()
    const response = await get(gateway, '/dashboard-plugins/hermie/app/index.html')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<!doctype html><title>Client</title>')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate')

    // A header the route does not send is a header a test could start to rely
    // on, which would pass here and fail on the gateway.
    for (const name of ['etag', 'last-modified', 'x-content-type-options', 'content-security-policy']) {
      expect(response.headers.has(name), name).toBe(false)
    }
  })

  it.each([
    ['app/assets/index-AbC123xy.js', 'application/javascript'],
    ['app/assets/index-AbC123xy.css', 'text/css; charset=utf-8'],
    ['app/assets/index-AbC123xy.js.map', 'application/json'],
    ['app/manifest.json', 'application/json'],
    ['app/icons/icon.svg', 'image/svg+xml']
  ])('serves %s as %s', async (file, type) => {
    const gateway = await start()
    const response = await get(gateway, `/dashboard-plugins/hermie/${file}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate')
  })

  it('answers 404 for a directory and does not fall back to an index', async () => {
    const gateway = await start()

    for (const path of [
      '/dashboard-plugins/hermie/',
      '/dashboard-plugins/hermie/app',
      '/dashboard-plugins/hermie/app/'
    ]) {
      const response = await get(gateway, path)

      expect(response.status, path).toBe(404)
      expect(await response.json()).toEqual({ detail: 'File not found' })
    }
  })

  it('answers 404 for a file that is not there, and for a route a single-page app would have caught', async () => {
    const gateway = await start()

    for (const path of ['/dashboard-plugins/hermie/app/missing.js', '/dashboard-plugins/hermie/app/chat/researcher']) {
      const response = await get(gateway, path)

      expect(response.status, path).toBe(404)
      expect(await response.json()).toEqual({ detail: 'File not found' })
    }
  })

  it('answers 404 for a suffix outside the allow-list, whatever the file', async () => {
    const gateway = await start()

    // `.webmanifest` is why the client ships `manifest.json`; `.py` is why the list exists.
    for (const file of ['app/manifest.webmanifest', 'app/notes.txt', 'plugin_api.py']) {
      const response = await get(gateway, `/dashboard-plugins/hermie/${file}`)

      expect(response.status, file).toBe(404)
      expect(await response.json()).toEqual({ detail: 'File not found' })
    }
  })

  it('refuses a traversal with 403, whichever way it is spelled', async () => {
    const gateway = await start()
    const target = encodeURIComponent(join(outside, 'secret.json'))

    // `%2F` survives URL normalisation and is decoded once, by the route, as an
    // ASGI server does — which is the way a `..` actually reaches it.
    for (const file of [
      `..%2F${outside.split('/').pop()}%2Fsecret.json`,
      `..%2F..%2Fetc%2Fhosts`,
      target,
      'app%2F..%2F..%2Fx.json'
    ]) {
      const response = await get(gateway, `/dashboard-plugins/hermie/${file}`)

      expect(response.status, file).toBe(403)
      expect(await response.json()).toEqual({ detail: 'Path traversal blocked' })
    }
  })

  it('refuses a symlink that leaves the directory, as `resolve()` does', async () => {
    const gateway = await start()
    const response = await get(gateway, '/dashboard-plugins/hermie/app/linked.json')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ detail: 'Path traversal blocked' })
  })

  it('does not mistake a file whose name starts with two dots for an escape', async () => {
    const gateway = await start()
    const response = await get(gateway, '/dashboard-plugins/hermie/..hidden.json')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ dots: true })
  })

  it('answers 404 `Plugin not found` for another plugin, for no directory, and for a gateway without the plugin', async () => {
    const other = await start()
    const bare = await startFakeGateway({ port: 0 })
    gateways.push(bare)
    const without = await start({ plugin: false })

    for (const [gateway, path] of [
      [other, '/dashboard-plugins/other/app/index.html'],
      [bare, '/dashboard-plugins/hermie/app/index.html'],
      [without, '/dashboard-plugins/hermie/app/index.html']
    ] as const) {
      const response = await get(gateway, path)

      expect(response.status, path).toBe(404)
      expect(await response.json()).toEqual({ detail: 'Plugin not found' })
    }
  })

  it('serves GET only: a POST is 405 with `Allow: GET`, as FastAPI answers it', async () => {
    const gateway = await start()
    const response = await get(gateway, '/dashboard-plugins/hermie/app/index.html', { method: 'POST' })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })

  it('reads the directory on every request, so a build can be swapped under a running gateway', async () => {
    const gateway = await start()

    expect(await (await get(gateway, '/dashboard-plugins/hermie/app/index.html')).text()).toContain('Client')

    writeFileSync(join(root, 'app', 'index.html'), '<!doctype html><title>Previous build</title>')

    expect(await (await get(gateway, '/dashboard-plugins/hermie/app/index.html')).text()).toContain('Previous build')
  })

  it('is public on an ungated gateway, and on one with a session token', async () => {
    for (const auth of ['none', 'token'] as const) {
      const gateway = await start({ auth })

      expect((await get(gateway, '/dashboard-plugins/hermie/app/index.html')).status, auth).toBe(200)
    }
  })
})

describe('the gate, with --auth cookie', () => {
  it('redirects an unauthenticated visit for any file to the sign-in page, naming where to return to', async () => {
    const gateway = await start({ auth: 'cookie' })

    for (const path of [
      '/dashboard-plugins/hermie/app/index.html',
      '/dashboard-plugins/hermie/app/assets/index-AbC123xy.js'
    ]) {
      const response = await get(gateway, path)

      expect(response.status, path).toBe(302)
      expect(response.headers.get('location')).toBe(`/login?next=${encodeURIComponent(path)}`)
      expect(response.headers.has('cache-control')).toBe(false)
    }
  })

  it('keeps the query in `next`, encoded the way `urllib.parse.quote` encodes it', async () => {
    const gateway = await start({ auth: 'cookie' })
    const response = await get(gateway, '/dashboard-plugins/hermie/app/index.html?a=1&b=(x)!')

    expect(response.headers.get('location')).toBe(
      '/login?next=%2Fdashboard-plugins%2Fhermie%2Fapp%2Findex.html%3Fa%3D1%26b%3D%28x%29%21'
    )
  })

  it('redirects the pages it serves, and leaves a path it does not serve with the plain JSON 401', async () => {
    const gateway = await start({ auth: 'cookie' })
    const page = await get(gateway, '/')
    const other = await get(gateway, '/not-a-gateway/api/status')

    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/login?next=%2F')
    // What a probe of a wrong address tells a gate from a gateway by.
    expect(other.status).toBe(401)
    expect(await other.json()).toEqual({ detail: 'Unauthorized' })
  })

  it('answers an `/api` call with a JSON 401 that names where to sign in, and no redirect', async () => {
    const gateway = await start({ auth: 'cookie' })
    const response = await get(gateway, '/api/auth/me')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'unauthenticated',
      detail: 'Unauthorized',
      reason: 'no_cookie',
      // `/api` is never a place to return to, so the real gate names none.
      login_url: '/login'
    })
  })

  it('tells an expired session from a visitor who never signed in, and clears the dead cookie', async () => {
    const gateway = await start({ auth: 'cookie' })
    const cookie = await signIn(gateway)

    expect((await get(gateway, '/api/auth/me', { headers: { cookie } })).status).toBe(200)
    expect(await (await fetch(`${gateway.url}/__fake/expire-sessions`, { method: 'POST' })).json()).toEqual({
      expired: 1
    })

    const api = await get(gateway, '/api/auth/me', { headers: { cookie } })

    expect(api.status).toBe(401)
    expect(await api.json()).toEqual({
      error: 'session_expired',
      detail: 'Unauthorized',
      reason: 'invalid_or_expired_session',
      login_url: '/login'
    })
    expect(api.headers.get('set-cookie')).toContain('Max-Age=0')

    const page = await get(gateway, '/dashboard-plugins/hermie/app/index.html', { headers: { cookie } })

    expect(page.status).toBe(302)
    expect(page.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('serves the files once signed in, still no-store', async () => {
    const gateway = await start({ auth: 'cookie' })
    const cookie = await signIn(gateway)
    const response = await get(gateway, '/dashboard-plugins/hermie/app/index.html', { headers: { cookie } })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate')
  })

  it('still answers the sign-in page, the password login and the status route without a session', async () => {
    const gateway = await start({ auth: 'cookie' })

    expect((await get(gateway, '/login')).status).toBe(200)
    expect((await get(gateway, '/api/status')).status).toBe(200)
    expect((await get(gateway, '/api/auth/providers')).status).toBe(200)
  })

  it('does not sign a bearer-only gateway in by cookie: native mode keeps its JSON 401', async () => {
    const gateway = await start({ auth: 'native' })
    const response = await get(gateway, '/dashboard-plugins/hermie/app/index.html')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: 'Unauthorized' })
  })
})

describe('the sign-in page', () => {
  /** Run the page's script against stubs, and report what it did when the form was submitted. */
  const submit = async (next: string | null, ok = true) => {
    const gateway = await start({ auth: 'cookie' })
    const page = await (await get(gateway, '/login')).text()
    const script = /<script>([\s\S]*)<\/script>/u.exec(page)?.[1] as string
    const sent: { url: string; init: Record<string, unknown> }[] = []
    const navigated: string[] = []
    const handlers: Record<string, (event: { preventDefault: () => void }) => Promise<void>> = {}
    const message = { textContent: '' }
    const form = {
      username: { value: 'tester' },
      password: { value: 'hunter2' },
      addEventListener: (type: string, handler: (event: { preventDefault: () => void }) => Promise<void>) => {
        handlers[type] = handler
      }
    }

    runInNewContext(script, {
      URLSearchParams,
      JSON,
      document: { getElementById: (id: string) => (id === 'f' ? form : message) },
      location: {
        search: next === null ? '' : `?next=${encodeURIComponent(next)}`,
        assign: (to: string) => navigated.push(to)
      },
      fetch: async (url: string, init: Record<string, unknown>) => {
        sent.push({ url, init })

        return { ok }
      }
    })

    await handlers.submit?.({ preventDefault: () => undefined })

    return { page, sent, navigated, message }
  }

  it('is a form that posts the credentials as JSON to /auth/password-login', async () => {
    const { page, sent } = await submit('/dashboard-plugins/hermie/app/index.html')

    expect(page).toContain('<form')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe('/auth/password-login')
    expect(sent[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      username: 'tester',
      password: 'hunter2',
      next: '/dashboard-plugins/hermie/app/index.html'
    })
  })

  it('returns to `next` when it is a same-origin path the gateway would accept', async () => {
    const { navigated } = await submit('/dashboard-plugins/hermie/app/index.html?x=1')

    expect(navigated).toEqual(['/dashboard-plugins/hermie/app/index.html?x=1'])
  })

  it.each(['//evil.example/x', 'https://evil.example/', '/login', '/loginx', '/auth/logout', '/api/status', '/api'])(
    'goes to `/` instead of %s',
    async next => {
      expect((await submit(next)).navigated).toEqual(['/'])
    }
  )

  it('goes to `/` when there is no `next`, and stays put with a message when the sign-in fails', async () => {
    expect((await submit(null)).navigated).toEqual(['/'])

    const failed = await submit('/dashboard', false)

    expect(failed.navigated).toEqual([])
    expect(failed.message.textContent).toBe('Invalid credentials')
  })
})

describe('GET / with --auth token', () => {
  it('hands the session token to the page in the form `_serve_index` writes it', async () => {
    const gateway = await start({ auth: 'token', token: 'tok-123' })
    const response = await get(gateway, '/')
    const page = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate')
    expect(page).toContain('window.__HERMES_SESSION_TOKEN__="tok-123";')
    expect(page).toContain('window.__HERMES_AUTH_REQUIRED__=false;')
  })

  it('cannot be made to close its own script element by a hostile token', async () => {
    const gateway = await start({ auth: 'token', token: '</script><b>x' })
    const page = await (await get(gateway, '/')).text()

    expect(page.match(/<\/script>/gu)).toHaveLength(1)
  })

  it('leaves every API call needing the header, even for a page that read the token', async () => {
    const gateway = await start({ auth: 'token', token: 'tok-123' })

    expect((await get(gateway, '/api/profiles')).status).toBe(401)
    expect((await get(gateway, '/api/profiles', { headers: { 'x-hermes-session-token': 'tok-123' } })).status).toBe(200)
  })

  it('is not served on a gated gateway, where the page itself is behind the gate', async () => {
    const gateway = await start({ auth: 'cookie' })
    const response = await get(gateway, '/')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?next=%2F')
  })
})

describe('the sign-in redirect helpers', () => {
  it.each([
    ['/dashboard', true],
    ['/dashboard-plugins/hermie/app/index.html', true],
    ['', false],
    ['dashboard', false],
    ['//evil.example', false],
    ['/login', false],
    ['/auth/login', false],
    ['/api', false],
    ['/api/status', false],
    ['/api/auth/me', false]
  ])('isSafeNextPath(%j) is %s', (path, safe) => {
    expect(isSafeNextPath(path)).toBe(safe)
  })

  it('quotes everything but letters, digits and `_.-~`', () => {
    expect(quoteComponent("/a b?c=d&e='(f)'!*")).toBe('%2Fa%20b%3Fc%3Dd%26e%3D%27%28f%29%27%21%2A')
    expect(quoteComponent('a_b.c-d~e')).toBe('a_b.c-d~e')
  })

  it('names no `next` for a path it would not return to', () => {
    expect(loginUrlFor('/api/status', '?x=1')).toBe('/login')
    expect(loginUrlFor('/dashboard', '?x=1')).toBe('/login?next=%2Fdashboard%3Fx%3D1')
  })
})
