/**
 * Everything Hermie Web can be told, and what it decides when it is told
 * nothing.
 *
 * One rule runs through all of it: **the gateway is fixed at startup.** There
 * is no path, header or query parameter that can point the proxy somewhere
 * else, because an HTTP proxy a browser can steer is an open proxy, and an open
 * proxy on a machine that can reach `127.0.0.1` is a way into everything else
 * running there.
 */
import { hostname } from 'node:os'
import path from 'node:path'

import { decodeLocalSecret, type LocalSecretHash } from './admin/access'
import { DEFAULT_CACHE_MAX_MB } from './cache'
import { RELAY_DEFAULT_ORIGIN } from './push/relay'
import { relayOriginOf } from './push/registrations'
import { defaultStateDir } from './push/state'

export interface HermieWebOptions {
  /** The gateway to proxy to. Fixed for the life of the process. */
  gatewayUrl: string
  /**
   * Did anybody actually CHOOSE that gateway?
   *
   * `gatewayUrl` always has a value, because the default is the port
   * `hermes serve` listens on — which is right often enough to be the default
   * and is still a guess. This is the difference between the guess and a
   * decision: a flag, an environment variable, or a setup an operator saved
   * through `/setup`.
   *
   * It decides one thing only: whether the operator setup page of
   * [ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md) is
   * served or answers 404. The gateway is still fixed at process start — there
   * is one transition, from unconfigured to configured, and no route back.
   */
  gatewayConfigured: boolean
  port: number
  host: string
  /**
   * The host the GATEWAY believes it is served on — its `dashboard.public_url`.
   *
   * Proxied requests carry this in `Host` and `Origin`, because the gateway
   * refuses an upgrade whose `Host` is not a host it knows (DNS-rebinding
   * guard) and refuses an `Origin` that does not match it either. What a
   * browser sends is Hermie Web's own address, which the gateway has never
   * heard of, so it has to be rewritten rather than forwarded.
   */
  publicUrl: string
  /**
   * Hermie Web's OWN public origin — the address a browser types to reach this
   * service, e.g. `https://app.example.com` (`--web-public-url` /
   * `HERMIE_WEB_PUBLIC_URL`). `''` when unset.
   *
   * Deliberately a second option rather than a new meaning for `publicUrl`:
   * that one is, and stays, the GATEWAY's own `dashboard.public_url`, which
   * `--pass-host` still needs — for the fallback when the gateway turns the
   * pass-through down, for the probe, and for everything that names the
   * gateway (`gatewayHost` in `/hermie/config.json`, the built-in issuer's
   * redirect URI). Giving `--public-url` a second meaning under a switch
   * would silently change what every existing deployment sends.
   */
  webPublicUrl: string
  /**
   * Send the gateway Hermie Web's own origin instead of rewriting to the
   * gateway's (`--pass-host` / `HERMIE_PASS_HOST`, off by default).
   *
   * For a gateway that lists this origin in `dashboard.public_urls` (the
   * fullstackstudio-org fork): `Host` becomes `webPublicUrl`'s host, and the
   * browser's own `Origin` and `Referer` pass through untouched, so the
   * gateway sees the origin the browser is really on — and builds the OIDC
   * `redirect_uri` on it, so sign-in finishes HERE rather than on the
   * gateway's own host. Needs `webPublicUrl`. See `server.ts`'s startup
   * check for the fallback when the gateway does not list the origin.
   */
  passHost: boolean
  /**
   * The path the gateway sends the browser to once a sign-in finishes.
   *
   * The app puts it in `next=` on `/auth/login`, and the gateway hands it back
   * as a RELATIVE redirect from `/auth/callback` — which is on
   * `dashboard.public_url`, not here. So on a deployment where Hermie Web sits
   * on a different port of that same host, the browser lands on the gateway
   * rather than on the app, and this is the path an operator points back at
   * Hermie Web (a redirect in the reverse proxy; `deploy/web/README.md` has the
   * worked example). `/` is right whenever the two share an origin.
   *
   * `''` means "send no `next=` at all", which is the default under
   * `passHost`: the callback then lands on Hermie Web's own origin, and the
   * gateway's own default (`/`) is already the right place.
   */
  loginReturn: string

