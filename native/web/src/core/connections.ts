/**
 * The connector authorisations a bot is waiting on: one card per chat
 * (`connection.request`, or a resume's `pending_connection` for a page that missed
 * it), moved by `connection.update`, withdrawn when the operation settles, its
 * deadline passes or the chat lets go of the session. What the page shows is in
 * `state/connections.ts`; the request layer draws it as a sheet with a countdown.
 *
 * The native apps' `ConnectionRequestsModel`, for a browser. The rules, as built:
 *
 *  1. **A card needs** an op id, the tool call that opened it, a deadline and at
 *     least one named row, on a chat's runtime session (`normalizeConnectionRequest`);
 *     anything less is not shown.
 *  2. **Order.** A frame for the operation already shown moves it only when its own
 *     `seq` is higher. A resume's snapshot of the same operation on another runtime
 *     session moves the card to that session (the answer must name it) and changes
 *     nothing else; a resume that names no operation withdraws the chat's card.
 *  3. **Ending.** `connection.update` with `settled: true` withdraws the card; so
 *     does the deadline on this page's clock (the gateway settles it then, and a
 *     socket that is down cannot say so); so does the chat letting go of its session.
 *     An account-wide operation (`owner.type: account`) is not a chat's and moves
 *     nothing here.
 *  4. **Links** are the gateway's word and untrusted: only `authorisationLink`
 *     passes one (plain `https`, a host, no user name or password before it, as the
 *     browser's own URL parser reads it), and the sheet shows its host and opens it
 *     only when the person presses it. A link that does not pass is dropped and the
 *     row says so.
 *  5. **Answers** go out with `connection.respond`: "Not now" on one row
 *     (`status: skipped`) or Cancel for the whole card (`settled_by: continue`, so
 *     the agent stops waiting for the deadline), in exactly the shape the gateway's
 *     strict contract takes (`ConnectionRespondParams` below). The card moves when
 *     the gateway's `connection.update` comes back; an answer that did not go out
 *     says why on the sheet.
 *  6. **Texts** are the gateway's and cleaned like every other bot-supplied text
 *     (`displayText`).
 */
import type { RpcMethods } from '@hermes/shared/gateway-contract'
import type { StoreApi } from 'zustand/vanilla'

import type { ChatsState } from '../state/chats'
import {
  type AuthorisationLink,
  type ConnectionAnswerState,
  type ConnectionCard,
  type ConnectionEnd,
  type ConnectionsState,
  connectionsStore,
  type ConnectionTarget
} from '../state/connections'
import type { SessionSignal } from './chat-controller'
import type { ChatGateway } from './link'
import { displayText, NAME_LIMIT, type SecureInputTimers, TEXT_LIMIT } from './requests/secure-input'
import { botOfConversationKey } from './sessions/session-model'

/**
 * `connection.respond`'s params, as the gateway's contract defines them
 * (`tui_gateway/contracts/connectors_operation.py`: `ConnectionRespondParams` on
 * `ConnectionOperationParams` on `ProfileParams`). Every params model there is
 * `extra="forbid"`, so a key that is not listed here makes the gateway refuse the
 * whole answer with `4000`.
 *
 * Written here rather than read from `@hermes/shared/gateway-contract`, whose
 * generated `ConnectionRespondParams` names the session as a top-level
 * `session_id` and has no `owner`, which the gateway would refuse. That package is
 * vendored and not edited from here; `respondThrough` is the one place the two meet.
 */
export interface ConnectionRespondParams {
  /** The profile the chat runs on. */
  profile: string
  /** `SessionOwner`: the runtime session the operation belongs to. (`AccountOwner` is the settings screen's.) */
  owner: { type: 'session'; session_id: string }
  op_id: string
  result: ConnectionAnswer
}

/** `ConnectionAnswer`: per-row outcomes, and an optional Continue. */
export interface ConnectionAnswer {
  targets?: ConnectionAnswerTarget[]
  settled_by?: 'all_resolved' | 'continue' | 'deadline' | 'interrupt' | null
}

/** `ConnectionAnswerTarget`: one row's outcome as the card saw it. */
export interface ConnectionAnswerTarget {
  name: string
  status: 'approved' | 'skipped'
  detail?: string | null
  /** The credential values an install asked for through `required_env`. */
  env?: Record<string, string> | null
}

