import type { IncomingMessage, ServerResponse } from 'node:http'

import { type Identity, userKey } from '../passkey/gateway'
import { GRANT_ID_PATTERN, type McpGateway, type McpGrant } from './store'

/**
 * The two MCP routes the app's Settings page uses, with the shapes, codes and reasons of
 * `contract/gateway/mcp.md` (the fork's `hermes_cli/dashboard_auth/mcp/api_routes.py`):
 *
 *     GET  /api/auth/mcp                       the caller's MCP page: endpoint, command, config, grants
 *     POST /api/auth/mcp/grants/{id}/revoke    revoke one of one's own grants
 *
 * Rules both keep, modelled on the passkey routes:
 *
 * - The gateway has to know the feature (`--mcp`) AND have it on. Otherwise they are not there: 404 for
 *   a GET and 405 for a POST, as for any unknown `/api` path of a gateway without them.
 * - The identity is the gate's: the signed-in account of the cookie or bearer, never a body. Without one
 *   (session-token or ungated mode) the answer is 403 `no_identity`. A caller only ever sees or revokes
 *   their own grants.
 * - A cookie-authenticated write must carry an `Origin` the gateway trusts. A bearer caller (the native
 *   app) is exempt: a browser never attaches one by itself.
 * - A body is a JSON object of at most 16 KiB.
 * - Revoking a grant that is not the caller's, does not exist, is revoked already or has expired is one
 *   answer, 404 `not_found`: there is no way to ask whether somebody else's grant exists.
 */

export const PREFIX = '/api/auth/mcp'
export const BODY_CAP = 16 * 1024

/** Who is calling and how the gate recognised them. */
export interface RouteCall {
  identity: Identity | null
  auth: 'bearer' | 'cookie'
  ip: string
}

class Fail extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly detail: string
  ) {
    super(error)
  }
}

interface Reply {
  status: number
  body: unknown
  headers?: Record<string, string>
}

const NO_STORE = { 'cache-control': 'no-store' }

function send(res: ServerResponse, reply: Reply): void {
  const text = JSON.stringify(reply.body)

  res.writeHead(reply.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...reply.headers
  })
  res.end(text)
}

const failReply = (fail: Fail): Reply => ({
  status: fail.status,
  body: { error: fail.error, detail: fail.detail },
  headers: NO_STORE
})

/** What a gateway without these routes answers for the same request. */
function notFound(method: string, path: string): Reply {
  if (method === 'GET') {
    return { status: 404, body: { detail: `No such API endpoint: ${path}` } }
  }

  return { status: 405, body: { detail: 'Method Not Allowed' }, headers: { allow: 'GET' } }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = req.headers['content-length']

  if (declared !== undefined) {
    const length = Number(declared)

    if (!Number.isFinite(length)) {
      throw new Fail(400, 'bad_request', 'Malformed Content-Length.')
    }

    if (length > BODY_CAP) {
      throw new Fail(413, 'body_too_large', `The body is larger than ${BODY_CAP} bytes.`)
    }
  }

  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    size += (chunk as Buffer).length

    if (size > BODY_CAP) {
      throw new Fail(413, 'body_too_large', `The body is larger than ${BODY_CAP} bytes.`)
    }

    chunks.push(chunk as Buffer)
  }

  let data: unknown

  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  } catch {
    throw new Fail(400, 'bad_request', 'The body is not JSON.')
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Fail(400, 'bad_request', 'The body must be a JSON object.')
  }

  return data as Record<string, unknown>
}

/** The grant as the app sees it: nothing about the person, the tokens or the client's secret. */
export const grantView = (grant: McpGrant): Record<string, unknown> => ({
  id: grant.id,
  client_name: grant.clientName,
  client_id: grant.clientId,
  scopes: [...grant.scopes],
  created_at: grant.createdAt,
  created_ip: grant.createdIp,
  created_user_agent: grant.createdUserAgent,
  last_used_at: grant.lastUsedAt,
  last_used_ip: grant.lastUsedIp,
  expires_at: grant.expiresAt
})

/** The instructions the page shows. English: a client localises its own chrome, never this text. */
export const INSTRUCTIONS =
  'Connect a coding agent such as Claude Code to the bots on this gateway. Run the command in a terminal, ' +
  "or add the JSON to your MCP client's configuration, then sign in when your browser opens and allow the " +
  'connection. The agent works as you, marked as an agent: what it sends shows as your name followed by ' +
  '"via" and the agent\'s name. It cannot approve commands, confirm with a passkey or hand over secrets; ' +
  'those stay in your own app. Revoke a client here at any time.'

function page(gw: McpGateway, call: Call): Reply {
  const { endpointUrl, label } = gw.settings

  return {
    status: 200,
    headers: NO_STORE,
    body: {
      v: 1,
      enabled: true,
      endpoint_url: endpointUrl,
      issuer: endpointUrl,
      label,
      claude_command: `claude mcp add --transport http ${label} ${endpointUrl}`,
      config_json: JSON.stringify({ mcpServers: { [label]: { type: 'http', url: endpointUrl } } }, null, 2),
      instructions: INSTRUCTIONS,
      grants: gw.store.active(call.user).map(grantView)
    }
  }
}

function revoke(gw: McpGateway, call: Call, id: string): Reply {
  const revoked = GRANT_ID_PATTERN.test(id) ? gw.store.revoke(id, call.user, 'user') : null

  if (!revoked) {
    throw new Fail(404, 'not_found', 'No such grant.')
  }

  gw.announce('revoked', revoked)

  return { status: 200, headers: NO_STORE, body: { ok: true } }
}

interface Call extends RouteCall {
  identity: Identity
  user: string
}

const REVOKE_PATH = /^\/grants\/([^/]+)\/revoke$/u

/**
 * Serve one MCP route. `false` when `path` is not one of them (the caller carries on). The caller has
 * already run the gate: the request is authenticated, `call` says as whom.
 */
export async function handleMcpRoute(
  gw: McpGateway,
  req: IncomingMessage,
  res: ServerResponse,
  call: RouteCall
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
    return false
  }

  const suffix = url.pathname.slice(PREFIX.length)
  const method = req.method ?? 'GET'
  let revokeId: string | undefined

  if (suffix !== '') {
    const match = REVOKE_PATH.exec(suffix)

    if (!match) {
      return false
    }

    try {
      revokeId = decodeURIComponent(match[1] as string)
    } catch {
      revokeId = ''
    }
  }

  if (!gw.settings.enabled) {
    send(res, notFound(method, url.pathname))

    return true
  }

  const allowed = revokeId === undefined ? 'GET' : 'POST'

  if (method !== allowed) {
    send(res, { status: 405, body: { detail: 'Method Not Allowed' }, headers: { allow: allowed } })

    return true
  }

  try {
    if (!call.identity) {
      throw new Fail(403, 'no_identity', 'MCP clients belong to a signed-in user; this connection has none.')
    }

    const write = method !== 'GET'

    if (write && call.auth === 'cookie' && !gw.acceptedOrigins().includes(String(req.headers.origin ?? ''))) {
      throw new Fail(403, 'origin_not_listed', "A browser write needs an Origin that is one of this gateway's own.")
    }

    if (write) {
      await readBody(req)
    }

    const scoped: Call = { ...call, identity: call.identity, user: userKey(call.identity) }

    send(res, revokeId === undefined ? page(gw, scoped) : revoke(gw, scoped, revokeId))
  } catch (error) {
    if (error instanceof Fail) {
      send(res, failReply(error))
    } else {
      throw error
    }
  }

  return true
}