  /** Directory holding the exported web build. */
  staticDir: string
  /** Hermie Web's own version, reported by `/healthz` and `/hermie/config.json`. */
  version: string
  /** Turn the self-update endpoints off entirely. */
  selfUpdate: boolean
  /** Where releases are unpacked and the `current` link lives. */
  installRoot: string
  /**
   * Watch every Bot Chat and notify registered devices ([ADR-0017](../../../docs/adr/0017-push-through-hermie-web.md)).
   *
   * Off by default, and deliberately a separate switch from serving the app: the
   * daemon holds a gateway connection that keeps every Bot Chat resident in the
   * gateway's live-session list, which is a real cost a self-hoster should opt
   * into rather than discover.
   */
  push: boolean
  /** The session token an ungated gateway takes. Empty on a gated one; see `hermie-web login`. */
  gatewayToken: string
  /** Where the watch state, the VAPID key pair and any stored sign-in live. */
  stateDir: string
  /**
   * How much disk the message cache may take, in megabytes
   * ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
   *
   * `0` turns it off, and turning it off is a real option rather than a
   * degenerate one: the cache holds transcript CONTENT, which is the first
   * thing this process has ever stored that is not a credential. An operator
   * who would rather every chat opened cold than have Bot Chat tails on the
   * service's disk says so here.
   */
  cacheMaxMb: number
  /**
   * The `sub` claim of the VAPID token (RFC 8292 §2.1): a `mailto:` or `https:`
   * URI a push service can use to reach whoever runs this. The default names the
   * project because it has to name something; an operator sending real volume
   * should put their own address here.
   */
  vapidSubject: string
  /**
   * Ask the gateway to route server→client requests to the push connection.
   *
   * Off by default, and it should stay off unless the operator knows their
   * gateway fans a request out to EVERY peer of a session. On one that routes
   * to a single peer, a daemon that receives an approval and holds it open —
   * which is the only thing it will ever do with one — has taken the question
   * away from the person it was for. Without it, open questions are learnt from
   * a resume's snapshot and from the `approval.pending` poll, which is what the
   * app does too.
   */
  pushServerRequests: boolean
  /**
   * The push relays a native Apple app's registration may be delivered
   * through, as https origins.
   *
   * An ALLOW-LIST, and the only thing that decides where a relay request goes:
   * a registration names its relay, and a registration naming an origin that is
   * not here is not sent to at all. Anybody who can write the gateway's
   * `ui_meta` can write a registration, so following the row would let them
   * point this process at any https address it can reach. Default: the
   * project's own relay, `https://push.hermie.dev`, and nothing else. Empty
   * means relay registrations are never sent.
   */
  pushRelays: string[]
  /**
   * Let the built-in OIDC provider be enabled on an origin that is not https.
   *
   * It exists to be REFUSED by default rather than to be used. The gateway's
   * own relying party rejects an issuer that is not `https` — or `http` on
   * `localhost`, `127.0.0.1` or `::1`, which it allows by name and which
   * therefore needs no flag at all. So this only unlocks the one case upstream
   * will not accept: plain http on a real hostname. An operator who passes it
   * gets a provider a browser can use and the gateway will not, which is why
   * `/admin` says so beside the switch rather than letting it be discovered
   * later ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
   */
  allowInsecureOidc: boolean
  /**
   * Let the app sign in through the GATEWAY's own OIDC/SSO providers, proxied
   * through this Hermie Web.
   *
   * On by default, so an operator who has never heard of this flag gets the
   * browser build's ordinary behaviour. Off:
   *
   *  - `/hermie/config.json` answers `oidc: false`, and the shared app code
   *    that reads it leaves every OIDC/SSO provider out of the sign-in screen
   *    and the connect wizard — only a password provider remains, and a
   *    gateway that offers nothing else is told so in plain language rather
   *    than shown an empty screen.
   *  - This service refuses the two OIDC browser routes itself —
   *    `/auth/login` and `/auth/callback`, see `OIDC_BROWSER_PATHS` — with a
   *    403, so nobody starts one through this Hermie Web by typing the URL
   *    either, and `/auth/native/authorize` unless the provider the gateway
   *    would pick takes a password (`oidcRouteDecision`). The decision is
   *    made on the path decoded once the way the gateway decodes it, and the
   *    original bytes are what is forwarded — see `server.ts`.
   *
   * Unaffected: `/auth/password-login`, `/api/auth/me`, logout, WebSocket
   * tickets, and `hermie-web login` — a different thing entirely, the CLI's
   * own OIDC sign-in for an OIDC-gated *upstream* gateway, used to obtain a
   * refresh token for `--push`. It never goes through a browser and this flag
   * does not touch it.
   *
   * Not to be confused with the BUILT-IN identity provider (`allowInsecureOidc`
   * above, `/admin/oidc`): that one is this service acting as an OpenID
   * Provider FOR the gateway. This one is about the gateway's own upstream
   * providers, reached through this proxy.
   */
  oidc: boolean
  /**
   * Gateway user ids this container declares administrators of `/admin`,
   * enforced on every start.
   *
   * A gateway user id, precisely: whatever `/api/auth/me` answers as
   * `user_id` — an OIDC `sub`, or a basic-auth username — because that is the
   * exact string `isAdminIdentity` compares against (`admin/access.ts`). Not
   * an email address as a separate way to name somebody: `identity.ts` falls
   * back to `email` only for a gateway whose `/api/auth/me` sends no
   * `user_id` at all, and even then it is that ONE resulting string that has
   * to be listed here, never a second lookup on top of it.
   *
   * This id space is **not namespaced per provider.** If a gateway's OIDC
   * provider and its basic-auth users could ever mint the same string as a
   * `sub` or username — unlikely, but nothing here rules it out — `admins`
   * cannot tell those two people apart.
   *
   * Each one is added as an administrator if it is not already one. An id
   * that is an administrator ONLY because it is on this list cannot be
   * removed through `/admin` or its forms while it stays on the list — see
   * `admin/env-admins.ts` and `admin/access.ts`'s `withoutAdmin`. An id a
   * person added by hand, through `/setup` or `/admin/people`, is unaffected
   * either way: naming it here does not change how it was added, and dropping
   * it from here later does not touch an administrator a person actually
   * added.
   */
  admins: string[]
  /**
   * A local administrator secret from the container's own configuration, in
   * `admin/access.ts`'s `encodeLocalSecret` format — never a plaintext
   * password; see `HERMIE_LOCAL_ADMIN_PASSWORD_HASH`'s note on
   * `ResolveOptionsInput` for why. `null` when it is not set, which leaves
   * whatever `/setup` wrote (or did not) untouched.
   */
  localAdminPasswordHash: LocalSecretHash | null
}

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9119'
export const DEFAULT_PORT = 9120
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_LOGIN_RETURN = '/'
/** Named so a test can say it, and so the docs and the code cannot drift apart. */
export const DEFAULT_VAPID_SUBJECT = 'https://hermie.dev'

