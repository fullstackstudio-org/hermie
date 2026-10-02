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
 *  - **https only, redirects not followed, every request times out, every
 *    answer is read to a cap.** A relay that answers with a redirect is treated
 *    as a failed request; following it would undo the allow-list.
 *  - **Nothing a person wrote crosses the relay.** The body is always the
 *    name-free event-type phrase (`PushMessage.summary`), whatever the device
 *    asked for, until the sender can encrypt for the row's `enc` key — and the
 *    registration reader already reads every relay row as `preview: false`.
 *  - **Never log a secret or a whole handle.** A log line names a handle by its
 *    first few characters and nothing else.
 *
 * And the rules about pacing, ported from the gateway plugin's `push/relay.py`
 * so the two senders treat the relay alike. A send never waits long — one
 * retry, after at most `RELAY_MAX_RETRY_WAIT_SECONDS`. A relay that failed a
 * whole request, or rate-limited this sender's address, is left alone for the
 * time it asked (at most an hour); a device it rate-limited, likewise (at most
 * a day). A `(relay, handle, secret)` the relay called `gone` is not sent to
 * again, and a person whose rows keep coming back `gone` has their unproven
 * rows held for an hour, so one co-user writing made-up handles cannot spend
 * the relay's per-address `gone` allowance for everybody.
 *
 * A request the relay refused WHOLE (400 or 413) is sent again one entry at a
 * time, so one bad row costs only itself.
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
 * Under every cap the relay has had, on purpose: the cap is the relay's to
 * change and it does not advertise it. The plugin's number.
 */
export const RELAY_REQUEST_LIMIT_BYTES = 7_680

/** One message (its `message` object, as JSON): the relay's cap is 3,584; this side keeps a margin. */
export const RELAY_MESSAGE_LIMIT_BYTES = 3_500

/** How long one request may take before it counts as a network failure. */
export const RELAY_TIMEOUT_MS = 10_000

/** How much of an answer is read. An answer to twenty messages is a couple of kilobytes. */
export const RELAY_MAX_RESPONSE_BYTES = 64 * 1024

/**
 * The longest `retryAfter` this sender will wait out before its one retry.
 *
 * A send runs inside the watcher's notification path, so this is how long a
 * notification can be held. A relay that asks for longer is not waited for:
 * the message is dropped and the relay, or the device, is left alone instead.
 */
export const RELAY_MAX_RETRY_WAIT_SECONDS = 10

/** The pause before the one retry when the relay named none, or did not answer. */
export const RELAY_DEFAULT_RETRY_SECONDS = 2

/** How long a relay that failed again on the retry is left alone when it named no time. */
export const RELAY_BACKOFF_SECONDS = 60

/** How long a rate-limited device is left alone when the relay named no time. */
export const RELAY_HANDLE_BACKOFF_SECONDS = 60

/**
 * The longest a relay, or one handle on it, is left alone, whatever it asked.
 *
 * The relay is trusted for pacing, not for silence: a mistaken or hostile
 * `Retry-After: 1000000000` costs an hour for a whole relay and a day (the
 * relay's own daily limit) for one handle, not every notification until the
 * daemon restarts.
 */
export const RELAY_MAX_ORIGIN_HOLD_SECONDS = 3_600
export const RELAY_MAX_HANDLE_HOLD_SECONDS = 86_400

/** The most handles, and `(relay, handle, secret)` pairs, remembered. */
export const RELAY_MAX_REMEMBERED = 1_024

/** After this many `gone` answers in `RELAY_GONE_WINDOW_SECONDS`, a person's unproven rows are held. */
export const RELAY_GONE_BUDGET = 3
export const RELAY_GONE_WINDOW_SECONDS = 3_600

/** How long a pair the relay called `gone`, or delivered to, is remembered. */
export const RELAY_PAIR_MEMORY_SECONDS = 30 * 86_400

/** The relay's own rule for a collapse id: 1 to 64 printable ASCII characters. */
export const RELAY_COLLAPSE_ID_LIMIT = 64
const COLLAPSE_ID = /^[\x21-\x7e]{1,64}$/u

/** The relay's cap on a thread id, in characters. */
const MAX_THREAD_CHARS = 256

/** How long the relay may hold a notification for an unreachable device. */
export const RELAY_TTL_SECONDS = 3600

export type RelayStatus = 'sent' | 'gone' | 'rejected' | 'retry' | 'limited'

/**
 * What the relay has said that outlives one send, kept by whoever owns the
 * sender and in memory only: a restart forgetting it costs at most a request
 * the relay answers the same way again. Times are milliseconds on the
 * sender's (monotonic) clock.
 */
