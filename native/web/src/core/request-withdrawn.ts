/**
 * What answering a request that is no longer open says.
 *
 * A request can leave the open state between the moment a person pressed a
 * button and the moment the press reached the controller: the gateway withdrew it
 * (`request.cancel`, a timeout) in the same frame, or an earlier press already
 * answered it. The controller then sends nothing, because an answer to a request
 * the agent no longer waits on is noise at best and, at worst, turns the
 * transcript's `cancelled` card into an `answered` one. It rejects with this
 * error so the caller can say what happened instead of a generic failure.
 */
/**
 * The `cancelReason` of a clarify the reader ended themselves with "Cancel all" (`ChatController.cancelClarify`).
 * The card closes as `cancelled`, because nothing was answered, and under this reason, because the gateway did
 * not withdraw anything: the layer says nothing about it, the reader just did it.
 */
export const CANCELLED_BY_READER = 'cancelled_by_reader'

export class RequestWithdrawnError extends Error {
  /** `cancelled`: the gateway took the request back. `answered`: it was already answered. */
  readonly state: 'cancelled' | 'answered'
  /** Why the gateway withdrew it (`timeout`, ...), when it said. */
  readonly reason: string | undefined

  constructor(requestId: string, state: 'cancelled' | 'answered', reason?: string) {
    super(`request ${requestId} is no longer open (${state})`)
    this.name = 'RequestWithdrawnError'
    this.state = state
    this.reason = reason
  }
}

/** The error to throw when the item is a request that is not open any more; `undefined` when it is open or unknown. */
export function closedRequest(
  item: { kind: string; state?: string; cancelReason?: string } | undefined,
  requestId: string
): RequestWithdrawnError | undefined {
  if ((item?.kind !== 'approval' && item?.kind !== 'clarify') || item.state === undefined || item.state === 'open') {
    return undefined
  }

  return new RequestWithdrawnError(requestId, item.state === 'cancelled' ? 'cancelled' : 'answered', item.cancelReason)
}