/**
 * Where the browser build reads the application-server key it has to subscribe
 * against. It is PUBLIC by definition — it is the half a browser is given — and
 * it authorises nothing on its own.
 */
export const PUSH_PUBLIC_KEY_PATH = '/push/vapid-public-key'

/**
 * Paths that belong to the gateway rather than to the app.
 *
 * A prefix list rather than a catch-all, so an unknown path falls through to
 * the SPA and a typo cannot silently become a proxied request. The cookie flow
 * needs all four: `/login` is the gateway's own sign-in page for password
 * providers, `/auth/*` is the whole OAuth round trip plus `password-login` and
 * `logout`, `/api/*` is the REST surface and the WebSocket, and `/logout` is
 * the shorthand some deployments link to.
 */
export const GATEWAY_PATH_PREFIXES: readonly string[] = ['/api', '/auth', '/login', '/logout']

/** Paths Hermie Web answers itself, and therefore never proxies. */
export const LOCAL_PATHS: readonly string[] = [
  '/healthz',
  '/hermie/config.json',
  '/hermie/update',
  PUSH_PUBLIC_KEY_PATH
]

export function isGatewayPath(pathname: string): boolean {
  if (LOCAL_PATHS.includes(pathname)) {
    return false
  }

  return GATEWAY_PATH_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Where the gateway's WebSocket routes live: `/api/ws`, `/api/pty`,
 * `/api/console`, `/api/events` and the rest are all under `/api`, and no
 * route under `/auth`, `/login` or `/logout` is a WebSocket. An upgrade to
 * anything else is refused rather than proxied (`server.ts`).
 */
export function isWebSocketGatewayPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/**
 * The gateway's own OIDC/SSO browser routes that a plain redirect can start or
 * finish: exactly these two, and nothing wider — `/auth/password-login`,
 * `/api/auth/me`, `/auth/logout` and everything else under `/auth` and `/api`
 * are a different door and stay open when `--no-oidc` closes this one. See
 * `HermieWebOptions.oidc`.
 *
 * `/auth/native/authorize` is NOT in this list: it takes a `provider` and is
 * refused or not depending on which one, so `oidcRouteDecision` below checks
 * it on its own.
 */
export const OIDC_BROWSER_PATHS: readonly string[] = ['/auth/login', '/auth/callback']

/** The one other route that can start a provider round trip, by name. */
export const NATIVE_AUTHORIZE_PATH = '/auth/native/authorize'

/**
 * The query parameters `oidcRouteDecision` reads. Each may appear at most once:
 * the gateway (FastAPI on Starlette) binds a repeated scalar parameter to its
 * LAST value, `URLSearchParams.get` answers the FIRST, and a request that
 * names one twice is refused rather than guessed about.
 */
const DECISION_PARAMS: readonly string[] = ['provider']

/** Visible ASCII only: what a browser puts on the wire after percent-encoding everything else. */
const REQUEST_TARGET_CHARS = /^[!-~]*$/

/**
 * What no decoded path segment may contain. `/` and `\` would turn one segment
 * into several; `%` would be a second escape for somebody downstream to
 * unwrap; `?` and `#` would move the end of the path; control characters have
 * no business in a route. None of them occurs in a legitimate gateway route.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_SEGMENT = /[%?#/\\\u0000-\u001f\u007f-\u009f]/

/**
 * A raw request target (`IncomingMessage.url`, exactly as it arrived), split
 * into its path and query at the first `?` — the same split the gateway's own
 * HTTP parser makes. `null` for anything that is not an origin-form target of
 * visible ASCII: an absolute or `//`-prefixed target, a raw fragment, a space,
 * a control character or an unencoded non-ASCII byte. A browser sends none of
 * those.
 */
export function splitRequestTarget(target: string): { path: string; query: string } | null {
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) {
    return null
  }

  if (!REQUEST_TARGET_CHARS.test(target)) {
    return null
  }

  const at = target.indexOf('?')

  return at === -1 ? { path: target, query: '' } : { path: target.slice(0, at), query: target.slice(at + 1) }
}

