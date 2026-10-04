/**
 * The interactive requests a bot sends a client (`input.form`, `input.file`,
 * `review.draft`, `review.diff`; `contract/requests/`), from the moment they arrive until they are
 * answered, skipped, expired, withdrawn or declined.
 *
 * The secure input model's sibling (`secure-input.ts`, the native apps' `SecureInputCenter`),
 * with the same rules about when a request exists and who may end it, for requests that
 * carry structure instead of one string.
 *
 * **Beside the engine, on purpose.** What a person types into a form, the files they pick
 * and the text they edit a draft into never reach the transcript engine, the chat store, the
 * cache, drafts, a log or a diagnostics export. So these requests never go through the chat
 * controller (which passes them on): this model takes them from the connection itself
 * (`onRequest`, tried after the controller and the passkey model and before the secure input
 * model), keeps what was asked in `state/interactive.ts` and answers through `request.answer`,
 * so the gateway's refusal (`4034 data.reason`) comes back to the sheet. `answer` takes the
 * result as an argument, hands it to the call and keeps nothing: the sheet built it a moment
 * before from its fields.
 *
 * The one thing the engine is told is that a question was asked and how it ended
 * (`InteractiveEngine`, a `request` item): its heading, its words and a summary of the answer
 * (`{status | decision, count?, edited?}`), never a value.
 *
 * The rules, as built:
 *
 *  1. **Answers.** `request.answer {id, result}`; `ok` means the gateway took it. A refused
 *     answer (`4034`) leaves the request open and says why (`refusal`); the tenth, which the
 *     gateway answers `too_many_attempts` and withdraws, ends it. A call that failed without
 *     the gateway's word leaves it open for another try, and uncertain: that answer may have
 *     arrived, so a later "no longer waiting" (a non-`ok` reply, a reconnect that no longer lists
 *     it, a `resolved` cancel) says the answer may not have arrived rather than that it expired.
 *     Any other non-`ok` reply means the request already ended (`expired` is the gateway's word
 *     for every ending), and the chat is told what is known. Nothing is sent while the connection
 *     is not `ready`. Skip is `{status: "skipped"}`, only when the request is `optional`.
 *  2. **Cannot show.** A request this page cannot show (a version it does not know, a frame
 *     that is not the contract's, a form field kind it does not know, no chat, too many
 *     waiting, or what the sheet says: no camera, a failed upload) is answered with the JSON-RPC
 *     error `4041 cannot_show {reason}`, never a made-up skip, and leaves ONE notice on its chat
 *     per request however often it is re-delivered. A shutdown (`stop`) fails every open one with
 *     reason `shutting_down` before the socket closes.
 *  3. **Deadlines are the request's own** (`expires_at`): the sheet hides at that time, on the
 *     page's clock, and no answer is sent after it (`request.cancel` is authoritative and still
 *     closes it). A request that arrives already past its time is not shown.
 *  4. **Ending.** The deadline passing closes a request with an "expired" notice and sends
 *     nothing; `request.cancel` closes it with "expired" (`timeout`), "answered elsewhere"
 *     (`resolved`: another device answered) or "withdrawn", whether it arrived live or in a
 *     reconnect's replay (`replayedCancel`). After a reconnect, a request its session's
 *     `open_requests` no longer lists ended while the page was not listening and closes with a
 *     notice saying so (`reconcile`); the list can be short, though (with turn isolation the gateway mirrors one
 *     request per session), so it closes as let go of here, not as withdrawn: the gateway delivering it again opens it
 *     again (rule 6). **An answer on its way is not overruled**: the gateway sends
 *     `request.cancel {reason: resolved}` to every client once an answer settled the request, the
 *     one that answered included, and it can arrive before the reply to that answer; so while an
 *     answer is in flight a cancel and the local deadline wait for the call's result, which decides
 *     (`ok` is answered; anything else lets the cancel, or the deadline, end it). A cancel other than
 *     `resolved` after an answer the gateway took says the answer may not have arrived.
 *  5. **Routing.** A request belongs to the chat whose runtime session is the request's
 *     `session_id`. One for a session no chat holds yet waits (a resume re-delivers open requests
 *     before it binds their session), at most 16 at once, until a chat holds it or its deadline
 *     passes. It is never declined for waiting (the native apps decline after 15 s): the gateway
 *     parks a request for a capable device, and a chat the reader is about to open may still
 *     answer it. When its session moves to another chat the request moves with it.
 *  6. **An answer that did not arrive.** A re-delivered copy of a request this model already
 *     answered or let go is proof the gateway never got it: it opens again and says so. A copy of
 *     one the gateway withdrew, one that expired, or one this page declined (answered again with
 *     the same refusal) never opens.
 *  7. **Advertising.** The page lists the methods it can show in the second
 *     `client.capabilities` call (`interactiveAdvert`, run by the passkey model, which owns the
 *     two calls: the second replaces what the first said); `ADVERTISE_INTERACTIVE_REQUESTS` is the
 *     switch. The gateway lists a request in `open_requests` only to a
 *     connection whose advert it accepted, and a reconnect's resume and replay run before the new
 *     socket's advert: so on a new socket the controller's `open_requests` say nothing about these
 *     requests until the advert is settled. Once it is accepted they are read again
 *     (`RequestsAdvert.openRequests`), and only a list asked for after that counts; when it is not,
 *     the page cannot answer them anyway and the lists it was given count as they are.
 *
 * Texts from the request are cleaned and bounded for display by `interactive-types.ts`
 * (`displayText`), so one text cannot pass for another or paint over the sheet's own words.
 */
