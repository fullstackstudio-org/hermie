/**
 * A ring of gateway calls that FAILED and whose failure the UI decided to
 * absorb, so the next protocol mismatch can be read instead of guessed at.
 *
 * It exists because of one: the composer's slash popover queried
 * `commands.catalog` and `complete.slash` inside `catch {}`, answered an empty
 * list, and cached the emptiness for the rest of the session. Against the fake
 * gateway every call succeeded, so the suite was green; against a real
 * `hermes serve` the owner typed `/`, saw nothing, sent `/model`, saw nothing,
 * and the app had recorded not one word about why. A swallowed error is only
 * defensible if something, somewhere, still says it happened.
 *
 * Unlike the auth timeline this ring DOES carry the gateway's message text,
 * because a protocol mismatch is unreadable without it ("skill command: use
 * command.dispatch for /docx" is the entire diagnosis). That makes it developer
 * material rather than paste-anywhere material, and the debug screen labels it
 * as such: a message can name a command, a profile or a path.
 */

/** How many failures the ring keeps. A few minutes of typing at worst. */
export const RPC_FAILURE_RING_SIZE = 20

export interface RpcFailure {
  at: number
  /** The JSON-RPC method that was called, e.g. `complete.slash`. */
  method: string
  /** The gateway's own code when it sent one — 4018, 5030 — else undefined. */
  code?: number
  /** The gateway's message, trimmed. Empty when the failure was a transport one. */
  message: string
}

const CODE_RE = /"code"\s*:\s*(-?\d+)/u
const MESSAGE_RE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/u
const MAX_MESSAGE = 300

/**
 * Pull the gateway's `{code, message}` out of whatever reached the catch.
 *
 * The channel rejects with an `Error` whose message is the serialized JSON-RPC
 * error object, so the code is there to be read rather than re-requested — and
 * a code is what tells a refusal (4018: wrong method for this command) apart
 * from a fault (5030: the worker died).
 */
export function describeRpcFailure(method: string, error: unknown, at: number): RpcFailure {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const code = CODE_RE.exec(raw)?.[1]
  const inner = MESSAGE_RE.exec(raw)?.[1]
  const message = (inner ?? raw).replace(/\\n/gu, ' ').trim().slice(0, MAX_MESSAGE)

  return {
    at,
    method,
    ...(code === undefined ? {} : { code: Number(code) }),
    message
  }
}

/** Append to a ring, oldest first, dropping from the front past the cap. */
export function pushRpcFailure(ring: readonly RpcFailure[], failure: RpcFailure): RpcFailure[] {
  return [...ring, failure].slice(-RPC_FAILURE_RING_SIZE)
}
