/**
 * The watcher: the half of `--push` that decides whether anything happened.
 *
 * [ADR-0017](../../../../docs/adr/0017-push-through-hermie-web.md) names four
 * things worth a buzz and nothing else — a new bot message in a chat no client
 * is attached to, an approval or clarify request opening, a bot-to-bot DM, and a
 * cron delivery or cron error. Everything below follows from that list and from
 * three properties the gateway does not have:
 *
 *  - **It cannot be asked who is watching.** `session.active_list` answers about
 *    the CALLING connection and nobody else's, so "nobody is attached" is a
 *    heartbeat the app writes into `push.seen` and this reads. It is a
 *    heuristic, written down as one: it fails towards a redundant notification
 *    for a chat somebody is already reading, which is the right direction.
 *  - **It has no event for a cron delivery or a DM.** Both arrive as an ordinary
 *    inbound row with a header in front of it, so classifying a finished turn
 *    costs one `session.history` — see the note on `classifyTurn`.
 *  - **It never evicts a session whose transport is alive.** Resuming every Bot
 *    Chat therefore pins every Bot Chat, which ADR-0017 accepts knowingly and
 *    the deployment notes say out loud.
 *
 * Requests, DMs and cron deliveries are deliberately NOT suppressed by the
 * heartbeat: a question with a countdown on it is worth a buzz even if the chat
 * is open on a tablet in another room.
 *
 * **Open questions are polled, not subscribed to.** `link.ts` explains why the
 * daemon does not ask a backend to route server→client requests to it by
 * default. What is left is the snapshot a resume answers with and
 * `approval.pending` — the same RPC and the same 30 s cadence the app's own
 * chat controller uses. The poll runs only while at least one device is
 * registered, because a poll that notifies nobody is load on a gateway for
 * nothing.
 */
import { announceAvailability, availabilityIsCurrent, type PushAvailability, withAvailability } from './announce'
import type { PushMessage } from './expo'
import { lastInboundRow } from './inbound'
import type { LinkEvent, LinkServerRequest } from './link'
import { gatewayKeyOf } from './gateway-key'
import { eventIdOf, type NotifiableEvent, pushMessageFor, typeForTurn } from './payload'
import { type PushRegistration, type PushType, registrationsForAny, someoneAttached } from './registrations'
import { readRoster, type Roster, type WatchedBot } from './roster'
import type { PushState } from './state'

/** How fresh a `seen` stamp has to be to keep a message notification quiet. */
export const ATTACHED_WINDOW_SECONDS = 90

/**
 * The pause before a message notification goes out.
 *
 * ADR-0017: "A short delay before sending absorbs the case where the app is
 * opening." The registrations are re-read across it, so an app that got its
 * heartbeat in during the pause claims the chat and the buzz never happens.
 */
export const OPENING_GRACE_MS = 4000

/** Registrations are re-read no more often than this, outside a change signal. */
export const REGISTRATION_TTL_MS = 30_000

/** Per device. A bot in a loop must not become a hundred notifications. */
export const RATE_LIMIT_BURST = 12
export const RATE_LIMIT_WINDOW_SECONDS = 300

