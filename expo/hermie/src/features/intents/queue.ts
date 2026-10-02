/**
 * What a Shortcut asks for, and what it gets back — as two small files.
 *
 * An App Intent runs in Swift. The gateway lives in JavaScript, inside the app,
 * behind a socket that only exists while the app is running and signed in. So
 * an intent cannot do the thing it promises; it can only write down what was
 * asked, cause the app to be in front, and wait for an answer to appear.
 *
 * This module is that pair of files, read and written from the TypeScript side.
 * It is the same shape as `features/share/outbox.ts` and for the same reasons —
 * a versioned format in a container two sandboxes share, one pure function per
 * direction, every refusal a row in a table.
 *
 * ## Why a queue at all, when the intent runs in the app's own process
 *
 * `openAppWhenRun` makes `perform()` execute inside the app, so the two halves
 * really are in one process. They are still in two LANGUAGES with no call
 * between them: an Expo module can be called FROM JavaScript, and nothing calls
 * into JavaScript from an arbitrary Swift stack frame. A file both sides can
 * see is the shortest path that does not involve inventing a bridge.
 *
 * ## The budget is the whole design constraint
 *
 * Shortcuts will not wait forever, and neither will a person holding a phone.
 * `INTENT_BUDGET_MS` is what the Swift side polls for and what this side uses
 * to age a request out, and it is deliberately ONE number in ONE place: a
 * requester that gives up before the answerer does leaves a result file nobody
 * will ever read, and the reverse leaves Shortcuts showing a spinner over an
 * app that has already finished.
 */

/** Bumped when a field changes meaning or goes. Adding an OPTIONAL one is free. */
export const INTENT_QUEUE_VERSION = 1

/** The directory inside the shared container. Also spelled in Swift. */
export const INTENT_QUEUE_DIRECTORY = 'intents'

/**
 * How long a Shortcut waits for its answer, and how long a request stays fresh.
 *
 * Forty-five seconds is a compromise with one side measured and the other not.
 * The measured side is Shortcuts: an action that returns nothing for a minute
 * or so is reported to the person as a problem, whatever it is doing. The
 * unmeasured side is a model — plenty of real prompts take longer than this,
 * and one that does returns the timeout rather than the reply.
 *
 * That is stated in the failure text rather than hidden, because the useful
 * response to it is to use "Send to" instead of "Ask", which does not wait at
 * all. Raising the number would trade a clear message for a spinner.
 */
export const INTENT_BUDGET_MS = 45_000

/**
 * What a Shortcut can ask for.
 *
 * Only the two that need the app to DO something are here. "Open chat with" is
 * a deep link and needs no queue — the intent opens `hermie://chat/<bot>` and
 * is finished. "Bots needing input" reads the widget snapshot in Swift and
 * never launches the app at all, which is what makes it usable from a watch
 * face or a lock-screen button.
 */
export type IntentKind = 'ask' | 'send'

export interface PendingIntent {
  version: number
  id: string
  kind: IntentKind
  /** The handle, as the entity's id carries it — never the display label. */
  bot: string
  text: string
  /** Unix MILLISECONDS, so it can be compared against the budget directly. */
  createdAt: number
}

/** What the intent reads back. Exactly one of `reply` and `error` is present. */
export interface IntentResult {
  version: number
  id: string
  ok: boolean
  /** The bot's answer, for `ask`. Absent for `send`, which returns nothing. */
  reply?: string
  /** One sentence, shown to the person by Shortcuts. */
  error?: string
}

/** One queued request as the bridge hands it over. */
export interface IntentQueueEntry {
  id: string
  /** The request file's bytes, exactly as the intent wrote them. */
  payload: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * The id is a file name and a URL path component, so it is the same alphabet
 * the share outbox uses and for the same reason: minted by this app, out of a
 * fixed set, which lets everything else refuse anything odd outright.
 */
export function isSafeIntentId(id: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(id)
}

/**
 * Read one request, or answer `null`.
 *
 * Nothing here is repaired. Unlike a share — where a note written badly is not
 * a reason to lose somebody's photograph — every field of a request is load
 * bearing: a missing bot has nowhere to go, a missing text is a prompt with
 * nothing in it, and a kind this build does not know is a Shortcut from a newer
 * app. There is a person watching a spinner in every one of those cases, so the
 * right answer is to refuse quickly and let the caller say why.
 */
export function parsePendingIntent(payload: string): PendingIntent | null {
  let raw: unknown

  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }

  if (!isObject(raw) || num(raw.version) !== INTENT_QUEUE_VERSION) {
    return null
  }

  const id = str(raw.id)
  const kind = str(raw.kind)
  const bot = str(raw.bot)
  const text = str(raw.text)

  if (!isSafeIntentId(id) || (kind !== 'ask' && kind !== 'send') || !bot || !text.trim()) {
    return null
  }

  return { version: INTENT_QUEUE_VERSION, id, kind, bot, text, createdAt: num(raw.createdAt) }
}

/** The answer, as the bytes the intent will read. */
export function intentReply(id: string, reply: string): string {
  return JSON.stringify({ version: INTENT_QUEUE_VERSION, id, ok: true, reply } satisfies IntentResult)
}

/** The other answer. One sentence, because Shortcuts shows it as one. */
export function intentFailure(id: string, error: string): string {
  return JSON.stringify({ version: INTENT_QUEUE_VERSION, id, ok: false, error } satisfies IntentResult)
}

/**
 * Whether this request is past the point at which anyone is still listening.
 *
 * A request outlives its Shortcut in one ordinary case: the app was opened,
 * took too long, and the person moved on. Nothing should then send that prompt
 * — a message arriving in a chat ten minutes after somebody gave up on asking
 * for it is worse than no message — so it is failed rather than run.
 */
export function isExpired(intent: PendingIntent, now: number): boolean {
  return now - intent.createdAt > INTENT_BUDGET_MS
}

/** Oldest first, so a queue of requests runs in the order somebody made them. */
export function sortIntents(intents: readonly PendingIntent[]): PendingIntent[] {
  return [...intents].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}
