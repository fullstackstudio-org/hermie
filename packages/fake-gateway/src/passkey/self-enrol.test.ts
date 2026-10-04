/**
 * Self-enrolment against the running fake: a signed-in person adds a passkey by signing in again, with no code
 * (contract §7.2, §8; the real gateway's `test_passkey_routes.py` and `test_passkey_reauth_signin.py`).
 *
 * Pinned here: `reauth/begin` (the binding cookie for a browser only, the https rule, the limits, the switches);
 * the sign-in's start checked before anything is redirected or set; the simulated sign-in and what a test can
 * script it to report; the native round trip that returns no tokens; `register/begin|finish` with a grant (the
 * binding at both, exactly one authority, every `reauth_invalid` reason, single use, the failure limiters);
 * cooling-off; and the contract's wire examples against what the routes answer.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { b64u, b64uDecode } from './encoding'
import { REAUTH_COOKIE } from './reauth'
import { PasskeyStore, reauthSecretHash } from './store'
import {
  ALICE,
  BOB,
  bearerFor,
  closeAll,
  connect,
  cookieFor,
  post,
  startPasskeyGateway,
  stateOf,
  until,
  type Account,
  type Harness,
  type Json
} from './harness'
import { SoftAuthenticator } from '../testing/soft-authenticator'

afterEach(closeAll)

const PREFIX = '/api/auth/passkeys'
const PROVIDER = 'self-hosted'
const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../contract/confirm-passkey/vectors.json', import.meta.url)), 'utf8')
) as Json
const examples = vectors.wire_examples as Json

interface Caller {
  who: Account
  headers: Record<string, string>
}

const cookieCaller = async (h: Harness, who: Account, origin: string | null = h.url): Promise<Caller> => ({
  who,
  headers: { cookie: await cookieFor(h, who), ...(origin === null ? {} : { origin }) }
})

const bearerCaller = async (h: Harness): Promise<Caller> => ({
  who: ALICE,
  headers: { authorization: await bearerFor(h) }
})

interface Answer {
  status: number
  body: Json
  headers: Headers
}

const read = async (response: Response): Promise<Answer> => ({
  status: response.status,
  body: (await response.json()) as Json,
  headers: response.headers
})

const get = async (h: Harness, c: Caller): Promise<Answer> =>
  read(await fetch(`${h.url}${PREFIX}`, { headers: c.headers }))

const send = async (
  h: Harness,
  c: Caller,
  path: string,
  body: unknown,
  extra: Record<string, string> = {}
): Promise<Answer> => read(await post(`${h.url}${PREFIX}${path}`, body, { ...c.headers, ...extra }))

const control = async (h: Harness, action: string, body: unknown = {}): Promise<Answer> =>
  read(await post(`${h.url}/__fake/passkey/${action}`, body))

/** The contract's error answer. */
const asExample = (answer: Answer): Json => ({ status: answer.status, body: answer.body })

/** The text of a person-facing refusal page. */
const pageText = (page: string): string => (page.split('</head>')[1] ?? '').replace(/<[^>]+>/gu, '')

/** `matches(actual, example)`: the fields and kinds of the example (an empty list on either side matches any). */
function matches(actual: unknown, example: unknown, path = ''): void {
  if (Array.isArray(example)) {
    expect(Array.isArray(actual), path).toBe(true)

    if ((actual as unknown[]).length && example.length) {
      matches((actual as unknown[])[0], example[0], `${path}[0]`)
    }
  } else if (example !== null && typeof example === 'object') {
    expect(typeof actual, path).toBe('object')
    expect(Object.keys(actual as Json).sort(), path).toEqual(Object.keys(example).sort())

    for (const key of Object.keys(example)) {
      matches((actual as Json)[key], (example as Json)[key], `${path}.${key}`)
    }
  } else if (example === null) {
    expect(actual, path).toBeNull()
  } else {
    expect(typeof actual, path).toBe(typeof example)
  }
}

// ── grants, the way each kind of client holds them ─────────────────────────────────────────────────

interface Grant {
  caller: Caller
  kind: 'web' | 'native'
  id: string
  /** The cookie secret of a web grant; for a native one the `use_secret` once the sign-in came back fresh. */
  secret: string | null
  body: Json
  headers: Headers
}

const secretOf = (headers: Headers): string => {
  const cookie = headers.getSetCookie().find(value => value.startsWith(`${REAUTH_COOKIE}=`))

  if (!cookie) {
    throw new Error('no reauth cookie')
  }

  return (cookie.split(';')[0] as string).split('=')[1] as string
}

const open = async (h: Harness, caller: Caller): Promise<Grant> => {
  const answer = await send(h, caller, '/reauth/begin', {})

  expect(answer.status, JSON.stringify(answer.body)).toBe(200)

  const web = !('authorization' in caller.headers)

  return {
    caller,
    kind: web ? 'web' : 'native',
    id: answer.body.grant_id,
    secret: web ? secretOf(answer.headers) : null,
    body: answer.body,
    headers: answer.headers
  }
}

/** A request's headers as the grant's own client sends them: the browser adds its cookie, the app nothing. */
const withBinding = (grant: Grant, secret: string | null = grant.secret): Record<string, string> =>
  grant.kind === 'web' && secret !== null
    ? { cookie: `${grant.caller.headers.cookie}; ${REAUTH_COOKIE}=${secret}` }
    : {}

/** The web sign-in, simulated: `GET /auth/login?reauth=`, from the browser that opened the grant. */
const signInWeb = (
  h: Harness,
  grant: Grant,
  options: { cookie?: string | null; next?: string; provider?: string } = {}
) =>
  fetch(
    `${h.url}/auth/login?${new URLSearchParams({
      provider: options.provider ?? PROVIDER,
      reauth: grant.id,
      next: options.next ?? '/settings'
    })}`,
    {
      redirect: 'manual',
      headers: {
        cookie:
          options.cookie === undefined
            ? `${grant.caller.headers.cookie}; ${REAUTH_COOKIE}=${grant.secret}`
            : (options.cookie ?? '')
      }
    }
  )

