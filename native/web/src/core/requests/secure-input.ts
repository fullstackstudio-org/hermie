/**
 * The one-string prompts a bot sends a client (`secret`, `sudo`,
 * `vault.unlock_prompt`, `vault.code`, `vault.save_login`), from the moment they
 * arrive until they are answered, skipped, expired or withdrawn; and the requests
 * only the desktop app can answer (`unsupported.ts`), declined with one notice on
 * their chat.
 *
 * The native apps' `SecureInputCenter` (`HermieCore/SecureInput`), for a browser.
 *
 * **Beside the engine, on purpose.** What a person types for one of these must
 * never reach the transcript engine, the chat store, the cache, drafts, a log or
 * a diagnostics export. So these requests never go through the chat controller
 * (which declines them) or the ingest: this model takes them from the connection
 * itself (`onRequest`, tried after the controller and the passkey model), keeps
 * what was asked in `state/secure-input.ts`, and answers on the request's own
 * reply. `answer` takes the typed text as an argument, builds the `{value}` the
 * gateway reads, hands it to `respond` and keeps nothing: the sheet read it from
 * its field a moment before and clears the field once it went.
 *
 * The rules, as built:
 *
 *  1. **Answers.** `{value}` with what was typed; `''` is Skip. A one-time code
 *     loses the spaces and dashes people type to read it in groups. A login is the
 *     JSON text `{"identifier": ..., "password": ...}` the gateway parses, built in
 *     memory from the two fields. Nothing is sent while the connection is not
 *     `ready` (the reply would be lost on a socket that is gone): the sheet keeps
 *     what is typed and says so.
 *  2. **Deadlines follow the gateway** (`tui_gateway/agent_callbacks.py`): 300 s
 *     for a secret (`_ask`'s default), 120 s for sudo and an unlock, 180 s for a
 *     code and a login. A live request's countdown starts when it arrives. One
 *     first seen re-delivered (a resume's `open_requests`, a reload) has no
 *     countdown, because it may have waited a while, and is closed here at its
 *     arrival plus the method's timeout, which is never before the gateway's.
 *  3. **Ending.** The deadline passing closes a prompt with an "expired" notice
 *     and sends nothing; `request.cancel` closes it with "expired" (`timeout`) or
 *     "withdrawn" (any other reason). A prompt whose session no chat holds any
 *     more is answered `''` with a "withdrawn" notice, and `stop` (a sign-out)
 *     answers every open one `''` before the socket closes.
 *  4. **Routing.** A prompt belongs to the chat whose runtime session is the
 *     request's `session_id`. One for a session no chat holds yet waits (a resume
 *     re-delivers open requests before it binds their session), bounded in number,
 *     until a chat holds it or its deadline passes; it is never declined for
 *     waiting, because another client of the same gateway, or a chat the reader is
 *     about to open, may answer it. When its session moves to another chat, the
 *     prompt moves with it.
 *  5. **An answer that did not arrive.** A re-delivered copy of a request this
 *     model already answered or let go is proof that the gateway never got it:
 *     the prompt opens again and says so. A copy of one the gateway withdrew, one
 *     that expired, or one that was only a notice is ignored.
 *  6. **Requests only the desktop app can answer** are declined at once with the
 *     native apps' `-32601`, and leave ONE notice on their chat per request, however
 *     often it is re-delivered (a notice for a session no chat holds waits 15 s for
 *     one).
 *
 * Texts from the request are cleaned and bounded for display (`displayText`): no
 * control, format (bidirectional overrides among them), private-use or unassigned
 * characters, no runs of blank lines, at most four combining marks per character,
 * and a length limit, so one text cannot pass for another or paint over the
 * sheet's own words.
 */
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { ConnectionStatus } from '@hermie/gateway-client'
import type { StoreApi } from 'zustand/vanilla'

import {
  type SecureAsk,
  type SecureInputState,
  secureInputStore,
  type SecureNoticeKind,
  type SecurePrompt
} from '../../state/secure-input'
import type { ChatGateway } from '../link'
import { declineUnsupported, isUnsupportedMethod, UNSUPPORTED_CODE } from './unsupported'