/**
 * The route the gateway will take for this raw request path — for a DECISION
 * only; what is forwarded is always the raw path itself (see `server.ts`).
 *
 * The gateway's ASGI server (uvicorn) percent-decodes the path exactly once
 * and routes on the result, with no dot-segment resolution and no slash
 * merging. This decodes once too, segment by segment, and then refuses
 * (`null`) anything whose single decode leaves something a second decoder,
 * router or intermediary could read differently:
 *
 *  - a segment that decodes to contain `%`, `?`, `#`, `/`, `\` or a control
 *    character — `%256cogin` is `%6cogin` after one pass, which is only
 *    harmless for as long as nobody decodes it again, and `login%3F…` would
 *    become a query string the moment anything re-parsed it;
 *  - a `.` or `..` segment, encoded or not, which a normalising hop could
 *    resolve into a different route;
 *  - a malformed escape or one that is not UTF-8.
 *
 * Empty segments are dropped rather than refused, so `/auth//login` and
 * `/auth/login/` both read as `/auth/login`. That only ever makes MORE paths
 * match a refused route, never fewer: none of the refused routes has an empty
 * segment, so a path the gateway would route to one of them is unchanged by it.
 *
 * Under `/api` — a path whose first segment decodes to exactly `api` — the
 * rule is narrower, because its routes carry names (a file, a session, a
 * profile) that may legitimately hold an encoded `%`, `?` or `#`. Those three
 * are allowed there. What is still refused is anything that could MOVE the
 * path out of `/api` at a hop between here and the gateway: `--gateway` may
 * name an edge proxy that decodes `%2e` and resolves dot segments, or decodes
 * twice, and `/api/%2e%2e/auth/login` would reach `/auth/login` through it.
 * So each segment is decoded repeatedly, as far as it will go, and refused if
 * any stage is `.` or `..` or contains `/`, `\` or a control character
 * (`apiSegmentMayMove`). The answer is `/api` plus the rest AS SENT: nothing
 * under `/api` is a route `oidcRouteDecision` refuses, so "it is under `/api`
 * and stays there" is the whole of what the decision needs, and the raw bytes
 * are what is forwarded either way.
 */
export function canonicalGatewayPath(rawPath: string): string | null {
  if (!rawPath.startsWith('/') || !REQUEST_TARGET_CHARS.test(rawPath)) {
    return null
  }

  const firstRaw = rawPath.slice(1).split('/')[0] as string
  let first: string

  try {
    first = decodeURIComponent(firstRaw)
  } catch {
    return null
  }

  if (first === 'api') {
    const rest = rawPath.slice(1 + firstRaw.length)

    return rest.split('/').some(apiSegmentMayMove) ? null : `/api${rest}`
  }

  const decoded: string[] = []

  for (const segment of rawPath.slice(1).split('/')) {
    let value: string

    try {
      value = decodeURIComponent(segment)
    } catch {
      return null
    }

    if (FORBIDDEN_IN_SEGMENT.test(value) || value === '.' || value === '..') {
      return null
    }

    if (value) {
      decoded.push(value)
    }
  }

  return `/${decoded.join('/')}`
}