const pkce = () => {
  const verifier = b64u(randomBytes(32))

  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const authorizeUrl = (h: Harness, challenge: string, extra: Record<string, string> = {}): string => {
  const url = new URL(`${h.url}/auth/native/authorize`)

  for (const [key, value] of Object.entries({
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: 'http://127.0.0.1:1/callback',
    state: 'app-state',
    auto: '1',
    ...extra
  })) {
    url.searchParams.set(key, value)
  }

  return url.toString()
}

/** The native sign-in, simulated: authorize with `reauth`, then redeem the loopback code with the verifier. */
const signInNative = async (
  h: Harness,
  grant: Grant,
  options: { provider?: string; verifier?: string } = {}
): Promise<Answer> => {
  const { verifier, challenge } = pkce()
  const authorize = await fetch(
    authorizeUrl(h, challenge, { reauth: grant.id, ...(options.provider ? { provider: options.provider } : {}) }),
    { redirect: 'manual' }
  )

  expect(authorize.status).toBe(302)

  const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code')
  const token = await read(
    await post(`${h.url}/auth/native/token`, { code, code_verifier: options.verifier ?? verifier })
  )

  if (token.status === 200 && token.body.reauth?.use_secret) {
    grant.secret = token.body.reauth.use_secret
  }

  return token
}

/** Open a grant and complete it with a fresh sign-in of the same person. */
const fresh = async (h: Harness, caller: Caller): Promise<Grant> => {
  const grant = await open(h, caller)

  if (grant.kind === 'web') {
    expect((await signInWeb(h, grant)).status).toBe(302)
  } else {
    expect((await signInNative(h, grant)).body.reauth.state).toBe('fresh')
  }

  return grant
}

const begin = (h: Harness, grant: Grant, auth: SoftAuthenticator, extra: Record<string, unknown> = {}) =>
  send(
    h,
    grant.caller,
    '/register/begin',
    {
      rp_id: auth.rpId,
      base_url: h.url,
      name: 'Laptop',
      grant_id: grant.id,
      ...(grant.kind === 'native' && grant.secret ? { use_secret: grant.secret } : {}),
      ...extra
    },
    withBinding(grant)
  )

const finishBody = (auth: SoftAuthenticator, opened: Json): Record<string, unknown> => {
  const { code: _code, ...body } = auth.register(
    {
      registrationId: opened.registration_id,
      baseUrl: opened.base_url,
      gatewayId: b64uDecode(opened.gateway_id),
      userId: opened.user.id,
      name: opened.user.name,
      nonce: b64uDecode(opened.nonce)
    },
    ''
  )

  return body
}

const finish = (h: Harness, grant: Grant, body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  send(
    h,
    grant.caller,
    '/register/finish',
    {
      ...body,
      grant_id: grant.id,
      ...(grant.kind === 'native' && grant.secret ? { use_secret: grant.secret } : {}),
      ...extra
    },
    withBinding(grant)
  )

/** Self-enrol `auth` with a fresh grant; returns the credential the finish route answered. */
const selfEnrol = async (h: Harness, caller: Caller, auth: SoftAuthenticator): Promise<Json> => {
  const grant = await fresh(h, caller)
  const opened = await begin(h, grant, auth)

  expect(opened.status, JSON.stringify(opened.body)).toBe(200)

  const done = await finish(h, grant, finishBody(auth, opened.body))

  expect(done.status, JSON.stringify(done.body)).toBe(200)

  return done.body.credential
}

const operatorCode = async (h: Harness, who: Account): Promise<string> =>
  ((await (await post(`${h.url}/__fake/passkey/code`, { user: who.key })).json()) as Json).code

// ── reauth/begin ───────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/passkeys/reauth/begin', () => {
  it('answers like an unknown path while the level is off, and opens nothing', async () => {
    const h = await startPasskeyGateway({ passkey: { enabled: false } })
    const alice = await cookieCaller(h, ALICE)
    const response = await fetch(`${h.url}${PREFIX}/reauth/begin`, {
      method: 'POST',
      headers: { ...alice.headers, 'content-type': 'application/json' },
      body: '{}'
    })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    expect(await response.json()).toEqual({ detail: 'Method Not Allowed' })
    expect(h.gateway.passkey()?.store.counts().openGrants).toBe(0)
    expect((await fetch(`${h.url}${PREFIX}/reauth/begin`, { headers: alice.headers })).status).toBe(404)
  })

  it('is behind the gate: no cookie, no answer', async () => {
    const h = await startPasskeyGateway()

    expect((await fetch(`${h.url}${PREFIX}/reauth/begin`, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('gives a browser the binding cookie and a login path, as the contract shows', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const grant = await open(h, alice)

    matches(grant.body, examples.reauth_begin_answer_web)
    expect(grant.body.login_path).toBe(`/auth/login?provider=${PROVIDER}&reauth=${grant.id}`)
    expect(grant.body.provider).toBe(PROVIDER)
    expect(grant.body.expires_at).toBe((h.gateway.passkey()?.store.now() ?? 0) + 600)

    const cookie = grant.headers.getSetCookie().find(value => value.startsWith(`${REAUTH_COOKIE}=`)) as string
    const example = examples.reauth_cookie_set as string
    const attributes = (value: string) =>
      value
        .split(';')
        .slice(1)
        .map(part => part.trim().toLowerCase())
        .sort()

    expect(attributes(cookie)).toEqual(attributes(example))
    expect(cookie.split(';')[0]?.split('=')[1]).toHaveLength(
      (example.split(';')[0] as string).split('=')[1]?.length ?? 0
    )
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)).toMatchObject({
      client: 'web',
      state: 'open',
      provider: PROVIDER
    })
  })

  it('gives the app no cookie and no login path', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const grant = await open(h, await bearerCaller(h))

    matches(grant.body, examples.reauth_begin_answer_native)
    expect(grant.headers.getSetCookie()).toEqual([])
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)).toMatchObject({ client: 'native', state: 'open' })
  })

  it('keeps the proxy prefix in the login path and the cookie on the root', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const answer = await send(h, alice, '/reauth/begin', {}, { 'x-forwarded-prefix': '/hermes/' })

    expect(answer.body.login_path).toBe(`/hermes/auth/login?provider=${PROVIDER}&reauth=${answer.body.grant_id}`)
    expect(secretOf(answer.headers)).toHaveLength(43)
    expect(answer.headers.getSetCookie()[0]).toContain('Path=/;')
    expect(answer.headers.getSetCookie()[0]).not.toContain('Path=/hermes')
  })

  it('needs an Origin on the level’s own list for a cookie caller', async () => {
    const h = await startPasskeyGateway()
    const answer = await send(h, await cookieCaller(h, ALICE, null), '/reauth/begin', {})

    expect(asExample(answer)).toEqual(examples.error_origin_not_listed)
    expect(h.gateway.passkey()?.refusals().at(-1)).toMatchObject({ surface: 'reauth', reason: 'origin_not_listed' })
  })

  it('refuses a browser that is not on https, and accepts https and a loopback dev host', async () => {
    const lan = 'http://gw.example.invalid'
    const h = await startPasskeyGateway({
      passkey: { baseUrls: [lan, 'http://localhost:9119', 'https://gw.example.invalid'], allowPrivateBaseUrls: true }
    })

    for (const extra of [{}, { 'x-forwarded-proto': 'https' }] as Record<string, string>[]) {
      // A forwarded-proto header does not change what the browser itself is on.
      const answer = await send(h, await cookieCaller(h, ALICE, lan), '/reauth/begin', {}, extra)

      expect(asExample(answer)).toEqual(examples.error_insecure_binding)
      expect(answer.headers.getSetCookie()).toEqual([])
    }

    expect(h.gateway.passkey()?.store.counts().openGrants).toBe(0)

    for (const origin of ['https://gw.example.invalid', 'http://localhost:9119']) {
      expect((await send(h, await cookieCaller(h, ALICE, origin), '/reauth/begin', {})).status, origin).toBe(200)
    }

    // The app has no cookie and no browser: it can still self-enrol where a browser cannot.
    const native = await startPasskeyGateway({ auth: 'native' })

    expect((await open(native, await bearerCaller(native))).kind).toBe('native')
  })

  it('is refused when the operator switched self-enrolment off, or the provider cannot authenticate again', async () => {
    const off = await startPasskeyGateway({ passkey: { selfEnrol: { enabled: false } } })

    expect(asExample(await send(off, await cookieCaller(off, ALICE), '/reauth/begin', {}))).toEqual(
      examples.error_self_enrol_disabled
    )
    expect((await get(off, await cookieCaller(off, ALICE))).body.self_enrol).toEqual(examples.self_enrol_disabled)

    const plain = await startPasskeyGateway({ passkey: { providerReauth: false } })

    expect(asExample(await send(plain, await cookieCaller(plain, ALICE), '/reauth/begin', {}))).toEqual(
      examples.error_provider_no_reauth
    )
    expect((await get(plain, await cookieCaller(plain, ALICE))).body.self_enrol).toEqual(
      examples.self_enrol_provider_no_reauth
    )
    expect(off.gateway.passkey()?.store.counts().openGrants).toBe(0)
    expect(plain.gateway.passkey()?.store.counts().openGrants).toBe(0)
  })

  it('is limited to five a person and five an address in ten minutes', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const answers = []

    for (let i = 0; i < 6; i += 1) {
      answers.push(await send(h, alice, '/reauth/begin', {}))
    }

    expect(answers.map(a => a.status)).toEqual([200, 200, 200, 200, 200, 429])
    expect(asExample(answers[5] as Answer)).toEqual(examples.error_reauth_rate_limited)
    expect(answers[5]?.headers.get('retry-after')).toBe('600')
    // Every caller of this test shares one address: Bob is refused too.
    expect((await send(h, await cookieCaller(h, BOB), '/reauth/begin', {})).status).toBe(429)
    expect(h.gateway.passkey()?.store.counts().openGrants).toBe(5)
  })
})

