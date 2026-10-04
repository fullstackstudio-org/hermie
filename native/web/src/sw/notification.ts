/**
 * What the service worker shows for a push, what it closes, and what it hands the
 * page when one is clicked, as pure functions over plain values.
 *
 * The plugin sends a Web Push as `{title, body, data}`, or `{data}` alone for a
 * clearing push (`contract/push/contract.json`, `clear`). `title` and `body` are the
 * plugin's own visible strings: the bot's name and the kind of event, or a preview
 * of the message when the device asked for one and the gateway allows it. They are
 * shown exactly as they came (trimmed to a length a notification can hold), and the
 * worker adds no text of its own beyond the two button titles: nothing in `data` is
 * ever put on screen. `data` is kept whole on the notification, unread except for
 * what the rendering needs, because that is what tells the page where a tap lands
 * (`core/push/actions.ts`).
 *
 * The payload arrived from a push service, so every field is read defensively:
 * anything that is not the shape the contract names is read as absent.
 *
 * This module is the worker's (`sw.ts`) and nothing outside `src/sw` imports it:
 * the worker is a classic script that must import nothing at run time, and a module
 * shared with the page would be split into a chunk of its own
 * (`vite.config.ts`, `sw-graph.test.ts`). The few constants the page needs too are
 * repeated in `core/push/actions.ts`; `sw-graph.test.ts` holds them equal.
 */

/** The contract's action ids (`category.actions`). */
export const PUSH_ACTION_ALLOW = 'hermie.request.allow'
export const PUSH_ACTION_DENY = 'hermie.request.deny'

/** The `source` of the message the worker posts to an open page. */
export const PUSH_MESSAGE_SOURCE = 'hermie-push'

/** The query a cold start from a click carries: read once by the page, then removed. */
export const PUSH_LAUNCH_PARAM = 'hermiePush'

/** The title of a push that carries none, or none that can be shown. */
export const DEFAULT_TITLE = 'Hermie'

/** The most of a title and a body a notification is given; longer is cut, never dropped. */
export const MAX_TITLE_LENGTH = 200
export const MAX_BODY_LENGTH = 1000

/** The only request method a notification offers buttons for (`category.when`). */
const ACTIONS_METHOD = 'approval'

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The payload as an object, or `{}`: JSON that is not an object, or not JSON at all. */
export function payloadOf(raw: unknown): JsonObject {
  return isObject(raw) ? raw : {}
}

/** The payload's `data`, or `{}`. */
export function dataOf(payload: JsonObject): JsonObject {
  return isObject(payload.data) ? payload.data : {}
}

/** One button on a notification. */
export interface NotificationButton {
  action: string
  title: string
}

/** What `registration.showNotification` is given: the options this worker sets, and nothing else. */
export interface ShownNotification {
  title: string
  options: {
    body: string
    data: JsonObject
    tag: string
    requireInteraction: boolean
    actions: NotificationButton[]
    timestamp?: number
  }
}

/** Which notifications a clearing push closes. */
export interface ClearTarget {
  bot: string
  /** The request it closes, when the sender knew it. */
  requestId: string
  /** The `eventId` of the notification it withdraws (`data.replaces`). */
  replaces: string
}

export type PushDisplay = { kind: 'show'; notification: ShownNotification } | { kind: 'clear'; target: ClearTarget }

/** The two button titles, in the languages the client speaks; English for any other. */
const BUTTON_TITLES: Readonly<Record<'en' | 'nl' | 'de', { allow: string; deny: string }>> = {
  en: { allow: 'Allow', deny: 'Deny' },
  nl: { allow: 'Toestaan', deny: 'Weigeren' },
  de: { allow: 'Erlauben', deny: 'Ablehnen' }
}

/** The first of the browser's languages the client speaks, by its primary subtag. */
export function buttonTitlesFor(languages: readonly string[]): { allow: string; deny: string } {
  for (const language of languages) {
    const primary = language.toLowerCase().split('-')[0]

    if (primary === 'en' || primary === 'nl' || primary === 'de') {
      return BUTTON_TITLES[primary]
    }
  }

  return BUTTON_TITLES.en
}

/**
 * The conversation a payload is about, as the session list knows it: a request's
 * `sessionKey` (its `sessionId` is the runtime id, which names no conversation),
 * else `sessionId`, else Hermie Web's older `session`.
 */