/** How an answer goes out. */
export type ConnectionRespond = (params: ConnectionRespondParams) => Promise<unknown>

/**
 * `connection.respond` on the page's connection. The cast is the generated
 * contract's wrong spelling of the params (see `ConnectionRespondParams`), and
 * nothing else: what goes on the wire is exactly `params`.
 */
export function respondThrough(gateway: Pick<ChatGateway, 'request'>): ConnectionRespond {
  return async params =>
    await gateway.request('connection.respond', params as unknown as RpcMethods['connection.respond']['params'])
}

/** The longest link that is looked at at all. */
const LINK_LIMIT = 4_096
/** The longest detail line shown under a row. */
const DETAIL_LIMIT = 300

const pageTimers: SecureInputTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/**
 * Rule 4: a link that may be opened, or `null`. Read by the browser's own parser,
 * so what is checked is what would be opened: the scheme is `https`, there is a
 * host, and there is no user name or password before it
 * (`https://trusted.example@elsewhere.example` reads as one host and goes to the
 * other). `javascript:`, `data:`, `http:` and everything else is refused.
 */
export function authorisationLink(raw: unknown): AuthorisationLink | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()

  if (!trimmed || trimmed.length > LINK_LIMIT) {
    return null
  }

  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' || !url.hostname || url.username !== '' || url.password !== '') {
    return null
  }

  return { url: url.href, host: url.host }
}

/** One wire row as the card holds it, or `null` for a row without a name. */
export function connectionTarget(raw: unknown): ConnectionTarget | null {
  const wire = recordOf(raw)
  const name = str(wire.name).trim()

  if (!name) {
    return null
  }

  const connectUrl = str(wire.connect_url)
  const link = authorisationLink(connectUrl)

  return {
    name,
    label: displayText(name, NAME_LIMIT) || name.slice(0, NAME_LIMIT),
    kind: str(wire.kind) || 'mcp',
    action: str(wire.action) || 'install',
    state: str(wire.state) || 'pending',
    detail: displayText(wire.detail, DETAIL_LIMIT),
    instructions: typeof wire.instructions === 'string' ? displayText(wire.instructions, TEXT_LIMIT) || null : null,
    link,
    linkRefused: link === null && connectUrl.trim() !== '',
    opened: false
  }
}

/** `mergeLiveTarget`: what the frame carries replaces what was held; what it leaves out stays. */
function mergeTarget(held: ConnectionTarget, raw: Record<string, unknown>): ConnectionTarget {
  const next = { ...held }

  if (typeof raw.state === 'string' && raw.state) {
    next.state = raw.state
  }

  if (typeof raw.detail === 'string') {
    next.detail = displayText(raw.detail, DETAIL_LIMIT)
  }

  if (Object.hasOwn(raw, 'instructions')) {
    next.instructions = typeof raw.instructions === 'string' ? displayText(raw.instructions, TEXT_LIMIT) || null : null
  }

  if (typeof raw.connect_url === 'string') {
    next.link = authorisationLink(raw.connect_url)
    next.linkRefused = next.link === null && raw.connect_url.trim() !== ''

    if (next.link?.url !== held.link?.url) {
      next.opened = false
    }
  }

  return next
}

/** States nobody has to act on any more. */
const RESOLVED: ReadonlySet<string> = new Set(['connected', 'skipped', 'failed', 'expired', 'unavailable'])

/** Whether a row still waits on the person. */
export const isTargetOpen = (target: Pick<ConnectionTarget, 'state'>): boolean => !RESOLVED.has(target.state)

export interface ConnectionsModelOptions {
  /** How an answer goes out: `respondThrough(gateway)` on the page. */
  respond: ConnectionRespond
  /** Where the chat controller's signals are heard (`ChatController.onSessionSignal`). */
  watchSignals: (listener: (signal: SessionSignal) => void) => () => void
  /** The chats, so a card whose chat let go of its session goes with it (rule 3). */
  chats?: Pick<StoreApi<ChatsState>, 'getState' | 'subscribe'>
  store?: StoreApi<ConnectionsState>
  /** Epoch milliseconds. */
  now?: () => number
  timers?: SecureInputTimers
}

export class ConnectionsModel {
  readonly store: StoreApi<ConnectionsState>

  private readonly options: ConnectionsModelOptions
  private readonly timers: SecureInputTimers
  private readonly deadlines = new Map<string, unknown>()
  private unsubscribes: (() => void)[] = []
  private started = false
  private stopped = false
  private version = 0
  private order = 0