describe('GET /api/auth/passkeys: self_enrol', () => {
  it('says whether a person can add a passkey by signing in again, and what a cooling-off passkey shows', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)

    expect((await get(h, alice)).body.self_enrol).toEqual(examples.status_self_enrol.self_enrol)

    await selfEnrol(h, alice, SoftAuthenticator.native())
    matches((await get(h, alice)).body, examples.status_self_enrol)

    const cooling = await startPasskeyGateway({ passkey: { selfEnrol: { coolingOffS: 600 } } })
    const bob = await cookieCaller(cooling, BOB)

    expect((await get(cooling, bob)).body.self_enrol).toEqual(examples.status_self_enrol_cooling_off.self_enrol)
    await selfEnrol(cooling, bob, SoftAuthenticator.native())

    const status = await get(cooling, bob)

    matches(status.body, examples.status_self_enrol_cooling_off)
    expect(status.body.credentials[0].usable_from).toBe((cooling.gateway.passkey()?.store.now() ?? 0) + 600)
  })
})

// ── the sign-in ────────────────────────────────────────────────────────────────────────────────

describe('GET /auth/login?reauth= (the web sign-in, simulated)', () => {
  it('completes the grant with a fresh sign-in of the same person, signs them in and sends the browser to next', async () => {
    const h = await startPasskeyGateway()
    const grant = await open(h, await cookieCaller(h, ALICE))
    const response = await signInWeb(h, grant, { next: '/settings/passkeys' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/settings/passkeys')
    expect(response.headers.get('set-cookie')).toMatch(/^hermes_session_at=sess-/u)
    // The binding cookie is the grant's use binding until the spend: the sign-in leaves it alone.
    expect(response.headers.getSetCookie().some(value => value.includes(REAUTH_COOKIE))).toBe(false)

    const state = (await stateOf(h)).passkey.grants[0]

    expect(state).toMatchObject({
      id: grant.id,
      user_id: ALICE.key,
      client: 'web',
      state: 'fresh',
      failure: '',
      auth_time_assumed: false
    })
    expect(JSON.stringify(await stateOf(h))).not.toContain(grant.secret as string)
  })

  it('is refused with a 400 page, before any redirect or cookie, for a browser without the binding cookie', async () => {
    const h = await startPasskeyGateway()
    const grant = await open(h, await cookieCaller(h, ALICE))
    const victim = await cookieFor(h, BOB)

    for (const cookie of [
      victim,
      `${victim}; ${REAUTH_COOKIE}=${'x'.repeat(43)}`,
      `${victim}; hermes_reauth=${grant.secret}`
    ]) {
      const response = await signInWeb(h, grant, { cookie })

      expect(response.status).toBe(400)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.getSetCookie()).toEqual([])
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('expired or was not started here')
    }

    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)?.state).toBe('open')
  })

  it('is refused for a malformed id, a dead grant and a grant another provider asked for, and 404s an unknown provider', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const grant = await open(h, alice)
    const cookie = `${alice.headers.cookie}; ${REAUTH_COOKIE}=${grant.secret}`
    const login = (id: string, provider = PROVIDER) =>
      fetch(`${h.url}/auth/login?${new URLSearchParams({ provider, reauth: id })}`, {
        redirect: 'manual',
        headers: { cookie }
      })

    expect((await login('not-a-grant-id')).status).toBe(400)
    expect((await login(b64u(randomBytes(16)))).status).toBe(400)
    expect((await login(grant.id, 'nobody')).status).toBe(404)
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)?.state).toBe('open')

    await control(h, 'expire', { grants: true })
    expect((await login(grant.id)).status).toBe(400)
  })

  it('stops answering a grant id at an address after twenty refusals, with Retry-After, and only that grant id', async () => {
    const h = await startPasskeyGateway()
    const grant = await open(h, await cookieCaller(h, ALICE))
    const refused = await signInWeb(h, grant, { cookie: await cookieFor(h, BOB) })
    const statuses = [refused.status]
    const refusedPage = examples.sign_in_refused_page as Json

    expect(refused.headers.get('content-type')).toContain(refusedPage.content_type)
    expect(pageText(await refused.text())).toBe(refusedPage.text)

    for (let i = 1; i < 21; i += 1) {
      statuses.push((await signInWeb(h, grant, { cookie: await cookieFor(h, BOB) })).status)
    }

    expect(statuses).toEqual([...Array<number>(20).fill(400), 429])

    // Behind that address the grant is refused for everybody until the window passes, its own browser too;
    // another grant id is not touched by it.
    const limited = await signInWeb(h, grant)
    const limitedPage = examples.sign_in_rate_limited_page as Json

    expect(limited.status).toBe(limitedPage.status)
    expect(limited.headers.get('content-type')).toContain(limitedPage.content_type)
    expect(pageText(await limited.text())).toBe(limitedPage.text)
    // The whole seconds until a slot frees: the window is 600 s, the oldest refusal was just now.
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(590)
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(600)
    expect((await signInWeb(h, await open(h, await cookieCaller(h, BOB)))).status).toBe(302)
  })

  it('ends a spray of random ids in 429 at the per-address ceiling, and a found grant does not use up a slot', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const cookie = await cookieFor(h, BOB)
    const spray = () =>
      fetch(`${h.url}/auth/login?${new URLSearchParams({ provider: PROVIDER, reauth: b64u(randomBytes(16)) })}`, {
        redirect: 'manual',
        headers: { cookie }
      })

    for (let i = 0; i < 199; i += 1) {
      expect((await spray()).status).toBe(400)
    }

    // A check that finds its grant gives its slots back: this one is not the 200th use of the ceiling.
    expect((await signInWeb(h, await open(h, alice))).status).toBe(302)
    expect((await spray()).status).toBe(400) // the 200th refusal
    expect((await signInWeb(h, await open(h, alice))).status).toBe(429) // the ceiling is used up, for every grant

    const limited = await spray()

    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('limits native authorize the same way, with Retry-After', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const { challenge } = pkce()
    const id = b64u(randomBytes(16))
    const attempt = () => fetch(authorizeUrl(h, challenge, { reauth: id }), { redirect: 'manual' })
    const statuses = []

    for (let i = 0; i < 21; i += 1) {
      statuses.push((await attempt()).status)
    }

    expect(statuses).toEqual([...Array<number>(20).fill(400), 429])
    expect(Number((await attempt()).headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('goes back to a plain login when there is no reauth', async () => {
    const h = await startPasskeyGateway()
    const response = await fetch(`${h.url}/auth/login?provider=${PROVIDER}&next=%2Fx`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?next=%2Fx')
  })

  it('never sends the browser to another site', async () => {
    const h = await startPasskeyGateway()

    for (const next of ['https://evil.example/', '//evil.example', 'javascript:alert(1)']) {
      const response = await signInWeb(h, await open(h, await cookieCaller(h, ALICE)), { next })

      expect(response.headers.get('location'), next).toBe('/')
    }
  })

  it('clears the binding cookie at logout', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const logout = await fetch(`${h.url}/auth/logout`, { method: 'POST', redirect: 'manual', headers: alice.headers })
    const cleared = logout.headers.getSetCookie()

    expect(cleared).toContain(examples.reauth_cookie_cleared)
    expect(cleared.some(value => value.startsWith('hermes_session_at=;'))).toBe(true)
  })
})

describe('what the simulated sign-in reports', () => {
  it.each([
    ['provider_mismatch', 'provider_mismatch'],
    ['user_mismatch', 'user_mismatch'],
    ['auth_time_missing', 'auth_time_missing'],
    ['auth_not_fresh', 'auth_not_fresh']
  ])('fails the grant with %s, and the sign-in stands', async (fail, failure) => {
    const h = await startPasskeyGateway()
    const grant = await open(h, await cookieCaller(h, ALICE))

    expect((await control(h, 'reauth', { fail })).body.script).toEqual({ fail, sticky: false })

    const response = await signInWeb(h, grant)

    expect(response.status).toBe(302) // a failed grant never undoes a login
    expect(response.headers.get('set-cookie')).toMatch(/^hermes_session_at=sess-/u)
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)).toMatchObject({ state: 'failed', failure })
    expect(h.gateway.passkey()?.refusals().at(-1)).toMatchObject({ surface: 'reauth', reason: failure })

    // The script served once: the next sign-in is a plain fresh one.
    expect((await stateOf(h)).passkey.reauth_script).toBeNull()
    expect((await signInWeb(h, await open(h, await cookieCaller(h, ALICE)))).status).toBe(302)
  })

  it('signs the browser in as the other person on user_mismatch when the gateway knows them', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const grant = await open(h, alice)

    await control(h, 'reauth', { user: BOB.username })

    const response = await signInWeb(h, grant)
    const session = (response.headers.get('set-cookie') as string).split(';')[0] as string
    const me = (await (await fetch(`${h.url}/api/auth/me`, { headers: { cookie: session } })).json()) as Json

    expect(me.user_id).toBe(BOB.userId)
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)).toMatchObject({
      state: 'failed',
      failure: 'user_mismatch'
    })
  })

  it('takes the facts from an explicit auth_time, applies the skew, and can be sticky', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const store = h.gateway.passkey()?.store
    const now = store?.now() ?? 0

    await control(h, 'reauth', { auth_time: now - 100, sticky: true })

    const inside = await open(h, alice)

    await signInWeb(h, inside)
    expect(store?.grant(inside.id, ALICE.key)).toMatchObject({ state: 'fresh' }) // inside the 120 s skew

    await control(h, 'reauth', { auth_time: now - 121, sticky: true })

    const outside = await open(h, alice)

    await signInWeb(h, outside)
    expect(store?.grant(outside.id, ALICE.key)).toMatchObject({ state: 'failed', failure: 'auth_not_fresh' })
    expect((await stateOf(h)).passkey.reauth_script).toMatchObject({ sticky: true }) // still there

    expect((await control(h, 'reauth', {})).body.script).toBeNull()
    expect((await stateOf(h)).passkey.reauth_script).toBeNull()
  })

  it('counts a missing auth_time as fresh, marked assumed, when the operator accepts it', async () => {
    const h = await startPasskeyGateway({ passkey: { selfEnrol: { acceptMissingAuthTime: true } } })
    const grant = await open(h, await cookieCaller(h, ALICE))

    await control(h, 'reauth', { fail: 'auth_time_missing' })
    await signInWeb(h, grant)
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)).toMatchObject({
      state: 'fresh',
      authTimeAssumed: true,
      authTime: 0
    })

    // It excuses a missing time only, never an old one.
    const old = await open(h, await cookieCaller(h, ALICE))

    await control(h, 'reauth', { fail: 'auth_not_fresh' })
    await signInWeb(h, old)
    expect(h.gateway.passkey()?.store.grant(old.id, ALICE.key)).toMatchObject({
      state: 'failed',
      failure: 'auth_not_fresh'
    })
  })

  it('refuses a script it cannot play', async () => {
    const h = await startPasskeyGateway()

    for (const body of [
      { fail: 'nope' },
      { fail: 7 },
      { auth_time: 'now' },
      { auth_time: -1 },
      { auth_time: 1.5 },
      { user: 7 },
      { provider: '' }
    ]) {
      expect((await control(h, 'reauth', body)).status, JSON.stringify(body)).toBe(400)
    }

    expect((await control(h, 'reauth', { auth_time: null })).body.script).toEqual({ auth_time: null, sticky: false })
  })

  it('answers 409 until the gateway knows the level', async () => {
    const h = await startPasskeyGateway({ passkey: false })

    expect((await control(h, 'reauth', { fail: 'user_mismatch' })).status).toBe(409)
  })
})