/** The slice of the connection the model uses. */
export type SecureInputGateway = Pick<ChatGateway, 'onAny' | 'onRequest' | 'onStatus'>

/** The methods answered here, and what each asks for. */
export const SECURE_METHODS: Readonly<Record<string, SecureAsk['kind']>> = Object.freeze({
  secret: 'secret',
  sudo: 'sudo',
  'vault.unlock_prompt': 'vault_unlock',
  'vault.code': 'vault_code',
  'vault.save_login': 'vault_save_login'
})

export const isSecureMethod = (method: string): boolean => Object.hasOwn(SECURE_METHODS, method)

/** How long the gateway waits for each kind before it gives up by itself (rule 2). */
export const GATEWAY_TIMEOUT_MS: Readonly<Record<SecureAsk['kind'], number>> = Object.freeze({
  secret: 300_000,
  sudo: 120_000,
  vault_unlock: 120_000,
  vault_code: 180_000,
  vault_save_login: 180_000
})

/** The longest name shown (a variable, a site, a password manager, a method). */
export const NAME_LIMIT = 120
/** The longest free text shown (a prompt, a hint). */
export const TEXT_LIMIT = 600
/** The longest command shown. */
export const COMMAND_LIMIT = 1_000
/** The most combining marks kept on one character: enough for any script, too few to paint over other lines. */
export const MARKS_PER_CHARACTER = 4

/** How many prompts wait for their chat at once; one more is declined. */
const MAX_PARKED = 16
/** How many notices wait for their chat at once; one more drops the oldest. */
const MAX_PARKED_NOTICES = 16
/** How long a notice waits for its chat. */
const NOTICE_PARK_MS = 15_000
/** How many finished ids are remembered (rule 5). */
const CLOSED_LIMIT = 512

const DROPPED = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]$/u
const SPACE = /^\p{Zs}$/u
const MARK = /^\p{M}$/u

/**
 * `raw` for display, in one bounded pass over its code points (the native apps'
 * `SecurePrompt.displayText`): control, format, separator, private-use, surrogate
 * and unassigned characters are dropped; a tab is a space, runs of spaces are one
 * and every run of line breaks (blank lines included) is one line break; at most
 * `MARKS_PER_CHARACTER` combining marks stay on one character; the result is
 * trimmed and holds at most `limit` code points, with an ellipsis when anything was
 * cut. At most `limit * 8 + 64` code points of `raw` are read, so a request of any
 * size costs the same. Anything but a string is empty.
 */
