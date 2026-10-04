/**
 * The management transport (`features/settings/manage-runtime.ts`) in memory, for the page tests of Memory, Skills,
 * MCP servers, Connectors and Boards: a REST client that answers from a table of routes and a socket whose methods
 * are plain functions, each recording its calls. A test names the routes and methods it is about.
 */
import { GatewayError } from '@hermie/gateway-client'
import { vi } from 'vitest'

import type { ManageTransport } from '../features/settings/manage-runtime'

export type RouteHandler = (request: {
  path: string
  query: URLSearchParams
  body: unknown
  /** The `:name` segments of the pattern the route was written with. */
  params: Record<string, string>
}) => unknown

export interface RpcCall {
  method: string
  params: Record<string, unknown>
}

/** A refusal as the REST client throws it: the status, and a FastAPI `detail` when the body had one. */
export function httpFailure(status: number, detail?: string): GatewayError {
  return new GatewayError(
    status === 404 ? 'protocol' : status === 401 || status === 403 ? 'auth' : 'protocol',
    `HTTP ${status}`,
    { status, ...(detail ? { hint: detail } : {}) }
  )
}

/** The route a request names: an exact `METHOD /path`, else a pattern whose `:name` segments match one segment each. */
function matchRoute(
  routes: Record<string, RouteHandler>,
  method: string,
  pathname: string
): { handler: RouteHandler; params: Record<string, string> } | null {
  const exact = routes[`${method} ${pathname}`]

  if (exact) {
    return { handler: exact, params: {} }
  }

  for (const [key, handler] of Object.entries(routes)) {
    const [keyMethod, pattern = ''] = key.split(' ')

    if (keyMethod !== method || !pattern.includes(':')) {
      continue
    }

    const names: string[] = []
    const expression = new RegExp(
      `^${pattern.replace(/:([A-Za-z]+)/gu, (_, name: string) => {
        names.push(name)

        return '([^/]+)'
      })}$`,
      'u'
    )
    const match = expression.exec(pathname)

    if (match) {
      return {
        handler,
        params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]))
      }
    }
  }

  return null
}

export function aManageTransport(
  routes: Record<string, RouteHandler> = {},
  methods: Record<string, (params: Record<string, unknown>) => unknown> = {}
) {
  const requests: { method: string; path: string; body: unknown }[] = []
  const rpc: RpcCall[] = []

  const route = async (method: string, target: string, body?: unknown): Promise<unknown> => {
    requests.push({ method, path: target, body })

    const url = new URL(target, 'https://gw.example.test')
    const found = matchRoute(routes, method, url.pathname)

    if (!found) {
      throw httpFailure(404)
    }

    return found.handler({ path: url.pathname, query: url.searchParams, body, params: found.params })
  }

  const transport = {
    gateway: {
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        rpc.push({ method, params: structuredClone(params) })

        const handler = methods[method]

        if (!handler) {
          throw Object.assign(new Error(`unknown method ${method}`), { code: 4001 })
        }

        return handler(params)
      })
    },
    http: {
      get: vi.fn((path: string) => route('GET', path)),
      post: vi.fn((path: string, body?: unknown) => route('POST', path, body)),
      patch: vi.fn((path: string, body?: unknown) => route('PATCH', path, body)),
      delete: vi.fn((path: string, body?: unknown) => route('DELETE', path, body))
    }
  } as unknown as ManageTransport

  return { transport, requests, rpc }
}