describe('the native sign-in (authorize and token with reauth)', () => {
  it('returns the grant state and a one-time use_secret, and no tokens', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const grant = await open(h, await bearerCaller(h))
    const exchanges = h.gateway.state.tokenExchanges
    const token = await signInNative(h, grant, { provider: PROVIDER })

    expect(token.status).toBe(200)
    matches(token.body, examples.native_token_reauth_fresh)
    expect(token.body.reauth).toMatchObject({ grant_id: grant.id, state: 'fresh', expires_at: grant.body.expires_at })
    expect(b64uDecode(token.body.reauth.use_secret)).toHaveLength(32)
    expect(JSON.stringify(token.body)).not.toMatch(/access_token|refresh_token/u)
    expect(h.gateway.state.tokenExchanges).toBe(exchanges) // the app's own token set is untouched
    expect(JSON.stringify(await stateOf(h))).not.toContain(token.body.reauth.use_secret)
  })

  it('names the provider from the grant when authorize names none', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const grant = await open(h, await bearerCaller(h))

    expect((await signInNative(h, grant)).body.reauth.state).toBe('fresh')
  })

  it.each(['provider_mismatch', 'user_mismatch', 'auth_time_missing', 'auth_not_fresh'])(
    'reports %s as a failed grant, without use_secret',
    async fail => {
      const h = await startPasskeyGateway({ auth: 'native' })
      const grant = await open(h, await bearerCaller(h))

      await control(h, 'reauth', { fail })

      const token = await signInNative(h, grant)

      expect(token.body).toEqual({
        reauth: { grant_id: grant.id, state: 'failed', reason: fail, expires_at: grant.body.expires_at }
      })
    }
  )

  it('shows the example for a stale sign-in', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const grant = await open(h, await bearerCaller(h))

    await control(h, 'reauth', { fail: 'auth_not_fresh' })
    matches((await signInNative(h, grant)).body, examples.native_token_reauth_failed)
  })

  it('refuses the code without the app’s verifier, and a second redemption', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const grant = await open(h, await bearerCaller(h))
    const { challenge } = pkce()
    const authorize = await fetch(authorizeUrl(h, challenge, { reauth: grant.id }), { redirect: 'manual' })
    const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code')

    expect((await post(`${h.url}/auth/native/token`, { code, code_verifier: 'not-the-verifier' })).status).toBe(400)
    // The code is gone, and the grant is still open for another try.
    expect((await post(`${h.url}/auth/native/token`, { code, code_verifier: 'x' })).status).toBe(400)
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)?.state).toBe('open')
  })

  it('refuses authorize with a bad grant before any code is issued', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const bearer = await bearerCaller(h)
    const grant = await open(h, bearer)
    const { challenge } = pkce()
    const attempt = (reauth: string, extra: Record<string, string> = {}) =>
      fetch(authorizeUrl(h, challenge, { reauth, ...extra }), { redirect: 'manual' })

    for (const response of [await attempt('nope'), await attempt(b64u(randomBytes(16)))]) {
      expect(response.status).toBe(400)
      expect(response.headers.get('location')).toBeNull()
      expect(await response.text()).toContain('expired or was not started here')
    }

    expect((await attempt(grant.id, { provider: 'nobody' })).status).toBe(404)

    // A web grant is not a native one.
    const web = await startPasskeyGateway()
    const webGrant = await open(web, await cookieCaller(web, ALICE))

    expect((await fetch(authorizeUrl(web, challenge, { reauth: webGrant.id }), { redirect: 'manual' })).status).toBe(
      400
    )

    await control(h, 'expire', { grants: true })
    expect((await attempt(grant.id)).status).toBe(400)
  })

  it('still signs the app in with tokens when there is no reauth', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })

    expect(await bearerFor(h)).toMatch(/^Bearer at-/u)
    expect(h.gateway.state.tokenExchanges).toBe(1)
  })
})

