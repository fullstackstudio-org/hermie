import type { FileHead } from './diff-hunks'
import {
  INTERACTIVE_METHODS,
  type InteractiveMethod,
  acceptedDiff,
  acceptedDraft,
  headOfParams,
  refusalFor
} from './interactive'
import { AnswerRefused } from './passkey/confirm'
import type { ReviewRegister } from './review-register'

/**
 * The life of an interactive request (`input.form`, `input.file`, `review.draft`, `review.diff`) on the fake gateway,
 * as `contract/requests/README.md` gives it:
 *
 * - the frame goes only to connections that advertised the method in their second `client.capabilities`
 *   call (`requests`, accepted only together with `server_requests: true`), and `session.resume` lists
 *   an open request to those connections only;
 * - an answer, on the request's own reply frame or as `request.answer`, is checked by `refusalFor`
 *   (`interactive.ts`). A refused one is `4034` with `data.reason` and the request STAYS OPEN; the tenth
 *   refusal withdraws it (`request.cancel too_many_attempts`) and says `too_many_attempts` instead of the
 *   problem;
 * - an approved `review.draft` puts its final text in the review register under a `draft_id` (a later `confirm`
 *   with that id shows exactly that text); an approved or rejected `review.diff` hands the agent each hunk's
 *   decision and, for an approval, `approved_patch`, composed from the gateway's own copy of the hunks;
 * - an ERROR response (`4041 cannot_show`, ...) settles it: the agent is told it is unavailable;
 * - at `expires_at` the gateway withdraws it with `request.cancel {reason: timeout}`, and an answer after
 *   that is `expired`.
 *
 * Methods the fake does not know as interactive never come here.
 */

/** The tenth refused answer withdraws the request. */
export const MAX_REFUSALS = 10

/** The longest delay a timer takes (a larger one fires at once): an `expires_at` far away waits this long. */
const MAX_TIMER_MS = 2_147_483_647

/** How a request ended, for the agent's side of it. */
export interface InteractiveOutcome {
  outcome: 'answered' | 'timeout' | 'withdrawn' | 'too_many_attempts' | 'unavailable'
  /**
   * What the gateway took: the result, with a draft's text as it will be used, whether it was edited and its
   * `draft_id`; a diff's decisions in the request's order and, for an approval, the `approved_patch`.
   */
  answer?: Record<string, unknown>
  /** The client's JSON-RPC error, for `unavailable`. */
  error?: Record<string, unknown>
  reason?: string
}

/** What `GET /__fake/request/<id>` reports. */
export interface InteractiveView {
  id: string
  method: InteractiveMethod
  open: boolean
  answer?: Record<string, unknown>
  /** The reason of every refused answer so far, as the client was told it. */
  refusals: string[]
  outcome?: InteractiveOutcome['outcome']
  error?: Record<string, unknown>
  reason?: string
}

/** The server an interactive request lives in. */
export interface InteractiveHost<Peer> {
  peers: () => Peer[]
  send: (peer: Peer, frame: unknown) => void
  publish: (type: string, sessionId: string | undefined, payload: Record<string, unknown>) => void
  /** Schedule `fn`; the returned function cancels it. */
  later: (fn: () => void, ms: number) => () => void
  nextRequestId: () => string
  now: () => number
  /** Where an approved draft's text is kept for a later `confirm` with its `draft_id`. */
  drafts: ReviewRegister
  /** List an open request where `session.resume` finds it, for the connections `viewer` accepts. */
  register: (
    id: string,
    entry: {
      sessionId: string
      method: InteractiveMethod
      params: Record<string, unknown>
      viewer: (peer: Peer) => boolean
    }
  ) => void
  forget: (id: string) => void
  recordAnswer: (entry: { id: string; method: InteractiveMethod; result?: unknown; error?: unknown }) => void
}

export type RaisedInteractive =
  | { kind: 'raised'; id: string; method: InteractiveMethod; expiresAt: number; settled: Promise<InteractiveOutcome> }
  | { kind: 'unavailable'; reason: 'no_capable_client' }