/*
  What could move a path at SOME hop, in any decoded stage: `/` and `\`,
  control characters, U+FF0E (a fullwidth full stop, which an NFKC-normalising
  hop turns into `.`; `apiSegmentMayMove` also checks the NFKC form itself),
  and `;` (a path parameter a Tomcat-style hop strips, which would turn `..;`
  into `..`).
*/
// eslint-disable-next-line no-control-regex
const MOVES_A_PATH = /[/\\;\u0000-\u001f\u007f-\u009f\uff0e]/

/**
 * Whether one raw `/api` path segment is, or could become at a hop that
 * decodes again, a dot segment or more than one segment. Decoded until it
 * stops changing (or stops decoding), every stage checked — so `%2e%2e`,
 * `..%2f`, `%5c` and a double-encoded `%252e%252e` are all caught, while a
 * name holding `%25`, `%3F` or `%23` that decodes to nothing of the kind is
 * not.
 */
function apiSegmentMayMove(raw: string): boolean {
  let stage = raw

  for (let pass = 0; pass < 8; pass++) {
    // Checked as sent and as an NFKC-normalising hop would see it, which
    // catches U+FF0E's cousins (U+2024, U+FE52, a fullwidth solidus) as well.
    const folded = stage.normalize('NFKC')

    if ([stage, folded].some(form => form === '.' || form === '..' || MOVES_A_PATH.test(form))) {
      return true
    }

    let next: string

    try {
      next = decodeURIComponent(stage)
    } catch {
      // A malformed escape on the FIRST pass is a malformed request; later, it
      // is just a literal `%` in a name, which no hop can decode either.
      return pass === 0
    }

    if (next === stage) {
      return false
    }

    stage = next
  }

  // Still decoding after eight passes is nothing a real name does.
  return true
}

/** A gateway sign-in provider, as `/api/auth/providers` lists it. */
export interface SessionProvider {
  name: string
  supportsPassword: boolean
}

/**
 * What `--no-oidc` does with one gateway request.
 *
 *  - `refuse`: it would start or finish a browser OIDC/SSO round trip.
 *  - `ambiguous`: a parameter this decision reads is repeated, so this
 *    service and the gateway could read it differently.
 *  - `allow`: anything else.
 *
 * `/auth/login` and `/auth/callback` are refused whatever the query string
 * says: both exist only for that redirect chain. `/auth/native/authorize` is
 * also how the native flow reaches a PASSWORD provider (the gateway 302s it to
 * its own `/login` form), so it is allowed exactly when the provider the
 * gateway will pick takes a password — mirroring `_select_native_provider` in
 * the gateway's `dashboard_auth/routes.py`: the named one, or, when none is
 * named, the ONLY session provider there is. With several and none named the
 * gateway would draw a chooser that links to OIDC providers too, so that is
 * refused. `sessionProviders` is the gateway's own `/api/auth/providers`
 * answer; an empty list (the gateway could not be read) refuses every case.
 */
export function oidcRouteDecision(
  canonicalPath: string,
  searchParams: URLSearchParams,
  sessionProviders: readonly SessionProvider[]
): 'allow' | 'refuse' | 'ambiguous' {
  if (OIDC_BROWSER_PATHS.includes(canonicalPath)) {
    return 'refuse'
  }

  if (canonicalPath !== NATIVE_AUTHORIZE_PATH) {
    return 'allow'
  }

  if (DECISION_PARAMS.some(name => searchParams.getAll(name).length > 1)) {
    return 'ambiguous'
  }

  const named = searchParams.get('provider') ?? ''
  const chosen = named
    ? sessionProviders.find(provider => provider.name === named)
    : sessionProviders.length === 1
      ? sessionProviders[0]
      : undefined

  return chosen?.supportsPassword ? 'allow' : 'refuse'
}

/**
 * The origin a proxied request claims to come from.
 *
 * `https://gateway.example` for a public URL with a scheme; a bare host is
 * read as the same scheme the gateway itself is on, which is what a person
 * typing `--public-url hermes.tailnet.ts.net` means.
 */
export function normalizePublicUrl(raw: string, gatewayUrl: string): string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return new URL(gatewayUrl).origin
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${new URL(gatewayUrl).protocol}//${trimmed}`

  try {
    return new URL(withScheme).origin
  } catch {
    throw new Error(`--public-url (or HERMIE_PUBLIC_URL) must be a URL or host (got ${raw}).`)
  }
}

/**
 * `--web-public-url`, checked: an `http(s)://` URL, answered as its origin.
 * A scheme is required rather than guessed — whether this service is reached
 * over https is exactly what the gateway will compare, and a guess here would
 * be a silent mismatch there.
 */