export interface WatcherLink {
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

/**
 * The REST transcript, newest rows last, or `null` when this gateway has no
 * REST surface.
 *
 * It exists for one reason: `session.history` is unpaginated, so classifying a
 * finished turn on a chat with thousands of rows would re-download all of them
 * to read the last one. The app's `fetchMessages` has the same signature and the
 * same `null` contract — a gateway without the route is a supported gateway,
 * not a broken one.
 */
export type FetchTail = (sessionId: string, limit: number) => Promise<Record<string, unknown>[] | null>

export interface PushSender {
  /** Deliver to these registrations. Answers with the installations whose address is finished. */
  send(registrations: readonly PushRegistration[], message: PushMessage): Promise<{ dead: string[] }>
}

/** How long the availability stamp is allowed to stand before it is rewritten. */
export const AVAILABILITY_TTL_SECONDS = 300

/**
 * How often the approval queue is read.
 *
 * The same 30 s the app's `APPROVAL_POLL_MS` uses, restated here for the reason
 * `link.ts` gives for restating anything: this package cannot import from the
 * app. If the two ever have to differ, the app's is the one that matters to a
 * person watching a screen and this one can be slower.
 */
export const APPROVAL_POLL_MS = 30_000

/** Rows read from the REST tail when classifying a finished turn. */
export const TAIL_ROW_LIMIT = 5

export interface WatcherOptions {
  link: WatcherLink
  state: PushState
  save: () => Promise<void>
  sender: PushSender
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  attachedWindowSeconds?: number
  openingGraceMs?: number
  registrationTtlMs?: number
  rateLimit?: { burst: number; windowSeconds: number }
  /**
   * What to put in `hermie-app.push` so Settings can say push is available.
   * Absent means say nothing, which is what a test without a daemon wants.
   */
  availability?: () => Omit<PushAvailability, 'at'>
  availabilityTtlSeconds?: number
  /** The REST tail. Absent means every classification falls back to `session.history`. */
  fetchTail?: FetchTail
  /** How often the approval queue is read; 0 turns the poll off. */
  approvalPollMs?: number
  /**
   * The gateway this daemon watches, so every notification can say which one
   * it came from. `gatewayKeyOf` turns it into the key the payload carries.
   *
   * Absent means the payloads carry no key, which is what every notification
   * looked like before this and what an app with one gateway does not need.
   */
  gatewayUrl?: string
  /**
   * What the operator has decided about one person and one bot (`/admin`).
   *
   * Absent means "nothing has been decided about anybody", which is every
   * deployment that has never opened the admin page and every test. This is one
   * of the two places a service-level rule is COMPLETE rather than advisory:
   * the daemon is ours, so a device that may not be notified simply is not,
   * before anything leaves the process.
   */
  allowedTo?: (owner: string, bot: string) => boolean
  /**
   * The service-wide ceiling an operator set on `/admin`.
   *
   * A CEILING rather than a second opt-in: a device still has to have asked for
   * the type, and this can only take it away. `preview: 'never'` overrides each
   * device's own flag, which is the one setting here that makes a notification
   * say LESS than the device asked for — for a shared or regulated deployment
   * where a message summary on a lock screen is not acceptable.
   *
   * Absent means no ceiling, which is every deployment that has never opened
   * the page and every test.
   */
  policy?: () => { types: Record<PushType, boolean>; preview: 'device' | 'never' }
}

interface WatchedSession extends WatchedBot {
  /** Ids the gateway may name this session by; a resume answers with both. */
  aliases: string[]
}

export class PushWatcher {
  private roster: Roster = {
    bots: [],
    defaultProfile: '',
    appSection: null,
    appRevision: 0,
    push: { registrations: [], seen: {} }
  }
  private rosterReadAt = 0
  /** Every id the gateway might stamp on an event → the session it belongs to. */
  private readonly byId = new Map<string, WatchedSession>()
  private readonly rateLimit = new Map<string, number[]>()
  private relisting: Promise<void> | null = null
  private pendingRelist = false
  private inFlight = new Set<Promise<void>>()

  constructor(private readonly options: WatcherOptions) {}

  private get now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000)
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /** The chats being watched right now, for a log line and for the tests. */
  get watched(): WatchedBot[] {
    return this.roster.bots
  }

  /**
   * The sessions actually resumed, which is what subscribes this connection to
   * their events. Distinct from `watched` on purpose: the roster is read before
   * the resumes are made, so a caller that has to know the daemon is LISTENING
   * — a test, a log line — has to ask about this and not about that.
   */
  get resumed(): string[] {
    return [...new Set([...this.byId.values()].map(session => session.sessionId))]
  }

  /** What the last roster read said about registrations. */
  get registrations(): PushRegistration[] {
    return this.roster.push.registrations
  }