export interface RelayBackoff {
  /** origin → not before. */
  origins: Map<string, number>
  /** `origin handle` → not before. */
  handles: Map<string, number>
  /** `origin handle secret` → until when it is remembered as gone. */
  gone: Map<string, number>
  /** `origin handle secret` → until when it is remembered as delivered to. */
  proven: Map<string, number>
  /** owner → when their rows came back gone. */
  failures: Map<string, number[]>
}

export function createRelayBackoff(): RelayBackoff {
  return { origins: new Map(), handles: new Map(), gone: new Map(), proven: new Map(), failures: new Map() }
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
  /** Milliseconds on a monotonic clock. Default `performance.now()`. */
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
  owners: string[]
  handle: string
  /** `origin handle secret`, the key of the pair memories. */
  pair: string
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

/** The relay's collapse id: the event id when it is one the relay takes, its SHA-256 hex otherwise. */
function collapseIdOf(eventId: string | undefined): string {
  if (!eventId) {
    return ''
  }

  return COLLAPSE_ID.test(eventId) ? eventId : createHash('sha256').update(eventId, 'utf8').digest('hex')
}

/**
 * The relay's abstract message for one notification.
 *
 * Exported so the payload can be checked against `contract/push/contract.json`
 * without a network. The body is the summary and never the preview: see the
 * note at the top of this file. Optional members are left out rather than sent
 * empty, which is also what the relay requires of them. Priority is always
 * `high`, as the plugin sends it: everything here is something a person asked
 * to be told about.
 */
export function relayMessageFor(message: PushMessage): Record<string, unknown> {
  const bot = typeof message.data.bot === 'string' ? message.data.bot : ''
  const gatewayKey = typeof message.data.gatewayKey === 'string' ? message.data.gatewayKey : ''
  const collapseId = collapseIdOf(message.eventId)
  const thread = (gatewayKey ? `${gatewayKey}:${bot}` : bot).slice(0, MAX_THREAD_CHARS)

  return {
    title: message.title,
    body: message.summary ?? message.body,
    ...(message.categoryId ? { category: message.categoryId } : {}),
    // One thread per chat per gateway, so two gateways' `researcher` do not
    // stack into one group on a lock screen.
    ...(thread ? { thread } : {}),
    ...(collapseId ? { collapseId } : {}),
    priority: 'high',
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
 * The relay's answers are matched by handle, so one handle twice in one
 * request — the same device under two rows with different secrets, one of
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

/** `Retry-After` in seconds, 0 to a day, or `undefined` for a missing or unreadable header. */
function retryAfterHeader(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  const seconds = raw === null ? Number.NaN : Number(raw)

  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, RELAY_MAX_HANDLE_HOLD_SECONDS) : undefined
}

/** Read at most `RELAY_MAX_RESPONSE_BYTES` of a body; `null` when it is longer or the read fails. */
async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()

  if (!reader) {
    return ''
  }

  const chunks: Uint8Array[] = []
  let size = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      size += value.byteLength

      if (size > RELAY_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)

        return null
      }

      chunks.push(value)
    }
  } catch {
    return null
  }

  return Buffer.concat(chunks).toString('utf8')
}

