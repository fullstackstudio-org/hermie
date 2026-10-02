/**
 * Hermie Web: one small process next to `hermes serve`, on its own port.
 *
 * It does two things and refuses a third. It serves the browser build of the
 * app, and it proxies exactly one gateway onto the same origin — which is the
 * whole point, because the gateway's session is an `HttpOnly` cookie and a
 * cookie belongs to an origin. The third thing, proxying anywhere the caller
 * names, is what would make this an open relay onto the operator's loopback
 * interface, so the gateway is fixed at startup and there is no code path that
 * changes it.
 *
 * Routing, in the order it is decided:
 *
 *  1. `/healthz`, `/hermie/config.json`, `/hermie/update` — answered here.
 *  2. `/setup` and `/hermie/setup/*` — answered here while no gateway is
 *     configured, and 404 for ever once one is
 *     ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 *  3. `/api/*`, `/auth/*`, `/login*`, `/logout*` — proxied to the gateway.
 *  4. Anything that names a file in the static build — served from disk.
 *  5. Everything else — `index.html`, so a deep link into the SPA works.
 */
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import {
  cacheDir,
  isCapturableAnswer,
  MAX_CAPTURE_BYTES,
  rowsOfMessagesBody,
  sessionIdOfMessagesPath,
  TranscriptCache
} from './cache'
import { AdminRouter } from './admin/routes'
import { hashLocalSecret, mayProxyMethod, withAdmin } from './admin/access'
import {
  DEFAULT_USER_OPTIONS,
  emptyAdminState,
  loadAdminState,
  mayReachBot,
  optionsFor,
  saveAdminState,
  type AdminState
} from './admin/state'
import { reconcileAdminAndIssuer } from './admin/reconcile'
import { IdentityReader, type GatewayIdentity } from './identity'
import { webCopy } from './i18n'
import { OidcProvider } from './oidc/provider'
import { OidcRouter } from './oidc/routes'
import { loadOidcState, saveOidcState, type OidcState } from './oidc/state'
import {
  canonicalGatewayPath,
  type HermieWebOptions,
  isGatewayPath,
  isWebSocketGatewayPath,
  NATIVE_AUTHORIZE_PATH,
  oidcRouteDecision,
  PUSH_PUBLIC_KEY_PATH,
  resolveOptions,
  type ResolveOptionsInput,
  splitRequestTarget
} from './options'
import { type PushDaemon, startPushDaemon } from './push/daemon'
import { buildAuthorizeUrl, createPkce, exchangeCode, type Pkce } from './push/login'
import { sameGateway } from './push/credentials'
import { loadPushState, PUSH_STATE_VERSION, savePushState } from './push/state'
import { hostPinnedFetch, proxyHttp, type ProxyObserver, proxyUpgrade } from './proxy'
import {
  normalizeGatewayInput,
  ownOrigin,
  probeGateway,
  readSetup,
  SETUP_CALLBACK_PATH,
  setupCallbackPage,
  SETUP_FILE,
  setupPage,
  type SetupProbe,
  writeSetup
} from './setup'
import { serveIndex, serveStatic } from './static-files'
import {
  applyUpdate,
  detectInstallShape,
  hasGatewaySession,
  isSupervised,
  ReleaseCache,
  restartProcess,
  statusFrom
} from './update'

export interface HermieWebServer {
  url: string
  port: number
  options: HermieWebOptions
  /** The push daemon, when `--push` asked for one. */
  push: PushDaemon | null
  /** The message cache. Always present; `enabled` is false at `--cache-max-mb 0`. */
  cache: TranscriptCache
  /**
   * The built-in OIDC provider. Always present; `enabled` is false until an
   * operator turns it on, which is every deployment that has not (ADR-0025).
   */
  oidc: OidcProvider
  close(): Promise<void>
}

export interface StartOptions extends ResolveOptionsInput {
  /** Injected by the tests so they never reach GitHub. */
  releaseCache?: ReleaseCache
  /** Injected by the tests so nothing exits the test runner. */
  restart?: () => void
  /** Injected by the tests so `--push` never dials a real gateway. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocket
  /** Injected by the tests so a probe and a code exchange can be watched. */
  fetchImpl?: typeof fetch
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)

  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store'
  })
  response.end(payload)
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store'
  })
  response.end(body)
}