interface Entry {
  id: string
  method: InteractiveMethod
  sessionId: string
  /** The conversation the request belongs to: what the review register keeps an approved draft under. */
  conversation: string
  /** A `review.diff`'s file head, as the gateway read it from the diff. */
  head: FileHead | undefined
  params: Record<string, unknown>
  open: boolean
  refusals: string[]
  result?: InteractiveOutcome
  stop: () => void
  settle: (outcome: InteractiveOutcome) => void
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export class InteractiveGate<Peer extends object> {
  private readonly advertised = new WeakMap<Peer, Set<InteractiveMethod>>()
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly host: InteractiveHost<Peer>) {}

  /**
   * `client.capabilities`: the methods this connection says it can show. Only together with
   * `server_requests: true`; names that are not interactive methods are ignored, and so is everything
   * past the 32nd entry. Every call replaces what the connection said before.
   */
  advertise(peer: Peer, params: Record<string, unknown>): InteractiveMethod[] {
    const list = params.server_requests === true && Array.isArray(params.requests) ? params.requests.slice(0, 32) : []
    const accepted = INTERACTIVE_METHODS.filter(method => list.includes(method))

    if (accepted.length) {
      this.advertised.set(peer, new Set(accepted))
    } else {
      this.advertised.delete(peer)
    }

    return accepted
  }

  /** The live connections that advertised `method`. */
  capable(method: InteractiveMethod): Peer[] {
    return this.host.peers().filter(peer => this.advertised.get(peer)?.has(method))
  }

  /** Raise a request to every connection that advertised its method; none is `no_capable_client`. */
  raise(input: {
    sessionId: string
    method: InteractiveMethod
    params: Record<string, unknown>
    /** The conversation key (the stored session id); an approved draft is kept under it. Defaults to `sessionId`. */
    conversation?: string
    /** A `review.diff`'s file head (from `parseDiff`); read from the params when absent. */
    head?: FileHead
  }): RaisedInteractive {
    const targets = this.capable(input.method)

    if (targets.length === 0) {
      return { kind: 'unavailable', reason: 'no_capable_client' }
    }

    const id = this.host.nextRequestId()
    const expiresAt = typeof input.params.expires_at === 'number' ? input.params.expires_at : 0
    let settle: (outcome: InteractiveOutcome) => void = () => undefined
    const settled = new Promise<InteractiveOutcome>(resolve => {
      settle = resolve
    })
    const entry: Entry = {
      id,
      method: input.method,
      sessionId: input.sessionId,
      conversation: input.conversation ?? input.sessionId,
      head: input.method === 'review.diff' ? (input.head ?? headOfParams(input.params)) : undefined,
      params: input.params,
      open: true,
      refusals: [],
      stop: this.host.later(
        () => this.expire(id),
        Math.min(MAX_TIMER_MS, Math.max(0, expiresAt * 1000 - this.host.now()))
      ),
      settle
    }

    this.entries.set(id, entry)
    this.host.register(id, {
      sessionId: input.sessionId,
      method: input.method,
      params: input.params,
      viewer: peer => this.advertised.get(peer)?.has(input.method) === true
    })

    for (const peer of targets) {
      this.host.send(peer, {
        jsonrpc: '2.0',
        id,
        method: input.method,
        params: { session_id: input.sessionId, ...input.params }
      })
    }

    return { kind: 'raised', id, method: input.method, expiresAt, settled }
  }

  /**
   * A JSON-RPC response frame from `peer`. `true` when the id is an interactive request's (settled or
   * not), so the caller stops looking; a refused answer is answered with the `4034` error frame.
   */
  respond(peer: Peer, frame: { id?: unknown; result?: unknown; error?: unknown }): boolean {
    const entry = typeof frame.id === 'string' ? this.entries.get(frame.id) : undefined

    if (!entry) {
      return false
    }

    if (!entry.open) {
      return true
    }

    if (frame.error !== undefined && frame.error !== null) {
      const error = isObject(frame.error) ? frame.error : { message: String(frame.error) }
      const data = isObject(error.data) ? error.data : undefined

      this.host.recordAnswer({ id: entry.id, method: entry.method, error: frame.error })
      this.close(entry, {
        outcome: 'unavailable',
        error,
        ...(typeof data?.reason === 'string' ? { reason: data.reason } : {})
      })

      return true
    }

    const refused = this.take(entry, frame.result)

    if (refused) {
      this.host.send(peer, {
        jsonrpc: '2.0',
        id: entry.id,
        error: { code: 4034, message: 'answer refused', data: { reason: refused } }
      })
    }

    return true
  }