export function normalizeWebPublicUrl(raw: string): string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return ''
  }

  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    url = new URL('invalid:')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `--web-public-url (or HERMIE_WEB_PUBLIC_URL) must be an http:// or https:// URL with its scheme (got ${raw}).`
    )
  }

  return url.origin
}

/**
 * Is this a path on our own origin, and nothing else?
 *
 * Everything that is not one is a way to send a signed-in browser somewhere
 * else: `https://evil.example` is obvious, `//evil.example` is a
 * protocol-relative URL that reads as a host, and `/\evil.example` is the same
 * trick for the browsers that normalise a backslash into a slash. Control
 * characters are refused because a header cannot carry them and something
 * downstream would have to decide what to do with them.
 *
 * The gateway validates `next=` again on arrival, which is the check that
 * actually protects the session. This one exists so a mistake in a unit file is
 * a startup failure with a name on it rather than a redirect that works.
 */
export function isSameOriginPath(raw: string): boolean {
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return false
  }

  // eslint-disable-next-line no-control-regex
  return !/[\s\\]|[\u0000-\u001f\u007f]/.test(raw)
}

/** `--login-return`, checked. Empty means the default; anything unsafe throws. */
export function normalizeLoginReturn(raw: string, fallback: string = DEFAULT_LOGIN_RETURN): string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return fallback
  }

  if (!isSameOriginPath(trimmed)) {
    throw new Error(
      `--login-return (or HERMIE_LOGIN_RETURN) must be a path on this origin, starting with a single "/" (got ${raw}).`
    )
  }

  return trimmed
}

export interface ResolveOptionsInput {
  gatewayUrl?: string | undefined
  /** Overrides the "was it chosen or defaulted" reading; `startHermieWeb` sets it from the saved setup. */
  gatewayConfigured?: boolean | undefined
  port?: string | number | undefined
  host?: string | undefined
  publicUrl?: string | undefined
  webPublicUrl?: string | undefined
  passHost?: boolean | undefined
  staticDir?: string | undefined
  loginReturn?: string | undefined
  version?: string | undefined
  selfUpdate?: boolean | undefined
  installRoot?: string | undefined
  push?: boolean | undefined
  gatewayToken?: string | undefined
  stateDir?: string | undefined
  cacheMaxMb?: string | number | undefined
  vapidSubject?: string | undefined
  pushServerRequests?: boolean | undefined
  /** Comma-separated, or already split. `''` is an empty allow-list. */
  pushRelays?: string | string[] | undefined
  allowInsecureOidc?: boolean | undefined
  oidc?: boolean | undefined
  /** Already split and trimmed; `resolveOptions` validates it either way. */
  admins?: string[] | undefined
  /**
   * `admin/access.ts`'s `encodeLocalSecret` format, already decoded. There is
   * deliberately no way to pass a plaintext password here: a secret an
   * operator has typed into a container's configuration is one that shows up
   * in a process list, a CI log or a Kubernetes event, and a hash the module
   * itself produced (`hermie-web hash-secret`) is the only thing this reads.
   */
  localAdminPasswordHash?: LocalSecretHash | null | undefined
  env?: NodeJS.ProcessEnv
  /** Where `dist/web` sits when `--static` is not given. */
  packageRoot?: string
}