  constructor(options: ConnectionsModelOptions) {
    this.options = options
    this.store = options.store ?? connectionsStore
    this.timers = options.timers ?? pageTimers
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  start(): void {
    if (this.started || this.stopped) {
      return
    }

    this.started = true
    this.store.getState().reset()
    this.unsubscribes.push(this.options.watchSignals(signal => this.receive(signal)))

    const { chats } = this.options

    if (chats) {
      this.unsubscribes.push(chats.subscribe(() => this.chatsChanged()))
    }
  }

  /** Every card goes, and nothing more is heard. Idempotent. */
  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true

    for (const unsubscribe of this.unsubscribes) {
      unsubscribe()
    }

    this.unsubscribes = []

    for (const handle of this.deadlines.values()) {
      this.timers.clearTimeout(handle)
    }

    this.deadlines.clear()
    this.store.getState().reset()
  }

  // ── actions ───────────────────────────────────────────────────────────────────────────────────

  /** The person opened a row's link from this page. */
  markOpened(chat: string, target: string): void {
    this.patch(chat, card => ({
      targets: card.targets.map(entry => (entry.name === target ? { ...entry, opened: true } : entry))
    }))
  }

  /** "Not now" on one row. Answers whether the answer went out; the card moves when the gateway's update comes. */
  async skip(chat: string, target: string): Promise<boolean> {
    const card = this.store.getState().cards[chat]

    if (!card || !card.targets.some(entry => entry.name === target)) {
      return false
    }

    return await this.answer(card, { targets: [{ name: target, status: 'skipped' }] }, { what: 'skip', target })
  }

  /** Cancel: end the operation now with whatever is unresolved, so the agent stops waiting for the deadline. */
  async cancel(chat: string): Promise<boolean> {
    const card = this.store.getState().cards[chat]

    if (!card) {
      return false
    }

    return await this.answer(card, { settled_by: 'continue' }, { what: 'cancel' })
  }

  private async answer(
    card: ConnectionCard,
    result: ConnectionAnswer,
    sending: { what: 'skip' | 'cancel'; target?: string }
  ): Promise<boolean> {
    const { chat, opId } = card

    this.setAnswer(chat, opId, { kind: 'sending', ...sending })

    try {
      await this.options.respond({
        profile: botOfConversationKey(chat),
        owner: { type: 'session', session_id: card.runtimeSessionId },
        op_id: opId,
        result
      })
      this.setAnswer(chat, opId, { kind: 'idle' })

      return true
    } catch (error) {
      this.setAnswer(chat, opId, { kind: 'failed', message: displayText(messageOf(error), TEXT_LIMIT) })

      return false
    }
  }

  private setAnswer(chat: string, opId: string, answer: ConnectionAnswerState): void {
    this.patch(chat, card => (card.opId === opId ? { answer } : null))
  }

  // ── from the gateway ──────────────────────────────────────────────────────────────────────────

  private receive(signal: SessionSignal): void {
    switch (signal.kind) {
      case 'connection.request':
        this.requested(signal.chat, signal.runtimeSessionId, signal.payload)
        break
      case 'connection.update':
        this.updated(signal.chat, signal.payload)
        break
      case 'resumed':
        if (signal.pendingConnection === null) {
          this.withdraw(signal.chat, 'withdrawn')
        } else {
          this.requested(signal.chat, signal.runtimeSessionId, signal.pendingConnection)
        }

        break
      default:
        break
    }
  }

  private requested(chat: string, runtimeSessionId: string, payload: Record<string, unknown>): void {
    const opId = str(payload.op_id)
    const toolCallId = str(payload.tool_call_id)
    const deadlineAt = positive(payload.deadline_at)
    const targets = (Array.isArray(payload.targets) ? payload.targets : []).flatMap(raw => {
      const target = connectionTarget(raw)

      return target ? [target] : []
    })

    if (!opId || !toolCallId || deadlineAt === undefined || targets.length === 0 || !runtimeSessionId) {
      return
    }

    const seq = typeof payload.seq === 'number' && Number.isFinite(payload.seq) ? payload.seq : 0
    const current = this.store.getState().cards[chat]

    if (current?.opId === opId && current.seq >= seq) {
      if (current.runtimeSessionId !== runtimeSessionId) {
        this.patch(chat, () => ({ runtimeSessionId }))
      }

      return
    }

    const opened = new Set(
      current?.opId === opId ? current.targets.filter(entry => entry.opened).map(entry => entry.name) : []
    )

    this.put({
      chat,
      runtimeSessionId,
      opId,
      toolCallId,
      seq,
      deadline: deadlineAt * 1000,
      targets: targets.map(target => (opened.has(target.name) && target.link ? { ...target, opened: true } : target)),
      answer: current?.opId === opId ? current.answer : { kind: 'idle' },
      version: 0,
      seq0: current?.opId === opId ? current.seq0 : (this.order += 1)
    })
  }

