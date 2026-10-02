/**
 * Sending through the project's push relay, for the native Apple apps.
 *
 * Only an app's publisher can talk to Apple's push service, so a native build
 * registers with a relay the project operates and writes a `transport: "relay"`
 * row into `ui_meta`: the relay's origin, a public `handle` for the device and
 * a `secret` that authorises sending to that one device. This module turns a
 * notification into the relay's abstract message and posts it to
 * `POST {relay}/v1/send`; the relay builds the APNs payload itself.
 *
 * Four rules carry the security of it, and each is enforced here rather than
 * trusted to the caller:
 *
 *  - **The allow-list, not the row, says where a request goes.** A row is
 *    written by anybody who can write `ui_meta`, so the relay it names is a
 *    claim. A row naming an origin that is not on this sender's own list is
 *    skipped (and not retired: it may be valid for some other sender).
 *  - **https only, redirects not followed, every request times out.** A relay
 *    that answers with a redirect is treated as a failed request; following it
 *    would undo the allow-list.
 *  - **No message text crosses the relay.** The body is always the event-type
 *    phrase (`PushMessage.summary`), whatever the device asked for, until the
 *    sender can encrypt for the row's `enc` key — and the registration reader
 *    already reads every relay row as `preview: false`. Two locks, one rule.
 *  - **Never log a secret or a whole handle.** A log line names a handle by its
 *    first few characters and nothing else.
 *
 * And one rule about time: **a send never waits long.** It runs inside the
 * watcher's notification path, so a relay that is shedding load must cost the
 * notification, not the daemon. One retry, after at most
 * `RELAY_MAX_RETRY_WAIT_SECONDS`; a relay that answered a whole request with a
 * failure is not asked again until its back-off has passed, and neither is a
 * device the relay rate-limited.
 *
 * Each message in a batch carries its own handle and secret and the relay
 * authorises each on its own, so one device's stale secret costs that device
 * and nothing else in the batch. A request the relay refused WHOLE (400 or
 * 413) is sent again one entry at a time, so one bad row costs only itself.
 */
import { createHash } from 'node:crypto'

import type { PushMessage } from './expo'
import { type PushRegistration, relayOriginOf } from './registrations'

/** The relay the project operates, and the whole default allow-list. */
export const RELAY_DEFAULT_ORIGIN = 'https://push.hermie.dev'

export const RELAY_SEND_PATH = '/v1/send'

/** The relay's own cap on one request: 1 to 20 messages. */
export const RELAY_BATCH_SIZE = 20

/**
 * The most this sender puts in one request body, encoded.
 *
 * Under the relay's 8 KB cap on purpose: the cap is the relay's to change and
 * a sender that filled it exactly would start failing the day it moved down.
 */
export const RELAY_REQUEST_LIMIT_BYTES = 7_680

/** The relay refuses one message (its `message` object, as JSON) larger than this. */
export const RELAY_MESSAGE_LIMIT_BYTES = 3_584

/** How long one request may take before it counts as a network failure. */
export const RELAY_TIMEOUT_MS = 10_000

/**
 * The longest `retryAfter` this sender will wait out before its one retry.
 *
 * A relay that asks for longer is shedding load, and the honest answer to that
 * is to drop this notification rather than to retry early or to hold the
 * watcher for minutes.
 */
export const RELAY_MAX_RETRY_WAIT_SECONDS = 10

/** The pause before the one retry when the relay named none, or did not answer. */
export const RELAY_DEFAULT_RETRY_SECONDS = 1

/** How long a relay that failed a whole request (twice) is left alone when it named no time. */
export const RELAY_ORIGIN_BACKOFF_SECONDS = 30

/** How long a rate-limited device is left alone when the relay named no time. */
export const RELAY_HANDLE_BACKOFF_SECONDS = 60

/** APNs caps `apns-collapse-id` at 64 bytes. */
export const RELAY_COLLAPSE_ID_LIMIT = 64

/** How long the relay may hold a notification for an unreachable device. */
export const RELAY_TTL_SECONDS = 3600

export type RelayStatus = 'sent' | 'gone' | 'rejected' | 'retry' | 'limited'

