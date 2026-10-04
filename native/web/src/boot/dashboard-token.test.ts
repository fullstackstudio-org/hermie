import { describe, expect, it } from 'vitest'

import { fakeFetch, json, type RecordedCall } from '../test-support/fake-fetch'
import { dashboardIndexUrl, extractDashboardToken, MAX_TOKEN_LENGTH, readDashboardToken } from './dashboard-token'

/** The page `_serve_index` writes on an ungated gateway, around a script body of our choosing. */
const page = (script: string): string =>
  '<!doctype html><html><head><meta charset="utf-8"><title>Hermes</title>' +
  `<script>${script}</script></head><body><div id="root"></div></body></html>`

/** The bootstrap script the fork writes, with the token line as given. */
const bootstrap = (tokenLine: string, authRequired = false): string =>
  page(
    `${tokenLine}window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=false;window.__HERMES_BASE_PATH__="";` +
      `window.__HERMES_AUTH_REQUIRED__=${authRequired ? 'true' : 'false'};window.__HERMES_INITIAL_PROFILE__="";`
  )

/** One backslash, spelled so no tool or editor turns an escape into the character it names. */
const BACKSLASH = String.fromCharCode(92)

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

describe('extractDashboardToken', () => {
  it('reads the token the dashboard bootstrap carries', () => {
    expect(extractDashboardToken(bootstrap('window.__HERMES_SESSION_TOKEN__="Abc_123-xyz.~";'))).toBe('Abc_123-xyz.~')
    // Spaces around the sign, and the headless page (`json.dumps`, then the next global).
    expect(extractDashboardToken(page('window.__HERMES_SESSION_TOKEN__ = "tok-123" ;'))).toBe('tok-123')
    expect(
      extractDashboardToken(page('window.__HERMES_SESSION_TOKEN__="tok-123";window.__HERMES_AUTH_REQUIRED__=false;'))
    ).toBe('tok-123')
  })

  it('reads a token the length of what the gateway mints, and refuses one past the limit', () => {
    const minted = 'a'.repeat(43)

    expect(extractDashboardToken(bootstrap(`window.__HERMES_SESSION_TOKEN__="${minted}";`))).toBe(minted)
    expect(
      extractDashboardToken(bootstrap(`window.__HERMES_SESSION_TOKEN__="${'a'.repeat(MAX_TOKEN_LENGTH + 1)}";`))
    ).toBeNull()
  })

  it('is null when the page carries no token', () => {
    expect(extractDashboardToken(bootstrap(''))).toBeNull()
    expect(extractDashboardToken('')).toBeNull()
    expect(extractDashboardToken('{"error":"Frontend not built. Run: cd web && npm run build"}')).toBeNull()
  })

  it('is null on a gated gateway’s page, whatever else it says', () => {
    expect(extractDashboardToken(bootstrap('', true))).toBeNull()
    expect(extractDashboardToken(bootstrap('window.__HERMES_SESSION_TOKEN__="tok-123";', true))).toBeNull()
    // The gateway's own sign-in page, which is where a gated gateway sends a page load.
    expect(extractDashboardToken(page('const next = new URLSearchParams(location.search).get("next")'))).toBeNull()
  })

  it.each([
    ['an empty string', 'window.__HERMES_SESSION_TOKEN__="";'],
    ['single quotes', "window.__HERMES_SESSION_TOKEN__='tok-123';"],
    ['no quotes', 'window.__HERMES_SESSION_TOKEN__=tok123;'],
    ['an expression', 'window.__HERMES_SESSION_TOKEN__=atob("dG9r");'],
    ['a concatenation', 'window.__HERMES_SESSION_TOKEN__="tok"+"123";'],
    ['no closing quote', 'window.__HERMES_SESSION_TOKEN__="tok-123;'],
    ['no semicolon', 'window.__HERMES_SESSION_TOKEN__="tok-123"</script>']
  ])('is null for a malformed value: %s', (_, line) => {
    expect(extractDashboardToken(bootstrap(line))).toBeNull()
  })

  it.each([
    ['a space', 'tok 123'],
    ['a slash', 'tok/123'],
    ['a plus', 'tok+123'],
    ['an equals sign', 'tok123='],
    ['a percent escape', 'tok%20123'],
    ['a JSON escape', `tok${BACKSLASH}u0041`],
    ['an escaped quote', `tok${BACKSLASH}"123`],
    ['a non-ASCII letter', 'tök123'],
    ['an angle bracket', 'tok<123']
  ])('is null for a token with a character outside the URL-safe set: %s', (_, value) => {
    expect(extractDashboardToken(bootstrap(`window.__HERMES_SESSION_TOKEN__="${value}";`))).toBeNull()
  })

  it('is null when the page assigns the token twice with different values, or once in another form', () => {
    expect(
      extractDashboardToken(page('window.__HERMES_SESSION_TOKEN__="tok-a";window.__HERMES_SESSION_TOKEN__="tok-b";'))
    ).toBeNull()
    expect(
      extractDashboardToken(page('window.__HERMES_SESSION_TOKEN__="tok-a";window.__HERMES_SESSION_TOKEN__=other;'))
    ).toBeNull()
    // The same value twice is still one token.
    expect(
      extractDashboardToken(page('window.__HERMES_SESSION_TOKEN__="tok-a";window.__HERMES_SESSION_TOKEN__="tok-a";'))
    ).toBe('tok-a')
    // A comparison is a read, not an assignment.
    expect(
      extractDashboardToken(page('window.__HERMES_SESSION_TOKEN__="tok-a";if(window.__HERMES_SESSION_TOKEN__=="x"){}'))
    ).toBe('tok-a')
  })
})