/** Flags beat environment variables beat defaults, in that order. */
export function resolveOptions(input: ResolveOptionsInput = {}): HermieWebOptions {
  const env = input.env ?? process.env
  const packageRoot = input.packageRoot ?? path.resolve(__dirname, '..', '..')
  const gatewayUrl = readUrlOption(
    input.gatewayUrl ?? env.HERMIE_GATEWAY_URL,
    DEFAULT_GATEWAY_URL,
    '--gateway',
    'HERMIE_GATEWAY_URL'
  )
  const port = readIntOption(input.port ?? env.HERMIE_PORT, DEFAULT_PORT, '--port', 'HERMIE_PORT', {
    min: 0,
    max: 65_535
  })

  const selfUpdate = input.selfUpdate ?? readBooleanEnv(env.HERMIE_SELF_UPDATE, 'HERMIE_SELF_UPDATE') ?? true
  const passHost = input.passHost ?? readBooleanEnv(env.HERMIE_PASS_HOST, 'HERMIE_PASS_HOST') ?? false
  const webPublicUrl = normalizeWebPublicUrl(input.webPublicUrl ?? env.HERMIE_WEB_PUBLIC_URL ?? '')

  if (passHost && !webPublicUrl) {
    throw new Error(
      '--pass-host (or HERMIE_PASS_HOST) needs --web-public-url (or HERMIE_WEB_PUBLIC_URL): ' +
        'Hermie Web’s own public address, e.g. https://app.example.com, which is what the gateway is sent.'
    )
  }

  return {
    gatewayUrl,
    // A flag or an environment variable is a decision; the default is not. A
    // caller that has read a saved setup says so outright.
    gatewayConfigured: input.gatewayConfigured ?? (input.gatewayUrl ?? env.HERMIE_GATEWAY_URL) !== undefined,
    port,
    host: input.host ?? env.HERMIE_HOST ?? DEFAULT_HOST,
    publicUrl: normalizePublicUrl(input.publicUrl ?? env.HERMIE_PUBLIC_URL ?? '', gatewayUrl),
    webPublicUrl,
    passHost,
    staticDir: path.resolve(input.staticDir ?? env.HERMIE_STATIC_DIR ?? path.join(packageRoot, 'dist', 'web')),
    // Under `--pass-host` the callback lands on this origin, so no `next=` is
    // needed unless an operator still asks for one.
    loginReturn: normalizeLoginReturn(
      input.loginReturn ?? env.HERMIE_LOGIN_RETURN ?? '',
      passHost ? '' : DEFAULT_LOGIN_RETURN
    ),
    version: input.version ?? env.HERMIE_VERSION ?? readOwnVersion(packageRoot),
    selfUpdate,
    installRoot: path.resolve(input.installRoot ?? env.HERMIE_INSTALL_ROOT ?? path.join(packageRoot, '..')),
    push: input.push ?? readBooleanEnv(env.HERMIE_PUSH, 'HERMIE_PUSH') ?? false,
    gatewayToken: input.gatewayToken ?? env.HERMIE_GATEWAY_TOKEN ?? '',
    // NOT the install root: a self-update replaces that, and a daemon that
    // forgot its VAPID key after an update would orphan every browser
    // subscription it had ever handed out.
    stateDir: path.resolve(input.stateDir ?? defaultStateDir(env)),
    cacheMaxMb: readCacheMaxMb(input.cacheMaxMb ?? env.HERMIE_CACHE_MAX_MB),
    vapidSubject: input.vapidSubject ?? env.HERMIE_VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT,
    pushServerRequests:
      input.pushServerRequests ??
      readBooleanEnv(env.HERMIE_PUSH_SERVER_REQUESTS, 'HERMIE_PUSH_SERVER_REQUESTS') ??
      false,
    pushRelays: readRelayOrigins(input.pushRelays ?? env.HERMIE_PUSH_RELAYS),
    allowInsecureOidc:
      input.allowInsecureOidc ?? readBooleanEnv(env.HERMIE_ALLOW_INSECURE_OIDC, 'HERMIE_ALLOW_INSECURE_OIDC') ?? false,
    oidc: input.oidc ?? readBooleanEnv(env.HERMIE_OIDC, 'HERMIE_OIDC') ?? true,
    admins: readAdminIds(input.admins ?? env.HERMIE_ADMINS, '--admins', 'HERMIE_ADMINS'),
    localAdminPasswordHash:
      input.localAdminPasswordHash ?? readLocalAdminPasswordHash(env.HERMIE_LOCAL_ADMIN_PASSWORD_HASH)
  }
}

/**
 * `HERMIE_LOCAL_ADMIN_PASSWORD_HASH`, checked. No flag: see the option's note
 * on why a container's configuration is the only place this is read from at
 * all.
 */
function readLocalAdminPasswordHash(raw: string | undefined): LocalSecretHash | null {
  if (!raw) {
    return null
  }

  const decoded = decodeLocalSecret(raw)

  if (!decoded) {
    throw new Error(
      'HERMIE_LOCAL_ADMIN_PASSWORD_HASH must be a hash `hermie-web hash-secret` produced, not a plaintext ' +
        'password (got a value of the wrong shape).'
    )
  }

  return decoded
}

/** Longer than any real gateway user id or email; short of "a token pasted here by accident". */
const MAX_ADMIN_ID_LENGTH = 320

// eslint-disable-next-line no-control-regex
const CONTAINS_CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * `--admins` (or `HERMIE_ADMINS`), checked.
 *
 * A comma-separated list, trimmed entry by entry with the empty ones dropped —
 * `HERMIE_ADMINS=ada@example.invalid, ,grace@example.invalid` is two ids, not
 * three, since a trailing comma or a stray space in a Kubernetes manifest is
 * an editing accident and not a decision to name an empty administrator.
 *
 * Already-split input (`string[]`, from a test or a repeatable flag) is
 * trimmed and filtered the same way and validated regardless, so the checks
 * below cannot be bypassed by whichever caller supplied the list.
 */