/**
 * "Not before" times, epoch milliseconds, kept across sends by whoever owns
 * the sender. In memory only: a restart forgetting a back-off costs at most one
 * request the relay refuses again.
 */
export interface RelayBackoff {
  /** origin → not before. Set after a whole request failed. */
  origins: Map<string, number>
  /** `origin handle` → not before. Set after the relay said `limited`. */
  handles: Map<string, number>
}

export function createRelayBackoff(): RelayBackoff {
  return { origins: new Map(), handles: new Map() }
}

export interface RelayOptions {
  /**
   * The relay origins this sender may post to. Normalised here; an entry that
   * is not an https origin is ignored. Empty means no relay row is ever sent.
   */
  allowList: readonly string[]
  /** Shared across sends; absent means every send starts with a clean slate. */
  backoff?: RelayBackoff
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Epoch milliseconds. */
  now?: () => number
  log?: (line: string) => void
  timeoutMs?: number
}

export interface RelayOutcome {
  installationId: string
  /** The final answer for this device, after the one retry. `skipped` never left the process. */
  status: RelayStatus | 'skipped'
  reason?: string
}

export interface RelaySendResult {
  /** Installation ids whose relay registration is finished: the relay said `gone`. */
  dead: string[]
  outcomes: RelayOutcome[]
}

/** One `messages[]` entry, and every installation whose row it stands for. */
interface Attempt {
  installationIds: string[]
  handle: string
  /** Built once and sent unchanged on the retry. */
  entry: Record<string, unknown>
  bytes: number
}

interface Answer {
  status: RelayStatus
  reason?: string
  retryAfter?: number
  /** The relay (or the network) failed the whole request, not this entry. */
  whole?: boolean
}

/** The first characters of a handle: enough to tell two apart in a log, not enough to send with. */
export function handleHint(handle: string): string {
  return handle.length > 8 ? `${handle.slice(0, 8)}…` : '…'
}

/** The normalised allow-list, duplicates and non-origins dropped. */
export function relayAllowList(entries: readonly string[]): string[] {
  return [...new Set(entries.map(relayOriginOf).filter(Boolean))]
}

/** `priority` per type: what somebody is waiting on goes now, a routine report may be batched by APNs. */
function priorityOf(type: unknown): 'high' | 'normal' {
  return type === 'cron' || type === 'cron_done' || type === 'turn_done' ? 'normal' : 'high'
}

/** At most 64 bytes, and the same string for the same event every time. */
function collapseIdOf(eventId: string | undefined): string {
  if (!eventId) {
    return ''
  }

  return Buffer.byteLength(eventId, 'utf8') <= RELAY_COLLAPSE_ID_LIMIT
    ? eventId
    : createHash('sha256').update(eventId, 'utf8').digest('hex')
}

/**
 * The relay's abstract message for one notification.
 *
 * Exported so the payload can be checked against `contract/push/contract.json`
 * without a network. The body is the summary and never the preview: see the
 * note at the top of this file. Optional members are left out rather than sent
 * empty, which is also what the relay requires of them.
 */