// ── registering with a grant ───────────────────────────────────────────────────────────────────

describe.each(['web', 'native'] as const)('enrolling with a fresh grant (%s)', kind => {
  const start = async () => {
    const h = await startPasskeyGateway(kind === 'native' ? { auth: 'native' } : {})
    const caller = kind === 'native' ? await bearerCaller(h) : await cookieCaller(h, ALICE)

    return { h, caller }
  }

  it('enrols, marks the passkey self, clears the binding and announces it to the person’s connections', async () => {
    const { h, caller } = await start()
    const headers = kind === 'native' ? { authorization: caller.headers.authorization as string } : caller.headers
    const alice = await connect(h, headers)
    const bob = kind === 'web' ? await connect(h, { cookie: await cookieFor(h, BOB) }) : null
    const grant = await fresh(h, caller)
    const auth = SoftAuthenticator.native()
    const opened = await begin(h, grant, auth)

    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    matches(opened.body, examples.register_begin_answer_with_grant)
    expect(opened.body.grant).toEqual({ expires_at: grant.body.expires_at })

    const done = await finish(h, grant, finishBody(auth, opened.body))

    expect(done.status, JSON.stringify(done.body)).toBe(200)
    matches(done.body, examples.register_finish_answer_self)
    expect(done.body.credential.created_via).toBe('self')

    const cleared = done.headers.getSetCookie()

    expect(cleared.length).toBe(kind === 'web' ? 1 : 0)

    if (kind === 'web') {
      expect(cleared[0]).toBe(examples.reauth_cookie_cleared)
    }

    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)).toMatchObject({ state: 'spent' })
    await until('passkey.changed', () => alice.events('passkey.changed').length === 1)
    expect(alice.events('passkey.changed')[0]?.params?.payload).toMatchObject({
      change: 'added',
      credential: { id: auth.id }
    })
    expect(bob?.events('passkey.changed') ?? []).toEqual([])
    expect((await stateOf(h)).passkey.credentials[0]).toMatchObject({ created_via: 'self', usable_from: null })
    expect((await stateOf(h)).passkey.grants[0]).toMatchObject({ state: 'spent', credential_id: auth.id })
  })

  it('may repeat begin with the same grant while it is unspent, and spends it once', async () => {
    const { h, caller } = await start()
    const grant = await fresh(h, caller)
    const first = SoftAuthenticator.native()
    const second = SoftAuthenticator.native()
    const a = await begin(h, grant, first)
    const b = await begin(h, grant, second)

    expect([a.status, b.status]).toEqual([200, 200])
    expect((await finish(h, grant, finishBody(second, b.body))).status).toBe(200)

    const again = await finish(h, grant, finishBody(first, a.body))

    expect([again.status, again.body.error, again.body.reason]).toEqual([403, 'reauth_invalid', 'spent'])
    expect((await get(h, caller)).body.credentials).toHaveLength(1)
  })

  it('takes exactly one of code and grant_id', async () => {
    const { h, caller } = await start()
    const grant = await fresh(h, caller)
    const auth = SoftAuthenticator.native()
    const opened = await begin(h, grant, auth)
    const body = finishBody(auth, opened.body)
    const code = await operatorCode(h, ALICE)
    const binding = kind === 'native' ? { use_secret: grant.secret } : {}
    const post = (sent: Record<string, unknown>) => send(h, caller, '/register/finish', sent, withBinding(grant))

    expect(asExample(await post({ ...body, ...binding, grant_id: grant.id, code }))).toEqual(
      examples.error_exactly_one_authority
    )
    expect(asExample(await post({ ...body, ...binding }))).toEqual(examples.error_exactly_one_authority)

    for (const bad of [
      { ...body, code: 7 },
      { ...body, ...binding, grant_id: 7 },
      { ...body, ...binding, grant_id: '' },
      { ...body, ...binding, grant_id: 'g'.repeat(65) },
      ...(kind === 'native' ? [{ ...body, grant_id: grant.id, use_secret: 7 }] : [])
    ]) {
      const answer = await post(bad)

      expect([answer.status, answer.body.error], JSON.stringify(bad)).toEqual([400, 'bad_request'])
    }

    expect((await get(h, caller)).body.credentials).toEqual([])
    expect((await finish(h, grant, body)).status).toBe(200)
  })

  it('refuses a thief with the session and the grant id but not the binding, at begin and at finish', async () => {
    const { h, caller } = await start()
    const grant = await fresh(h, caller)
    const thief = SoftAuthenticator.native()

    for (const wrong of [null, 'x'.repeat(43)]) {
      const headers = kind === 'web' ? withBinding(grant, wrong) : {}
      const extra = kind === 'native' && wrong ? { use_secret: wrong } : {}
      const opened = await send(
        h,
        caller,
        '/register/begin',
        { rp_id: thief.rpId, base_url: h.url, name: 'Thief', grant_id: grant.id, ...extra },
        headers
      )

      expect([opened.status, opened.body.reason], String(wrong)).toEqual([403, 'unknown'])

      // A registration opened without the grant cannot borrow it either.
      const plain = await send(h, caller, '/register/begin', { rp_id: thief.rpId, base_url: h.url, name: 'Thief' })
      const sent = await send(
        h,
        caller,
        '/register/finish',
        { ...finishBody(thief, plain.body), grant_id: grant.id, ...extra },
        headers
      )

      expect([sent.status, sent.body.reason], String(wrong)).toEqual([403, 'unknown'])
    }

    expect((await get(h, caller)).body.credentials).toEqual([])
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)?.state).toBe('fresh')

    const own = SoftAuthenticator.native()
    const opened = await begin(h, grant, own)

    expect((await finish(h, grant, finishBody(own, opened.body))).status).toBe(200)
  })

  it.each(['open', 'expired', 'spent', 'failed', 'unknown', ...(kind === 'web' ? ['other_user'] : [])])(
    'refuses a grant that cannot authorise (%s) with reauth_invalid at begin and at finish',
    async state => {
      const { h, caller } = await start()
      const auth = SoftAuthenticator.native()
      let grant: Grant
      let who: Caller = caller
      let expected: [string, string | undefined] = ['unknown', undefined]

      if (state === 'unknown') {
        grant = { ...(await open(h, caller)), id: b64u(randomBytes(16)) }
      } else if (state === 'open') {
        grant = await open(h, caller)
        // A browser holding the cookie learns it is still open; the app has no use_secret yet.
        expected = kind === 'web' ? ['not_fresh', undefined] : ['unknown', undefined]
      } else if (state === 'failed') {
        grant = await open(h, caller)
        await control(h, 'reauth', { fail: 'auth_not_fresh' })

        if (kind === 'web') {
          await signInWeb(h, grant)
          expected = ['failed', 'auth_not_fresh']
        } else {
          // The app learns why from the token answer; it gets no use_secret, so here the grant is unknown.
          await signInNative(h, grant)
        }
      } else {
        grant = await fresh(h, caller)
      }

      if (state === 'expired') {
        await control(h, 'expire', { grants: true })
      } else if (state === 'other_user') {
        who = await cookieCaller(h, BOB) // Bob's session with Alice's cookie secret
      } else if (state === 'spent') {
        const own = SoftAuthenticator.native()
        const opened = await begin(h, grant, own)

        expect((await finish(h, grant, finishBody(own, opened.body))).status).toBe(200)
        expected = ['spent', undefined]
      }

      const as: Grant = { ...grant, caller: who }
      const opened = await begin(h, as, auth)

      expect([opened.status, opened.body.error, opened.body.reason, opened.body.failure]).toEqual([
        403,
        'reauth_invalid',
        expected[0],
        expected[1]
      ])

      // Finish re-checks it: a registration opened without the grant cannot borrow it.
      const registration = await send(h, who, '/register/begin', { rp_id: auth.rpId, base_url: h.url, name: 'Laptop' })
      const sent = await finish(h, as, finishBody(auth, registration.body))

      expect([sent.status, sent.body.error, sent.body.reason, sent.body.failure]).toEqual([
        403,
        'reauth_invalid',
        expected[0],
        expected[1]
      ])
      expect((await get(h, who)).body.credentials).toHaveLength(state === 'spent' ? 1 : 0)
    }
  )

  it('counts a refused grant at finish like a wrong enrolment code', async () => {
    const { h, caller } = await start()
    const grant = await open(h, caller) // never completed
    const auth = SoftAuthenticator.native()
    const registration = await send(h, caller, '/register/begin', { rp_id: auth.rpId, base_url: h.url, name: 'Laptop' })
    const statuses = []

    for (let i = 0; i < 6; i += 1) {
      statuses.push((await finish(h, grant, finishBody(auth, registration.body))).status)
    }

    expect(statuses).toEqual([403, 403, 403, 403, 403, 429])
  })

  it('refuses a grant opened before the operator switched self-enrolment off', async () => {
    const { h, caller } = await start()
    const grant = await fresh(h, caller)
    const auth = SoftAuthenticator.native()
    const registration = await send(h, caller, '/register/begin', { rp_id: auth.rpId, base_url: h.url, name: 'Laptop' })

    await control(h, 'enable', { self_enrol: { enabled: false } })

    expect(asExample(await begin(h, grant, auth))).toEqual(examples.error_self_enrol_disabled)
    expect(asExample(await finish(h, grant, finishBody(auth, registration.body)))).toEqual(
      examples.error_self_enrol_disabled
    )
    // The codes are unaffected.
    expect(
      (
        await send(h, caller, '/register/finish', {
          ...finishBody(auth, registration.body),
          code: await operatorCode(h, ALICE)
        })
      ).status
    ).toBe(200)
  })

  it('refuses the registration of the wrong RP before it looks at the grant, like any other', async () => {
    const { h, caller } = await start()
    const grant = await fresh(h, caller)
    const answer = await send(
      h,
      caller,
      '/register/begin',
      { rp_id: 'other.example', base_url: h.url, name: 'Laptop', grant_id: grant.id },
      withBinding(grant)
    )

    expect([answer.status, answer.body.reason]).toEqual([400, 'rp_not_accepted'])
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)?.state).toBe('fresh')
  })
})

