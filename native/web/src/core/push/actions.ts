/**
 * What a click on a notification is allowed to do (ADR-0017, plan W13).
 *
 * > Tapping one does not answer anything by itself: the app opens, connects to
 * > the gateway, re-reads the open requests, and responds only if that request
 * > is still open and still says what the notification said it did. A
 * > notification is a hint that something happened, never an instruction.
 *
 * So a payload is trusted for one thing only, *which conversation to look in*,
 * and even that is a lookup the chat screen resolves against the gateway before
 * it shows anything. An Allow or a Deny answers only when the gateway's own
 * `approval.pending`, asked just now for the bot's chat, lists a request with the
 * same id in the same session (when the payload names one), and offers the
 * choice: `once` for Allow (never a wider one, whatever the request allows: a
 * button on a notification is the least considered decision of the day), `deny`
 * for Deny. Nothing else counts as "still says the same thing": a Web Push
 * payload carries no text about the request to compare, and the id, the bot and
 * the session are what both sides can name (the Apple apps' `PushTapRules`,
 * which this follows rule for rule).
 *
 * Everything else falls through to opening the conversation, where the request,
 * if it is still open, is on screen to be answered: a request answered on
 * another device, an approval without an id, a clarify, a secure input, a
 * confirmation, a clearing push, a notification about a branch or another
 * conversation (its request lives in a session the bot's chat did not resume).
 *
 * A click reaches the page two ways: posted by the worker to an open window
 * (`responseOfMessage`), or, on a cold start, in the address the worker opened
 * (`takeLaunchResponse`, read once and removed before anything else can act on
 * it again).
 *
 * Pure, except `takeLaunchResponse`, which is given the location and history to
 * read and rewrite.
 */
import type { PushSessionKind } from '../../features/sessions/push-destination'

/** The contract's action ids; `src/sw/notification.ts` posts the same (`sw-constants.test.ts`). */
export const PUSH_ACTION_ALLOW = 'hermie.request.allow'
export const PUSH_ACTION_DENY = 'hermie.request.deny'

/** The ids the Expo app's worker used, read for a notification posted by an older worker. */
export const LEGACY_PUSH_ACTION_ALLOW = 'allow'
export const LEGACY_PUSH_ACTION_DENY = 'deny'

/** The `source` of a message from the worker. */
export const PUSH_MESSAGE_SOURCE = 'hermie-push'

/** The query a cold start from a click carries. */
export const PUSH_LAUNCH_PARAM = 'hermiePush'

/** The request method a notification button may answer. */
const ACTIONS_METHOD = 'approval'

/** The longest name of a bot a click is followed to; the router's own limit. */
const MAX_NAME = 256

/** One click: the button (or `default`) and the notification's data. */
export interface PushResponse {
  actionIdentifier: string
  data: Record<string, unknown>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** A response as the worker spells it, or `null`. */
export function responseOf(value: unknown): PushResponse | null {
  if (!isObject(value)) {
    return null
  }

  return {
    actionIdentifier:
      typeof value.actionIdentifier === 'string' && value.actionIdentifier ? value.actionIdentifier : 'default',
    data: isObject(value.data) ? value.data : {}
  }
}

/** The response in a message the worker posted, or `null` for any other message. */
export function responseOfMessage(message: unknown): PushResponse | null {
  return isObject(message) && message.source === PUSH_MESSAGE_SOURCE ? responseOf(message.response) : null
}

/**
 * The click a cold start carries, once: the query is removed from the address
 * before it is read, so a reload (or a second read) never acts on it again.
 */
export function takeLaunchResponse(
  location: Pick<Location, 'href'>,
  history: Pick<History, 'state' | 'replaceState'>
): PushResponse | null {
  let url: URL

  try {
    url = new URL(location.href)
  } catch {
    return null
  }

  if (!url.searchParams.has(PUSH_LAUNCH_PARAM)) {
    return null
  }

  const raw = url.searchParams.get(PUSH_LAUNCH_PARAM) ?? ''

  url.searchParams.delete(PUSH_LAUNCH_PARAM)
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)

  try {
    return responseOf(JSON.parse(raw))
  } catch {
    return null
  }
}