export function relayMessageFor(message: PushMessage): Record<string, unknown> {
  const bot = typeof message.data.bot === 'string' ? message.data.bot : ''
  const gatewayKey = typeof message.data.gatewayKey === 'string' ? message.data.gatewayKey : ''
  const collapseId = collapseIdOf(message.eventId)
  const thread = gatewayKey ? `${gatewayKey}:${bot}` : bot

  return {
    title: message.title,
    body: message.summary ?? message.body,
    ...(message.categoryId ? { category: message.categoryId } : {}),
    // One thread per chat per gateway, so two gateways' `researcher` do not
    // stack into one group on a lock screen.
    ...(thread ? { thread: thread.slice(0, 256) } : {}),
    ...(collapseId ? { collapseId } : {}),
    priority: priorityOf(message.data.type),
    ttl: RELAY_TTL_SECONDS,
    data: { ...message.data }
  }
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** `{"v":1,"messages":[]}`, which every request body starts from. */
const ENVELOPE_BYTES = bytesOf({ v: 1, messages: [] })

/**
 * Batches of at most 20 entries whose request body stays under
 * `RELAY_REQUEST_LIMIT_BYTES`, with no handle twice in one batch.
 *
 * The relay answers by handle as well as by position, so one handle twice in
 * one request — the same device under two rows with different secrets, one of
 * them stale — would make two answers indistinguishable. First fit, so the
 * order of the input is kept as far as the rules allow.
 */
function batchesOf(attempts: readonly Attempt[]): Attempt[][] {
  const batches: { items: Attempt[]; bytes: number; handles: Set<string> }[] = []

  for (const attempt of attempts) {
    const fits = batches.find(
      batch =>
        batch.items.length < RELAY_BATCH_SIZE &&
        !batch.handles.has(attempt.handle) &&
        batch.bytes + 1 + attempt.bytes <= RELAY_REQUEST_LIMIT_BYTES
    )

    if (fits) {
      fits.items.push(attempt)
      fits.bytes += 1 + attempt.bytes
      fits.handles.add(attempt.handle)
    } else {
      batches.push({ items: [attempt], bytes: ENVELOPE_BYTES + attempt.bytes, handles: new Set([attempt.handle]) })
    }
  }

  return batches.map(batch => batch.items)
}

/** `Retry-After` in seconds, or `undefined` for a missing or unreadable header. */
function retryAfterHeader(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  const seconds = raw === null ? Number.NaN : Number(raw)

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

const STATUSES: readonly string[] = ['sent', 'gone', 'rejected', 'retry', 'limited']

/** What one request came back as: an answer per entry, or a reason to try the entries one by one. */
type Posted = { answers: Answer[] } | { split: string }

async function post(origin: string, batch: readonly Attempt[], options: RelayOptions): Promise<Posted> {
  const send = options.fetchImpl ?? fetch
  const all = (answer: Answer): Posted => ({ answers: batch.map(() => ({ ...answer })) })
  let response: Response

  try {
    response = await send(`${origin}${RELAY_SEND_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ v: 1, messages: batch.map(attempt => attempt.entry) }),
      // Never followed: a redirect would take the request, secrets and all, to
      // an origin the allow-list was never asked about.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? RELAY_TIMEOUT_MS)
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''

    return all({ status: 'retry', whole: true, reason: name === 'TimeoutError' ? 'timeout' : 'network' })
  }

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return all({ status: 'rejected', reason: 'redirect' })
  }

  if (response.status === 429) {
    const retryAfter = retryAfterHeader(response)

    return all({
      status: 'limited',
      whole: true,
      reason: 'http_429',
      ...(retryAfter === undefined ? {} : { retryAfter })
    })
  }

  if (response.status >= 500) {
    const retryAfter = retryAfterHeader(response)

    return all({
      status: 'retry',
      whole: true,
      reason: `http_${String(response.status)}`,
      ...(retryAfter === undefined ? {} : { retryAfter })
    })
  }

  // The envelope was refused: one entry in it may be the whole reason.
  if (response.status === 400 || response.status === 413) {
    return { split: `http_${String(response.status)}` }
  }

  if (response.status !== 200) {
    return all({ status: 'rejected', reason: `http_${String(response.status)}` })
  }

  let results: unknown[]

  try {
    const parsed = (await response.json()) as { results?: unknown }

    results = Array.isArray(parsed?.results) ? parsed.results : []
  } catch {
    return all({ status: 'retry', whole: true, reason: 'unreadable_response' })
  }

  return {
    answers: batch.map((attempt, index) => {
      // By position, checked against the handle; a relay that reordered its
      // answers is matched by handle instead rather than misattributed. A
      // batch never holds one handle twice, so the handle is unambiguous.
      const positional = results[index] as Record<string, unknown> | undefined
      const row =
        positional && positional.handle === attempt.handle
          ? positional
          : (results.find(item => (item as Record<string, unknown> | null)?.handle === attempt.handle) as
              Record<string, unknown> | undefined)
      const status = typeof row?.status === 'string' && STATUSES.includes(row.status) ? (row.status as RelayStatus) : ''

      if (!status) {
        return { status: 'retry', reason: 'no_result' }
      }

      const retryAfter =
        typeof row?.retryAfter === 'number' && Number.isFinite(row.retryAfter) && row.retryAfter >= 0
          ? row.retryAfter
          : undefined
      const reason = typeof row?.reason === 'string' ? row.reason.slice(0, 64) : undefined

      return {
        status,
        ...(reason ? { reason } : {}),
        ...(retryAfter === undefined ? {} : { retryAfter })
      }
    })
  }
}

/**
 * Send every attempt for one origin, in batches, and answer for each.
 *
 * A batch the relay refused whole (400, 413) is sent again one entry at a time,
 * once; what those answer is final. Once a request has failed whole — no
 * answer, 429, 5xx — the rest of this round's batches are not sent at all: they
 * get the same answer, because asking a relay that is down or shedding load
 * again within the same second is the one thing guaranteed not to help.
 */
async function postAll(origin: string, attempts: readonly Attempt[], options: RelayOptions): Promise<Answer[]> {
  const answers = new Map<Attempt, Answer>()
  let failed: Answer | null = null

  for (const batch of batchesOf(attempts)) {
    if (failed) {
      for (const attempt of batch) {
        answers.set(attempt, { ...failed })
      }

      continue
    }

    const posted = await post(origin, batch, options)

    if ('answers' in posted) {
      batch.forEach((attempt, index) => answers.set(attempt, posted.answers[index] as Answer))
      failed = posted.answers.find(answer => answer.whole) ?? null

      continue
    }

    if (batch.length === 1) {
      answers.set(batch[0] as Attempt, { status: 'rejected', reason: posted.split })

      continue
    }

    for (const attempt of batch) {
      const alone = await post(origin, [attempt], options)
      const answer: Answer =
        'answers' in alone ? (alone.answers[0] as Answer) : { status: 'rejected', reason: alone.split }

      answers.set(attempt, answer)
    }
  }

  return attempts.map(attempt => answers.get(attempt) as Answer)
}

/**
 * One notification to a set of relay registrations.
 *
 * `sent` is done. `gone` retires the registration exactly as Expo's
 * `DeviceNotRegistered` does. `rejected` is logged and dropped: the relay
 * refused this message and sending it again would be refused again. `retry`,
 * `limited` and a network failure get ONE more attempt, after the relay's
 * `retryAfter` — unless that is longer than `RELAY_MAX_RETRY_WAIT_SECONDS`, in
 * which case the notification is dropped instead — and are dropped if that
 * fails too, leaving a back-off behind for the origin or the device. Rows that
 * name the same relay, handle and secret are one device and are sent to once.
 * Nothing here throws.
 */
export async function sendRelay(
  registrations: readonly PushRegistration[],
  message: PushMessage,
  options: RelayOptions
): Promise<RelaySendResult> {
  const log = options.log ?? (() => undefined)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref()))
  const now = options.now ?? (() => Date.now())
  const backoff = options.backoff ?? createRelayBackoff()
  const allowed = new Set(relayAllowList(options.allowList))
  const outcomes: RelayOutcome[] = []
  const dead: string[] = []
  const relayMessage = relayMessageFor(message)
  const tooLarge = bytesOf(relayMessage) > RELAY_MESSAGE_LIMIT_BYTES
  const byOrigin = new Map<string, Map<string, Attempt>>()
  const skipped = { foreign: 0, origin: 0, handle: 0 }

  const skip = (installationId: string, reason: string): void => {
    outcomes.push({ installationId, status: 'skipped', reason })
  }

  for (const registration of registrations) {
    const { installationId, handle, secret } = registration

    if (registration.transport !== 'relay' || !handle || !secret) {
      continue
    }

    const origin = relayOriginOf(registration.relay)

    if (!origin || !allowed.has(origin)) {
      skipped.foreign += 1
      skip(installationId, 'not_allowed')

      continue
    }

    if ((backoff.origins.get(origin) ?? 0) > now()) {
      skipped.origin += 1
      skip(installationId, 'relay_backoff')

      continue
    }

    if ((backoff.handles.get(`${origin} ${handle}`) ?? 0) > now()) {
      skipped.handle += 1
      skip(installationId, 'handle_backoff')

      continue
    }

    if (tooLarge) {
      // Refused here rather than by the relay: the answer would be the same
      // `rejected`, after a round trip that carried the secret for nothing.
      log(`push: relay message for ${handleHint(handle)} is too large; not sent`)
      outcomes.push({ installationId, status: 'rejected', reason: 'payload_too_large' })

      continue
    }

    // One device under two rows — a copied row, a reinstall that kept its
    // registration — is one message, and its answer is every row's answer.
    const attempts = byOrigin.get(origin) ?? new Map<string, Attempt>()
    const key = `${handle}\n${secret}`
    const held = attempts.get(key)

    if (held) {
      held.installationIds.push(installationId)
    } else {
      const entry = { handle, secret, message: relayMessage }

      attempts.set(key, { installationIds: [installationId], handle, entry, bytes: bytesOf(entry) })
    }

    byOrigin.set(origin, attempts)
  }

  // Counted, never named: the origin a row claims is not this log's to print
  // and the handle beside it is half a credential.
  if (skipped.foreign) {
    log(`push: ${String(skipped.foreign)} relay registration(s) name a relay that is not on the allow-list; not sent`)
  }

  if (skipped.origin) {
    log(`push: ${String(skipped.origin)} relay registration(s) skipped; the relay is backing off`)
  }

  if (skipped.handle) {
    log(`push: ${String(skipped.handle)} relay registration(s) skipped; the relay rate-limited the device`)
  }

  const settle = (attempt: Attempt, answer: Answer): void => {
    if (answer.status === 'gone') {
      dead.push(...attempt.installationIds)
    } else if (answer.status === 'rejected') {
      log(
        `push: relay rejected the message for ${handleHint(attempt.handle)}${answer.reason ? ` (${answer.reason})` : ''}`
      )
    }

    for (const installationId of attempt.installationIds) {
      outcomes.push({ installationId, status: answer.status, ...(answer.reason ? { reason: answer.reason } : {}) })
    }
  }

  /** A final `retry` or `limited`: dropped, with the back-off it leaves behind. */
  const drop = (origin: string, attempt: Attempt, answer: Answer, why: string): void => {
    const seconds = answer.retryAfter ?? (answer.whole ? RELAY_ORIGIN_BACKOFF_SECONDS : RELAY_HANDLE_BACKOFF_SECONDS)

    if (answer.whole) {
      backoff.origins.set(origin, Math.max(backoff.origins.get(origin) ?? 0, now() + seconds * 1000))
    } else if (answer.status === 'limited') {
      backoff.handles.set(`${origin} ${attempt.handle}`, now() + seconds * 1000)
    }

    log(
      `push: relay ${answer.status} for ${handleHint(attempt.handle)}${answer.reason ? ` (${answer.reason})` : ''}, ${why}; dropped`
    )

    for (const installationId of attempt.installationIds) {
      outcomes.push({ installationId, status: answer.status, reason: 'dropped' })
    }
  }

  for (const [origin, keyed] of byOrigin) {
    const attempts = [...keyed.values()]
    const first = await postAll(origin, attempts, options)
    const again: Attempt[] = []
    let wait = 0

    attempts.forEach((attempt, index) => {
      const answer = first[index] as Answer

      if (answer.status !== 'retry' && answer.status !== 'limited') {
        settle(attempt, answer)

        return
      }

      const after = answer.retryAfter ?? RELAY_DEFAULT_RETRY_SECONDS

      if (after > RELAY_MAX_RETRY_WAIT_SECONDS) {
        drop(origin, attempt, answer, `retry after ${String(after)} s is too long`)

        return
      }

      wait = Math.max(wait, after)
      again.push(attempt)
    })

    if (!again.length) {
      continue
    }

    await sleep(wait * 1000)

    const second = await postAll(origin, again, options)

    again.forEach((attempt, index) => {
      const answer = second[index] as Answer

      if (answer.status === 'retry' || answer.status === 'limited') {
        drop(origin, attempt, answer, 'after one retry')

        return
      }

      settle(attempt, answer)
    })
  }

  return { dead, outcomes }
}