/** At most 64 KiB of JSON off a request body; more than that is not a setup form. */
const MAX_BODY_BYTES = 64 * 1024

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length

    if (size > MAX_BODY_BYTES) {
      throw new Error('the request body is too large')
    }

    chunks.push(buffer)
  }

  if (!chunks.length) {
    return {}
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown

  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

/**
 * How long the gateway's public surface is held before it is read again.
 *
 * The app asks for it on every load, and it changes when somebody restarts the
 * gateway with another provider — which is minutes apart at worst, never
 * seconds. A minute keeps a tab refresh free and still notices a change while
 * the operator is still looking at the terminal they made it in.
 */
const PROBE_TTL_MS = 60_000
/** How long one "fresh" probe answers every caller that asks for one. */
const FRESH_PROBE_TTL_MS = 3_000
/** How long the `--pass-host` startup check waits for the gateway before it answers "unknown". */
const PASS_HOST_CHECK_TIMEOUT_MS = 5_000
/** How soon an unanswered `--pass-host` check is asked again. */
const PASS_HOST_RETRY_MS = 30_000
/** The same for a probe that failed: short, so a gateway that is back is seen again quickly. */
const FAILED_PROBE_TTL_MS = 1_000

export async function startHermieWeb(input: StartOptions = {}): Promise<HermieWebServer> {
  const first = resolveOptions(input)
  /*
    A gateway the operator SAVED is a gateway the operator chose, so it is read
    before anything else and makes this a configured start. It is only consulted
    when no flag and no environment variable already answered: a `--gateway` on
    the command line beats a file every time, or an operator could not override
    their own deployment without deleting state.
  */
  const saved = first.gatewayConfigured ? null : await readSetup(first.stateDir)
  const options = saved
    ? resolveOptions({
        ...input,
        gatewayUrl: saved.gatewayUrl,
        gatewayConfigured: true,
        ...(saved.publicUrl ? { publicUrl: saved.publicUrl } : {})
      })
    : first
  const fetchImpl = input.fetchImpl ?? fetch
  // The probe's own fetch: an injected one (tests) gets the `Host` as a plain
  // header; the real one needs `hostPinnedFetch`, since the platform `fetch`
  // will not send a `Host` of the caller's choosing.
  const probeFetch = (host: string): typeof fetch =>
    input.fetchImpl
      ? (((url: Parameters<typeof fetch>[0], init?: RequestInit) =>
          fetchImpl(url, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), host }
          })) as typeof fetch)
      : hostPinnedFetch(host)
  const releases = input.releaseCache ?? new ReleaseCache()
  const shape = detectInstallShape({ selfUpdate: options.selfUpdate, installRoot: options.installRoot })
  // Mutable, and mutated in exactly one place: the single unconfigured →
  // configured transition in `handleSetup`. Nothing else in this process can
  // move it, and once moved there is no route back.
  const target: { gatewayUrl: string; publicUrl: string; passHostOrigin: string | null; webOrigin: string | null } = {
    gatewayUrl: options.gatewayUrl,
    publicUrl: options.publicUrl,
    // Optimistic until `checkPassHost` has asked the gateway; see there.
    passHostOrigin: options.passHost ? options.webPublicUrl : null,
    webOrigin: options.webPublicUrl || null
  }
  let passHostRetry: NodeJS.Timeout | null = null
  let closed = false
  /*
    Did a FLAG name the gateway, or did `/setup` save one?

    `first` is the resolve before the saved setup was consulted, so its
    `gatewayConfigured` is true only when `--gateway` or the environment
    answered. The difference matters in exactly one place: "run setup again"
    can reopen `/setup` on a deployment that was set up through it, and cannot
    on one whose gateway is on the command line — the flag would still be there
    after a restart, so the page would close again on its own.
  */
  const gatewayFromFlag = first.gatewayConfigured
  let configured = options.gatewayConfigured
  /** The operator's in-flight service sign-in, minted by `/hermie/setup/login`. */
  let pendingLogin: (Pkce & { gatewayUrl: string; redirectUri: string }) | null = null
  let probeCache: { at: number; probe: SetupProbe } | null = null
  // The single-flight, few-second answer `gatewayProbe({ fresh: true })` shares.
  let freshProbe: { probe: Promise<SetupProbe | null>; settledAt: number; failed: boolean } | null = null
  const cache = new TranscriptCache({
    dir: cacheDir(options.stateDir),
    maxBytes: Math.round(options.cacheMaxMb * 1024 * 1024)
  })
  /**
   * Who each cookie belongs to, as the gateway says (ADR-0007's per-user
   * chats). One short-lived memo, so a page's burst of transcript reads costs
   * one round trip rather than one each.
   */
  const identities = new IdentityReader()
  /**
   * What `/admin` has decided, held in memory so the hot paths do not read a
   * file per request. The router hands back every new copy through `onChanged`,
   * and nothing else in this process writes it.
   */
  let admin: AdminState = await loadAdminState(options.stateDir)
  /**
   * The built-in OIDC provider's state (ADR-0025 part 3), held the same way
   * `admin` is and for the same reason: one authority in this process, so a
   * request rendered between a write and its flush does not read a stale file.
   *
   * It is `enabled: false` on every deployment that has not turned it on, which
   * is what makes every path below a no-op by default.
   */
  let oidc: OidcState = await loadOidcState(options.stateDir)
  let updating = false
  // Assigned once the listener is up; the handler reads it, so it is declared
  // here rather than beside the `await` that fills it.
  let push: PushDaemon | null = null

  /**
   * Note that we have seen somebody, so `/admin` has a list to show.
   *
   * This is the whole of the "user list" on a gateway with no way to ask for
   * one. Upstream has no documented `/api/auth/users`, and inventing a call for
   * it would be this service guessing at another project's routes — so the
   * honest answer is the one it can actually make: the people who have signed
   * in HERE, and when. The page says which of the two it is showing.
   *
   * Best effort and never awaited. A row that could not be written costs a name
   * missing from a list.
   */
  function noteSeen(identity: GatewayIdentity | null): void {
    if (!identity?.userId) {
      return
    }

    const held = admin.users[identity.userId]
    const at = Math.floor(Date.now() / 1000)

    // A minute's resolution, so a page of forty requests writes the file once.
    if (held && at - held.seenAt < 60 && held.displayName === identity.displayName) {
      return
    }

    const next: AdminState = {
      ...admin,
      users: {
        ...admin.users,
        [identity.userId]: {
          ...(held ?? { ...DEFAULT_USER_OPTIONS, userId: identity.userId }),
          userId: identity.userId,
          displayName: identity.displayName,
          email: identity.email,
          seenAt: at
        }
      }
    }

    admin = next
    void saveAdminState(options.stateDir, next).catch(() => undefined)
  }

  /**
   * `HERMIE_LOCAL_ADMIN_PASSWORD_HASH`: enforced every start, for the same
   * reason `HERMIE_ADMINS` is — a container's configuration should not
   * silently lose to whatever `/setup` last wrote (or a hand-edited file).
   * There is nothing to "drop" here the way an id can fall off
   * `HERMIE_ADMINS`: a container that stops setting this variable simply
   * stops overwriting whatever is already stored.
   *
   * Ahead of `reconcileAdminState` below, so that one reconcile's single write
   * carries both, rather than this costing a write of its own first.
   */
  function withLocalAdminHash(state: AdminState): AdminState {
    const wanted = options.localAdminPasswordHash

    if (!wanted || (state.localAdmin?.salt === wanted.salt && state.localAdmin.hash === wanted.hash)) {
      return state
    }

    return { ...state, localAdmin: wanted }
  }

  /**
   * Bring `HERMIE_ADMINS`, the built-in issuer's roles, and
   * `HERMIE_LOCAL_ADMIN_PASSWORD_HASH` all into step with `admins`, in ONE
   * pass, and write the result at most once.
   *
   * This is the fix for a real bug: `HERMIE_ADMINS=owner` naming an id whose
   * issuer account had role `user` used to leave `admins` as `[owner]` after
   * the env reconcile and then `[]` — `owner` gone — the moment
   * `reconcileIssuerPeople` ran on its own right after, because that
   * function's role loop deleted any non-admin account from `admins`
   * regardless of why it was there. Two reconciles, each with its own idea of
   * the truth, each writing the file its own way, is how that happened; one
   * function computing the final answer BEFORE anything is written is what
   * rules it out. `reconcileIssuerPeople` also carries its own guard now
   * (never delete an env-named id), which is the backstop for a caller that
   * skips this one — but this is the one every code path in this file
   * actually takes.
   *
   * The whole computation — promoting a named id's issuer role, demoting a
   * role the container raised once it stops naming the id, and `admins`
   * following both — is `admin/reconcile.ts`'s, pure. This only writes what
   * it answers and logs what it had to keep.
   *
   * Two files, never one write: the OIDC state (roles, and the `roleFromEnv`
   * mark beside each role it explains) is written FIRST, then `admin.json`.
   * A crash between the two leaves roles that are ahead of `admins`, never
   * the reverse, and the next start's call converges from there: the same
   * inputs give the same roles (already written, so no second OIDC write) and
   * the `admins` that should have followed them. Nothing the lost write
   * would have recorded is needed to recompute it: the `roleFromEnv` mark
   * lives with the role it explains, and `admins`/`managedAdmins` are reconciled
   * again from the option and the roles on every call.
   *
   * Called after every write to the provider's state and once at startup,
   * which between them cover every way an account can appear, change role or
   * go — and, since it is idempotent, the startup call is also the migration
   * for a deployment that predates any of this.
   */
  const keptLogged = new Set<string>()

  async function reconcileAdminState(): Promise<void> {
    const result = reconcileAdminAndIssuer(withLocalAdminHash(admin), oidc, options.admins)

    // Once per id and reason per process: this runs after every write to
    // the provider's state, token refreshes included.
    for (const { id, reason } of result.kept) {
      const line = `hermie-web: ${id}: ${reason}.`

      if (!keptLogged.has(line)) {
        keptLogged.add(line)
        console.warn(line)
      }
    }

    if (result.oidc !== oidc) {
      oidc = result.oidc
      await saveOidcState(options.stateDir, result.oidc)
    }

    if (result.admin !== admin) {
      admin = result.admin
      await saveAdminState(options.stateDir, result.admin)
    }
  }

  const writeOidc = async (next: OidcState): Promise<void> => {
    oidc = next
    await saveOidcState(options.stateDir, next)
    await reconcileAdminState()
  }

  const oidcProvider = new OidcProvider({ read: () => oidc, write: writeOidc })
  const oidcRouter = new OidcRouter({
    provider: oidcProvider,
    read: () => oidc,
    write: writeOidc,
    // The team's own name where one is set, so the sign-in page a reader lands
    // on says what they think they are signing in to rather than what we call
    // it. The same fallback `brandOf` uses, so the provider's pages and the
    // administration's call one deployment one thing.
    issuerName: () => admin.branding.name || 'Hermie',
    /*
      Where the provider's own pages send somebody onward.

      The root of this origin, which is where the app is served from — NOT
      `--login-return`. That one is a path on the gateway's vhost which the
      gateway redirects back here, so resolving it against this origin would be
      a link to something this service does not answer for.
    */
    appPath: '/'
  })

  /**
   * Throw away what `/setup` wrote.
   *
   * The list is short and each line is a file, which is the only way to keep it
   * honest: the saved gateway, everything `/admin` holds, and the service login.
   * What it does NOT touch is the built-in identity provider — `/setup` never
   * wrote `oidc.json`, and discarding an issuer's signing key because somebody
   * wanted to re-run a wizard would sign out every account on the gateway.
   *
   * The message cache and the push key are each behind a tick, because each has
   * a cost an operator may not want: a cold cache for everybody, and a VAPID key
   * change that orphans every browser registration ever handed out.
   */
  async function resetSetup(choices: { cache: boolean; push: boolean }): Promise<{ setupOpen: boolean }> {
    admin = emptyAdminState()
    await saveAdminState(options.stateDir, admin)
    await rm(path.join(options.stateDir, SETUP_FILE), { force: true })

    const held = await loadPushState(options.stateDir)

    if (choices.push) {
      await savePushState(options.stateDir, { v: PUSH_STATE_VERSION, seq: {}, sent: {}, invalid: {}, tickets: [] })
    } else {
      // The service login and nothing else: `oidc` is the stored refresh token,
      // and it is what `/setup` put there.
      const { oidc: _serviceLogin, ...rest } = held

      await savePushState(options.stateDir, rest)
    }

    if (choices.cache) {
      await cache.clear()
    }

    if (!gatewayFromFlag) {
      configured = false
      probeCache = null
      freshProbe = null
    }

    console.warn(
      `hermie-web: the setup was reset through /admin; ${
        gatewayFromFlag ? 'the gateway from the command line was kept' : '/setup is open again'
      }.`
    )

    return { setupOpen: !gatewayFromFlag }
  }

  const adminRouter = new AdminRouter({
    stateDir: options.stateDir,
    // One authority in this process: the variable above. See the option's note.
    read: () => admin,
    gatewayUrl: () => target.gatewayUrl,
    identities,
    bots: () => (push?.watcher?.watched ?? []).map(bot => bot.name),
    clearCache: () => cache.clear(),
    status: async () => {
      const release = options.selfUpdate ? await releases.get().catch(() => null) : null

      return {
        version: options.version,
        serviceLogin: Boolean(push?.credentials.mode === 'oidc' || options.gatewayToken),
        pushRunning: Boolean(push),
        vapidPresent: Boolean(push?.vapidPublicKey),
        cacheEnabled: cache.enabled,
        cacheEntries: cache.count,
        cacheBytes: cache.size,
        cacheMaxBytes: Math.round(options.cacheMaxMb * 1024 * 1024),
        cacheHits: cache.hits,
        cacheMisses: cache.misses,
        gatewayUrl: target.publicUrl,
        updateAvailable: Boolean(release && release.version !== options.version),
        latestVersion: release?.version ?? '',
        canSelfUpdate: shape.canSelfUpdate,
        updateReason: shape.reason ?? '',
        usersFrom: 'seen'
      }
    },
    resetSetup,
    setupReopens: () => !gatewayFromFlag,
    update: async () => {
      if (!shape.canSelfUpdate) {
        return shape.reason || 'This install cannot update itself.'
      }

      const release = await releases.get({ force: true })

      if (!release) {
        return 'The release listing could not be read.'
      }

      await applyUpdate({ installRoot: options.installRoot, release })

      const restart = input.restart ?? (() => restartProcess({ supervised: isSupervised() }))
      setTimeout(restart, 100).unref()

      return `Updating to ${release.version}; this service is restarting.`
    },
    oidc: {
      provider: oidcProvider,
      read: () => oidc,
      allowInsecure: options.allowInsecureOidc,
      // The gateway's own public URL, which is the only thing the one
      // registered redirect URI can be built from (upstream's `_redirect_uri`).
      gatewayPublicUrl: () => target.publicUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
    },
    onChanged: next => {
      admin = next
      // Retention is a setting rather than a flag, so it is applied when it
      // changes rather than on a timer nobody can see.
      void cache.sweep(next.cache.retentionHours * 3600).catch(() => undefined)
    },
    envAdmins: () => options.admins
  })

  /*
    One reconcile, one write at most: HERMIE_ADMINS, HERMIE_LOCAL_ADMIN_PASSWORD_HASH
    and the issuer's roles are all brought into step with `admins` before
    anything is written — see `reconcileAdminState`. It is also the migration
    for a state directory written before any of this existed: a deployment
    already in step pays the comparisons and writes nothing.
  */
  await reconcileAdminState()

  // Warm the release listing at startup so the first Settings visit is instant,
  // and never let its failure take the server down with it.
  if (options.selfUpdate) {
    void releases.get().catch(() => undefined)
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        json(response, 500, { error: 'hermie_web_failed', detail: String(error) })

        return
      }

      response.end()
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const method = request.method ?? 'GET'

    if (url.pathname === '/healthz') {
      json(response, 200, { ok: true, version: options.version })

      return
    }

    if (url.pathname === '/hermie/config.json') {
      await handleConfig(response)

      return
    }

    /*
      The built-in identity provider (ADR-0025 part 3).

      Ahead of `/admin` and ahead of the proxy, and reachable on an UNCONFIGURED
      process too: `/oidc` answers for itself and needs no gateway. It answers
      404 for every path while it is disabled, which is every deployment that
      has not turned it on.
    */
    if (oidcRouter.owns(url.pathname)) {
      await oidcRouter.handle(request, response, url)

      return
    }

    if (adminRouter.owns(url.pathname)) {
      if (!configured) {
        // Nothing to administer and nobody to check against: the gateway is
        // what this page's gate is built on.
        json(response, 503, { error: 'setup_required', detail: 'This Hermie Web has no gateway yet. Open /setup.' })

        return
      }

      await adminRouter.handle(request, response, url)

      return
    }

    if (url.pathname === '/hermie/update') {
      await handleUpdate(request, response, method, url)

      return
    }

    if (url.pathname.startsWith('/hermie/cache/')) {
      await handleCacheRead(request, response, method, url)

      return
    }

    if (url.pathname === '/setup' || url.pathname.startsWith('/hermie/setup/')) {
      await handleSetup(request, response, method, url)

      return
    }

    /*
      Nothing to proxy TO yet.

      Without this the default gateway — the port `hermes serve` usually takes —
      would be dialled by an install that has never been told about a gateway at
      all, and the browser would read the connection failure as "your gateway is
      down" rather than as "nobody has set this up". The status code is the one
      the app already treats as "the gateway is not answering", and the body
      names the page that fixes it.
    */
    if (!configured && isGatewayPath(url.pathname)) {
      json(response, 503, {
        error: 'setup_required',
        detail: 'This Hermie Web has no gateway yet. Open /setup.'
      })

      return
    }

    if (url.pathname === PUSH_PUBLIC_KEY_PATH) {
      // The browser build needs this before it can subscribe, and it has
      // nowhere else to get it: the key is the daemon's, generated on its first
      // run, and the app never talks to the daemon by any other route.
      if (!push?.vapidPublicKey) {
        json(response, 503, {
          error: 'push_unavailable',
          detail: 'This Hermie Web is not running the push daemon (start it with --push).'
        })

        return
      }

      json(response, 200, { publicKey: push.vapidPublicKey, version: options.version })

      return
    }

    if (isGatewayPath(url.pathname)) {
      /*
        `--no-oidc` / `HERMIE_OIDC=0`: which gateway route is this, really?

        DECIDED ON: the raw request target (`request.url`, the bytes exactly as
        they arrived), split at its first `?`. The path half is decoded ONCE by
        `canonicalGatewayPath` — the same single pass uvicorn makes before the
        gateway routes — and the query half is read with `URLSearchParams`, the
        same `&`/`=`/`+`/percent rules Starlette's `parse_qsl` applies.

        FORWARDED: that same raw target, byte for byte, behind the gateway's
        own path prefix (`proxyHttp`'s `verbatimPathAndQuery`). Nothing decoded,
        re-encoded or normalised on the way — not even by `URL`, which would
        resolve dot segments and turn a backslash into a slash.

        WHY THEY CANNOT DISAGREE: the gateway decodes the forwarded bytes once;
        the decision decoded the identical bytes once, the same way. The one
        place two single passes could still part ways is a decoded segment
        that is itself decodable or re-parsable — `%256cogin` → `%6cogin`,
        `login%3F…` → `login?…`, `login%23…` → `login#…`, an encoded `/` or `\`,
        a `.`/`..` — and every one of those is refused with a 400 before any
        decision, along with any target that is not visible ASCII in origin
        form. A parameter the decision reads (`provider`) that appears twice is
        refused as well: the gateway binds the LAST one, `get()` reads the
        first. An earlier version decided on a decoded path and then forwarded
        THAT, so the gateway decoded it a second time; that is the gap this
        closes.

        Scoped to `!options.oidc`: with OIDC on there is no decision here for an
        encoding to slip past, and the proxy forwards what it always has.
      */
      let verbatimPathAndQuery: string | undefined

      if (!options.oidc) {
        const rawTarget = request.url ?? '/'
        const split = splitRequestTarget(rawTarget)
        const canonicalPath = split ? canonicalGatewayPath(split.path) : null

        if (!split || canonicalPath === null) {
          json(response, 400, { error: 'bad_path', detail: 'That path could not be safely decoded.' })

          return
        }

        const query = new URLSearchParams(split.query)
        // `/auth/native/authorize` needs the gateway's provider list, and reads
        // it fresh: it is one request per sign-in, and a list up to a minute
        // stale is a list the gateway may already have changed its answer on.
        const sessionProviders =
          canonicalPath === NATIVE_AUTHORIZE_PATH ? ((await gatewayProbe({ fresh: true }))?.providers ?? []) : []
        const decision = oidcRouteDecision(canonicalPath, query, sessionProviders)

        if (decision === 'ambiguous') {
          json(response, 400, {
            error: 'ambiguous_query',
            detail: 'A sign-in parameter was given more than once.'
          })

          return
        }

        if (decision === 'refuse') {
          /*
            The gateway's own OIDC/SSO browser routes, refused here too, not
            merely hidden by the app — so typing the URL by hand, encoded or
            not, does not start one through this Hermie Web either.
            Everything else under `/auth` and `/api`, including
            `/auth/password-login` and the gateway's own `/login` form (where
            native sign-in with a password provider lands), keeps proxying
            exactly as before.
          */
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          response.end('Sign-in with SSO is turned off on this Hermie Web.')

          return
        }

        verbatimPathAndQuery = rawTarget
      }

      /*
        The one thing a proxy CAN police, and the honest limit on it.

        `readOnly` is a service-level setting (see `admin/access.ts`): it
        refuses every mutating request that arrives over HTTP — which is the
        REST surface and the file uploads — and it cannot touch the gateway
        WebSocket, which is a raw byte pipe by design (ADR-0015). The admin page
        says so beside the switch, because an operator who reads it as a
        security boundary has been misled by us rather than by themselves.

        The identity is read for this and for the seen-list, and it is the same
        memoised round trip the cache tee makes, so a page load costs one.
      */
      const who = await identities.read({ gatewayUrl: target.gatewayUrl, cookie: request.headers.cookie })

      noteSeen(who)

      if (who && !mayProxyMethod(optionsFor(admin, who.userId).readOnly, method)) {
        json(response, 403, {
          error: 'read_only',
          detail: 'This Hermie Web is configured to accept only reads from this account.'
        })

        return
      }

      proxyHttp(request, response, target, observeForCache(method, url, request.headers.cookie), verbatimPathAndQuery)

      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      json(response, 405, { error: 'method_not_allowed' })

      return
    }

    // The app cannot render anything useful against a gateway that does not
    // exist, so the root is the setup page until there is one.
    if (!configured && url.pathname === '/') {
      response.writeHead(302, { location: '/setup', 'cache-control': 'no-store' })
      response.end()

      return
    }

    if (await serveStatic({ root: options.staticDir, pathname: url.pathname, method, response })) {
      return
    }

    if (await serveIndex(options.staticDir, method, response)) {
      return
    }

    json(response, 404, {
      error: 'no_web_build',
      detail: `There is no web build at ${options.staticDir}. Run \`npm run web:build\`, or pass --static.`
    })
  }

  /**
   * What the gateway's public surface says today, at most once a minute.
   *
   * A failure is cached as "nothing known" rather than retried on every load:
   * the app falls back to probing the gateway itself, which is what the browser
   * build did before this endpoint existed, so a gateway that is briefly down
   * costs a slower sign-in screen and never a stuck one.
   */
  async function gatewayProbe({ fresh = false }: { fresh?: boolean } = {}): Promise<SetupProbe | null> {
    if (!configured) {
      return null
    }

    if (!fresh && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
      return probeCache.probe
    }

    /*
      "Fresh" still means at most one probe in flight and one per
      `FRESH_PROBE_TTL_MS`: `/auth/native/authorize` asks for it on every hit,
      and an unauthenticated client hammering that route must not turn each
      request into two more against the gateway. Callers inside the window
      share one answer — a failure for only `FAILED_PROBE_TTL_MS`, so a
      gateway that is back is seen again within a second.
    */
    if (
      freshProbe &&
      (!freshProbe.settledAt ||
        Date.now() - freshProbe.settledAt < (freshProbe.failed ? FAILED_PROBE_TTL_MS : FRESH_PROBE_TTL_MS))
    ) {
      return freshProbe.probe
    }

    const current: { probe: Promise<SetupProbe | null>; settledAt: number; failed: boolean } = {
      settledAt: 0,
      failed: false,
      probe: Promise.resolve(null)
    }

    current.probe = (async () => {
      try {
        // With the same `Host` every proxied request carries (`upstreamHeaders`),
        // so a gateway with its Host guard armed answers this too.
        const probe = await probeGateway(target.gatewayUrl, probeFetch(new URL(target.publicUrl).host))
        probeCache = { at: Date.now(), probe }

        return probe
      } catch {
        current.failed = true

        return null
      } finally {
        current.settledAt = Date.now()
      }
    })()
    freshProbe = current

    return current.probe
  }

  /**
   * The bootstrap the browser build reads before it renders anything
   * (ADR-0025): where the gateway is, what it takes to sign in to it, what this
   * service is running, and which Hermie Web this is.
   *
   * Everything here is either public or about this process. Nothing in it
   * depends on who is asking, which is why it is answered without a session —
   * the sign-in screen has to be able to draw itself before there is one.
   */
  async function handleConfig(response: ServerResponse): Promise<void> {
    const probe = await gatewayProbe()

    json(response, 200, {
      gatewayHost: new URL(target.publicUrl).host,
      gatewayOrigin: new URL(target.publicUrl).origin,
      // `''` means "send no next= at all" — the default under `--pass-host`,
      // where the sign-in finishes on this origin anyway.
      loginReturn: options.loginReturn,
      // Whether the gateway is being sent THIS origin (`--pass-host`, and the
      // gateway accepted it), and what that origin is: the configured
      // `--web-public-url`, or `null`. Never the request's own Host — a value
      // a caller chose is not this service's to publish as its origin.
      passHost: target.passHostOrigin !== null,
      origin: options.webPublicUrl || null,
      version: options.version,
      setupRequired: !configured,
      // Whether the GATEWAY's own OIDC/SSO providers are reachable through
      // this Hermie Web (`--no-oidc` / `HERMIE_OIDC`). The shared app code
      // reads this to leave those providers out of the sign-in screen and the
      // connect wizard; the proxy itself refuses the two browser routes below
      // regardless of what the app does with this field.
      oidc: options.oidc,
      // `null` and `[]` are different answers and the app reads them as such:
      // an empty list is a gateway that asks for nothing, `null` is a gateway
      // we could not read, and only the second means "probe it yourself".
      authRequired: probe ? probe.authRequired : null,
      authKinds: probe ? probe.authFlows : null,
      providers: probe ? probe.providers : null,
      service: {
        /** A stored service sign-in, which is what push and the cache are spent on. */
        login: Boolean(push?.credentials.mode === 'oidc' || options.gatewayToken),
        push: Boolean(push),
        // The flag can turn the cache off for the app without deleting what is
        // already on disk, which is what makes it a flag rather than a restart.
        cache: cache.enabled && admin.flags.messageCache
      },
      /*
        What this team's build looks like and which service features are on
        (ADR-0025's part 2). Both are read by the app BEFORE it draws anything,
        beside the auth fields above, and both are omitted when nobody has set
        them — an absent key is "the app decides", which is not the same answer
        as an empty string.
      */
      ...(admin.branding.name || admin.branding.accent || admin.branding.theme
        ? {
            branding: {
              ...(admin.branding.name ? { name: admin.branding.name } : {}),
              ...(admin.branding.accent ? { accent: admin.branding.accent } : {}),
              ...(admin.branding.theme ? { theme: admin.branding.theme } : {})
            }
          }
        : {}),
      flags: { ...admin.flags, selfUpdate: admin.flags.selfUpdate && options.selfUpdate }
    })
  }

  /**
   * One session's cached tail, for the seam that paints a chat before the
   * socket has answered (ADR-0025).
   *
   * **It requires the caller's own gateway session**, checked the same way
   * `POST /hermie/update` checks it: by putting their cookies to
   * `/api/auth/me`. The cache is gateway-wide rather than per person — there is
   * no ownership field to key it on — but "shared among everyone signed in to
   * this gateway" is a long way from "readable by anything that can reach this
   * port", and this is the check that keeps those two apart.
   *
   * The key may be the runtime session id, the stored session id or the bot's
   * profile name. All three name one chat, because by ADR-0007 there is one
   * canonical Bot Chat per bot — and the seam in the browser holds the bot's
   * name, not a session id, at the moment it has to ask.
   */
  async function handleCacheRead(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL
  ): Promise<void> {
    if (method !== 'GET') {
      json(response, 405, { error: 'method_not_allowed' })

      return
    }

    if (!cache.enabled || !admin.flags.messageCache) {
      json(response, 404, { error: 'cache_disabled' })

      return
    }

    if (!configured) {
      json(response, 503, { error: 'setup_required' })

      return
    }

    /*
      The session check applies to a gateway that HAS sessions.

      On an ungated one there is no cookie to present and no identity to check:
      `/api/sessions/<id>/messages` is proxied to anyone who can reach this
      port, so refusing the cached copy of the same rows would protect nothing
      and turn the cache off for every ungated deployment. A gateway we could
      not read is treated as gated, because the safe reading of "unknown" is the
      one that asks for a credential.
    */
    const probe = await gatewayProbe()
    const identity = await identities.read({ gatewayUrl: target.gatewayUrl, cookie: request.headers.cookie })

    if (probe?.authRequired !== false && !identity) {
      json(response, 401, { error: 'unauthorized' })

      return
    }

    const key = decodeURIComponent(url.pathname.slice('/hermie/cache/'.length))
    /*
      A bot this reader may not reach is not served from here.

      This is one of the two places a service-level allow list is COMPLETE
      rather than advisory (the other is push): the cache is ours, so nothing
      has to be policed on a pipe we do not read.

      The check is on the ENTRY's bot rather than on the key, because the key
      may be a session id and only the entry knows which bot it belongs to. A
      private chat has no bot on it at all and is already gated by its owner,
      which is the stronger check of the two.
    */
    const permissions = optionsFor(admin, identity?.userId ?? '')
    /*
      The reader's own name goes in, and the cache decides.

      A shared Bot Chat answers to anybody signed in, which is what ADR-0025
      settled and why the check above is "signed in" rather than "signed in as
      somebody in particular". A conversation that belongs to one person answers
      to that person and comes back as a MISS to everybody else — see
      `TranscriptCache.get`.
    */
    const entry = await cache.get(key, identity?.userId ?? '')

    if (!entry) {
      json(response, 404, { error: 'not_cached' })

      return
    }

    if (entry.bot && !mayReachBot(permissions, entry.bot)) {
      json(response, 404, { error: 'not_cached' })

      return
    }

    json(response, 200, {
      sessionId: entry.sessionId,
      bot: entry.bot,
      storedId: entry.storedId,
      // The transport the rows came off. `rowsToItems` needs it, and reading a
      // REST tail as an RPC one loses every row id — which is precisely what
      // would make the reconcile hand out new ids and move the view.
      shape: entry.shape,
      updatedAt: entry.updatedAt,
      rows: entry.rows
    })
  }

  /**
   * Copy a proxied transcript read into the cache on its way past.
   *
   * This is the half of the feed that works with no `--push` at all: the app
   * asks for a long chat's tail, the gateway answers it, and the same bytes
   * that paint this browser's chat become the thing that paints the next one's.
   * Nothing is added to the request and nothing is changed in the answer.
   */
  function observeForCache(method: string, url: URL, cookie: string | undefined): ProxyObserver | undefined {
    if (!cache.enabled || method !== 'GET') {
      return undefined
    }

    const sessionId = sessionIdOfMessagesPath(url.pathname)

    if (!sessionId) {
      return undefined
    }

    return upstream => {
      if (
        !isCapturableAnswer({
          statusCode: upstream.statusCode,
          contentType: String(upstream.headers['content-type'] ?? ''),
          contentEncoding: String(upstream.headers['content-encoding'] ?? '')
        })
      ) {
        return null
      }

      const chunks: Buffer[] = []
      let size = 0
      let abandoned = false

      return chunk => {
        if (abandoned) {
          return
        }

        if (chunk) {
          size += chunk.length

          if (size > MAX_CAPTURE_BYTES) {
            // A transcript larger than the cap is a transcript this cache has
            // no business holding. Drop the copy and keep the buffers.
            abandoned = true
            chunks.length = 0

            return
          }

          chunks.push(chunk)

          return
        }

        try {
          const rows = rowsOfMessagesBody(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)

          /*
            The bytes are stored under the NAME OF WHOEVER ASKED FOR THEM.

            A response body says nothing about which conversation it is, and
            since ADR-0007's amendment a profile has two kinds: the canonical
            Bot Chat everybody shares, and `Chat · <name>`, which is one
            person's. So the tee cannot tell, and the safe half of the guess is
            the one it makes — private to the reader, unless the service link
            has already named this session as a bot's canonical chat, which is
            the one case where the cache KNOWS it is shared. `cache.write` holds
            that rule; here we only supply the name.

            On an ungated gateway there is nobody to name and the entry is
            shared, which is the behaviour ADR-0025 described and the only one a
            gateway with no accounts can have.
          */
          void identities
            .read({ gatewayUrl: target.gatewayUrl, cookie })
            .then(identity =>
              cache.put({
                sessionId,
                bot: '',
                owner: identity?.userId ?? '',
                storedId: '',
                shape: 'rest',
                rows,
                updatedAt: 0
              })
            )
            .catch(() => undefined)
        } catch {
          // Not the answer we thought it was. Nothing is stored, and the
          // browser already has the bytes.
        }

        chunks.length = 0
      }
    }
  }

  /**
   * The operator setup page and its three calls, alive only while no gateway is
   * configured.
   *
   * The 404 is deliberate rather than a 403: once this deployment is set up,
   * these paths do not exist, and a page that says "forbidden" invites somebody
   * to go looking for the way in.
   */
  async function handleSetup(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL
  ): Promise<void> {
    if (configured) {
      json(response, 404, { error: 'not_found' })

      return
    }

    if (url.pathname === '/setup') {
      if (method !== 'GET' && method !== 'HEAD') {
        json(response, 405, { error: 'method_not_allowed' })

        return
      }

      html(
        response,
        200,
        setupPage({ version: options.version, defaultGateway: options.gatewayUrl, ...webCopy(request) })
      )

      return
    }

    if (url.pathname === SETUP_CALLBACK_PATH) {
      await handleSetupCallback(request, response, url)

      return
    }

    if (method !== 'POST') {
      json(response, 405, { error: 'method_not_allowed' })

      return
    }

    let body: Record<string, unknown>

    try {
      body = await readJsonBody(request)
    } catch (error) {
      json(response, 400, { error: 'bad_request', detail: String(error) })

      return
    }

    let gatewayUrl: string

    try {
      gatewayUrl = normalizeGatewayInput(typeof body.gateway === 'string' ? body.gateway : '')
    } catch (error) {
      json(response, 400, { error: 'bad_gateway_address', detail: (error as Error).message })

      return
    }

    if (url.pathname === '/hermie/setup/probe') {
      try {
        json(response, 200, { gateway: gatewayUrl, probe: await probeGateway(gatewayUrl, fetchImpl) })
      } catch (error) {
        json(response, 400, { error: 'probe_failed', detail: (error as Error).message })
      }

      return
    }

    if (url.pathname === '/hermie/setup/login') {
      const pkce = createPkce()
      const redirectUri = `${ownOrigin(request)}${SETUP_CALLBACK_PATH}`
      pendingLogin = { ...pkce, gatewayUrl, redirectUri }

      json(response, 200, {
        authorizeUrl: buildAuthorizeUrl(gatewayUrl, {
          challenge: pkce.challenge,
          state: pkce.state,
          redirectUri,
          ...(typeof body.provider === 'string' && body.provider ? { provider: body.provider } : {})
        })
      })

      return
    }

    if (url.pathname === '/hermie/setup/save') {
      /*
        Whoever completes the setup becomes this service's first administrator.

        It is the one moment the process can point at somebody without being
        told: the operator is standing in front of the page, and on a gateway
        with accounts their cookie names them. On one without — a token gateway,
        an ungated one — there is nobody to name, so the form may carry a local
        administrator secret instead, which is stored as a scrypt hash and is
        the only way back to `/admin` on that deployment.
      */
      const operator = await identities.read({ gatewayUrl, cookie: request.headers.cookie, fresh: true })
      const secret = typeof body.adminSecret === 'string' ? body.adminSecret : ''

      // `HERMIE_LOCAL_ADMIN_PASSWORD_HASH` is the container's own answer to
      // "what is the local administrator secret" — `/setup` accepting a
      // plaintext one here would let a browser silently overwrite it with
      // something the container's configuration never approved, the one
      // path `enforceLocalAdminHash` cannot re-correct until the NEXT start.
      if (secret && options.localAdminPasswordHash) {
        json(response, 400, {
          error: 'local_admin_managed',
          detail:
            'This container sets its own local administrator secret (HERMIE_LOCAL_ADMIN_PASSWORD_HASH); ' +
            'leave that field blank here.'
        })

        return
      }

      let next = admin

      if (operator?.userId) {
        next = withAdmin(next, operator.userId)
      }

      if (secret) {
        next = { ...next, localAdmin: hashLocalSecret(secret) }
      }

      if (next !== admin) {
        admin = next
        await saveAdminState(options.stateDir, next)
      }

      await writeSetup(options.stateDir, {
        gatewayUrl,
        publicUrl: typeof body.publicUrl === 'string' ? body.publicUrl : '',
        savedAt: Math.floor(Date.now() / 1000)
      })

      // The single transition. `publicUrl` is recomputed from the gateway the
      // same way `resolveOptions` would have, because the operator gave one or
      // they did not and the derivation is the same either way.
      target.gatewayUrl = new URL(gatewayUrl).toString()
      target.publicUrl =
        typeof body.publicUrl === 'string' && body.publicUrl
          ? new URL(body.publicUrl).origin
          : new URL(gatewayUrl).origin
      configured = true
      probeCache = null
      freshProbe = null

      console.warn(`hermie-web: gateway set to ${target.gatewayUrl} through /setup; /setup is now closed.`)
      void checkPassHost()
      // Push and the cache hold a connection that was not started, because at
      // startup there was nothing to connect to. Said plainly rather than left
      // for the operator to notice from an absence.
      json(response, 200, {
        ok: true,
        gateway: target.gatewayUrl,
        restartFor: options.push ? ['push'] : [],
        // What the page says next: whether there is a way back into `/admin`,
        // and how. A deployment with neither is one nobody can administer, and
        // it should hear that while the operator is still on the page.
        admin: admin.admins.length ? 'gateway' : admin.localAdmin ? 'secret' : 'none'
      })

      return
    }

    json(response, 404, { error: 'not_found' })
  }

  /**
   * The end of the service sign-in, run in the operator's browser instead of on
   * a loopback port.
   *
   * `push/login.ts` is the specification: the same PKCE pair, the same one-time
   * code, and the same refusal when the provider issues no refresh token — an
   * hour-long credential is not a credential a daemon can hold, and storing one
   * would mean push stopping in the night with nothing to say why.
   */
  async function handleSetupCallback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const copy = webCopy(request)
    const text = copy.strings.setup.callback
    const pending = pendingLogin
    pendingLogin = null

    if (!pending) {
      html(
        response,
        400,
        setupCallbackPage({ ...copy, title: text.nothingWaitingTitle, detail: text.nothingWaitingDetail })
      )

      return
    }

    const failure = url.searchParams.get('error')

    if (failure) {
      html(
        response,
        400,
        setupCallbackPage({
          ...copy,
          title: text.failedTitle,
          detail: `${failure}: ${url.searchParams.get('error_description') ?? ''}`
        })
      )

      return
    }

    const code = url.searchParams.get('code')

    if (!code || url.searchParams.get('state') !== pending.state) {
      // Either the redirect carried no code, or somebody else's redirect landed
      // here. Neither is a sign-in, and nothing is stored for either.
      html(response, 400, setupCallbackPage({ ...copy, title: text.failedTitle, detail: text.noCode }))

      return
    }

    try {
      const tokens = await exchangeCode(pending.gatewayUrl, { code, verifier: pending.verifier }, fetchImpl)
      const state = await loadPushState(options.stateDir)

      if (state.oidc && !sameGateway(state.oidc.gateway, pending.gatewayUrl)) {
        // A credential is only meaningful for the gateway it was made on, and
        // so is everything else in that file.
        state.seq = {}
        state.sent = {}
        state.invalid = {}
        state.tickets = []
      }

      state.oidc = { refreshToken: tokens.refreshToken, provider: tokens.provider, gateway: pending.gatewayUrl }
      await savePushState(options.stateDir, state)

      html(response, 200, setupCallbackPage({ ...copy, title: text.signedInTitle, detail: text.signedInDetail }))
    } catch (error) {
      html(response, 400, setupCallbackPage({ ...copy, title: text.failedTitle, detail: (error as Error).message }))
    }
  }

  async function handleUpdate(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL
  ): Promise<void> {
    if (method === 'GET') {
      const release = options.selfUpdate ? await releases.get({ force: url.searchParams.has('refresh') }) : null

      json(response, 200, statusFrom(options.version, release, shape))

      return
    }

    if (method !== 'POST') {
      json(response, 405, { error: 'method_not_allowed' })

      return
    }

    // Order matters: refuse an install we could not perform BEFORE asking the
    // gateway who the caller is, so a Docker deployment never sends a request
    // it has no use for.
    if (!shape.canSelfUpdate) {
      json(response, 409, { error: 'self_update_unavailable', reason: shape.reason ?? '' })

      return
    }

    if (!(await hasGatewaySession({ gatewayUrl: target.gatewayUrl, cookie: request.headers.cookie }))) {
      json(response, 401, { error: 'unauthorized', detail: 'Sign in to the gateway before updating Hermie Web.' })

      return
    }

    if (updating) {
      json(response, 409, { error: 'already_updating' })

      return
    }

    const release = await releases.get({ force: true })

    if (!release) {
      json(response, 503, { error: 'no_release', detail: 'The release listing could not be read.' })

      return
    }

    updating = true

    try {
      await applyUpdate({ installRoot: options.installRoot, release })
    } catch (error) {
      updating = false
      json(response, 500, { error: 'update_failed', detail: String(error) })

      return
    }

    json(response, 200, { restarting: true, version: release.version })
    // Answer first, then go away: the browser has to receive this before the
    // socket dies, or the settings row has nothing to poll `/healthz` about.
    response.on('finish', () => {
      const restart = input.restart ?? (() => restartProcess({ supervised: isSupervised() }))
      setTimeout(restart, 100).unref()
    })
  }

  /*
    Upgrades: WebSockets under `/api`, and nothing else, in either mode.

    Node emits `upgrade` for ANY `Connection: Upgrade`, whatever the Upgrade
    token says, and uvicorn serves every token but `websocket` as plain HTTP
    — so an upgrade path that forwarded anything else was a second, unchecked
    way to reach every gateway route, `/auth/login` and `/auth/callback`
    included, with the gateway's redirect and cookies relayed straight back.
    Hence, in order:

     - Only `GET` with `Upgrade: websocket` (any case) is an upgrade at all;
       everything else is a 400 on the spot.
     - Only a path under `/api` is proxied: every WebSocket route the gateway
       has lives there (`web_routers/chat_ws.py`, `display.py`, `audio.py`),
       and none under `/auth`, `/login` or `/logout`. Anything else is a 404.
     - With `--no-oidc`, the decision is the same one plain HTTP gets — raw
       target split, decoded once, `oidcRouteDecision` — and the raw target is
       what is forwarded, for the same reason (see the HTTP path above).
  */
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (status: string): void => {
      socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
    }

    if (
      request.method !== 'GET' ||
      String(request.headers.upgrade ?? '')
        .trim()
        .toLowerCase() !== 'websocket'
    ) {
      refuse('400 Bad Request')

      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (!isGatewayPath(url.pathname) || !isWebSocketGatewayPath(url.pathname)) {
      refuse('404 Not Found')

      return
    }

    let verbatimPathAndQuery: string | undefined

    if (!options.oidc) {
      const rawTarget = request.url ?? '/'
      const split = splitRequestTarget(rawTarget)
      const canonicalPath = split ? canonicalGatewayPath(split.path) : null

      if (!split || canonicalPath === null) {
        refuse('400 Bad Request')

        return
      }

      // The route the gateway will actually take, decided the way plain HTTP
      // decides it. Under `/api` that is always `allow` today; checked anyway,
      // so a future refused route cannot be reached by upgrading to it.
      if (
        !isWebSocketGatewayPath(canonicalPath) ||
        oidcRouteDecision(canonicalPath, new URLSearchParams(split.query), []) !== 'allow'
      ) {
        refuse('404 Not Found')

        return
      }

      verbatimPathAndQuery = rawTarget
    }

    proxyUpgrade(request, socket, head, target, verbatimPathAndQuery)
  })

  /*
    `--pass-host`: does the gateway accept this origin at all?

    Asked once before anything is served, with exactly the headers a proxied
    request will carry. The gateway's Host guard answers 400 for a host that
    is not one of its listed origins (and not its bound host), which is the
    one clear "no" there is: the pass-through is then switched off and every
    request is rewritten to `--public-url` as before, rather than the whole
    app failing on a 400 per request — and the log says what to add where.

    What this cannot see, and says so instead: a gateway bound to 0.0.0.0
    accepts every Host, so a missing entry there only shows up as the
    gateway's own "matches no listed public origin" warning at the first
    sign-in; and whether the gateway TRUSTS this service as a proxy
    (loopback, or `dashboard.trusted_proxies`), without which it ignores
    `X-Forwarded-Proto` and an https origin never matches. A gateway that
    does not answer at all is asked again every 30 seconds, pass-through
    kept meanwhile.
  */
  async function checkPassHost(): Promise<void> {
    if (!options.passHost || !configured || closed) {
      return
    }

    const origin = new URL(options.webPublicUrl)
    const base = target.gatewayUrl.replace(/\/+$/, '')
    let status: number

    try {
      const answer = await probeFetch(origin.host)(`${base}/api/status`, {
        headers: {
          accept: 'application/json',
          'x-forwarded-host': origin.host,
          'x-forwarded-proto': origin.protocol.replace(':', '')
        },
        signal: AbortSignal.timeout(PASS_HOST_CHECK_TIMEOUT_MS)
      })

      status = answer.status
      await answer.body?.cancel().catch(() => undefined)
    } catch (error) {
      console.warn(
        `hermie-web: --pass-host could not be checked (${String(error)}); sending ${origin.origin} ` +
          'as Host meanwhile and asking again in 30 seconds.'
      )

      if (!closed) {
        passHostRetry = setTimeout(() => void checkPassHost(), PASS_HOST_RETRY_MS)
        passHostRetry.unref()
      }

      return
    }

    if (status === 400) {
      target.passHostOrigin = null
      console.warn(
        `hermie-web: the gateway refused ${origin.origin} as a Host (HTTP 400), so Host and Origin are ` +
          `rewritten to ${target.publicUrl} instead. Add ${origin.origin} to dashboard.public_urls on the gateway.`
      )

      return
    }

    target.passHostOrigin = origin.origin

    const gatewayHost = new URL(target.gatewayUrl).hostname.replace(/^\[|\]$/g, '')

    if (!['127.0.0.1', '::1', 'localhost'].includes(gatewayHost)) {
      console.warn(
        `hermie-web: --pass-host sends ${origin.origin} to ${target.gatewayUrl}. The gateway must trust this ` +
          'service as a proxy (dashboard.trusted_proxies), or it ignores X-Forwarded-Proto and sign-in falls back ' +
          'to its primary origin.'
      )
    }
  }

  await checkPassHost()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const port = (server.address() as AddressInfo).port
  /*
    The daemon is started AFTER the listener is up, and its failure is not the
    server's. A gateway that is briefly unreachable, a state directory that is
    not writable yet — none of those should mean the browser build stops being
    served, because serving it is the thing this process does that nothing else
    can do for it.

    It is also not started on an UNCONFIGURED process, because there is nothing
    to watch: the gateway is a default nobody chose, and a daemon dialling it
    would fill the log with failures about an address the operator has not named
    yet. `/setup` says so when it saves, rather than leaving it to be noticed
    from an absence.
  */
  push =
    options.push && configured
      ? await startPushDaemon({
          gatewayUrl: target.gatewayUrl,
          gatewayToken: options.gatewayToken,
          stateDir: options.stateDir,
          vapidSubject: options.vapidSubject,
          version: options.version,
          serverRequests: options.pushServerRequests,
          relays: options.pushRelays,
          cache,
          /*
            The operator's per-person rules, read at send time (ADR-0025 part
            2). `admin` is reassigned whenever `/admin` saves, so this closure
            sees the current answer rather than the one that existed when the
            daemon started.

            An owner of `''` is a device registered under the legacy anonymous
            key: nobody to have decided anything about, so nothing is refused.
          */
          policy: () => admin.push,
          allowedTo: (owner, bot) => {
            if (!owner) {
              return true
            }

            const rules = optionsFor(admin, owner)

            return rules.pushAllowed && mayReachBot(rules, bot)
          },
          ...(input.socketFactory ? { socketFactory: input.socketFactory } : {})
        }).catch((error: unknown) => {
          console.error(`hermie-web: push did not start — ${String(error)}`)

          return null
        })
      : null

  return {
    url: `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${port}`,
    port,
    options,
    push,
    cache,
    oidc: oidcProvider,
    close: async () => {
      closed = true

      if (passHostRetry) {
        clearTimeout(passHostRetry)
      }

      await push?.stop().catch(() => undefined)
      await closeServer(server)
    }
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}