describe('the store’s binding rules', () => {
  const secret = b64u(randomBytes(32))
  const openGrant = (store: PasskeyStore, client: 'web' | 'native') =>
    store.openGrant('p:u', 'p', client, client === 'web' ? reauthSecretHash(secret) : null)
  const complete = (store: PasskeyStore, id: string, client: 'web' | 'native', extra: Record<string, unknown> = {}) =>
    store.completeGrant(id, {
      sessionUser: 'p:u',
      sessionProvider: 'p',
      authTime: store.now(),
      client,
      secret: client === 'web' ? secret : null,
      useSecretHash: client === 'native' ? reauthSecretHash('use') : null,
      ...extra
    })

  it('starts a web sign-in only with the cookie secret and a native one only without a secret', () => {
    const store = new PasskeyStore()
    const web = openGrant(store, 'web')
    const native = openGrant(store, 'native')

    expect(store.grantForLogin(web.id, 'p', null)).toBeUndefined()
    expect(store.grantForLogin(web.id, 'p', 'x')).toBeUndefined()
    expect(store.grantForLogin(web.id, 'q', secret)).toBeUndefined()
    expect(store.grantForLogin(web.id, 'p', secret)?.id).toBe(web.id)
    expect(store.grantForLogin(native.id, 'p', null)?.id).toBe(native.id)
    expect(store.grantForLogin(native.id, 'p', 'anything')).toBeUndefined()
  })

  it('completes a grant once, and only over the kind of client that opened it, with its secret', () => {
    const store = new PasskeyStore()
    const web = openGrant(store, 'web')
    const native = openGrant(store, 'native')

    for (const attempt of [
      () => complete(store, web.id, 'native'),
      () => complete(store, native.id, 'web'),
      () => complete(store, web.id, 'web', { secret: 'x' }),
      () => complete(store, web.id, 'web', { secret: null }),
      () => complete(store, b64u(randomBytes(16)), 'web')
    ]) {
      expect(attempt).toThrow(expect.objectContaining({ reason: 'unknown' }))
    }

    // Nothing above changed anything.
    expect(store.grant(web.id, 'p:u')?.state).toBe('open')
    expect(complete(store, web.id, 'web').state).toBe('fresh')
    expect(() => complete(store, web.id, 'web')).toThrow(
      expect.objectContaining({ reason: 'not_open', state: 'fresh' })
    )
    expect(() => complete(store, native.id, 'native', { useSecretHash: null })).toThrow(Error)
  })

  it('lets only the use binding spend a fresh grant: the cookie secret, or the native use secret', () => {
    const store = new PasskeyStore()
    const web = openGrant(store, 'web')
    const native = openGrant(store, 'native')

    complete(store, web.id, 'web')
    complete(store, native.id, 'native')

    expect(store.freshGrant(web.id, { userId: 'p:u', secret }).state).toBe('fresh')
    expect(store.freshGrant(native.id, { userId: 'p:u', secret: 'use' }).state).toBe('fresh')

    for (const [id, given, user] of [
      [web.id, null, 'p:u'],
      [web.id, 'use', 'p:u'],
      [native.id, null, 'p:u'],
      [native.id, secret, 'p:u'],
      [web.id, secret, 'p:other']
    ] as const) {
      expect(() => store.freshGrant(id, { userId: user, secret: given })).toThrow(
        expect.objectContaining({ reason: 'unknown' })
      )
    }
  })

  it('keeps a failed grant failed, with its failure, and gives a native one no use secret', () => {
    const store = new PasskeyStore()
    const web = openGrant(store, 'web')
    const native = openGrant(store, 'native')

    expect(complete(store, web.id, 'web', { sessionUser: 'p:other' })).toMatchObject({
      state: 'failed',
      failure: 'user_mismatch'
    })
    expect(complete(store, native.id, 'native', { authTime: 0 })).toMatchObject({
      state: 'failed',
      failure: 'auth_time_missing'
    })
    expect(() => store.freshGrant(web.id, { userId: 'p:u', secret })).toThrow(
      expect.objectContaining({ reason: 'failed', failure: 'user_mismatch' })
    )
    expect(() => store.freshGrant(native.id, { userId: 'p:u', secret: 'use' })).toThrow(
      expect.objectContaining({ reason: 'unknown' })
    )
  })
})