import { JsonRpcGatewayError, type ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { ConnectionStatus } from '@hermie/gateway-client'
import type { RequestAnswerSummary } from '@hermie/transcript'
import type { StoreApi } from 'zustand/vanilla'

import {
  type InteractiveNoticeKind,
  type InteractiveRequest,
  type InteractiveState,
  interactiveStore
} from '../../state/interactive'
import { monotonicNow } from '../../platform/monotonic-clock'
import type { ReplaySignal } from '../chat-controller'
import type { ChatGateway } from '../link'
import {
  type InteractiveAnswer,
  type InteractiveAsk,
  type InteractiveMethod,
  INTERACTIVE_METHODS,
  isInteractiveMethod,
  readInteractiveParams,
  stripLineEnds,
  unknownFields
} from './interactive-types'
import { NAME_LIMIT, displayText } from './secure-input'

/** The slice of the connection the model uses. */
export type InteractiveGateway = Pick<ChatGateway, 'request' | 'onAny' | 'onRequest' | 'onStatus'>

/** `4041`: the client cannot show this request (contract §3). */
export const CANNOT_SHOW_CODE = 4041
export const CANNOT_SHOW_MESSAGE = 'cannot_show'
/** `4034`: the gateway refused an answer and left the request open. */
export const REFUSED_CODE = 4034

/** How many requests wait for their chat at once; one more is declined. */
const MAX_PARKED = 16
/** How many finished ids are remembered (rule 6). */
const CLOSED_LIMIT = 512
/** How many requests that ended before a chat held their session wait to be ended on that chat. */
const UNENDED_LIMIT = 64
/**
 * How long past its deadline (or past when it ended, if later) such a request waits for its chat: the snapshot that
 * puts it there comes with the resume that binds the session, moments after. Nothing lists it once it is over.
 */
const UNENDED_GRACE_MS = 60_000
/** The longest a timer waits in one go (a browser fires one past 2^31 ms at once). */
const MAX_TIMER_MS = 2_000_000_000
/** The longest a refusal's reason is kept and shown. */
const REASON_LIMIT = 120
/** A machine reason the page may tell the gateway: lower case words with underscores. */
const MACHINE_REASON = /^[a-z][a-z0-9_]{0,47}$/u

/** Answer a server request with a JSON-RPC error that carries `data` (see `platform/socket.ts`). */
export type FailWithData = (
  request: ServerRequest,
  code: number,
  message: string,
  data: Record<string, unknown>
) => void

/**
 * What the transcript engine is told. A `request` item records that a question was asked and how it ended;
 * `summary` is `{status | decision, count?, edited?}`: keys and numbers, never a value.
 */
export interface InteractiveEngine {
  /** The request is on a chat: the engine opens its item (`title` and `summary` are cleaned). */
  asked(
    bot: string,
    request: { id: string; method: string; title: string; summary: string; optional: boolean; replayed: boolean }
  ): void
  /** The gateway took an answer from here. */
  answered(bot: string, id: string, summary: RequestAnswerSummary): void
  /** It ended without an answer from here and without the gateway's own `request.cancel` (expired, lapsed, declined). */
  ended(bot: string, id: string, reason: string): void
  /**
   * The chat `bot` shows `id` as a question still open. A request that ended here before any chat held its session
   * is ended on the chat once one does and shows it (a resume's snapshot puts it there); without this, as soon as
   * a chat holds the session.
   */
  holds?(bot: string, id: string): boolean
}

/**
 * Whether the page lists the interactive methods in its advert. On: the sheets for all four exist (`FormSheet`,
 * `FileSheet`, `DraftSheet`, `DiffSheet`), so the page can show what it advertises. It is the switch to turn the advert off again
 * should a sheet ever be withdrawn: a page advertises only what it can really show, because a gateway that knows this
 * page can show a form sends it here instead of answering the agent `no_capable_client`.
 */
export const ADVERTISE_INTERACTIVE_REQUESTS = true

/**
 * What the advert of a socket came to: the gateway took methods of this page (`accepted`), it did not or none were
 * listed (`refused`), or the call that listed them failed and nobody knows (`unknown`).
 */
export type RequestsAdvertOutcome = 'accepted' | 'refused' | 'unknown'

/** What the passkey model, which owns the two `client.capabilities` calls, needs from this model. */
export interface RequestsAdvert {
  /** The methods to list in `requests`, given the first result's `server_requests`; none lists nothing. */
  methods(serverRequests: readonly string[]): readonly string[]
  /** What the advert of the current socket came to: once per socket, before `openRequests` reads. */
  settled(outcome: RequestsAdvertOutcome): void
  /** A session's open requests, read again once the list was accepted. */
  openRequests(sessionId: string, ids: readonly string[], askedAt: number): void
}

/**
 * The methods of `serverRequests` this page can show: the contract's three, each only where this browser can do
 * what it takes. `input.file` needs `File` and `FormData` (always, in a browser); `capture: scan` is a preference
 * the web ignores, so it never holds anything back.
 */
export function showableMethods(
  serverRequests: readonly string[],
  has: { file: boolean } = { file: typeof File === 'function' && typeof FormData === 'function' }
): InteractiveMethod[] {
  return INTERACTIVE_METHODS.filter(method => serverRequests.includes(method) && (method !== 'input.file' || has.file))
}

/**
 * What the passkey model is given to advertise with, wired to a model. `enabled` (default
 * `ADVERTISE_INTERACTIVE_REQUESTS`) off lists no method at all.
 */
export const interactiveAdvert = (
  model: Pick<InteractiveModel, 'reconcile' | 'advertSettled'>,
  { enabled = ADVERTISE_INTERACTIVE_REQUESTS }: { enabled?: boolean } = {}
): RequestsAdvert => ({
  methods: serverRequests => (enabled ? showableMethods(serverRequests) : []),
  settled: outcome => model.advertSettled(outcome),
  openRequests: (sessionId, ids, askedAt) => model.reconcile(sessionId, ids, askedAt)
})

/** What became of an answer or a Skip. */
export type AnswerOutcome =
  /** The gateway took it. */
  | { kind: 'sent' }
  /** The request is no longer open (answered, withdrawn, expired, declined); nothing went out. */
  | { kind: 'closed' }
  /** The connection is not ready; nothing went out and the request is still open. */
  | { kind: 'offline' }
  /** An earlier answer is still on its way; nothing new went out. */
  | { kind: 'busy' }
  /** Skip was asked for a request that is not `optional`; nothing went out. */
  | { kind: 'not_optional' }
  /** The gateway refused the answer (`4034`): the request is still open, and `reason` says what to correct. */
  | { kind: 'refused'; reason: string }
  /** The gateway ended it with this answer (too many refused answers, or its deadline): it is closed here too. */
  | { kind: 'ended' }
  /** The call did not get through, or the gateway said something else: the request is still open for another try. */
  | { kind: 'failed'; message: string }

export interface InteractiveTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const pageTimers: InteractiveTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface InteractiveModelOptions {
  gateway: InteractiveGateway
  store?: StoreApi<InteractiveState>
  /** The key of the chat that holds a runtime session, or `undefined` when none does. */
  chatFor: (sessionId: string) => string | undefined
  /** Call `listener` whenever the sessions the chats hold may have changed; returns the way to stop. */
  watchChats?: (listener: () => void) => () => void
  /** Call `listener` with what each reconnect learned about open requests (`ChatController.onReplaySignal`). */
  watchReplays?: (listener: (signal: ReplaySignal) => void) => () => void
  /** Where the transcript engine hears that a question was asked and how it ended. */
  engine?: InteractiveEngine
  /** How a `4041` with `data.reason` goes out; without one the error goes out without `data`. */
  failWithData?: FailWithData
  /** The gateway as a person knows it (its host), for the sheet's chrome. */
  gatewayName?: string
  /** Epoch milliseconds. */
  now?: () => number
  /**
   * A clock that never runs backward, for ordering what this page saw against a list the gateway answered
   * (`arrivedAt`, `acceptedAt` against `askedAt`): the system clock jumping back must not make a live request look
   * newer than a list that really listed it, or the other way round. Absent: `now` when it is given (a test that
   * fakes the clock fakes both), else the page's own (`monotonicNow`).
   */
  monotonic?: () => number
  timers?: InteractiveTimers
}

/** Why an id is done (rule 6). */
type CloseReason =
  /** An answer or a Skip the gateway took. */
  | 'answered'
  /**
   * Let go of here without an answer of the person's: its chat let go of it, or a reconnect's list of open requests
   * did not name it (a list that can be short: a re-delivery opens it again).
   */
  | 'closed_here'
  /** Its deadline passed. */
  | 'expired'
  /** The gateway withdrew it (`request.cancel`, or it ended with an answer). */
  | 'cancelled'
  /** This page declined it with `4041`. */
  | 'declined'

interface Closed {
  reason: CloseReason
  /** For `answered`: whether it was a Skip, and the chat it was on, for a later "may not have arrived". */
  skipped?: boolean
  bot?: string
  /** For `declined`: what every later copy is answered with. */
  decline?: string
  /**
   * For `cancelled`: it closed on a reply that said only that the gateway no longer waits, and the chat was told what
   * the page knew then; a `request.cancel` that arrives afterwards says why, and the notice is put right.
   */
  unheard?: boolean
}

/** A request that is open or waiting for its chat: the newest delivery and what it asks. */
interface Entry {
  request: ServerRequest
  method: InteractiveMethod
  sessionId: string
  ask: InteractiveAsk
  /** Epoch milliseconds. */
  deadline: number
  /** When this page first saw it, on its monotonic clock (`tick`). */
  arrivedAt: number
  earlierLost: InteractiveRequest['earlierLost']
  refusal: string | null
  version: number
  /** An answer is on its way to the gateway. */
  sending: boolean
  /** The reason of a `request.cancel` that arrived while an answer was on its way: the call's result decides. */
  pendingCancel: string | null
  /** An answer went out and the call failed without the gateway's word: it may have arrived. */
  uncertain: boolean
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export class InteractiveModel {
  readonly store: StoreApi<InteractiveState>

  private readonly options: InteractiveModelOptions
  private readonly timers: InteractiveTimers
  /** Every open request and every one waiting for its chat, by id. */
  private readonly entries = new Map<string, Entry>()
  /** The ids of `entries` that wait for their chat. */
  private readonly parked = new Set<string>()
  private readonly expiries = new Map<string, unknown>()
  private readonly closed = new Map<string, Closed>()
  /** Requests that ended here before a chat held their session, for the engine of the chat that comes to hold it. */
  private readonly unended = new Map<string, { sessionId: string; reason: string; until: number }>()
  /**
   * The advert of the current socket (rule 7): `pending` until the passkey model says what it came to, and the
   * controller's lists of open requests asked for before then are held (`heldLists`) rather than reconciled with.
   */
  private advert: 'pending' | RequestsAdvertOutcome = 'pending'
  /** When the advert of this socket was accepted, on this model's monotonic clock (`tick`). */
  private acceptedAt = 0
  private readonly heldLists = new Map<string, { ids: readonly string[]; askedAt: number }>()
  private unsubscribes: (() => void)[] = []
  private ready = false
  private started = false
  private stopped = false
  private seq = 0
  private serial = 0
  private settling = false
  private unsettled = false

  constructor(options: InteractiveModelOptions) {
    this.options = options
    this.store = options.store ?? interactiveStore
    this.timers = options.timers ?? pageTimers
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** The monotonic clock: `arrivedAt` and `acceptedAt` are read from it, and a list's `askedAt` is on it. */
  private tick(): number {
    return this.options.monotonic?.() ?? this.options.now?.() ?? monotonicNow()
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────

  /** Listen to the connection's server requests, its `request.cancel` events and its status, and to the chats. */
  start(): void {
    if (this.started || this.stopped) {
      return
    }

    this.started = true
    this.store.getState().reset()
    this.store.setState({ gateway: this.options.gatewayName ?? '' })

    const { gateway } = this.options

    this.unsubscribes.push(
      gateway.onRequest(request => this.ingest(request)),
      gateway.onAny(event => {
        if (event.type !== ('request.cancel' as typeof event.type)) {
          return
        }

        const payload = (isRecord(event.payload) ? event.payload : {}) as Record<string, unknown>

        this.withdraw(str(payload.id), str(payload.reason))
      }),
      gateway.onStatus((status: ConnectionStatus) => {
        this.ready = status === 'ready'

        // A socket that goes away takes its advert with it: the next one's is not settled yet.
        if (status !== 'ready') {
          this.advert = 'pending'
          this.heldLists.clear()
        }
      }),
      ...(this.options.watchChats ? [this.options.watchChats(() => this.chatsChanged())] : []),
      ...(this.options.watchReplays
        ? [
            this.options.watchReplays(signal =>
              signal.kind === 'cancel'
                ? this.replayedCancel(signal.id, signal.reason)
                : this.replayedOpenRequests(signal.sessionId, signal.ids, signal.askedAt)
            )
          ]
        : [])
    )
  }

  /**
   * Fail every open request with `4041 shutting_down` (the person is leaving; the agent is told it is unavailable
   * rather than left to the deadline), forget the rest, and stop. Call before the socket closes. Idempotent.
   */
  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true

    for (const unsubscribe of this.unsubscribes) {
      unsubscribe()
    }

    this.unsubscribes = []

    for (const entry of this.entries.values()) {
      this.fail(entry.request, 'shutting_down')
    }

    for (const timer of this.expiries.values()) {
      this.timers.clearTimeout(timer)
    }

    this.entries.clear()
    this.parked.clear()
    this.expiries.clear()
    this.closed.clear()
    this.unended.clear()
    this.heldLists.clear()
    this.store.getState().reset()
  }

  // ── answering ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Answer the request `id` with `result` (a form's values, the files' references, a draft's decision). The result
   * is used for this one call and kept nowhere. Nothing goes out for a request that is no longer open, whose
   * deadline passed, or while the connection is not ready.
   */
  async answer(id: string, result: InteractiveAnswer): Promise<AnswerOutcome> {
    const request = this.openRequest(id)
    const entry = this.entries.get(id)

    if (!request || !entry) {
      return { kind: 'closed' }
    }

    if (entry.sending) {
      return { kind: 'busy' }
    }

    if (!this.ready) {
      return { kind: 'offline' }
    }

    // The summary is built before the call: from the result's closed fields and the draft the agent sent, never a value.
    const summary = this.summaryOf(entry, result)
    const skipped = 'status' in result && result.status === 'skipped'

    entry.sending = true
    entry.pendingCancel = null

    let reply: unknown

    try {
      reply = await this.options.gateway.request('request.answer', {
        id,
        result: result as unknown as Record<string, unknown>
      })
    } catch (error) {
      entry.sending = false

      return this.afterFailure(id, entry, error)
    }

    entry.sending = false

    // A sign-out, or the chat letting go of it, came in while the call was on its way: that is what ended it.
    if (this.entries.get(id) !== entry) {
      return { kind: 'closed' }
    }

    const status = isRecord(reply) ? str(reply.status) : ''

    if (status === 'ok') {
      // The gateway took it; a `resolved` cancel that came first was this very answer settling it.
      const bot = this.store.getState().requests.find(open => open.id === id)?.bot ?? request.bot

      this.finish(id, 'answered', { skipped, bot })
      this.options.engine?.answered(bot, id, summary)

      return { kind: 'sent' }
    }

    // Anything but `ok` (`expired`) is the gateway saying the request already ended, whatever ended it: nothing
    // was taken from this call.
    this.endedUnderAnswer(id, entry)

    return { kind: 'ended' }
  }

  /** Skip: `{status: "skipped"}`, only for a request that is `optional`. */
  skip(id: string): Promise<AnswerOutcome> {
    const request = this.openRequest(id)

    if (!request) {
      return Promise.resolve({ kind: 'closed' })
    }

    if (!request.ask.optional || request.ask.method === 'review.draft' || request.ask.method === 'review.diff') {
      return Promise.resolve({ kind: 'not_optional' })
    }

    return this.answer(id, { status: 'skipped' })
  }

  /**
   * The sheet cannot show this request (no camera and no picker, a permission denied, an upload that failed): answer
   * the JSON-RPC error `4041 cannot_show {reason}` and leave one notice on its chat. `reason` is a short machine
   * string (`no_camera`, `permission_denied`, `upload_failed`, ...); anything else is sent as `not_supported_on_device`.
   * Nothing is sent while the connection is not ready, or while an answer is on its way: the request stays open.
   */
  cannotShow(id: string, reason: string): 'sent' | 'closed' | 'offline' | 'busy' {
    const request = this.openRequest(id)
    const entry = this.entries.get(id)

    if (!request || !entry) {
      return 'closed'
    }

    // An answer is on its way: its result decides first.
    if (entry.sending) {
      return 'busy'
    }

    if (!this.ready) {
      return 'offline'
    }

    this.decline(entry.request, MACHINE_REASON.test(reason) ? reason : 'not_supported_on_device', request.bot, entry)

    return 'sent'
  }

  /**
   * What a reconnect learned about the requests still waiting on one runtime session (a `session.resume`'s,
   * a `session.events.since`'s `open_requests`): every request of that session the gateway no longer lists ended
   * while this page was not listening (withdrawn, timed out, answered elsewhere), so it closes with a notice saying
   * so and nothing is sent. The snapshot's own requests were re-delivered a moment before it, so they stay, and so
   * does one first seen at or after `askedAt` (when the call went out): it may be newer than the snapshot.
   */
  reconcile(sessionId: string, openIds: readonly string[], askedAt = Number.POSITIVE_INFINITY): void {
    if (this.stopped || !sessionId) {
      return
    }

    const listed = new Set(openIds)

    for (const [id, entry] of [...this.entries]) {
      if (entry.sessionId !== sessionId || listed.has(id) || entry.arrivedAt >= askedAt || entry.sending) {
        continue
      }

      // An answer that failed without the gateway's word may be what ended it. Closed as let go of here, not as
      // withdrawn: the list is no proof it ended. With turn isolation the gateway mirrors one open request per
      // session into its `open_requests`, so a second one that is still open is missing from it, and the gateway's
      // own re-delivery of a request it still waits for opens it again (rule 6).
      this.endHere(id, 'closed_here', entry.uncertain ? { kind: 'may_not_have_arrived' } : { kind: 'lapsed' }, 'lapsed')
    }
  }

  /** A "no longer listed" notice about a request the gateway then delivered again: it is open, so the line goes. */
  private dropLapsedNotice(id: string): void {
    const notices = this.store.getState().notices
    const held = Object.entries(notices).find(
      ([, notice]) => notice.requestId === id && notice.notice.kind === 'lapsed'
    )

    if (held) {
      const next = { ...notices }

      delete next[held[0]]
      this.store.setState({ notices: next })
    }
  }

  /**
   * What the passkey model's advert came to on this socket (rule 7); the first word per socket counts, a later one
   * changes nothing. Accepted: the lists the controller was given before are dropped (they could not list these
   * requests), and the passkey model reads them again. Refused: this socket cannot answer them, and the lists count
   * as they are. Unknown (the call failed): no list of this socket counts, the held ones included; the gateway's
   * `request.cancel` and the deadlines still end what ends.
   */
  advertSettled(outcome: RequestsAdvertOutcome): void {
    if (this.stopped || this.advert !== 'pending') {
      return
    }

    const held = [...this.heldLists]

    this.heldLists.clear()
    this.advert = outcome

    if (outcome === 'accepted') {
      this.acceptedAt = this.tick()
    } else if (outcome === 'refused') {
      for (const [sessionId, list] of held) {
        this.reconcile(sessionId, list.ids, list.askedAt)
      }
    }
  }

  /** A resume's or a replay's `open_requests`, through the controller: counted only as the advert allows (rule 7). */
  private replayedOpenRequests(sessionId: string, ids: readonly string[], askedAt: number): void {
    if (this.stopped || !sessionId) {
      return
    }

    if (this.advert === 'pending') {
      this.heldLists.set(sessionId, { ids, askedAt })

      return
    }

    // Asked for before the gateway knew this socket shows these requests: it listed none of them. After an advert
    // nobody knows the outcome of, no list says anything about them.
    if ((this.advert === 'accepted' && askedAt < this.acceptedAt) || this.advert === 'unknown') {
      return
    }

    this.reconcile(sessionId, ids, askedAt)
  }

  /** A `request.cancel` that reached this page in a replay (`session.events.since`) rather than live. */
  replayedCancel(id: string, reason: string): void {
    if (!this.stopped) {
      this.withdraw(id, reason)
    }
  }

  /** Take the chat's notice away. */
  dismissNotice(bot: string): void {
    const notices = this.store.getState().notices

    if (!Object.hasOwn(notices, bot)) {
      return
    }

    const next = { ...notices }

    delete next[bot]
    this.store.setState({ notices: next })
  }

  /** The request, when it is open on a chat and its deadline has not passed (a deadline that passed ends it now). */
  private openRequest(id: string): InteractiveRequest | undefined {
    const request = this.store.getState().requests.find(entry => entry.id === id)

    if (!request) {
      return undefined
    }

    if (this.now() >= request.deadline) {
      this.expire(id)

      return undefined
    }

    return request
  }

  /** What an answer that failed means for the request (rule 1). */
  private afterFailure(id: string, entry: Entry, error: unknown): AnswerOutcome {
    if (this.entries.get(id) !== entry) {
      return { kind: 'closed' }
    }

    if (error instanceof JsonRpcGatewayError && error.code === REFUSED_CODE) {
      const reason = displayText(isRecord(error.data) ? error.data.reason : '', REASON_LIMIT)

      // The tenth refusal withdraws it: the gateway says `request.cancel` too, which finds it closed.
      if (reason === 'too_many_attempts') {
        this.endHere(id, 'cancelled', { kind: 'withdrawn' }, 'too_many_attempts')

        return { kind: 'ended' }
      }

      // The gateway read this answer while the request was open: an earlier one that failed did not end it.
      entry.uncertain = false

      // ... but it ended while the refusal was on its way back.
      if (entry.pendingCancel !== null) {
        this.endedUnderAnswer(id, entry)

        return { kind: 'ended' }
      }

      this.refuse(id, entry, reason === '' ? 'refused' : reason)

      return this.expiredMeanwhile(id, entry) ?? { kind: 'refused', reason: reason === '' ? 'refused' : reason }
    }

    // No word from the gateway (no socket, a timeout) or a word that is not a verdict on the answer: it may or may
    // not have arrived. The request is still open for another try, unless the gateway stopped waiting meanwhile.
    entry.uncertain = true

    if (entry.pendingCancel !== null) {
      this.endedUnderAnswer(id, entry)

      return { kind: 'ended' }
    }

    return (
      this.expiredMeanwhile(id, entry) ?? {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error)
      }
    )
  }

  /** The deadline passed while the call was on its way (the timer left it to the call): it ends now. */
  private expiredMeanwhile(id: string, entry: Entry): AnswerOutcome | null {
    if (this.entries.get(id) !== entry || this.now() < entry.deadline) {
      return null
    }

    this.expire(id)

    return { kind: 'ended' }
  }

  /**
   * The answer from here did not settle the request, and the request ended all the same: a `request.cancel` that
   * came in while the call was on its way says why, an earlier answer that failed may be what ended it, and a reply
   * that only says the gateway no longer waits is told as what the page knows (rule 4).
   */
  private endedUnderAnswer(id: string, entry: Entry): void {
    const bot = this.store.getState().requests.find(open => open.id === id)?.bot

    if (entry.pendingCancel !== null) {
      // The gateway's own cancel reached the engine through the controller.
      this.closeCancelled(id, entry, entry.pendingCancel)

      return
    }

    const expired = this.now() >= entry.deadline
    const notice: InteractiveNoticeKind = entry.uncertain
      ? { kind: 'may_not_have_arrived' }
      : expired
        ? { kind: 'expired' }
        : { kind: 'withdrawn' }

    this.finish(id, 'cancelled', { unheard: !entry.uncertain && !expired, ...(bot === undefined ? {} : { bot }) })

    if (bot !== undefined) {
      this.show(bot, id, notice)
      this.options.engine?.ended(bot, id, expired ? 'timeout' : 'withdrawn')
    } else {
      this.remember(id, entry.sessionId, expired ? 'timeout' : 'withdrawn', entry.deadline)
    }
  }

  /** Close a request the gateway withdrew (`request.cancel {reason}`), with the notice its reason calls for. */
  private closeCancelled(id: string, entry: Entry | undefined, reason: string): void {
    const bot = this.store.getState().requests.find(open => open.id === id)?.bot

    this.finish(id, 'cancelled')

    if (bot !== undefined) {
      this.show(bot, id, cancelNotice(reason, entry?.uncertain === true))
    }
  }

  private refuse(id: string, entry: Entry, reason: string): void {
    entry.refusal = reason
    entry.version += 1
    this.patchRequest(id, { refusal: reason, version: entry.version })
  }

  /** `{status | decision, count?, edited?}` of an answer: keys and numbers, never a value. */
  private summaryOf(entry: Entry, result: InteractiveAnswer): RequestAnswerSummary {
    if (entry.ask.method === 'review.diff') {
      const decisions = 'hunks' in result && result.hunks ? Object.values(result.hunks) : []
      const approvedHunks = decisions.filter(decision => decision === 'approved').length

      // How many hunks went which way: two whole numbers, never a hunk, a path or a line.
      return {
        decision: 'decision' in result && result.decision === 'approved' ? 'approved' : 'rejected',
        approvedHunks,
        rejectedHunks: decisions.length - approvedHunks
      }
    }

    if (entry.ask.method === 'review.draft') {
      const approved = 'decision' in result && result.decision === 'approved'

      return {
        decision: approved ? 'approved' : 'rejected',
        // The gateway computes the real flag for the agent; this one is for the transcript line, from what was sent.
        ...(approved && 'text' in result
          ? { edited: stripLineEnds(result.text) !== stripLineEnds(entry.ask.text) }
          : {})
      }
    }

    if (!('status' in result) || result.status === 'skipped') {
      return { status: 'skipped' }
    }

    return {
      status: 'answered',
      ...(entry.ask.method === 'input.file' && 'files' in result && Array.isArray(result.files)
        ? { count: result.files.length }
        : {})
    }
  }

  // ── arriving ──────────────────────────────────────────────────────────────────────────────────

  /** The connection's handler: the interactive methods are ours, anything else is not. */
  private ingest(request: ServerRequest): boolean {
    if (this.stopped || !isInteractiveMethod(request.method)) {
      return false
    }

    this.arrive(request, request.method)

    return true
  }

  private arrive(request: ServerRequest, method: InteractiveMethod): void {
    const { id } = request

    if (!id) {
      return
    }

    let reopening: Closed | undefined
    const done = this.closed.get(id)

    if (done) {
      // A request this page declined is declined again by every copy: the gateway waits on whichever reached it.
      if (done.reason === 'declined') {
        this.failQuietly(request, done.decline ?? 'not_supported_on_device')

        return
      }

      // Only the gateway's re-delivery of a request it still waits for opens it again (rule 6).
      if (!request.replayed || (done.reason !== 'answered' && done.reason !== 'closed_here')) {
        return
      }

      this.closed.delete(id)
      reopening = done
      this.dropLapsedNotice(id)
    }

    const existing = this.entries.get(id)

    // A copy of one already here: a reconnect re-delivered it, and an error now goes out on the newest copy,
    // under the session the newest copy names.
    if (existing) {
      existing.request = request

      const session = str(request.params.session_id)

      if (session && session !== existing.sessionId) {
        existing.sessionId = session
        existing.version += 1
        this.patchRequest(id, { sessionId: session, version: existing.version })
        this.chatsChanged()
      }

      return
    }

    const sessionId = str(request.params.session_id)

    if (!sessionId) {
      this.declineUnseen(request, 'no_session')

      return
    }

    const read = readInteractiveParams(method, request.params)

    if (!read.ok) {
      this.declineUnseen(request, read.reason, sessionId, method)

      return
    }

    // A form with a field kind this build does not know cannot be shown whole (README §7).
    if (unknownFields(read.ask).length > 0) {
      this.declineUnseen(request, 'not_supported_on_device', sessionId, method)

      return
    }

    const now = this.now()
    const deadline = read.ask.expiresAt * 1000
    const bot = this.options.chatFor(sessionId)

    // Past its time on this clock: not answerable (README §2). The gateway's own `request.cancel` closes it.
    if (now >= deadline) {
      this.close(id, 'expired')

      if (bot !== undefined) {
        this.show(bot, id, { kind: 'expired' })
        this.options.engine?.ended(bot, id, 'timeout')
      } else {
        this.remember(id, sessionId, 'timeout', deadline)
      }

      return
    }

    if (bot === undefined && this.parked.size >= MAX_PARKED) {
      this.declineUnseen(request, 'too_many_waiting', sessionId, method)

      return
    }

    const entry: Entry = {
      request,
      method,
      sessionId,
      ask: read.ask,
      deadline,
      arrivedAt: this.tick(),
      // Only an answer of the person's that went out from here can have been lost; one let go of here was not.
      earlierLost: reopening?.reason === 'answered' ? (reopening.skipped ? 'skip' : 'answer') : null,
      refusal: null,
      version: 0,
      sending: false,
      pendingCancel: null,
      uncertain: false
    }

    this.entries.set(id, entry)
    this.arm(id, deadline)

    if (bot === undefined) {
      this.parked.add(id)
    } else {
      this.place(id, entry, bot)
    }
  }

  private place(id: string, entry: Entry, bot: string): void {
    this.parked.delete(id)
    this.seq += 1
    entry.version += 1

    const request: InteractiveRequest = {
      id,
      method: entry.method,
      version: entry.version,
      ask: entry.ask,
      bot,
      sessionId: entry.sessionId,
      deadline: entry.deadline,
      earlierLost: entry.earlierLost,
      refusal: entry.refusal,
      seq: this.seq
    }

    this.store.setState(state => ({ requests: [...state.requests, request] }))
    this.options.engine?.asked(bot, {
      id,
      method: entry.method,
      title: entry.ask.title,
      summary: entry.ask.summary,
      optional: entry.ask.optional,
      replayed: entry.request.replayed === true
    })
  }

  /** Decline a request this page never opened: once, with one notice on its chat when a chat holds the session. */
  private declineUnseen(request: ServerRequest, reason: string, sessionId = '', method = request.method): void {
    const bot = sessionId ? this.options.chatFor(sessionId) : undefined

    this.close(request.id, 'declined', { decline: reason })
    this.fail(request, reason)

    if (bot !== undefined) {
      this.show(bot, request.id, { kind: 'cannot_show', method: displayText(method, NAME_LIMIT), reason })
      // A resume's snapshot may already have put the question in the engine (the controller hands it every open
      // request): its item ends here, or the chat would go on needing an answer nobody can give.
      this.options.engine?.ended(bot, request.id, 'cannot_show')
    } else {
      // The deadline the frame names, when it names one; a frame that cannot be read waits from now.
      const expiresAt = request.params.expires_at

      this.remember(
        request.id,
        sessionId,
        'cannot_show',
        typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt * 1000 : 0
      )
    }
  }

  /** Decline an open request: the error goes out, it closes, its chat is told once, and the engine's item ends. */
  private decline(request: ServerRequest, reason: string, bot: string, entry: Entry): void {
    this.finish(request.id, 'declined', { decline: reason })
    this.fail(request, reason)
    this.show(bot, request.id, { kind: 'cannot_show', method: displayText(entry.method, NAME_LIMIT), reason })
    // The person chose not to share (`declined`): the record says so, not that the page failed to show it.
    this.options.engine?.ended(bot, request.id, reason === 'declined' ? 'declined' : 'cannot_show')
  }

  // ── the chats moved on ────────────────────────────────────────────────────────────────────────

  /**
   * The chats changed: place the requests waiting for their chat, move a request whose session moved, and let go
   * of one whose session no chat holds (rule 4, rule 5). Telling the engine changes the chats, which calls this
   * again: a call made from inside a pass only asks for one more.
   */
  private chatsChanged(): void {
    if (this.stopped) {
      return
    }

    this.pruneUnended()

    if (this.entries.size === 0) {
      // Nothing open or waiting: only what ended before its chat held it can still match, and a chat-store update
      // (every streamed delta) costs a lookup per such request, of which there are few and none for long.
      if (this.unended.size > 0 && !this.settling) {
        this.endUnended()
      }

      return
    }

    if (this.settling) {
      this.unsettled = true

      return
    }

    this.settling = true

    try {
      do {
        this.unsettled = false
        this.settle()
      } while (this.unsettled && !this.stopped)
    } finally {
      this.settling = false
    }
  }

  /** What ended before its chat held its session ends on that chat, once the chat shows it. */
  private endUnended(): void {
    const { chatFor, engine } = this.options

    for (const [id, { sessionId, reason }] of [...this.unended]) {
      const bot = chatFor(sessionId)

      // `ended` changes the chats, which may have ended this one already from inside the call.
      if (this.unended.has(id) && bot !== undefined && (engine?.holds?.(bot, id) ?? true)) {
        this.unended.delete(id)
        engine?.ended(bot, id, reason)
      }
    }
  }

  /** Forget what ended before its chat held it once no snapshot can list it any more (`UNENDED_GRACE_MS`). */
  private pruneUnended(): void {
    if (this.unended.size === 0) {
      return
    }

    const now = this.now()

    for (const [id, { until }] of [...this.unended]) {
      if (now > until) {
        this.unended.delete(id)
      }
    }
  }

  private settle(): void {
    const { chatFor } = this.options

    this.endUnended()

    for (const id of [...this.parked]) {
      const entry = this.entries.get(id)
      const bot = entry ? chatFor(entry.sessionId) : undefined

      if (entry && bot !== undefined) {
        this.place(id, entry, bot)
      }
    }

    const abandoned: InteractiveRequest[] = []
    const moves: { from: string; request: InteractiveRequest }[] = []
    const next = this.store.getState().requests.map(request => {
      const bot = chatFor(request.sessionId)

      if (bot === undefined) {
        abandoned.push(request)

        return request
      }

      if (bot === request.bot) {
        return request
      }

      const entry = this.entries.get(request.id)

      if (entry) {
        entry.version += 1
      }

      const placed = { ...request, bot, version: entry?.version ?? request.version + 1 }

      moves.push({ from: request.bot, request: placed })

      return placed
    })

    if (moves.length > 0) {
      this.store.setState({ requests: next })
    }

    // The old chat's item ends where it was asked; the new chat's opens.
    for (const { from, request } of moves) {
      const entry = this.entries.get(request.id)

      this.options.engine?.ended(from, request.id, 'moved')

      if (entry) {
        this.options.engine?.asked(request.bot, {
          id: request.id,
          method: entry.method,
          title: entry.ask.title,
          summary: entry.ask.summary,
          optional: entry.ask.optional,
          replayed: true
        })
      }
    }

    for (const request of abandoned) {
      const entry = this.entries.get(request.id)

      this.finish(request.id, 'closed_here')
      this.show(request.bot, request.id, { kind: 'withdrawn' })
      this.options.engine?.ended(request.bot, request.id, 'lapsed')

      // If this does not arrive, the gateway's re-delivery opens it again (rule 6).
      if (entry) {
        this.fail(entry.request, 'no_chat')
      }
    }
  }

  // ── the gateway stopped waiting ───────────────────────────────────────────────────────────────

  /**
   * `request.cancel`: `timeout` reads as expired, `resolved` as answered on another device, any other reason as
   * withdrawn. One that arrives while an answer from here is on its way waits for the call's result (rule 4).
   */
  private withdraw(id: string, reason: string): void {
    if (!id) {
      return
    }

    const entry = this.entries.get(id)

    if (entry?.sending) {
      entry.pendingCancel = reason

      return
    }

    if (entry) {
      this.closeCancelled(id, entry, reason)

      return
    }

    const done = this.closed.get(id)

    // Answered from here a moment ago, and the gateway stopped waiting for another reason than that answer: the two
    // crossed, and the answer may never have counted. Said, not swallowed; a Skip that crossed changes nothing for
    // the reader. `resolved` is the gateway telling every client that an answer (this one) settled it.
    if (done?.reason === 'answered' && !done.skipped && done.bot !== undefined && reason !== 'resolved') {
      this.show(done.bot, id, { kind: 'may_not_have_arrived' })
    }

    // Closed on a reply that only said the gateway no longer waits: now it says why.
    if (done?.reason === 'cancelled' && done.unheard && done.bot !== undefined) {
      done.unheard = false
      this.show(done.bot, id, cancelNotice(reason, false))

      return
    }

    // Not here (yet, or not one of ours, or done): whatever arrives with this id later is ignored.
    if (done?.reason !== 'declined' && done?.reason !== 'cancelled') {
      this.close(id, 'cancelled')
    }
  }

  /** The deadline passed: close it, send nothing. An answer on its way is left to the call's result (rule 4). */
  private expire(id: string): void {
    if (this.entries.get(id)?.sending) {
      return
    }

    this.endHere(id, 'expired', { kind: 'expired' }, 'timeout')
  }

  /**
   * End a request on this page's own account: close it, say why on its chat, and end the engine's item (the gateway
   * said nothing the engine would hear).
   */
  private endHere(id: string, reason: CloseReason, notice: InteractiveNoticeKind, engineReason: string): void {
    const request = this.store.getState().requests.find(entry => entry.id === id)

    const entry = this.entries.get(id)

    if (request) {
      this.finish(id, reason)
      this.show(request.bot, id, notice)
      this.options.engine?.ended(request.bot, id, engineReason)
    } else if (entry) {
      this.finish(id, reason)
      this.remember(id, entry.sessionId, engineReason, entry.deadline)
    }
  }

  /**
   * A request that ended here while it waited for its chat: a resume's snapshot may still put its question on the
   * chat that comes to hold its session, and that item must end too (`settle`).
   */
  private remember(id: string, sessionId: string, reason: string, deadline: number): void {
    if (!sessionId) {
      return
    }

    this.unended.delete(id)
    this.unended.set(id, { sessionId, reason, until: Math.max(deadline, this.now()) + UNENDED_GRACE_MS })

    if (this.unended.size > UNENDED_LIMIT) {
      const oldest = this.unended.keys().next().value

      if (oldest !== undefined) {
        this.unended.delete(oldest)
      }
    }
  }

  /** Arm the timer that ends it at `deadline`, in steps a timer can count. */
  private arm(id: string, deadline: number): void {
    const wait = Math.min(Math.max(0, deadline - this.now()), MAX_TIMER_MS)

    this.expiries.set(
      id,
      this.timers.setTimeout(() => {
        this.expiries.delete(id)

        // An answer on its way when the time comes: `expire` leaves it to the call's result, which looks again.
        if (this.now() >= deadline) {
          this.expire(id)
        } else if (this.entries.has(id)) {
          this.arm(id, deadline)
        }
      }, wait)
    )
  }

  // ── bookkeeping ───────────────────────────────────────────────────────────────────────────────

  /** Answer `request` with `4041 cannot_show {reason}`. */
  private fail(request: ServerRequest, reason: string): void {
    const send = this.options.failWithData

    if (send) {
      send(request, CANNOT_SHOW_CODE, CANNOT_SHOW_MESSAGE, { reason })
    } else {
      request.fail(CANNOT_SHOW_CODE, CANNOT_SHOW_MESSAGE)
    }
  }

  /** Answer a copy of a request already declined; a socket that went away is not a problem. */
  private failQuietly(request: ServerRequest, reason: string): void {
    try {
      this.fail(request, reason)
    } catch {
      // The next copy is answered again.
    }
  }

  private patchRequest(id: string, patch: Partial<InteractiveRequest>): void {
    this.store.setState(state => ({
      requests: state.requests.map(request => (request.id === id ? { ...request, ...patch } : request))
    }))
  }

  /** Take a request out of every table, and remember it is done and why. */
  private finish(id: string, reason: CloseReason, extra: Omit<Closed, 'reason'> = {}): void {
    const timer = this.expiries.get(id)

    if (timer !== undefined) {
      this.timers.clearTimeout(timer)
    }

    this.expiries.delete(id)
    this.entries.delete(id)
    this.parked.delete(id)

    const requests = this.store.getState().requests

    if (requests.some(request => request.id === id)) {
      this.store.setState({ requests: requests.filter(request => request.id !== id) })
    }

    this.close(id, reason, extra)
  }

  private close(id: string, reason: CloseReason, extra: Omit<Closed, 'reason'> = {}): void {
    this.closed.delete(id)
    this.closed.set(id, { reason, ...extra })

    if (this.closed.size > CLOSED_LIMIT) {
      const oldest = this.closed.keys().next().value

      if (oldest !== undefined) {
        this.closed.delete(oldest)
      }
    }
  }

  private show(bot: string, requestId: string, notice: InteractiveNoticeKind): void {
    this.serial += 1
    this.store.setState(state => ({ notices: { ...state.notices, [bot]: { id: this.serial, requestId, notice } } }))
  }
}

/**
 * The notice a `request.cancel` reason calls for. `uncertain`: an answer from here failed without the gateway's
 * word, so a `resolved` may be that answer settling it, or another device's.
 */
function cancelNotice(reason: string, uncertain: boolean): InteractiveNoticeKind {
  switch (reason) {
    case 'timeout':
      return { kind: 'expired' }
    case 'resolved':
      return uncertain ? { kind: 'may_not_have_arrived' } : { kind: 'answered_elsewhere' }
    default:
      return { kind: 'withdrawn' }
  }
}
