/**
 * What the Hermie Web server tells the app about itself: `GET /hermie/config.json`.
 *
 * It began as three labels and is now the browser build's BOOTSTRAP
 * ([ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md)). The
 * gateway is not something a reader names — it is whatever the server in front
 * of this page proxies to — so the wizard does not ask for it, and since the
 * server has already read that gateway's `/api/status` it does not have to ask
 * what signing in to it takes either. `loginReturn` is where the server wants a
 * finished sign-in to land (`cookie-sign-in.web.ts` is the only thing that
 * reads it), `version` answers "which Hermie Web am I on" from inside the tab,
 * and `service` says whether the server's own gateway link is up.
 *
 * The fetch stays best-effort, and that is a decision rather than an omission:
 * a missing or malformed answer costs a label and a shortcut, never a
 * connection. The app still talks to its own origin — the one address that
 * cannot be wrong — and a sign-in step with no `authKinds` probes the gateway
 * itself, exactly as this build did before the field existed.
 *
 * Everything shared with the native half comes from `web-config.shared.ts` and
 * never from `./web-config`, which from inside this file is this file. See that
 * module for what that spelling cost.
 */
import type { AuthProvider } from '@hermie/gateway-client'

import type { HermieWebBranding, HermieWebConfig, HermieWebFlags, HermieWebService } from './web-config.shared'

export type { HermieWebBranding, HermieWebConfig, HermieWebFlags, HermieWebService } from './web-config.shared'
export { probeFromWebConfig } from './web-config.shared'

export const WEB_GATEWAY_BASE_URL: string | null = typeof window === 'undefined' ? null : window.location.origin

let cached: Promise<HermieWebConfig | null> | null = null

export function loadHermieWebConfig(): Promise<HermieWebConfig | null> {
  if (!cached) {
    cached = fetchConfig().catch(() => null)
  }

  return cached
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A list of strings, or `null` for anything that is not one — including a missing field. */
function stringsOrNull(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null
}

function providersOrNull(value: unknown): AuthProvider[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  return value
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map(row => ({
      name: str(row.name),
      displayName: str(row.displayName) || str(row.name),
      supportsPassword: row.supportsPassword === true
    }))
    .filter(provider => provider.name.length > 0)
}

function serviceOf(value: unknown): HermieWebService {
  const row = (Boolean(value) && typeof value === 'object' ? value : {}) as Record<string, unknown>

  return { login: row.login === true, push: row.push === true, cache: row.cache === true }
}

/** Nothing set is `null`, not an empty branding — the two mean different things. */
function brandingOf(value: unknown): HermieWebBranding | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const row = value as Record<string, unknown>
  const out: HermieWebBranding = {
    ...(str(row.name) ? { name: str(row.name) } : {}),
    ...(str(row.accent) ? { accent: str(row.accent) } : {}),
    ...(str(row.theme) ? { theme: str(row.theme) } : {})
  }

  return Object.keys(out).length ? out : null
}

/**
 * The flags, read so that an ABSENT one is on.
 *
 * A Hermie Web too old to send the object at all answers `null` and the app
 * behaves exactly as it did before flags existed. A field the server did not
 * send inside an object it did send is also on, for the same reason: a build
 * that has never heard of a flag must not be switched off by its absence.
 */
function flagsOf(value: unknown): HermieWebFlags | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const row = value as Record<string, unknown>

  return {
    userChats: row.userChats !== false,
    messageCache: row.messageCache !== false,
    selfUpdate: row.selfUpdate !== false
  }
}

async function fetchConfig(): Promise<HermieWebConfig | null> {
  const response = await fetch('/hermie/config.json', { headers: { accept: 'application/json' } })

  if (!response.ok) {
    return null
  }

  const body = (await response.json()) as Record<string, unknown>

  return {
    gatewayHost: str(body.gatewayHost),
    // An older Hermie Web serving a newer bundle answers without it; the host
    // on its own is still a truthful label, just not a qualified one.
    gatewayOrigin: str(body.gatewayOrigin),
    loginReturn: str(body.loginReturn),
    passHost: body.passHost === true,
    origin: str(body.origin),
    version: str(body.version),
    setupRequired: body.setupRequired === true,
    authRequired: typeof body.authRequired === 'boolean' ? body.authRequired : null,
    authKinds: stringsOrNull(body.authKinds),
    providers: providersOrNull(body.providers),
    // Absent (an older server) reads as on, same as every other flag here.
    oidc: body.oidc !== false,
    service: serviceOf(body.service),
    branding: brandingOf(body.branding),
    flags: flagsOf(body.flags)
  }
}