/** Let go of a body nobody will read, so the connection is not held open by it. */
function drain(response: Response): void {
  void response.body?.cancel().catch(() => undefined)
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

  if (response.status !== 200) {
    drain(response)
  }

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return all({ status: 'rejected', reason: 'redirect' })
  }

  if (response.status === 429 || response.status >= 500) {
    const retryAfter = retryAfterHeader(response)

    return all({
      status: response.status === 429 ? 'limited' : 'retry',
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
    const text = await readCapped(response)

    if (text === null) {
      throw new Error('unreadable')
    }

    const parsed = JSON.parse(text) as { results?: unknown }

    results = Array.isArray(parsed?.results) ? parsed.results : []
  } catch {
    return all({ status: 'retry', whole: true, reason: 'unreadable_response' })
  }

  return {
    answers: batch.map(attempt => {
      // Matched by handle, never by position: a relay that answered in another
      // order, or skipped one, must not have one device's `gone` retire
      // another. A batch never holds one handle twice.
      const row = results.find(item => (item as Record<string, unknown> | null)?.handle === attempt.handle) as
        Record<string, unknown> | undefined
      const status = typeof row?.status === 'string' && STATUSES.includes(row.status) ? (row.status as RelayStatus) : ''

      if (!status) {
        return { status: 'rejected', reason: 'no_result' }
      }

      const retryAfter =
        typeof row?.retryAfter === 'number' && Number.isFinite(row.retryAfter) && row.retryAfter >= 0
          ? Math.min(row.retryAfter, RELAY_MAX_HANDLE_HOLD_SECONDS)
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

/** Keep a not-before map at `RELAY_MAX_REMEMBERED`: the lapsed go first, then the soonest to lapse. */
function bounded(store: Map<string, number>, now: number): void {
  if (store.size <= RELAY_MAX_REMEMBERED) {
    return
  }

  for (const [key, until] of store) {
    if (until <= now) {
      store.delete(key)
    }
  }

  while (store.size > RELAY_MAX_REMEMBERED) {
    let soonest = ''
    let at = Number.POSITIVE_INFINITY

    for (const [key, until] of store) {
      if (until < at) {
        soonest = key
        at = until
      }
    }

    store.delete(soonest)
  }
}

/** The pacing half: when a relay, or a handle on it, may be asked again. */
class Pacing {
  constructor(
    private readonly backoff: RelayBackoff,
    private readonly now: () => number,
    private readonly log: (line: string) => void
  ) {}

  originWait(origin: string): number {
    return Math.max(0, (this.backoff.origins.get(origin) ?? 0) - this.now())
  }

  handleWait(origin: string, handle: string): number {
    return Math.max(0, (this.backoff.handles.get(`${origin} ${handle}`) ?? 0) - this.now())
  }

  /** Leave `origin` alone for `seconds`, at most an hour. Never shortens a hold. */
  holdOrigin(origin: string, seconds: number): void {
    const held = Math.min(Math.max(0, seconds), RELAY_MAX_ORIGIN_HOLD_SECONDS)
    const until = this.now() + held * 1000

    if (until <= (this.backoff.origins.get(origin) ?? 0)) {
      return
    }

    this.backoff.origins.set(origin, until)

    if (held > RELAY_BACKOFF_SECONDS) {
      // Said once per hold, never per notification it then drops.
      this.log(`push: WARNING relay ${origin} is left alone for ${String(Math.round(held))} s, as it asked`)
    }
  }

  /** Leave one handle alone for `seconds`, at most a day. Never shortens a hold. */
  holdHandle(origin: string, handle: string, seconds: number): void {
    const key = `${origin} ${handle}`
    const held = Math.min(Math.max(0, seconds), RELAY_MAX_HANDLE_HOLD_SECONDS)
    const until = this.now() + held * 1000

    if (until <= (this.backoff.handles.get(key) ?? 0)) {
      return
    }

    this.backoff.handles.set(key, until)

    if (held > RELAY_BACKOFF_SECONDS) {
      this.log(
        `push: WARNING relay ${origin} limited ${handleHint(handle)}; leaving it alone for ${String(Math.round(held))} s`
      )
    }

    bounded(this.backoff.handles, this.now())
  }
}

/** The trust half: which pairs the relay called gone or delivered to, and whose rows keep coming back gone. */
class Trust {
  constructor(
    private readonly backoff: RelayBackoff,
    private readonly now: () => number
  ) {}

  isGone(pair: string): boolean {
    return (this.backoff.gone.get(pair) ?? 0) > this.now()
  }

  isProven(pair: string): boolean {
    return (this.backoff.proven.get(pair) ?? 0) > this.now()
  }

  overBudget(owner: string): boolean {
    const now = this.now()
    const recent = (this.backoff.failures.get(owner) ?? []).filter(at => now - at < RELAY_GONE_WINDOW_SECONDS * 1000)

    if (recent.length) {
      this.backoff.failures.set(owner, recent)
    } else {
      this.backoff.failures.delete(owner)
    }

    return recent.length >= RELAY_GONE_BUDGET
  }

  record(attempt: Attempt, status: RelayStatus): void {
    const now = this.now()
    const until = now + RELAY_PAIR_MEMORY_SECONDS * 1000

    if (status === 'sent') {
      this.backoff.proven.set(attempt.pair, until)
      this.backoff.gone.delete(attempt.pair)
      bounded(this.backoff.proven, now)
    } else if (status === 'gone') {
      this.backoff.gone.set(attempt.pair, until)
      this.backoff.proven.delete(attempt.pair)
      bounded(this.backoff.gone, now)

      for (const owner of new Set(attempt.owners)) {
        const failures = [...(this.backoff.failures.get(owner) ?? []), now].slice(-RELAY_GONE_BUDGET)

        this.backoff.failures.set(owner, failures)
      }

      while (this.backoff.failures.size > RELAY_MAX_REMEMBERED) {
        const oldest = [...this.backoff.failures].sort((a, b) => Math.max(...a[1]) - Math.max(...b[1]))[0]

        this.backoff.failures.delete(oldest?.[0] ?? '')
      }
    }
  }
}

/**
 * Send every attempt for one origin, in batches, once, and answer for each.
 *
 * A batch the relay refused whole (400, 413) is sent again one entry at a time;
 * if every one of those is refused whole as well, no entry was the cause and
 * the relay is left alone. Once a request has failed whole — no answer, 429,
 * 5xx — nothing more is sent to that relay this round: the rest get the same
 * answer and the relay is held, because asking a relay that is down or
 * shedding load again within the same second is the one thing that cannot help.
 */
async function round(
  origin: string,
  attempts: readonly Attempt[],
  options: RelayOptions,
  pacing: Pacing,
  backoffSeconds: number
): Promise<Map<Attempt, Answer>> {
  const answers = new Map<Attempt, Answer>()
  let failed: Answer | null = null

  const hold = (answer: Answer): void => {
    failed = answer
    pacing.holdOrigin(origin, Math.max(answer.retryAfter ?? 0, backoffSeconds))
  }

  for (const batch of batchesOf(attempts)) {
    if (failed) {
      for (const attempt of batch) {
        answers.set(attempt, { ...(failed as Answer) })
      }

      continue
    }

    const posted = await post(origin, batch, options)

    if ('answers' in posted) {
      batch.forEach((attempt, index) => answers.set(attempt, posted.answers[index] as Answer))

      const whole = posted.answers.find(answer => answer.whole)

      if (whole) {
        hold(whole)
      }

      continue
    }

    if (batch.length === 1) {
      answers.set(batch[0] as Attempt, { status: 'rejected', reason: posted.split })

      continue
    }

    let refusedAlone = 0

    for (const attempt of batch) {
      if (failed) {
        answers.set(attempt, { ...(failed as Answer) })

        continue
      }

      const alone = await post(origin, [attempt], options)

      if ('split' in alone) {
        refusedAlone += 1
        answers.set(attempt, { status: 'rejected', reason: alone.split })

        continue
      }

      const answer = alone.answers[0] as Answer

      answers.set(attempt, answer)

      if (answer.whole) {
        hold(answer)
      }
    }

    if (refusedAlone === batch.length) {
      // Every entry was refused on its own as well, so none of them was the
      // cause: the relay refuses this sender's requests as such (a changed
      // protocol, a smaller cap). Asking it 1 + N times per notification
      // changes nothing; it is left alone for a while.
      options.log?.(`push: WARNING relay ${origin} refused every message on its own as well; leaving it alone`)
      pacing.holdOrigin(origin, RELAY_BACKOFF_SECONDS)
    }
  }

  return answers
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
 * fails too. Rows that name the same relay, handle and secret are one device
 * and are sent to once. Nothing here throws.
 */
export async function sendRelay(
  registrations: readonly PushRegistration[],
  message: PushMessage,
  options: RelayOptions
): Promise<RelaySendResult> {
  const log = options.log ?? (() => undefined)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref()))
  const now = options.now ?? (() => performance.now())
  const backoff = options.backoff ?? createRelayBackoff()
  const pacing = new Pacing(backoff, now, log)
  const trust = new Trust(backoff, now)
  const allowed = new Set(relayAllowList(options.allowList))
  const outcomes: RelayOutcome[] = []
  const dead: string[] = []
  const relayMessage = relayMessageFor(message)
  const tooLarge = bytesOf(relayMessage) > RELAY_MESSAGE_LIMIT_BYTES
  const byOrigin = new Map<string, Map<string, Attempt>>()
  const skipped = new Map<string, number>()
  const rejected = new Map<string, number>()
  const dropped = new Map<string, number>()

  const count = (store: Map<string, number>, reason: string): void => {
    store.set(reason, (store.get(reason) ?? 0) + 1)
  }

  const skip = (installationId: string, reason: string): void => {
    outcomes.push({ installationId, status: 'skipped', reason })
    count(skipped, reason)
  }

  for (const registration of registrations) {
    const { installationId, handle, secret } = registration

    if (registration.transport !== 'relay' || !handle || !secret) {
      continue
    }

    const origin = relayOriginOf(registration.relay)

    if (!origin || !allowed.has(origin)) {
      skip(installationId, 'not_allowed')

      continue
    }

    const pair = `${origin} ${handle} ${secret}`

    if (pacing.originWait(origin) > 0) {
      skip(installationId, 'relay_backoff')

      continue
    }

    if (pacing.handleWait(origin, handle) > 0) {
      skip(installationId, 'handle_backoff')

      continue
    }

    if (trust.isGone(pair)) {
      // The relay already said this pair is gone and it never hands a handle
      // out twice, so a row written again with it will not be answered
      // differently. Retired again, so the row stays out until it changes.
      skip(installationId, 'known_gone')
      dead.push(installationId)

      continue
    }

    if (!trust.isProven(pair) && trust.overBudget(registration.owner)) {
      skip(installationId, 'owner_gone_budget')

      continue
    }

    if (tooLarge) {
      // Refused here rather than by the relay: the answer would be the same
      // `rejected`, after a round trip that carried the secret for nothing.
      outcomes.push({ installationId, status: 'rejected', reason: 'payload_too_large' })
      count(rejected, 'payload_too_large')

      continue
    }

    // One device under two rows — a copied row, a reinstall that kept its
    // registration — is one message, and its answer is every row's answer.
    const attempts = byOrigin.get(origin) ?? new Map<string, Attempt>()
    const held = attempts.get(pair)

    if (held) {
      held.installationIds.push(installationId)
      held.owners.push(registration.owner)
    } else {
      const entry = { handle, secret, message: relayMessage }

      attempts.set(pair, {
        installationIds: [installationId],
        owners: [registration.owner],
        handle,
        pair,
        entry,
        bytes: bytesOf(entry)
      })
    }

    byOrigin.set(origin, attempts)
  }

  const settle = (attempt: Attempt, answer: Answer): void => {
    trust.record(attempt, answer.status)

    if (answer.status === 'gone') {
      dead.push(...attempt.installationIds)
    } else if (answer.status === 'rejected') {
      count(rejected, answer.reason ?? 'rejected')
    }

    for (const installationId of attempt.installationIds) {
      outcomes.push({ installationId, status: answer.status, ...(answer.reason ? { reason: answer.reason } : {}) })
    }
  }

  /** A final `retry` or `limited`: dropped, with the hold it leaves behind. */
  const drop = (origin: string, attempt: Attempt, answer: Answer): void => {
    if (answer.whole) {
      pacing.holdOrigin(origin, answer.retryAfter ?? RELAY_BACKOFF_SECONDS)
    } else if (answer.status === 'limited' && answer.reason === 'ip_rate_limited') {
      // The relay is limiting this sender's address, not the device: every
      // other message would get the same answer, so the relay is held.
      pacing.holdOrigin(origin, answer.retryAfter ?? RELAY_BACKOFF_SECONDS)
    } else if (answer.status === 'limited') {
      pacing.holdHandle(origin, attempt.handle, answer.retryAfter ?? RELAY_HANDLE_BACKOFF_SECONDS)
    }

    count(dropped, `${answer.status}${answer.reason ? ` ${answer.reason}` : ''}`)

    for (const installationId of attempt.installationIds) {
      outcomes.push({ installationId, status: answer.status, reason: 'dropped' })
    }
  }

  for (const [origin, keyed] of byOrigin) {
    const attempts = [...keyed.values()]
    const first = await round(origin, attempts, options, pacing, RELAY_DEFAULT_RETRY_SECONDS)
    const again: Attempt[] = []
    let wait = 0

    for (const attempt of attempts) {
      const answer = first.get(attempt) as Answer

      if (answer.status !== 'retry' && answer.status !== 'limited') {
        settle(attempt, answer)

        continue
      }

      const after = answer.retryAfter ?? RELAY_DEFAULT_RETRY_SECONDS

      if (after > RELAY_MAX_RETRY_WAIT_SECONDS) {
        drop(origin, attempt, answer)

        continue
      }

      wait = Math.max(wait, after)
      again.push(attempt)
    }

    if (!again.length) {
      continue
    }

    await sleep(Math.max(wait * 1000, pacing.originWait(origin)))

    // The second round is the last: a relay still failing after it is left
    // alone for a while rather than asked by every notification that follows.
    const second = await round(origin, again, options, pacing, RELAY_BACKOFF_SECONDS)

    for (const attempt of again) {
      const answer = second.get(attempt) as Answer

      if (answer.status === 'retry' || answer.status === 'limited') {
        drop(origin, attempt, answer)
      } else {
        settle(attempt, answer)
      }
    }
  }

  // One line per kind of trouble per send, counted and never naming a handle,
  // so an outage does not become a line per device per notification.
  const summary = (store: Map<string, number>): string =>
    [...store].map(([reason, times]) => `${reason} ×${String(times)}`).join(', ')

  if (skipped.size) {
    log(`push: relay messages not sent: ${summary(skipped)}`)
  }

  if (rejected.size) {
    log(`push: relay rejected messages: ${summary(rejected)}`)
  }

  if (dropped.size) {
    log(`push: relay messages dropped after one retry or a long wait: ${summary(dropped)}`)
  }

  return { dead, outcomes }
}