describe('readDashboardToken', () => {
  const baseUrl = 'https://gateway.example.com/hermes'

  it('fetches the index under the prefix, same origin, uncached and without following a redirect', async () => {
    const seen: RequestInit[] = []
    const { fetch, calls } = fakeFetch(
      { 'GET /': () => html(bootstrap('window.__HERMES_SESSION_TOKEN__="tok-123";')) },
      '/hermes'
    )

    const token = await readDashboardToken(baseUrl, (input, init) => {
      seen.push(init ?? {})

      return fetch(input, init)
    })

    expect(token).toBe('tok-123')
    expect(calls.map((call: RecordedCall) => call.url)).toEqual(['https://gateway.example.com/hermes/'])
    expect(seen[0]).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
    expect(dashboardIndexUrl('https://gateway.example.com')).toBe('https://gateway.example.com/')
  })

  it('is null, and never throws, when the page cannot be had or is not the bootstrap', async () => {
    const answer = (response: () => Response) => fakeFetch({ 'GET /': response }, '/hermes').fetch

    // Absent: an index without a token, a JSON 404, a refusal, a server error.
    expect(
      await readDashboardToken(
        baseUrl,
        answer(() => html(bootstrap('')))
      )
    ).toBeNull()
    expect(
      await readDashboardToken(
        baseUrl,
        answer(() => json(404, { error: 'Frontend not built' }))
      )
    ).toBeNull()
    expect(
      await readDashboardToken(
        baseUrl,
        answer(() => html(bootstrap('window.__HERMES_SESSION_TOKEN__="t";'), 401))
      )
    ).toBeNull()
    expect(
      await readDashboardToken(
        baseUrl,
        answer(() => html('oops', 502))
      )
    ).toBeNull()
    // Not HTML, even when the text would match.
    expect(
      await readDashboardToken(
        baseUrl,
        answer(
          () =>
            new Response('window.__HERMES_SESSION_TOKEN__="tok-123";', {
              status: 200,
              headers: { 'content-type': 'application/javascript' }
            })
        )
      )
    ).toBeNull()
    // A gated gateway: the bootstrap says so.
    expect(
      await readDashboardToken(
        baseUrl,
        answer(() => html(bootstrap('', true)))
      )
    ).toBeNull()
    // The network, or a redirect refused by `redirect: 'error'`.
    expect(await readDashboardToken(baseUrl, () => Promise.reject(new TypeError('Failed to fetch')))).toBeNull()
  })

  it('gives up after its timeout', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })

    expect(await readDashboardToken(baseUrl, hanging, 5)).toBeNull()
  })
})
