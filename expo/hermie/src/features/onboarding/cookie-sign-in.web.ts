/**
 * Starting and ending the gateway's cookie session, from the page it serves.
 *
 * Two doors, both the gateway's own:
 *
 *  - **`GET /auth/login?provider=<name>&next=/`** is the OAuth door. It is a
 *    FULL-PAGE navigation, not a fetch, and it has to be: the chain ends at an
 *    identity provider on another origin, which sets its own cookies and
 *    redirects back to `/auth/callback`, and nothing about that survives being
 *    read with `fetch`. The app is reloaded from scratch when it returns, which
 *    is why the wizard's only durable state is the cookie itself.
 *    A provider that `supports_password` makes this route redirect to the
 *    gateway's own `/login` page instead, so this door works for both kinds —
 *    it is simply a worse experience for the password kind, which is what
 *    `passwordLogin` below is for.
 *  - **`POST /auth/password-login`** is the in-page door for password
 *    providers. It answers `{ok: true, next}` and sets the session cookies on
 *    that response, so the app never leaves the SPA and never sees a password
 *    again after the field is cleared.
 *
 * `next` is validated by the gateway against its own allow-list of in-app
 * targets, so a value it dislikes comes back as the root rather than as an open
 * redirect.
 *
 * ## Where `next` comes from, and why it is not simply `/`
 *
 * The gateway builds the IdP's callback out of its own `dashboard.public_url`
 * and nothing else, so the last redirect of the chain arrives THERE — and
 * `next` is relative, so it is resolved against that host and port, not against
 * this page. Where Hermie Web shares the origin, that is the same place and `/`
 * is right. Where it answers on another port of the same host — which
 * [ADR-0015](../../../../../docs/adr/0015-web-variant-on-its-own-port.md) is the
 * reason for, since a cookie ignores the port but the callback does not — the
 * browser would finish a successful sign-in on the gateway's dashboard instead
 * of in the app. The operator puts a redirect back to Hermie Web at some path
 * on the gateway's host and names it with `--login-return`; this module asks
 * `/hermie/config.json` for it rather than guessing.
 */
import { GatewayError } from '@hermie/gateway-client'

import { loadHermieWebConfig } from '../../gateway/web-config'

export interface PasswordLoginInput {
  baseUrl: string
  provider: string
  username: string
  password: string
  next?: string
}

export const COOKIE_SIGN_IN_AVAILABLE = true

/** The landing path when nothing else is known, and the answer to anything unsafe. */
export const DEFAULT_LOGIN_RETURN = '/'

/**
 * How long to wait for `/hermie/config.json` before signing in anyway.
 *
 * The fetch is same-origin, tiny, and usually already resolved — the sign-in
 * step asks for it on mount. But it is on the path of a button press now, and a
 * button that does nothing while a request hangs is worse than one that lands
 * the user on the root.
 */
const CONFIG_WAIT_MS = 2_000

/**
 * A path on this origin, or the root.
 *
 * `loginReturn` arrives from the server this page came from, so this is not a
 * trust boundary — it is the same check the server already made, kept here so a
 * hand-edited or stale answer cannot turn the sign-in button into a link to
 * somewhere else. `//host` and `/\host` both read as a host to a browser.
 */
export function sameOriginPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') {
    return DEFAULT_LOGIN_RETURN
  }

  const trimmed = raw.trim()

  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || /[\s\\]/.test(trimmed)) {
    return DEFAULT_LOGIN_RETURN
  }

  return trimmed
}

/**
 * The gateway's OAuth door, with the provider and the landing path on it.
 *
 * `next === ''` sends no `next=` at all: what a Hermie Web under `--pass-host`
 * asks for, since the callback lands on this origin and the gateway's own
 * default is already the root.
 */
export function buildCookieSignInUrl(baseUrl: string, provider: string | undefined, next: string): string {
  const url = new URL('/auth/login', baseUrl)

  if (provider) {
    url.searchParams.set('provider', provider)
  }

  if (next !== '') {
    url.searchParams.set('next', sameOriginPath(next))
  }

  return url.toString()
}

/**
 * The `next` to sign in with: what the caller asked for, else what the server
 * configured, else the root. `''` when the server configured none on purpose
 * (`loginReturn: ''`), which `buildCookieSignInUrl` reads as "no `next=`".
 */
export async function loginReturnPath(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    return sameOriginPath(explicit)
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const config = await Promise.race([
      loadHermieWebConfig(),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), CONFIG_WAIT_MS)
      })
    ])

    // An empty answer from a server that sent one is a decision (`--pass-host`
    // needs no next=); no answer at all still falls back to the root.
    return config && config.loginReturn === '' ? '' : sameOriginPath(config?.loginReturn)
  } finally {
    // The race is over either way, and a timer nobody is waiting for still
    // holds the event loop open — which a test runner notices before a user does.
    clearTimeout(timer)
  }
}

export function startCookieSignIn(baseUrl: string, provider?: string, next?: string): void {
  // Deliberately not awaited by the caller: this ends in a full-page navigation,
  // so there is nothing left to tell it.
  void loginReturnPath(next).then(target => {
    window.location.assign(buildCookieSignInUrl(baseUrl, provider, target))
  })
}

/**
 * Reload at the app's own root, for reauth when the OAuth door is off.
 *
 * `--no-oidc` (`HERMIE_OIDC=0`) refuses `/auth/login` outright, whatever
 * provider it names — see `server.ts`'s handling of the flag — so a stored
 * cookie session that needs reauth cannot use `startCookieSignIn` at all on
 * such a deployment. It does not need to: `SignInStep.web` never lets sign-in
 * finish through anything but a password provider while OIDC is off, so a
 * fresh load of `/` finds no session, same as any other signed-out visit, and
 * draws that password form again — reaching it without ever asking the OAuth
 * door for anything.
 */
export function reauthAtAppRoot(): void {
  window.location.assign('/')
}

export async function passwordLogin(input: PasswordLoginInput): Promise<string> {
  const response = await fetch(new URL('/auth/password-login', input.baseUrl).toString(), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      provider: input.provider,
      username: input.username,
      password: input.password,
      next: input.next ?? '/'
    })
  })

  if (response.status === 401) {
    throw new GatewayError('auth', 'That user name and password were not accepted.', { status: 401 })
  }

  if (response.status === 429) {
    throw new GatewayError('auth', 'Too many sign-in attempts. Wait a moment and try again.', { status: 429 })
  }

  if (response.status === 404) {
    throw new GatewayError('config', 'This gateway has no password provider by that name.', { status: 404 })
  }

  if (!response.ok) {
    throw new GatewayError('server', `The gateway answered HTTP ${response.status} to the sign-in.`, {
      status: response.status
    })
  }

  const body = (await response.json()) as { ok?: boolean; next?: string }

  if (body.ok !== true) {
    throw new GatewayError('protocol', 'The gateway answered the sign-in without an outcome.')
  }

  return typeof body.next === 'string' && body.next ? body.next : '/'
}
