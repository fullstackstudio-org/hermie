/**
 * A `fetch` for unit tests: answers by method and path, and records every call
 * with the `credentials` mode it was made with, which is what the cookie
 * session's tests are about.
 */
import type { FetchLike } from '@hermie/gateway-client'

export interface RecordedCall {
  method: string
  url: string
  credentials: RequestCredentials | undefined
  redirect: RequestRedirect | undefined
  headers: Record<string, string>
}

export type Route = (call: RecordedCall) => Response | Promise<Response>

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export interface FakeFetch {
  fetch: FetchLike
  calls: RecordedCall[]
}

/**
 * `routes` is keyed `"<METHOD> <path>"`, the path under the gateway's `prefix`;
 * anything else (including a path outside the prefix) answers 404.
 */
export function fakeFetch(routes: Record<string, Route>, prefix = ''): FakeFetch {
  const calls: RecordedCall[] = []

  const fetch: FetchLike = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const call: RecordedCall = {
      method: init.method ?? 'GET',
      url,
      credentials: init.credentials,
      redirect: init.redirect,
      headers: Object.fromEntries(new Headers(init.headers).entries())
    }
    calls.push(call)

    const pathname = new URL(url).pathname
    const route = pathname.startsWith(`${prefix}/`)
      ? routes[`${call.method} ${pathname.slice(prefix.length)}`]
      : undefined

    return route ? route(call) : json(404, { detail: 'Not Found' })
  }

  return { fetch, calls }
}

/** What a gated gateway's `/api/status` and `/api/auth/providers` answer. */
export const gatedRoutes: Record<string, Route> = {
  'GET /api/status': () => json(200, { version: '0.0.0-test', auth_required: true, auth_flows: ['cookie'] }),
  'GET /api/auth/providers': () =>
    json(200, { providers: [{ name: 'basic', display_name: 'Password', supports_password: true }] })
}

/** What an ungated gateway's `/api/status` answers. */
export const ungatedRoutes: Record<string, Route> = {
  'GET /api/status': () => json(200, { version: '0.0.0-test', auth_required: false, auth_flows: [] })
}

/** `/api/auth/me` for the test account. */
export const meRoute: Route = () =>
  json(200, {
    user_id: 'tester',
    email: 'tester@example.invalid',
    display_name: 'Tester',
    org_id: '',
    provider: 'basic',
    expires_at: 1_900_000_000
  })
