/**
 * The shape of what Hermie Web tells the app about itself, and the one function
 * that reads it. Platform-neutral, and here rather than in `web-config.ts` for a
 * reason worth stating once.
 *
 * `web-config.ts` has a `.web.ts` twin, and a bundler that picks between the two
 * by platform picks the SAME way for a relative import written inside either of
 * them: `./web-config` read from `web-config.web.ts` resolves to
 * `web-config.web.ts` itself. A file that re-exported a value from its own twin
 * therefore re-exported it from itself, and the export became a getter that
 * returned its own getter — so reading the name overflowed the stack before the
 * call. That shipped: the browser build's sign-in step ended with "Maximum call
 * stack size exceeded" on every visit, including the one right after "Forget
 * gateway".
 *
 * So anything BOTH halves need lives in a third file with no platform twin, the
 * way `desktop-shortcuts.shared.ts` already does it. Nothing imports this file
 * directly; import `./web-config` and let the bundler pick.
 */
import type { AuthProvider, ProbeResult } from '@hermie/gateway-client'

/** What Hermie Web reports about its own long-lived gateway link. */
export interface HermieWebService {
  /** A service sign-in is stored, so push and the message cache have a credential. */
  login: boolean
  /** The push daemon is running. */
  push: boolean
  /** The message cache is on. */
  cache: boolean
}

/**
 * What a team's Hermie Web wants its build to look like (ADR-0025, part 2).
 *
 * Every field is optional and an ABSENT one means "the app decides", which is
 * not the same answer as an empty string. A reader who has already chosen a
 * theme or an accent keeps it: this is where the app starts, never an override,
 * because an operator's default that reached back in and undid somebody's
 * choice would be a setting that fights its own reader.
 */
export interface HermieWebBranding {
  /** Shown instead of "Hermie" where the app names itself. */
  name?: string
  /** One of the app's accent names. */
  accent?: string
  /** A theme preset name the app starts on. */
  theme?: string
}

/** Service features an operator turned off for everybody on this deployment. */
export interface HermieWebFlags {
  /** ADR-0007's amendment: the private chat beside the shared Bot Chat. */
  userChats: boolean
  /** Whether the service will serve its message cache to this app at all. */
  messageCache: boolean
  /** Whether Settings may offer the update button. */
  selfUpdate: boolean
}

export interface HermieWebConfig {
  /** The gateway host Hermie Web proxies to, for display only. */
  gatewayHost: string
  /** The same host with its scheme, which is what a label naming an origin wants. */
  gatewayOrigin: string
  /**
   * Where a finished sign-in should put the browser: the `next=` the app hands
   * `/auth/login`.
   *
   * It is the server's to decide because only the server knows the deployment.
   * The gateway's OAuth callback is fixed to its own `dashboard.public_url`, so
   * on an install where Hermie Web answers on another PORT of that host, the
   * redirect at the end of the chain lands on the gateway and not here; the
   * operator points a path there back at Hermie Web and names that path with
   * `--login-return`. `/` on every deployment that shares one origin. `''`
   * under `--pass-host`, where the app sends no `next=` at all.
   */
  loginReturn: string
  /**
   * Whether the server sends the gateway its OWN origin (`--pass-host`) and the
   * gateway accepted it. `false` on every server too old to send the field.
   */
  passHost: boolean
  /** Hermie Web's own origin, as the server knows it; `''` from an older server. */
  origin: string
  /** The Hermie Web version serving this bundle. */
  version: string
  /**
   * No gateway has been chosen server-side yet, so `/setup` is open and this
   * app has nothing to talk to.
   */
  setupRequired: boolean
  /**
   * What the gateway takes, as the SERVER read it — or `null` when it could not
   * be read.
   *
   * The distinction is the whole point of the field. `[]` is a gateway that
   * asks for nothing; `null` is "we do not know", and only `null` makes the app
   * probe the gateway itself.
   * [ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md): with
   * this in hand the browser build skips the address step AND the probe, and
   * opens on the sign-in step.
   */
  authKinds: string[] | null
  authRequired: boolean | null
  providers: AuthProvider[] | null
  /**
   * Whether this Hermie Web will proxy the gateway's own OIDC/SSO browser
   * routes at all (`--no-oidc` / `HERMIE_OIDC`).
   *
   * `true` on every server too old to send the field, which is the same
   * "absence reads as the ordinary behaviour" rule `flags` uses below: a build
   * that has never heard of this switch is unaffected by it. Off, a reader
   * leaves every provider that is not `supportsPassword` out of the sign-in
   * screen and the connect wizard — see `SignInStep.web.tsx` — because the
   * server refuses those routes anyway (a 403 for a URL typed by hand) and an
   * option a browser tab cannot use should not be shown as one.
   */
  oidc: boolean
  service: HermieWebService
  /** Absent on a service that has set none, and on every older one. */
  branding: HermieWebBranding | null
  /**
   * Absent on a Hermie Web too old to send them, which reads as "every feature
   * this build has". A flag nobody set is on; a build that has never heard of
   * a flag is unaffected by it.
   */
  flags: HermieWebFlags | null
}

/**
 * The server's bootstrap read as a probe result, or `null` when it does not
 * carry one.
 *
 * `supportsNativePkce` is reported honestly even though a browser cannot
 * complete that flow — the sign-in step is the thing that refuses it, and it
 * refuses it by name.
 */
export function probeFromWebConfig(config: HermieWebConfig | null): ProbeResult | null {
  if (!config || config.authKinds === null || config.authRequired === null) {
    return null
  }

  return {
    version: '',
    authRequired: config.authRequired,
    authFlows: config.authKinds,
    providers: config.providers ?? [],
    supportsNativePkce: config.authKinds.includes('native_pkce')
  }
}
