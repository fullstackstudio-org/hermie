/**
 * The two routes of the gateway's MCP endpoint that the page uses
 * (`contract/gateway/mcp.md`, sections 2 and 3): the read of what the gateway
 * says about its endpoint and the clients connected to it, and revoking one
 * client. The page never speaks MCP and builds nothing from the endpoint: the
 * command and the config are the gateway's own text.
 *
 * On the page's own origin with the cookie session (`credentials: 'same-origin'`),
 * so the browser sends the `Origin` the gateway checks on every cookie write.
 * Not through `GatewayHttp`: the page needs the refusal's `error` word (`no_identity`,
 * `not_found`), which that class does not keep.
 *
 * Every string in an answer is somebody else's text (a client's name, an
 * address): it is read as a string and nothing more, and nothing here logs a
 * body.
 */
import type { FetchLike } from '@hermie/gateway-client'

/** One MCP client the person has allowed. Nullable fields are `null` when the gateway has no value. */
export interface McpGrant {
  /** Opaque, `[A-Za-z0-9_-]{1,64}`: the key for revoking. */
  id: string
  /** The name the client registered under. Untrusted. */
  clientName: string
  clientId: string
  scopes: readonly string[]
  /** Unix seconds. */
  createdAt: number
  createdIp: string | null
  createdUserAgent: string | null
  lastUsedAt: number | null
  lastUsedIp: string | null
  /** Unix seconds: when the person must allow it again. `null` when the gateway did not say. */
  expiresAt: number | null
}

/** `GET /api/auth/mcp`, as the page keeps it. */
export interface McpStatus {
  endpointUrl: string
  issuer: string
  label: string
  /** The gateway's add command (`claude_command`), ready to copy. Shown and copied as text, never run. */
  command: string
  /** The `.mcp.json` fragment as text. Copied verbatim. */
  configJson: string
  /** English prose for the person. Plain text. */
  instructions: string
  /** Newest first, as the gateway sent them. */
  grants: readonly McpGrant[]
}

/** Why a call did not do what it was asked. */
export class McpRouteError extends Error {
  constructor(
    /**
     * `not_offered`: the gateway has no MCP endpoint, or it is off (404/405); `no_identity`: signed in without a
     * person (403) or not signed in (401); `refused`: any other answer; `bad_answer`: a 200 that is not the
     * shape; `transport`: no answer.
     */
    readonly kind: 'not_offered' | 'no_identity' | 'refused' | 'bad_answer' | 'transport',
    message: string,
    readonly status = 0,
    /** The route's `error` word (`origin_not_listed`, ...). */
    readonly error = ''
  ) {
    super(message)
    this.name = 'McpRouteError'
  }
}

export interface McpClient {
  status(): Promise<McpStatus>
  /** `revoked`: the gateway ended it; `gone`: it said there is no such grant (so there is none to end). */
  revoke(id: string): Promise<'revoked' | 'gone'>
}

const PREFIX = '/api/auth/mcp'
const GRANT_ID = /^[A-Za-z0-9_-]{1,64}$/u

/** The page's `fetch`, looked up when called. */
const pageFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const secondsOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** One grant, or `null` when it is not shaped like one (unknown keys are ignored). */
export function grantOf(value: unknown): McpGrant | null {
  if (!isRecord(value)) {
    return null
  }

  const id = textOf(value.id)
  const clientName = textOf(value.client_name)
  const createdAt = secondsOf(value.created_at)

  if (id === null || !GRANT_ID.test(id) || clientName === null || createdAt === null) {
    return null
  }

  return {
    id,
    clientName,
    clientId: textOf(value.client_id) ?? '',
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
    createdAt,
    createdIp: textOf(value.created_ip),
    createdUserAgent: textOf(value.created_user_agent),
    lastUsedAt: secondsOf(value.last_used_at),
    lastUsedIp: textOf(value.last_used_ip),
    expiresAt: secondsOf(value.expires_at)
  }
}

/** A 200 body as the page's status, or `null` when it does not have what the page needs. */
export function statusOf(value: unknown): McpStatus | null {
  if (!isRecord(value) || value.enabled !== true) {
    return null
  }

  const endpointUrl = textOf(value.endpoint_url)
  const command = textOf(value.claude_command)
  const configJson = textOf(value.config_json)

  if (endpointUrl === null || command === null || configJson === null) {
    return null
  }

  const grants = Array.isArray(value.grants)
    ? value.grants.flatMap(entry => {
        const grant = grantOf(entry)

        return grant ? [grant] : []
      })
    : []

  return {
    endpointUrl,
    issuer: textOf(value.issuer) ?? '',
    label: textOf(value.label) ?? '',
    command,
    configJson,
    instructions: textOf(value.instructions) ?? '',
    grants
  }
}

/** The routes on the gateway at `baseUrl` (origin plus prefix). `fetchImpl` is the page's own unless a test hands in its own. */
export function createMcpClient(baseUrl: string, fetchImpl: FetchLike = pageFetch): McpClient {
  async function call(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: unknown }> {
    let response: Response

    try {
      response = await fetchImpl(`${baseUrl}${PREFIX}${path}`, {
        method,
        headers: method === 'GET' ? { accept: 'application/json' } : { 'content-type': 'application/json' },
        // The revoke body is `{}`: nothing names a user.
        ...(method === 'POST' ? { body: '{}' } : {}),
        credentials: 'same-origin',
        cache: 'no-store',
        // A redirect is somebody else answering; the session is not followed anywhere.
        redirect: 'manual'
      })
    } catch (error) {
      throw new McpRouteError('transport', error instanceof Error ? error.message : String(error))
    }

    if (response.status === 0 || response.type === 'opaqueredirect') {
      throw new McpRouteError('transport', 'The gateway answered with a redirect.')
    }

    let body: unknown = null

    try {
      body = await response.json()
    } catch {
      body = null
    }

    return { status: response.status, body }
  }

  /** What a refusal says, in its own words: `detail`, else `error`, else the status. */
  function refusal(status: number, body: unknown): McpRouteError {
    const record = isRecord(body) ? body : {}
    const error = textOf(record.error) ?? ''
    const message = textOf(record.detail) || error || `HTTP ${status}`

    if (status === 404 || status === 405) {
      return new McpRouteError('not_offered', message, status, error)
    }

    if (status === 401 || (status === 403 && error === 'no_identity')) {
      return new McpRouteError('no_identity', message, status, error)
    }

    return new McpRouteError('refused', message, status, error)
  }

  return {
    async status() {
      const { status, body } = await call('GET', '')

      if (status !== 200) {
        throw refusal(status, body)
      }

      const parsed = statusOf(body)

      if (!parsed) {
        throw new McpRouteError('bad_answer', 'The gateway’s answer was not what MCP access looks like.', status)
      }

      return parsed
    },

    async revoke(id) {
      if (!GRANT_ID.test(id)) {
        return 'gone'
      }

      const { status, body } = await call('POST', `/grants/${encodeURIComponent(id)}/revoke`)

      if (status === 200) {
        return 'revoked'
      }

      // "No such grant": unknown, somebody else's, already revoked or expired are one answer. It is gone.
      if (status === 404 && isRecord(body) && body.error === 'not_found') {
        return 'gone'
      }

      throw refusal(status, body)
    }
  }
}