// ── cooling-off ────────────────────────────────────────────────────────────────────────────────

describe('cooling-off', () => {
  it('lists the passkey with usable_from but gives it no confirm, no step-up, and lets another revoke it', async () => {
    const h = await startPasskeyGateway({ passkey: { selfEnrol: { coolingOffS: 600 } } })
    const alice = await cookieCaller(h, ALICE)
    const store = h.gateway.passkey()?.store
    const laptop = SoftAuthenticator.native()
    const credential = await selfEnrol(h, alice, laptop)

    expect(credential.usable_from).toBe((store?.now() ?? 0) + 600)
    expect((await get(h, alice)).body.credentials.map((c: Json) => c.usable_from)).toEqual([credential.usable_from])
    expect(store?.snapshot(ALICE.key)).toEqual([])
    expect(store?.counts().coolingOff).toBe(1)

    // With only a cooling-off passkey there is nothing to step up with.
    const refused = await send(h, alice, '/stepup/begin', { purpose: 'invite' })

    expect([refused.status, refused.body.reason]).toEqual([400, 'not_enrolled'])

    // A usable passkey (from a code) is the only signer.
    const phone = SoftAuthenticator.native()
    const phoneOpened = await send(h, alice, '/register/begin', { rp_id: phone.rpId, base_url: h.url, name: 'Phone' })
    const phoneDone = await send(h, alice, '/register/finish', {
      ...finishBody(phone, phoneOpened.body),
      code: await operatorCode(h, ALICE)
    })

    expect(phoneDone.status).toBe(200)
    expect(phoneDone.body.credential.usable_from).toBeUndefined()

    const stepup = await send(h, alice, '/stepup/begin', { purpose: 'revoke', subject: credential.id })

    expect(stepup.body.credentials).toEqual([{ rp_id: phone.rpId, ids: [phone.id] }])

    const status = (await get(h, alice)).body
    const signed = phone.assert({
      baseUrl: h.url,
      gatewayId: b64uDecode(status.gateway_id),
      userId: ALICE.key,
      requestId: stepup.body.stepup_id,
      nonce: b64uDecode(stepup.body.nonce),
      title: '',
      summary: credential.id,
      detail: '',
      purpose: 'revoke',
      userHandle: status.user.handle
    }).passkey
    const revoked = await send(h, alice, '/revoke', {
      credential_id: credential.id,
      stepup_id: stepup.body.stepup_id,
      assertion: signed
    })

    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
    expect((await get(h, alice)).body.credentials.map((c: Json) => c.id)).toEqual([phone.id])
  })

  it('does not let the cooling-off passkey sign a step-up', async () => {
    const h = await startPasskeyGateway({ passkey: { selfEnrol: { coolingOffS: 600 } } })
    const alice = await cookieCaller(h, ALICE)
    const laptop = SoftAuthenticator.native()

    await selfEnrol(h, alice, laptop)

    const phone = SoftAuthenticator.native()
    const opened = await send(h, alice, '/register/begin', { rp_id: phone.rpId, base_url: h.url, name: 'Phone' })

    await send(h, alice, '/register/finish', { ...finishBody(phone, opened.body), code: await operatorCode(h, ALICE) })

    const stepup = await send(h, alice, '/stepup/begin', { purpose: 'invite' })
    const status = (await get(h, alice)).body
    const signed = laptop.assert({
      baseUrl: h.url,
      gatewayId: b64uDecode(status.gateway_id),
      userId: ALICE.key,
      requestId: stepup.body.stepup_id,
      nonce: b64uDecode(stepup.body.nonce),
      title: '',
      summary: 'invite',
      detail: '',
      purpose: 'invite',
      userHandle: status.user.handle
    }).passkey
    const refused = await send(h, alice, '/invites', { stepup_id: stepup.body.stepup_id, assertion: signed })

    expect([refused.status, refused.body.error, refused.body.reason]).toEqual([
      422,
      'assertion_invalid',
      'unknown_credential'
    ])
  })
})

