/**
 * Telling the plugin who is about to speak, before the turn starts.
 *
 * A shared gateway's plugin watches the transcript from the outside: it never
 * sees `prompt.submit`'s own `profile` field, so on a gateway with more than
 * one client attached it has no way to say which bot's turn is running. This
 * is the courtesy call that fills the gap — a plain `POST` naming the RUNTIME
 * session id the very next `prompt.submit` is about to carry.
 *
 * ## Why this can never fail the send
 *
 * The claim is offered, not required — nothing on the wire *needs* it, the
 * plugin only reads it if it can. So a refusal is not this call's business to
 * raise: a 404 means an older plugin that predates the route, a timeout means
 * a slow or wedged plugin, and either way the turn the reader is waiting on
 * must still go out. `claimTurn` therefore never throws; it is a best-effort
 * courtesy, awaited so the plugin has SEEN the claim before the turn that
 * names it lands, and abandoned rather than retried the moment anything about
 * it goes wrong.
 *
 * `GatewayHttp` already carries the one retry the auth contract allows — a 401
 * asks the credential provider for a fresh token before failing for good — so
 * nothing here has to special-case that path; whatever `http.post` still
 * throws after that is simply a claim that did not land.
 *
 * ## What must never call this
 *
 * A slash command is not a turn — it goes to `slash.exec`, never through
 * `send`, so it never reaches this call. A steer folds text into a turn that
 * was claimed when IT started; steering never opens a turn of its own, so it
 * never calls this either. Both rules live in the caller (`chat-controller.ts`
 * `send`), not here — this module only knows how to make the one call.
 */
import type { GatewayHttp } from '@hermie/gateway-client'

/** The plugin's own route. One profile-less call: the session id says which turn. */
export const TURN_CLAIM_ROUTE = '/api/plugins/hermie/context/turn'

/**
 * Short enough that a dead or wedged plugin is never felt as a delay on send.
 *
 * The claim is a courtesy, not a dependency — a reader pressing send should
 * never notice the round trip, whether it succeeds or not.
 */
export const TURN_CLAIM_TIMEOUT_MS = 1_500

/**
 * Claim one turn. Never throws — see the module doc for why.
 *
 * @param sessionId The RUNTIME session id `prompt.submit` is about to carry.
 *   Never the stored id and never a session key: the plugin reads this against
 *   the same live sessions the socket addresses.
 */
export async function claimTurn(http: GatewayHttp, sessionId: string): Promise<void> {
  try {
    await http.post(TURN_CLAIM_ROUTE, { session_id: sessionId }, { timeoutMs: TURN_CLAIM_TIMEOUT_MS })
  } catch {
    // Any refusal, timeout or network failure: the turn goes out unclaimed
    // rather than delayed or dropped over a courtesy call. See the module doc.
  }
}