/** What a click asked for, before the gateway has been asked anything. */
export interface PushTap {
  bot: string
  action: 'allow' | 'deny' | 'open'
  /** Empty unless the payload named one; an action without one cannot answer. */
  requestId: string
  /** For a request the RUNTIME session id (what `approval.pending` names); for any other type the stored id. */
  sessionId: string
  /** A request's conversation under its STORED id; empty when unknown. */
  sessionKey: string
  sessionKind: PushSessionKind
  type: string
  method: string
  /** A clearing push: never answered, never opened. */
  isClear: boolean
}

/** A name a click may be followed to: not empty, not over-long, no control character, no slash. */
function botNameOf(value: unknown): string {
  const name = text(value)

  // eslint-disable-next-line no-control-regex
  return name.length > 0 && name.length <= MAX_NAME && !/[\u0000-\u001f\u007f/]/u.test(name) ? name : ''
}

const SESSION_KINDS: readonly string[] = ['canonical', 'branch', 'other']

/** A click as a tap, or `null` when it names no usable bot. */
export function pushTapOf(response: PushResponse): PushTap | null {
  const data = response.data
  const bot = botNameOf(data.bot)

  if (!bot) {
    return null
  }

  const id = response.actionIdentifier
  const asked =
    id === PUSH_ACTION_ALLOW || id === LEGACY_PUSH_ACTION_ALLOW
      ? 'allow'
      : id === PUSH_ACTION_DENY || id === LEGACY_PUSH_ACTION_DENY
        ? 'deny'
        : 'open'
  const requestId = text(data.requestId) || text(data.request)
  const method = text(data.method)
  const isClear = data.clear === true
  // An approval, or a request that names no method (a sender older than the contract).
  const answerable = (method === '' || method === ACTIONS_METHOD) && !isClear
  const kind = text(data.sessionKind)

  return {
    bot,
    // A button with nothing it could answer is a plain open, never a guess at the oldest question.
    action: asked !== 'open' && requestId && answerable ? asked : 'open',
    requestId,
    sessionId: text(data.sessionId) || text(data.session),
    sessionKey: text(data.sessionKey),
    sessionKind: SESSION_KINDS.includes(kind) ? (kind as PushSessionKind) : '',
    type: text(data.type),
    method,
    isClear
  }
}

/** The conversation a tap is about, as the session list knows it: a request's `sessionKey`, else `sessionId`. */
export const conversationIdOf = (tap: PushTap): string => (tap.type === 'request' ? tap.sessionKey : tap.sessionId)

/** One row of `approval.pending`, as far as an action reads it. */
export interface OpenApproval {
  request_id?: string | null
  choices?: readonly string[] | null
  [key: string]: unknown
}

/** What `approval.pending` said for the bot's chat, and which session that is. */
export interface PendingAnswer {
  /** The runtime session the chat is attached to; empty when it is not. */
  sessionId: string
  approvals: readonly OpenApproval[]
}

export type PushIntent = { kind: 'open' } | { kind: 'respond'; requestId: string; choice: string }

/** Whether an action on this tap may be answered where it lands: never for a branch or another conversation. */
export const answersInPlace = (tap: PushTap): boolean => tap.sessionKind !== 'branch' && tap.sessionKind !== 'other'

/**
 * The tap, decided against what the gateway lists as open right now. Every path
 * that is not an exact match on a still-open request is `open`: the conversation
 * is already on screen, and what is there is the request as it actually stands.
 */
export function resolvePushTap(tap: PushTap, pending: PendingAnswer): PushIntent {
  const open: PushIntent = { kind: 'open' }

  if (tap.action === 'open' || !tap.requestId || !answersInPlace(tap) || !pending.sessionId) {
    return open
  }

  // A payload that names the runtime session must name the one the chat is attached to.
  if (tap.sessionId && tap.sessionId !== pending.sessionId) {
    return open
  }

  const match = pending.approvals.find(approval => text(approval.request_id) === tap.requestId)

  if (!match) {
    return open
  }

  const wanted = tap.action === 'allow' ? 'once' : 'deny'
  const choices = Array.isArray(match.choices) ? match.choices : []

  return choices.includes(wanted) ? { kind: 'respond', requestId: tap.requestId, choice: wanted } : open
}