  private updated(chat: string, payload: Record<string, unknown>): void {
    const card = this.store.getState().cards[chat]

    if (!card || recordOf(payload.owner).type === 'account' || str(payload.op_id) !== card.opId) {
      return
    }

    if (payload.settled === true) {
      this.withdraw(chat, payload.settled_by === 'deadline' ? 'deadline' : 'settled')

      return
    }

    const seq = typeof payload.seq === 'number' && Number.isFinite(payload.seq) ? payload.seq : undefined

    if (seq === undefined || seq <= card.seq) {
      return
    }

    const live = new Map(
      (Array.isArray(payload.targets) ? payload.targets : []).flatMap(raw => {
        const wire = recordOf(raw)
        const name = str(wire.name).trim()

        return name ? [[name, wire] as const] : []
      })
    )
    const deadlineAt = positive(payload.deadline_at)

    this.put({
      ...card,
      seq,
      deadline: deadlineAt === undefined ? card.deadline : deadlineAt * 1000,
      targets: card.targets.map(target => {
        const wire = live.get(target.name)

        return wire ? mergeTarget(target, wire) : target
      })
    })
  }

  private chatsChanged(): void {
    const chats = this.options.chats?.getState()

    if (!chats) {
      return
    }

    for (const card of Object.values(this.store.getState().cards)) {
      const chat = chats.chats[card.chat]

      if (!chat || chat.runtimeSessionId === undefined) {
        this.withdraw(card.chat, 'withdrawn')
      }
    }
  }

  // ── the cards ─────────────────────────────────────────────────────────────────────────────────

  private put(card: ConnectionCard): void {
    const { chat, opId } = card

    this.cancelDeadline(chat)

    const left = card.deadline - this.now()

    if (left <= 0) {
      this.withdraw(chat, 'deadline', card)

      return
    }

    const state = this.store.getState()
    const ended = { ...state.ended }

    delete ended[chat]
    this.store.setState({ cards: { ...state.cards, [chat]: { ...card, version: (this.version += 1) } }, ended })
    this.deadlines.set(
      chat,
      this.timers.setTimeout(() => this.deadlinePassed(chat, opId), Math.ceil(left))
    )
  }

  private deadlinePassed(chat: string, opId: string): void {
    this.deadlines.delete(chat)

    const card = this.store.getState().cards[chat]

    if (card?.opId !== opId) {
      return
    }

    if (card.deadline - this.now() <= 0) {
      this.withdraw(chat, 'deadline')
    } else {
      // A timer that ran early (or a deadline moved meanwhile): wait for the rest.
      this.put(card)
    }
  }

  private patch(chat: string, change: (card: ConnectionCard) => Partial<ConnectionCard> | null): void {
    const state = this.store.getState()
    const card = state.cards[chat]

    if (!card) {
      return
    }

    const next = change(card)

    if (next === null) {
      return
    }

    this.store.setState({ cards: { ...state.cards, [chat]: { ...card, ...next, version: (this.version += 1) } } })
  }

  /** The chat's card goes; `card` names one that never reached the store (its deadline had already passed). */
  private withdraw(chat: string, end: ConnectionEnd, card?: ConnectionCard): void {
    this.cancelDeadline(chat)

    const state = this.store.getState()
    const held = state.cards[chat] ?? card

    if (!held) {
      return
    }

    const cards = { ...state.cards }

    delete cards[chat]
    this.store.setState({ cards, ended: { ...state.ended, [chat]: { opId: held.opId, end } } })
  }

  private cancelDeadline(chat: string): void {
    const handle = this.deadlines.get(chat)

    if (handle !== undefined) {
      this.timers.clearTimeout(handle)
      this.deadlines.delete(chat)
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
