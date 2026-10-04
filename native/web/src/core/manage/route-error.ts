/**
 * What a call to one of the gateway's management routes (`/api/plugins/...`) or methods said when it did not
 * do what it was asked, as the one sentence and the status a panel can act on.
 *
 * The panels (Memory, Skills, MCP servers, Connectors, Boards) all draw three different things for three
 * different refusals: an install note (the route is not mounted: 404), a switched-off line (403) and an ordinary
 * error line. `status` is what tells them apart, so it is kept; `GatewayHttp` folds 401 and 403 together into an
 * `auth` error, which is why the status and not the kind is read.
 *
 * `GatewayError.hint` carries a JSON error body's `detail` (FastAPI's own sentence), which is the part a reader
 * can act on ("blocked by parent(s) not done"): it is preferred to the classification.
 */
import { isGatewayError } from '@hermie/gateway-client'

export class RouteError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when the failure was one. */
    readonly status?: number,
    /** The JSON-RPC code of a refused method, when it was one. */
    readonly code?: number
  ) {
    super(message)
    this.name = 'RouteError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Anything thrown, as a `RouteError`; one already is returned as it is. */
export function routeErrorOf(failure: unknown): RouteError {
  if (failure instanceof RouteError) {
    return failure
  }

  if (isGatewayError(failure)) {
    const hint = typeof failure.hint === 'string' && failure.hint.trim() ? failure.hint.trim() : ''

    return new RouteError(hint || failure.message, failure.status)
  }

  const code = isRecord(failure) && typeof failure.code === 'number' ? failure.code : undefined

  return new RouteError(
    failure instanceof Error && failure.message ? failure.message : String(failure),
    undefined,
    code
  )
}

/** The sentence a panel shows for a failure of any kind. */
export const failureText = (failure: unknown): string => routeErrorOf(failure).message

/** The route answered 404 with no sentence of its own: nothing is mounted there. */
export function isUnmounted(failure: unknown): boolean {
  const error = routeErrorOf(failure)

  return error.status === 404
}