export function displayText(raw: unknown, limit: number): string {
  if (typeof raw !== 'string' || raw === '' || limit <= 0) {
    return ''
  }

  let out = ''
  let count = 0
  let marks = 0
  let pendingSpace = false
  let pendingBreak = false
  let cut = false
  let read = 0
  const readLimit = limit * 8 + 64

  for (const char of raw) {
    read += 1

    if (read > readLimit) {
      cut = true
      break
    }

    if (char === '\n' || char === '\r') {
      pendingBreak = true
      pendingSpace = false
      continue
    }

    if (char === '\t' || char === ' ' || SPACE.test(char)) {
      pendingSpace = true
      continue
    }

    if (DROPPED.test(char)) {
      continue
    }

    if (MARK.test(char)) {
      marks += 1

      // On no character (the start, or after a blank), or one too many.
      if (marks > MARKS_PER_CHARACTER || count === 0 || pendingSpace || pendingBreak) {
        continue
      }
    } else {
      marks = 0
    }

    // The separator a run of blanks stands for, never at the start.
    if (count > 0 && (pendingBreak || pendingSpace)) {
      out += pendingBreak ? '\n' : ' '
      count += 1
    }

    pendingBreak = false
    pendingSpace = false

    if (count >= limit) {
      cut = true
      break
    }

    out += char
    count += 1
  }

  // A trailing separator was never written; one written just before the cut is dropped.
  out = out.replace(/[ \n]+$/u, '')

  return cut ? `${out}…` : out
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** What a request asks for, its texts cleaned; `null` for a method answered elsewhere. */
export function readAsk(method: string, params: Record<string, unknown>): SecureAsk | null {
  switch (method) {
    case 'secret':
      return {
        kind: 'secret',
        envVar: displayText(params.env_var, NAME_LIMIT),
        prompt: displayText(params.prompt, TEXT_LIMIT)
      }
    case 'sudo':
      return { kind: 'sudo', command: displayText(params.command, COMMAND_LIMIT) }
    case 'vault.unlock_prompt': {
      const name = displayText(params.display_name, NAME_LIMIT)

      return { kind: 'vault_unlock', name: name || displayText(params.backend, NAME_LIMIT) }
    }
    case 'vault.code':
      return {
        kind: 'vault_code',
        site: displayText(params.site, NAME_LIMIT),
        hint: displayText(params.hint, TEXT_LIMIT)
      }
    case 'vault.save_login': {
      const origin = displayText(params.origin, NAME_LIMIT)
      const site = displayText(params.site, NAME_LIMIT)

      return { kind: 'vault_save_login', site: site || origin, origin }
    }
    default:
      return null
  }
}

/**
 * The text that answers `ask` with what was typed, or `null` when it cannot answer it (nothing typed).
 * A value is sent as typed (a password may start or end with a space); a code drops spaces and dashes; a
 * login is the JSON text of the trimmed identifier and the password.
 */
export function answerText(ask: SecureAsk, value: string, identifier = ''): string | null {
  switch (ask.kind) {
    case 'vault_code': {
      const code = value.replace(/[\s-]/gu, '')

      return code === '' ? null : code
    }
    case 'vault_save_login': {
      const name = identifier.trim()

      return name === '' || value === '' ? null : JSON.stringify({ identifier: name, password: value })
    }
    default:
      return value === '' ? null : value
  }
}

/** What became of an answer or a Skip. */
export type AnswerOutcome =
  /** It went out on the request's reply. */
  | 'sent'
  /** Nothing typed that answers the prompt; nothing went out. */
  | 'empty'
  /** The prompt is no longer open (answered, withdrawn, expired); nothing went out. */
  | 'closed'
  /** The connection is not ready; nothing went out and the prompt is still open. */
  | 'offline'

export interface SecureInputTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const pageTimers: SecureInputTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface SecureInputModelOptions {
  gateway: SecureInputGateway
  store?: StoreApi<SecureInputState>
  /** The key of the chat that holds a runtime session, or `undefined` when none does. */
  chatFor: (sessionId: string) => string | undefined
  /** Call `listener` whenever the sessions the chats hold may have changed; returns the way to stop. */
  watchChats?: (listener: () => void) => () => void
  /** The gateway as a person knows it (its host), for the sheet's chrome. */
  gatewayName?: string
  /** Epoch milliseconds. */
  now?: () => number
  timers?: SecureInputTimers
}

/** Why an id is done (rule 5). */
type CloseReason =
  /** An answer (a value or `''`) went out from here. */
  | 'answered'
  /** Let go of here without an answer of the person's: its chat let go of it, or it was declined. */
  | 'closed_here'
  /** Its deadline passed. */
  | 'expired'
  /** The gateway withdrew it (`request.cancel`). */
  | 'cancelled'
  /** A request this page cannot show; its notice was left. */
  | 'notice'

interface Closed {
  reason: CloseReason
  deadline: number | null
}

/** A prompt that is open or waiting for its chat: the newest delivery and what it asks. */
interface Entry {
  request: ServerRequest
  sessionId: string
  ask: SecureAsk
  deadline: number | null
  earlierAnswerLost: boolean
}

interface ParkedNotice {
  sessionId: string
  method: string
  timer: unknown
}

const SKIPPED = ''

export class SecureInputModel {
  readonly store: StoreApi<SecureInputState>

  private readonly options: SecureInputModelOptions
  private readonly timers: SecureInputTimers
  /** Every open prompt and every one waiting for its chat, by id. */
  private readonly entries = new Map<string, Entry>()
  /** The ids of `entries` that wait for their chat. */
  private readonly parked = new Set<string>()
  private readonly expiries = new Map<string, unknown>()
  private readonly parkedNotices = new Map<string, ParkedNotice>()
  private readonly closed = new Map<string, Closed>()
  private unsubscribes: (() => void)[] = []
  private ready = false
  private started = false
  private stopped = false
  private seq = 0
  private serial = 0

  constructor(options: SecureInputModelOptions) {
    this.options = options
    this.store = options.store ?? secureInputStore
    this.timers = options.timers ?? pageTimers
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
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

        const payload = (event.payload ?? {}) as Record<string, unknown>

        this.withdraw(str(payload.id), str(payload.reason))
      }),
      gateway.onStatus((status: ConnectionStatus) => {
        this.ready = status === 'ready'
      }),
      ...(this.options.watchChats ? [this.options.watchChats(() => this.chatsChanged())] : [])
    )
  }

  /**
   * Answer every open prompt `''` (the person is leaving; the bot is told "skipped" rather than left to its
   * deadline), forget the rest, and stop. Call before the socket closes. Idempotent.
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

    for (const prompt of this.store.getState().prompts) {
      this.entries.get(prompt.id)?.request.respond({ value: SKIPPED })
    }

    for (const timer of this.expiries.values()) {
      this.timers.clearTimeout(timer)
    }

    for (const notice of this.parkedNotices.values()) {
      this.timers.clearTimeout(notice.timer)
    }

    this.entries.clear()
    this.parked.clear()
    this.expiries.clear()
    this.parkedNotices.clear()
    this.closed.clear()
    this.store.getState().reset()
  }

  // ── answering ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Answer the prompt `id` with what the person typed (and, for a login, the identifier). The text is used
   * for this one reply and kept nowhere. Nothing goes out for a prompt that is no longer open, whose deadline
   * passed, that `value` cannot answer, or while the connection is not ready.
   */
  answer(id: string, value: string, identifier = ''): AnswerOutcome {
    const prompt = this.openPrompt(id)

    if (!prompt) {
      return 'closed'
    }

    const text = answerText(prompt.ask, value, identifier)

    if (text === null) {
      return 'empty'
    }

    return this.deliver(id, text)
  }

  /** Skip: answer `''`, the gateway's "skipped". */
  skip(id: string): AnswerOutcome {
    return this.openPrompt(id) ? this.deliver(id, SKIPPED) : 'closed'
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

  /** The prompt, when it is open and its deadline has not passed (a deadline that passed ends it now). */
  private openPrompt(id: string): SecurePrompt | undefined {
    const prompt = this.store.getState().prompts.find(entry => entry.id === id)

    if (!prompt) {
      return undefined
    }

    if (this.pastDeadline(prompt)) {
      this.expire(id)

      return undefined
    }

    return prompt
  }

  private pastDeadline(prompt: SecurePrompt): boolean {
    return prompt.deadline !== null && this.now() >= prompt.deadline
  }

  private deliver(id: string, text: string): AnswerOutcome {
    const entry = this.entries.get(id)

    if (!entry) {
      return 'closed'
    }

    if (!this.ready) {
      return 'offline'
    }

    this.finish(id, 'answered')
    entry.request.respond({ value: text })

    return 'sent'
  }

  // ── arriving ──────────────────────────────────────────────────────────────────────────────────

  /** The connection's handler: the secure methods and the desktop-only ones are ours, anything else is not. */
  private ingest(request: ServerRequest): boolean {
    if (this.stopped) {
      return false
    }

    if (isUnsupportedMethod(request.method)) {
      this.unsupported(request)

      return true
    }

    if (!isSecureMethod(request.method)) {
      return false
    }

    this.arrive(request)

    return true
  }

  private arrive(request: ServerRequest): void {
    const { id, method } = request

    if (!id) {
      return
    }

    let reopening: Closed | undefined
    const done = this.closed.get(id)

    if (done) {
      // Only the gateway's re-delivery of a request it still waits for opens it again (rule 5).
      if (!request.replayed || (done.reason !== 'answered' && done.reason !== 'closed_here')) {
        return
      }

      this.closed.delete(id)
      reopening = done
    }

    const existing = this.entries.get(id)

    // A copy of one already here: a reconnect re-delivered it, and its reply now goes out on the newest copy.
    if (existing) {
      existing.request = request

      return
    }

    const ask = readAsk(method, request.params)
    const sessionId = str(request.params.session_id)

    if (!ask) {
      return
    }

    if (!sessionId) {
      this.close(id, 'closed_here')
      request.fail(UNSUPPORTED_CODE, `no chat on this client holds the session for: ${method}`)

      return
    }

    // The gateway's clock started when it sent the request: for one that arrives live, now (rule 2).
    const now = this.now()
    const timeout = GATEWAY_TIMEOUT_MS[ask.kind]
    let deadline: number | null
    let expiry: number

    if (!request.replayed) {
      deadline = now + timeout
      expiry = deadline
    } else if (reopening?.deadline != null) {
      deadline = reopening.deadline
      expiry = deadline
    } else {
      deadline = null
      expiry = now + timeout
    }

    const entry: Entry = { request, sessionId, ask, deadline, earlierAnswerLost: reopening?.reason === 'answered' }
    const bot = this.options.chatFor(sessionId)

    if (bot === undefined && this.parked.size >= MAX_PARKED) {
      this.close(id, 'closed_here', deadline)
      request.fail(UNSUPPORTED_CODE, `no chat on this client holds the session for: ${method}`)

      return
    }

    this.entries.set(id, entry)
    this.expiries.set(
      id,
      this.timers.setTimeout(() => this.expire(id), Math.max(0, expiry - now))
    )

    if (bot === undefined) {
      this.parked.add(id)
    } else {
      this.place(id, entry, bot)
    }
  }

  private place(id: string, entry: Entry, bot: string): void {
    this.parked.delete(id)
    this.seq += 1

    const prompt: SecurePrompt = {
      id,
      method: entry.request.method,
      ask: entry.ask,
      bot,
      sessionId: entry.sessionId,
      deadline: entry.deadline,
      earlierAnswerLost: entry.earlierAnswerLost,
      seq: this.seq
    }

    this.store.setState(state => ({ prompts: [...state.prompts, prompt] }))
  }

  private unsupported(request: ServerRequest): void {
    // Every copy is answered: the gateway waits on whichever one reached it.
    declineUnsupported(request)

    const { id } = request

    // One notice per request, however often it is delivered.
    if (!id || this.closed.has(id) || this.parkedNotices.has(id)) {
      return
    }

    this.close(id, 'notice')

    const sessionId = str(request.params.session_id)

    if (!sessionId) {
      return
    }

    const method = displayText(request.method, NAME_LIMIT)
    const bot = this.options.chatFor(sessionId)

    if (bot !== undefined) {
      this.show(bot, id, { kind: 'unsupported', method })

      return
    }

    if (this.parkedNotices.size >= MAX_PARKED_NOTICES) {
      const oldest = this.parkedNotices.keys().next().value

      if (oldest !== undefined) {
        this.dropNotice(oldest)
      }
    }

    this.parkedNotices.set(id, {
      sessionId,
      method,
      timer: this.timers.setTimeout(() => this.dropNotice(id), NOTICE_PARK_MS)
    })
  }

  private dropNotice(id: string): void {
    const parked = this.parkedNotices.get(id)

    if (parked) {
      this.timers.clearTimeout(parked.timer)
      this.parkedNotices.delete(id)
    }
  }

  // ── the chats moved on ────────────────────────────────────────────────────────────────────────

  /**
   * The chats changed: place the prompts and notices waiting for their chat, move a prompt whose session
   * moved, and let go of one whose session no chat holds (rule 3, rule 4).
   */
  private chatsChanged(): void {
    if (this.stopped || (this.entries.size === 0 && this.parkedNotices.size === 0)) {
      return
    }

    const { chatFor } = this.options

    for (const id of [...this.parked]) {
      const entry = this.entries.get(id)
      const bot = entry ? chatFor(entry.sessionId) : undefined

      if (entry && bot !== undefined) {
        this.place(id, entry, bot)
      }
    }

    for (const [id, notice] of [...this.parkedNotices]) {
      const bot = chatFor(notice.sessionId)

      if (bot !== undefined) {
        this.dropNotice(id)
        this.show(bot, id, { kind: 'unsupported', method: notice.method })
      }
    }

    const prompts = this.store.getState().prompts
    const abandoned: SecurePrompt[] = []
    let moved = false
    const next = prompts.map(prompt => {
      const bot = chatFor(prompt.sessionId)

      if (bot === undefined) {
        abandoned.push(prompt)

        return prompt
      }

      if (bot !== prompt.bot) {
        moved = true

        return { ...prompt, bot }
      }

      return prompt
    })

    if (moved) {
      this.store.setState({ prompts: next })
    }

    for (const prompt of abandoned) {
      const entry = this.entries.get(prompt.id)

      this.finish(prompt.id, 'closed_here')
      this.show(prompt.bot, prompt.id, { kind: 'withdrawn' })
      // If this does not arrive, the gateway's re-delivery opens it again (rule 5).
      entry?.request.respond({ value: SKIPPED })
    }
  }

  // ── the gateway stopped waiting ───────────────────────────────────────────────────────────────

  /** `request.cancel`: `timeout` reads as expired, any other reason as withdrawn. */
  private withdraw(id: string, reason: string): void {
    if (!id) {
      return
    }

    const prompt = this.store.getState().prompts.find(entry => entry.id === id)

    if (prompt) {
      this.finish(id, 'cancelled')
      this.show(prompt.bot, id, reason === 'timeout' ? { kind: 'expired' } : { kind: 'withdrawn' })

      return
    }

    if (this.entries.has(id)) {
      this.finish(id, 'cancelled')

      return
    }

    // Not here (yet, or not a prompt at all): whatever arrives with this id later is ignored.
    this.close(id, 'cancelled')
  }

  /** The deadline passed: close it, send nothing. */
  private expire(id: string): void {
    const prompt = this.store.getState().prompts.find(entry => entry.id === id)

    if (prompt) {
      this.finish(id, 'expired')
      this.show(prompt.bot, id, { kind: 'expired' })
    } else if (this.entries.has(id)) {
      this.finish(id, 'expired')
    }
  }

  // ── bookkeeping ───────────────────────────────────────────────────────────────────────────────

  /** Take a prompt out of every table, and remember it is done and why. */
  private finish(id: string, reason: CloseReason): void {
    const deadline = this.entries.get(id)?.deadline ?? null
    const timer = this.expiries.get(id)

    if (timer !== undefined) {
      this.timers.clearTimeout(timer)
    }

    this.expiries.delete(id)
    this.entries.delete(id)
    this.parked.delete(id)

    const prompts = this.store.getState().prompts

    if (prompts.some(prompt => prompt.id === id)) {
      this.store.setState({ prompts: prompts.filter(prompt => prompt.id !== id) })
    }

    this.close(id, reason, deadline)
  }

  private close(id: string, reason: CloseReason, deadline: number | null = null): void {
    this.closed.delete(id)
    this.closed.set(id, { reason, deadline })

    if (this.closed.size > CLOSED_LIMIT) {
      const oldest = this.closed.keys().next().value

      if (oldest !== undefined) {
        this.closed.delete(oldest)
      }
    }
  }

  private show(bot: string, requestId: string, notice: SecureNoticeKind): void {
    this.serial += 1
    this.store.setState(state => ({ notices: { ...state.notices, [bot]: { id: this.serial, requestId, notice } } }))
  }
}