  /**
   * `request.answer {id, result}`. `undefined` when the id is not an interactive request's; `expired`
   * once it settled or timed out; `ok` when the answer was valid; `4034` (thrown) when it was not.
   */
  answer(id: string, result: unknown): { status: 'ok' | 'expired' } | undefined {
    const entry = this.entries.get(id)

    if (!entry) {
      return undefined
    }

    if (!entry.open) {
      return { status: 'expired' }
    }

    const refused = this.take(entry, result)

    if (refused) {
      throw new AnswerRefused(4034, 'answer refused', { reason: refused })
    }

    return { status: 'ok' }
  }

  /** The gateway stops waiting: `request.cancel {reason: timeout}`. One request, or every open one. */
  expire(id?: string): number {
    const open = [...this.entries.values()].filter(entry => entry.open && (id === undefined || entry.id === id))

    for (const entry of open) {
      this.host.publish('request.cancel', entry.sessionId, { id: entry.id, method: entry.method, reason: 'timeout' })
      this.close(entry, { outcome: 'timeout', reason: 'timeout' })
    }

    return open.length
  }

  /** The cancel was published by someone else (`/__fake/withdraw-requests`): only the bookkeeping. */
  withdrawn(id: string, reason: string): void {
    const entry = this.entries.get(id)

    if (entry?.open) {
      this.close(entry, { outcome: 'withdrawn', reason })
    }
  }

  view(id: string): InteractiveView | undefined {
    const entry = this.entries.get(id)

    if (!entry) {
      return undefined
    }

    const { result } = entry

    return {
      id: entry.id,
      method: entry.method,
      open: entry.open,
      ...(result?.answer ? { answer: result.answer } : {}),
      refusals: [...entry.refusals],
      ...(result ? { outcome: result.outcome } : {}),
      ...(result?.error ? { error: result.error } : {}),
      ...(result?.reason ? { reason: result.reason } : {})
    }
  }

  /** Every request, in the order they were raised. */
  list(): InteractiveView[] {
    return [...this.entries.keys()].map(id => this.view(id) as InteractiveView)
  }

  /** Check one answer. `null` when it settled the request, else the reason the client is refused with. */
  private take(entry: Entry, result: unknown): string | null {
    const reason = refusalFor(entry.method, entry.params, result)

    if (reason === null) {
      const answer = result as Record<string, unknown>

      this.host.recordAnswer({ id: entry.id, method: entry.method, result })
      this.close(entry, { outcome: 'answered', answer: this.taken(entry, answer) })

      return null
    }

    // The tenth refusal names the cap, not the problem, and withdraws the request.
    const reported = entry.refusals.length + 1 >= MAX_REFUSALS ? 'too_many_attempts' : reason

    entry.refusals.push(reported)

    if (reported === 'too_many_attempts') {
      this.host.publish('request.cancel', entry.sessionId, {
        id: entry.id,
        method: entry.method,
        reason: 'too_many_attempts'
      })
      this.close(entry, { outcome: 'too_many_attempts', reason: 'too_many_attempts' })
    }

    return reported
  }

  /** What the agent learns of a valid answer (see `InteractiveOutcome.answer`). */
  private taken(entry: Entry, answer: Record<string, unknown>): Record<string, unknown> {
    if (entry.method === 'review.draft' && answer.decision === 'approved') {
      const accepted = acceptedDraft(entry.params, answer)
      const draft = this.host.drafts.put(entry.conversation, accepted.text, {
        edited: accepted.edited,
        now: this.host.now()
      })

      return { ...answer, ...accepted, draft_id: draft.draftId, sha256: draft.sha256 }
    }

    if (entry.method === 'review.diff') {
      return { ...answer, ...acceptedDiff(entry.params, answer, entry.head as FileHead) }
    }

    return answer
  }

  private close(entry: Entry, outcome: InteractiveOutcome): void {
    entry.open = false
    entry.result = outcome
    entry.stop()
    this.host.forget(entry.id)
    entry.settle(outcome)
  }
}