// ── the control surface ────────────────────────────────────────────────────────────────────────

describe('control: enable and expire', () => {
  it('sets the self_enrol switches and the provider at run time, and refuses what it cannot', async () => {
    const h = await startPasskeyGateway()
    const changed = await control(h, 'enable', {
      self_enrol: { enabled: true, accept_missing_auth_time: true, cooling_off_s: 90 },
      provider_reauth: false
    })

    expect(changed.body).toMatchObject({
      self_enrol: { enabled: true, accept_missing_auth_time: true, cooling_off_s: 90 },
      provider_reauth: false
    })

    for (const self_enrol of [
      'yes',
      [],
      { enabled: 'no' },
      { accept_missing_auth_time: 1 },
      { cooling_off_s: -1 },
      { cooling_off_s: 1.5 },
      { cooling_off_s: 8 * 24 * 3600 }
    ]) {
      const refused = await control(h, 'enable', { self_enrol })

      expect(refused.status, JSON.stringify(self_enrol)).toBe(400)
      expect(refused.body.detail).toContain('self_enrol')
    }

    // Nothing was changed by a refusal.
    expect((await stateOf(h)).passkey.self_enrol).toEqual({
      enabled: true,
      accept_missing_auth_time: true,
      cooling_off_s: 90
    })
  })

  it('ends open grants, and only those, with expire { grants: true }', async () => {
    const h = await startPasskeyGateway()
    const grant = await open(h, await cookieCaller(h, ALICE))

    expect((await control(h, 'expire', { grants: true })).body).toEqual({ grants: 1 })
    expect(h.gateway.passkey()?.store.grant(grant.id, ALICE.key)).toBeUndefined()
    expect((await signInWeb(h, grant)).status).toBe(400)
  })
})

// ── the contract ───────────────────────────────────────────────────────────────────────────────

describe('the contract’s wire examples', () => {
  it('describe the requests a client sends', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const grant = await fresh(h, await bearerCaller(h))
    const auth = SoftAuthenticator.native()
    const opened = await begin(h, grant, auth)

    expect(Object.keys(examples.register_begin_request_with_grant_native).sort()).toEqual(
      ['base_url', 'grant_id', 'name', 'rp_id', 'use_secret'].sort()
    )
    expect(Object.keys(examples.register_begin_request_with_grant_web).sort()).toEqual(
      ['base_url', 'grant_id', 'name', 'rp_id'].sort()
    )
    expect(Object.keys(examples.register_finish_request_with_grant_native).sort()).toEqual(
      [...Object.keys(finishBody(auth, opened.body)), 'grant_id', 'use_secret'].sort()
    )
    expect(Object.keys(examples.register_finish_request_with_grant_web).sort()).toEqual(
      [...Object.keys(finishBody(auth, opened.body)), 'grant_id'].sort()
    )
  })

  it('has the reauth failures in the order the fake judges them', () => {
    expect(vectors.reauth_failure_order).toEqual([
      'provider_mismatch',
      'user_mismatch',
      'auth_time_missing',
      'auth_not_fresh'
    ])
  })
})