  /** Let every in-flight notification finish. Used by the tests and by a clean stop. */
  async settle(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  /**
   * Read the roster and resume every bot's canonical Bot Chat.
   *
   * Called on every connect, and again whenever the gateway says the session
   * store or a profile moved. Resuming is what subscribes this connection to a
   * session's events; without it the socket is open and silent.
   */
  async resumeAll(): Promise<void> {
    if (this.relisting) {
      this.pendingRelist = true

      return this.relisting
    }

    const run = this.relist().finally(() => {
      this.relisting = null
    })
    this.relisting = run
    await run

    if (this.pendingRelist) {
      this.pendingRelist = false
      await this.resumeAll()
    }
  }

  private async relist(): Promise<void> {
    const roster = readRoster(await this.options.link.request('profiles.list', {}))
    this.roster = roster
    this.rosterReadAt = Date.now()

    for (const bot of roster.bots) {
      const existing = this.byId.get(bot.sessionId)

      if (existing && existing.name === bot.name) {
        continue
      }

      try {
        // `omit_messages` because the daemon is not painting a transcript: what
        // a resume is for here is the subscription and the open requests that
        // come back with it.
        const result = await this.options.link.request<{
          session_id?: unknown
          stored_session_id?: unknown
          open_requests?: unknown
          pending_approval?: unknown
        }>('session.resume', { session_id: bot.sessionId, omit_messages: true })

        const aliases = [
          bot.sessionId,
          bot.storedId,
          String(result?.session_id ?? ''),
          String(result?.stored_session_id ?? '')
        ]
        const session: WatchedSession = { ...bot, aliases: [...new Set(aliases.filter(Boolean))] }

        for (const alias of session.aliases) {
          this.byId.set(alias, session)
        }

        this.readResumeSnapshot(session, result)
      } catch (error) {
        // One bot that cannot be resumed costs that bot. A gateway mid-restart
        // would otherwise take the whole watch down with it.
        this.log(`push: could not watch ${bot.name} — ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // A bot that left the roster stops being watched, so a deleted profile does
    // not keep a stale alias alive for ever.
    const live = new Set(roster.bots.map(bot => bot.sessionId))

    for (const [alias, session] of this.byId) {
      if (!live.has(session.sessionId)) {
        this.byId.delete(alias)
      }
    }

    this.log(
      `push: watching ${String(roster.bots.length)} chat(s), ${String(roster.push.registrations.length)} registration(s)` +
        (roster.pluginPush ? '; the gateway’s hermie plugin delivers push, so this daemon sends nothing' : '')
    )
    await this.announce()
  }

  /**
   * Leave the liveness stamp, when there is something to say and it is stale.
   *
   * Skipped when the bag already says exactly this: the write is a
   * compare-and-swap against a key devices are heartbeating into, and rewriting
   * an unchanged value would be a round trip that can only lose a race.
   */
  async announce(): Promise<void> {
    const describe = this.options.availability

    if (!describe) {
      return
    }

    /*
      While the gateway's plugin is the notifier this daemon delivers nothing,
      so its stamp claims nothing either. Above all not `push.relay`: an app
      that read it would replace its Expo row with a relay row, and a plugin
      too old to deliver one would leave that device with no notifier at all.
    */
    const availability: PushAvailability = {
      ...describe(),
      ...(this.roster.pluginPush ? { capabilities: [], relayOrigins: [] } : {}),
      at: this.now
    }
    const ttl = this.options.availabilityTtlSeconds ?? AVAILABILITY_TTL_SECONDS

    if (availabilityIsCurrent(this.roster.appSection, availability, ttl)) {
      return
    }

    try {
      const result = await announceAvailability(this.options.link, this.roster, availability)

      if (result.written) {
        // Keep the local copy in step, through the same function that built the
        // write: the next sweep must compare against what was STORED and not
        // against what was last read.
        this.roster = {
          ...this.roster,
          appRevision: result.revision,
          appSection: withAvailability(this.roster.appSection, availability)
        }
      }
    } catch (error) {
      // Saying "push is available" is not what push is for. A gateway too old
      // for `profiles.configure`, or one that refuses the write, costs a line
      // in Settings and nothing else.
      this.log(
        `push: could not leave the availability stamp — ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** Re-read the roster when it is older than the TTL, or when told to. */
  private async refreshRegistrations(force = false): Promise<void> {
    if (!force && Date.now() - this.rosterReadAt < (this.options.registrationTtlMs ?? REGISTRATION_TTL_MS)) {
      return
    }

    try {
      this.roster = readRoster(await this.options.link.request('profiles.list', {}))
      this.rosterReadAt = Date.now()
    } catch {
      // Keep the last good roster: a refresh that failed is not a statement
      // that nobody is registered.
    }
  }

  /** One gateway event. Returns immediately; the work runs behind it. */
  onEvent(event: LinkEvent): void {
    if (event.type === 'sessions.changed' || event.type === 'profiles.changed') {
      this.track(this.resumeAll().catch(() => undefined))

      return
    }

    if (event.type !== 'message.complete') {
      return
    }

    const session = event.session_id ? this.byId.get(event.session_id) : undefined

    if (!session || typeof event.seq !== 'number') {
      return
    }

    this.track(
      this.onTurnComplete(session, event).catch(error => {
        this.log(`push: a turn could not be reported — ${error instanceof Error ? error.message : String(error)}`)
      })
    )
  }

  /** One server→client request. Never answered; see `link.ts`. */
  onServerRequest(request: LinkServerRequest): void {
    if (request.method !== 'approval' && request.method !== 'clarify') {
      return
    }

    const sessionId = typeof request.params.session_id === 'string' ? request.params.session_id : ''
    const session = this.byId.get(sessionId)

    if (!session) {
      return
    }

    /*
      The QUEUE id is the identity, not the JSON-RPC id.

      One question reaches this method under up to three different envelopes: a
      live frame (`srq-7`), a resume's `open_requests` entry (the same `srq-7`,
      but a new one after a reconnect), and the `pending_approval` snapshot or
      the `approval.pending` poll (`pending:<request_id>`). Keying on the
      envelope would buzz once per route and once per reconnect; keying on
      `params.request_id` is what makes them one question. A clarify has no queue
      id, so it falls back to the JSON-RPC id — which is stable for as long as
      the request is.
    */
    const queueId = typeof request.params.request_id === 'string' ? request.params.request_id : ''

    this.track(
      this.notify(
        {
          type: 'request',
          bot: session.name,
          botLabel: session.label,
          sessionId: session.sessionId,
          // This daemon resumes canonical Bot Chats only, so it can say which
          // kind of conversation this is as a fact rather than as a guess.
          sessionKind: 'canonical',
          requestId: queueId || request.id,
          requestMethod: request.method,
          preview: previewOfRequest(request.params),
          // The plugin's derivation and the plugin's parts, so the two
          // notifiers name the same question the same way.
          eventId: eventIdOf(
            request.method === 'clarify' ? 'clarify' : 'request',
            session.sessionId,
            queueId || request.id
          )
        },
        `${session.sessionId}:req:${queueId || request.id}`,
        { suppressWhenAttached: false }
      ).catch(() => undefined)
    )
  }

  /**
   * The open questions a resume answers with.
   *
   * Read HERE rather than through the link's own delivery of the same fields,
   * for an ordering reason that is easy to miss: the link hands them over while
   * the `session.resume` call is still settling, which is before this watcher
   * knows which bot that session belongs to. Reading them once the mapping
   * exists is the difference between a notification and a dropped one. The
   * link's delivery still happens and is deduped away.
   *
   * `pending_approval` is the queue entry, which is the only trace of a question
   * that opened before this connection existed.
   */
  private readResumeSnapshot(
    session: WatchedSession,
    result: { open_requests?: unknown; pending_approval?: unknown }
  ): void {
    for (const entry of Array.isArray(result?.open_requests)
      ? (result.open_requests as Record<string, unknown>[])
      : []) {
      if (typeof entry?.id === 'string' && typeof entry.method === 'string') {
        const params = (entry.params ?? {}) as Record<string, unknown>
        this.onServerRequest({
          id: entry.id,
          method: entry.method,
          params: { ...params, session_id: session.sessionId },
          replayed: true
        })
      }
    }

    const pending = result?.pending_approval

    if (pending && typeof pending === 'object') {
      const row = pending as Record<string, unknown>
      const requestId = typeof row.request_id === 'string' ? row.request_id : ''

      this.onServerRequest({
        id: `pending:${requestId || 'approval'}`,
        method: 'approval',
        params: { ...row, session_id: session.sessionId },
        replayed: true
      })
    }
  }

  /**
   * Read the approval queue of every watched chat.
   *
   * The safe default's primary source for a question that opened while nothing
   * was attached. Skipped entirely when nobody is registered: a poll that would
   * notify no one is load on somebody's gateway for nothing.
   *
   * A queue entry is not a live request and this never answers one — it is
   * reported under `pending:<request_id>`, exactly as the app's own poll
   * synthesizes it, and the dedupe in `onServerRequest` folds it onto whatever
   * envelope arrived first.
   */
  async pollApprovals(): Promise<void> {
    if (!this.roster.push.registrations.length || this.roster.pluginPush) {
      return
    }

    for (const session of new Set(this.byId.values())) {
      let result: { approvals?: unknown }

      try {
        result = await this.options.link.request('approval.pending', {
          session_id: session.sessionId,
          profile: session.name
        })
      } catch {
        // Best effort by construction; the next poll asks again.
        continue
      }

      for (const approval of Array.isArray(result?.approvals) ? (result.approvals as Record<string, unknown>[]) : []) {
        const requestId = typeof approval?.request_id === 'string' ? approval.request_id : ''

        this.onServerRequest({
          id: `pending:${requestId || 'approval'}`,
          method: 'approval',
          params: { ...approval, session_id: session.sessionId },
          replayed: true
        })
      }
    }
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise)
    void promise.finally(() => this.inFlight.delete(promise))
  }

  private async onTurnComplete(session: WatchedSession, event: LinkEvent): Promise<void> {
    const seq = event.seq ?? 0
    const payload = (event.payload ?? {}) as { text?: unknown; status?: unknown; error?: unknown }

    // Nothing to classify for, so nothing to fetch. The history read below is
    // the daemon's one expensive call and it is worth skipping when it would
    // only decide which of several empty audiences to address. The same goes
    // for a gateway whose plugin is the notifier: nothing here will be sent.
    if (!this.roster.push.registrations.length || this.roster.pluginPush) {
      return
    }

    const inbound = await this.classifyTurn(session)
    const failed = payload.status === 'error' || typeof payload.error === 'string'
    const type: PushType = typeForTurn(inbound.kind, failed)
    const cron = inbound.kind === 'cron'

    const notifiable: NotifiableEvent = {
      type,
      bot: session.name,
      botLabel: session.label,
      sessionId: session.sessionId,
      // Canonical, for the reason the request path above gives: the only
      // sessions this daemon watches are the ones it resumed off the roster.
      sessionKind: 'canonical',
      ...(inbound.name ? { name: inbound.name } : {}),
      /*
        A FACT here, and said so rather than left out.

        This daemon recognises a cron run by matching one of two headers the
        scheduler writes, word for word — see `inbound.ts` — so the answer is
        as certain as the transcript it read. A notifier whose only signal is a
        free-text platform string cannot say this, and the app words that case
        as an ordinary message instead of claiming a scheduled run.
      */
      ...(cron ? { cron: true, cronCertain: true } : {}),
      ...(cron && failed ? { failed: true } : {}),
      preview: typeof payload.text === 'string' ? payload.text : '',
      eventId: eventIdOf(type, session.sessionId, String(seq))
    }

    await this.notify(notifiable, `${session.sessionId}:${type}:${String(seq)}`, {
      // Only an ordinary message defers to the heartbeat. A DM, a cron report
      // and a failed run are worth a buzz whether or not a chat is on screen.
      suppressWhenAttached: type === 'message',
      /*
        A scheduled run answers to two switches at once. The payload names the
        finer one — `cron_done` or `cron_failed` — and the coarse `cron` is
        added to the audience so that every device which was being told about
        scheduled runs before these types existed goes on being told. Adding a
        type must never be how somebody's phone goes quiet.
      */
      ...(cron ? { audience: [type, 'cron' as const] } : {})
    })
  }

  /**
   * What started this turn.
   *
   * Hermes has no wire marker for a cron delivery or a DM, so the only place the
   * answer exists is the inbound row that the turn ran on. Reading it used to
   * cost a `session.history`, which is UNPAGINATED — on a chat with thousands of
   * rows that is the whole transcript downloaded to look at the last one, once
   * per finished turn.
   *
   * So the REST tail comes first: five rows, newest last, the same route and the
   * same shape the app's own tail reconcile uses. `session.history` stays as the
   * fallback for a gateway that has no REST surface, which is a supported
   * gateway rather than a broken one. Both failing degrades to "the owner
   * typed", which produces an ordinary message notification rather than none.
   */
  private async classifyTurn(session: WatchedSession): Promise<ReturnType<typeof lastInboundRow>> {
    const tail = this.options.fetchTail

    if (tail) {
      try {
        const rows = await tail(session.sessionId, TAIL_ROW_LIMIT)

        if (rows) {
          return lastInboundRow(rows)
        }
      } catch {
        // Treated as "no REST surface" rather than as "no answer": the RPC
        // below can still say what started this turn.
      }
    }

    try {
      const history = await this.options.link.request<{ messages?: unknown }>('session.history', {
        session_id: session.sessionId
      })

      return lastInboundRow(Array.isArray(history?.messages) ? (history.messages as Record<string, unknown>[]) : [])
    } catch {
      return { kind: 'message', name: '', body: '' }
    }
  }

  /** Decide, dedupe, rate-limit and send. The single exit for every notification. */
  private async notify(
    input: NotifiableEvent,
    dedupeKey: string,
    options: {
      suppressWhenAttached: boolean
      /** Every switch this one fact answers to. Defaults to the payload's own type. */
      audience?: readonly PushType[]
    }
  ): Promise<void> {
    const state = this.options.state
    // Stamped here rather than at each of the four places an event is built:
    // this is the one exit, and a key added at three of four call sites is a
    // notification type that silently cannot route.
    const key = gatewayKeyOf(this.options.gatewayUrl ?? '')
    const event: NotifiableEvent = key ? { ...input, gatewayKey: key } : input

    if (state.sent[dedupeKey]) {
      return
    }

    // Claimed BEFORE the grace pause, not after: two events racing through the
    // same key — a live frame and its replayed twin — must not both get past
    // this line and both buzz.
    state.sent[dedupeKey] = this.now

    if (options.suppressWhenAttached) {
      const sleep =
        this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref()))
      await sleep(this.options.openingGraceMs ?? OPENING_GRACE_MS)
      await this.refreshRegistrations(true)

      if (someoneAttached(this.roster.push, this.now, this.options.attachedWindowSeconds ?? ATTACHED_WINDOW_SECONDS)) {
        this.log(`push: ${event.bot} — somebody is reading; not notifying`)
        await this.options.save()

        return
      }
    } else {
      await this.refreshRegistrations()
    }

    /*
      The gateway's plugin delivers push, so this daemon does not — on any
      transport. Checked after the roster refresh, so a plugin installed or
      switched off while the daemon runs is noticed within one TTL; the claim on
      the dedupe key above stays, so the same event does not go out later if the
      plugin disappears in between.
    */
    if (this.roster.pluginPush) {
      this.log(`push: ${event.bot} — the gateway’s hermie plugin delivers push; not notifying`)
      await this.options.save()

      return
    }

    const policy = this.options.policy?.()

    if (policy && policy.types[event.type] === false) {
      this.log(`push: ${event.bot} — ${event.type} is off for this service; not notifying`)
      await this.options.save()

      return
    }

    const audience = registrationsForAny(this.roster.push, options.audience ?? [event.type]).filter(
      registration =>
        !state.invalid[registration.installationId] &&
        this.allow(registration.installationId) &&
        (this.options.allowedTo?.(registration.owner, event.bot) ?? true)
    )

    if (!audience.length) {
      await this.options.save()

      return
    }

    // One send per preview setting: the same event, said two ways, because the
    // decision is the registration's and not the event's.
    for (const preview of [false, true]) {
      // `never` folds every device into the no-preview pass: one send, and no
      // registration's own flag can put the text back.
      const targets = audience.filter(registration =>
        policy?.preview === 'never' ? preview === false : registration.preview === preview
      )

      if (!targets.length) {
        continue
      }

      const { dead } = await this.options.sender.send(targets, pushMessageFor(event, preview))

      for (const installationId of dead) {
        state.invalid[installationId] = this.now
      }
    }

    this.log(`push: ${event.bot} — ${event.type} to ${String(audience.length)} device(s)`)
    await this.options.save()
  }

  /**
   * A token bucket per device.
   *
   * Held in memory rather than in the state file on purpose: a restart clearing
   * it is the safe direction, because the dedupe keys ARE persisted and they are
   * what stops the same event being sent twice. This limit exists for a bot in a
   * loop producing a hundred DIFFERENT events, which is not something a restart
   * should be able to un-decide either — but a rate limit that survives a crash
   * is a silence nobody can explain.
   */
  private allow(installationId: string): boolean {
    const { burst, windowSeconds } = this.options.rateLimit ?? {
      burst: RATE_LIMIT_BURST,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS
    }
    const now = this.now
    const recent = (this.rateLimit.get(installationId) ?? []).filter(at => now - at < windowSeconds)

    if (recent.length >= burst) {
      this.rateLimit.set(installationId, recent)

      return false
    }

    recent.push(now)
    this.rateLimit.set(installationId, recent)

    return true
  }
}

/** The one line a request carries that a device with `preview` on may see. */
function previewOfRequest(params: Record<string, unknown>): string {
  for (const key of ['command', 'description', 'question', 'prompt', 'title']) {
    const value = params[key]

    if (typeof value === 'string' && value) {
      return value
    }
  }

  return ''
}