function readAdminIds(raw: string | string[] | undefined, flagName: string, envName: string): string[] {
  if (raw === undefined) {
    return []
  }

  const ids = (typeof raw === 'string' ? raw.split(',') : raw).map(id => id.trim()).filter(Boolean)

  for (const id of ids) {
    if (CONTAINS_CONTROL_CHARS.test(id)) {
      throw new Error(`${flagName} (or ${envName}) may not contain control characters (got ${JSON.stringify(id)}).`)
    }

    if (id.length > MAX_ADMIN_ID_LENGTH) {
      throw new Error(`${flagName} (or ${envName}) has an id longer than ${String(MAX_ADMIN_ID_LENGTH)} characters.`)
    }
  }

  return ids
}

/**
 * `--push-relays` (or `HERMIE_PUSH_RELAYS`), checked.
 *
 * Absent is the project's own relay. Present is the WHOLE list — not an
 * addition to the default — so an operator who runs their own relay and wants
 * nothing to go anywhere else can say exactly that, and `''` turns relay
 * delivery off. Every entry must be an https origin with nothing after it; a
 * typo is a startup failure rather than a list that silently allows nothing.
 */
function readRelayOrigins(raw: string | string[] | undefined): string[] {
  if (raw === undefined) {
    return [RELAY_DEFAULT_ORIGIN]
  }

  const entries = (typeof raw === 'string' ? raw.split(',') : raw).map(entry => entry.trim()).filter(Boolean)
  const origins: string[] = []

  for (const entry of entries) {
    const origin = relayOriginOf(entry)

    if (!origin) {
      throw new Error(
        `--push-relays (or HERMIE_PUSH_RELAYS) must be https origins such as ${RELAY_DEFAULT_ORIGIN}, ` +
          `with no path (got ${JSON.stringify(entry)}).`
      )
    }

    if (!origins.includes(origin)) {
      origins.push(origin)
    }
  }

  return origins
}

/**
 * A boolean flag's environment counterpart, checked.
 *
 * `1`, `true` and `yes` are on; `0`, `false` and `no` are off — case- and
 * whitespace-insensitive, since a unit file or a Kubernetes manifest is typed
 * by hand. Anything else is a startup failure that names the variable, rather
 * than a typo that silently reads as "off".
 */
function readBooleanEnv(raw: string | undefined, envName: string): boolean | undefined {
  if (raw === undefined || raw === '') {
    return undefined
  }

  const normalized = raw.trim().toLowerCase()

  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false
  }

  throw new Error(`${envName} must be 1/true/yes or 0/false/no (got ${raw}).`)
}

/**
 * An integer flag or its environment counterpart, checked. Named after
 * whichever of the two actually supplies a value, so a typo in a unit file is
 * a startup failure that says where to look rather than a stack trace or a
 * silent `NaN`.
 */
function readIntOption(
  raw: string | number | undefined,
  fallback: number,
  flagName: string,
  envName: string,
  { min, max }: { min: number; max: number }
): number {
  if (raw === undefined) {
    return fallback
  }

  const value = typeof raw === 'number' ? raw : Number.parseInt(raw, 10)

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${flagName} (or ${envName}) must be a number between ${String(min)} and ${String(max)} (got ${String(raw)}).`
    )
  }

  return value
}

/** A URL flag or its environment counterpart, checked — a scheme is required. */
function readUrlOption(raw: string | undefined, fallback: string, flagName: string, envName: string): string {
  if (raw === undefined) {
    return new URL(fallback).toString()
  }

  try {
    return new URL(raw).toString()
  } catch {
    throw new Error(`${flagName} (or ${envName}) must be a URL with a scheme (got ${raw}).`)
  }
}

/**
 * `--cache-max-mb`, checked.
 *
 * A typo here would either turn the cache off in silence or hand an eviction
 * loop a `NaN` to compare against, so anything that is not a number is a
 * startup failure with the value in it. `0` is legal and means off.
 */
function readCacheMaxMb(raw: string | number | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_CACHE_MAX_MB
  }

  const value = typeof raw === 'number' ? raw : Number.parseFloat(raw)

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `--cache-max-mb (or HERMIE_CACHE_MAX_MB) must be a number of megabytes, 0 or more (got ${String(raw)}).`
    )
  }

  return value
}

function readOwnVersion(packageRoot: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manifest = require(path.join(packageRoot, 'package.json')) as { version?: string }

    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** A short, honest name for the machine, used only in log lines. */
export function describeHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? `${hostname()} (all interfaces)` : host
}