export function conversationOf(data: JsonObject): string {
  if (text(data.type) === 'request' && text(data.sessionKey)) {
    return text(data.sessionKey)
  }

  return text(data.sessionId) || text(data.session)
}

/**
 * How one notification replaces another: one per conversation of a bot, so a
 * branch reporting in does not swallow the chat's own notification, and the
 * next notification about the same conversation replaces the one before it.
 */
export function tagOf(data: JsonObject): string {
  const bot = text(data.bot)

  if (!bot) {
    return 'hermie'
  }

  const conversation = conversationOf(data)

  return conversation ? `hermie:${bot}:${conversation}` : `hermie:${bot}`
}

/**
 * Whether a notification may carry Allow and Deny: an approval that names its
 * request and is not a clearing push. Every other request method is posted with
 * no buttons (`category.notFor`), and so is an approval without an id (it has
 * nothing to address an answer to). A request with no `method` gets none either:
 * only a sender older than the contract omits it, and this worker cannot tell an
 * approval from a secure input there.
 */
export function offersActions(data: JsonObject): boolean {
  return (
    text(data.type) === 'request' &&
    text(data.method) === ACTIONS_METHOD &&
    text(data.requestId) !== '' &&
    data.clear !== true
  )
}

const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

/** What a push shows, or which notifications it closes. */
export function displayOf(raw: unknown, languages: readonly string[] = []): PushDisplay {
  const payload = payloadOf(raw)
  const data = dataOf(payload)

  if (data.clear === true) {
    return {
      kind: 'clear',
      target: { bot: text(data.bot), requestId: text(data.requestId), replaces: text(data.replaces) }
    }
  }

  const title = cut(text(payload.title), MAX_TITLE_LENGTH) || DEFAULT_TITLE
  const body = typeof payload.body === 'string' ? cut(payload.body, MAX_BODY_LENGTH) : ''
  const needsInput = text(data.type) === 'request'
  const buttons = buttonTitlesFor(languages)
  const at = data.at

  return {
    kind: 'show',
    notification: {
      title,
      options: {
        body,
        data,
        tag: tagOf(data),
        // A question waiting on an answer stays on screen until it is dealt with.
        requireInteraction: needsInput,
        actions: offersActions(data)
          ? [
              { action: PUSH_ACTION_ALLOW, title: buttons.allow },
              { action: PUSH_ACTION_DENY, title: buttons.deny }
            ]
          : [],
        ...(typeof at === 'number' && Number.isFinite(at) && at > 0 ? { timestamp: Math.floor(at) * 1000 } : {})
      }
    }
  }
}

/**
 * Whether a clearing push closes the notification with this `data`: the one it
 * names by `eventId`, or the one for the same request of the same bot. A clear
 * that names neither closes nothing, and so does one for another bot.
 */
export function closes(target: ClearTarget, data: unknown): boolean {
  if (!target.bot || !isObject(data) || text(data.bot) !== target.bot) {
    return false
  }

  if (target.replaces && text(data.eventId) === target.replaces) {
    return true
  }

  return target.requestId !== '' && text(data.requestId) === target.requestId
}

/** What a click hands the page: the button (or `default`) and the notification's data, whole. */
export interface PushResponseMessage {
  actionIdentifier: string
  data: JsonObject
}

export function responseOf(action: unknown, data: unknown): PushResponseMessage {
  return {
    actionIdentifier: typeof action === 'string' && action ? action : 'default',
    data: isObject(data) ? data : {}
  }
}

/**
 * Whether a window is the client: its document is the scope's directory or its
 * `index.html`. `clients.matchAll` with `includeUncontrolled` answers every window
 * of the origin, and the origin is the gateway's: the dashboard and other
 * plugins' pages are on it too, and a file of the client's directory opened on
 * its own (`licenses.json`) is not a page that listens.
 */
export function inScope(url: string, scope: string): boolean {
  if (typeof url !== 'string' || typeof scope !== 'string' || !scope) {
    return false
  }

  const path = url.split(/[?#]/u)[0] ?? ''

  return path === scope || path === `${scope}index.html`
}

/** The page a click opens when no window of the client is open: the client, carrying the click. */
export function launchUrlOf(scope: string, response: PushResponseMessage): string {
  const url = new URL('index.html', scope)

  url.searchParams.set(PUSH_LAUNCH_PARAM, JSON.stringify(response))

  return url.href
}
