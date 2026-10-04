/**
 * Stream scenarios for the golden corpus: `contract/transcript/streams/*.json`.
 *
 * Each scenario starts the fake gateway in-process, drives it over a real
 * WebSocket the way the app's chat controller does (roster, resume, history,
 * replay watermark, submit, answer), and writes down three things:
 *
 * - `frames`: every frame the server sent to the recorded client, in arrival
 *   order, tagged with the connection it arrived on;
 * - `steps`: every transcript-engine call the client made because of them, in
 *   order, with the current state left implicit (see `contract/README.md`);
 * - `checkpoints` (what `visibleItems` shows at each verbosity at the end of
 *   each phase) and `final` (the whole `ChatState` after the last step).
 *
 * Determinism: `crypto.randomUUID` is replaced by a counter-seeded generator
 * and `Date.now` is pinned before the gateway is loaded, so ids, epochs and
 * timestamps are the same on every run. Every engine call gets an explicit
 * `now`. Frame order comes from the gateway's own timers; the scenarios avoid
 * anything that would race them (the reconnect scenario disconnects while the
 * chat is idle and lets a second device run the turn it then replays; the
 * reopen scenarios go away on a counted frame, `goAwayAfter`, and read nothing
 * from that connection after it, however the frames were batched on the wire).
 *
 *   tsx packages/fake-gateway/scripts/dump-frames.ts --out <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

import {
  answerRequest,
  applyEvent,
  applyResumeSnapshot,
  applyServerRequest,
  beginLocalTurn,
  type CachedTranscript,
  type ChatState,
  confirmSubmit,
  createChatState,
  INTERACTIVE_METHODS,
  type InteractiveMethod,
  reconcile,
  reconcileTail,
  type RequestAnswerSummary,
  rowsToItems,
  type ServerRequest,
  snapshotForCache,
  stateFromCache,
  type TranscriptEvent,
  type TranscriptRow,
  type Verbosity,
  visibleItems
} from '@hermie/transcript'
import { WebSocket } from 'ws'

import { prettyJson } from '../../../scripts/golden/canonical-json'
import type { FakeGateway } from '../src/index'
import { loadContract } from '../src/interactive'

/** The same instant the transcript corpus is pinned to: 2026-09-21T14:13:20Z. */
const PINNED_NOW = 1_790_000_000_000
/** Each engine step is one second after the one before it. */
const STEP_MS = 1_000
const TOKEN = 'golden'
const TIMEOUT_MS = 10_000
/** The controller's `TAIL_ROW_LIMIT`: how many rows a tail sweep reads. */
const TAIL_ROW_LIMIT = 30

// ── determinism, installed before the gateway module is evaluated ───────────

const nodeCrypto = createRequire(import.meta.url)('node:crypto') as { randomUUID: () => string }
let uuidCounter = 0

/** A v4-shaped id whose leading hex varies with every call (the gateway slices prefixes). */
function seededUuid(): string {
  uuidCounter += 1

  let hex = ''
  let hash = 0x811c9dc5

  for (let round = 0; hex.length < 32; round += 1) {
    for (const char of `golden-${uuidCounter}-${round}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
    }

    hex += hash.toString(16).padStart(8, '0')
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

nodeCrypto.randomUUID = seededUuid
syncBuiltinESMExports()
Date.now = () => PINNED_NOW

const { startFakeGateway } = await import('../src/index')

// ── one recorded client ──────────────────────────────────────────────────────

type Json = Record<string, unknown>

interface Step {
  op: string
  args: unknown[]
  /** Index into `frames` of the frame that caused this step, when one did. */
  frame?: number
}

interface Checkpoint {
  after: number
  label: string
  visible: Record<Verbosity, unknown>
}

interface Recording {
  /** `connection` numbers the WebSocket; `"rest"` marks an HTTP body the client fetched. */
  frames: { connection: number | 'rest'; frame: unknown }[]
  steps: Step[]
  checkpoints: Checkpoint[]
}

const LEVELS: Verbosity[] = ['quiet', 'normal', 'verbose']

/**
 * The controller's `transcriptEventOf`: a frame reaches the engine as the same
 * four envelope fields whether it came live or from the replay ring, with
 * `turn_id` when the gateway sent one (an older gateway has none).
 */
function transcriptEventOf(raw: Json): TranscriptEvent | null {
  if (typeof raw.type !== 'string') {
    return null
  }

  return {
    type: raw.type,
    ...(typeof raw.session_id === 'string' ? { session_id: raw.session_id } : {}),
    ...(typeof raw.seq === 'number' ? { seq: raw.seq } : {}),
    ...(typeof raw.turn_id === 'string' && raw.turn_id ? { turn_id: raw.turn_id } : {}),
    payload: raw.payload
  } as TranscriptEvent
}

class Client {
  readonly recording: Recording = { frames: [], steps: [], checkpoints: [] }
  state: ChatState
  runtimeId = ''
  storedId = ''
  resolvedId = ''

  private socket: WebSocket | null = null
  private connection = 0
  private requestSeq = 0
  private readonly pending = new Map<string, (frame: Json, index: number) => void>()
  private readonly waiters = new Set<() => void>()
  private readonly answers: { approval?: string; clarify?: Record<string, string> }
  /** The frame after which the app goes away: its event type and how many of that type to let through. */
  private awayAfter: { type: string; nth: number } | undefined
  /** The connection the app stopped reading when it went away. */
  private awayConnection = 0
  /** What the app had cached at the moment it went away. */
  cached: CachedTranscript | undefined

  constructor(
    private readonly gateway: FakeGateway,
    readonly profile: string,
    answers: { approval?: string; clarify?: Record<string, string> } = {}
  ) {
    this.answers = answers
    this.state = createChatState(profile, '', '')
  }

  private now(): number {
    return PINNED_NOW + this.recording.steps.length * STEP_MS
  }

  /** Run one engine call on the current state and write it down. */
  step(op: string, args: unknown[], fn: (state: ChatState) => ChatState, frame?: number): void {
    this.state = fn(this.state)
    this.recording.steps.push({ op, args, ...(frame === undefined ? {} : { frame }) })
  }

  checkpoint(label: string): void {
    const visible = {} as Record<Verbosity, unknown>

    for (const level of LEVELS) {
      visible[level] = visibleItems(this.state, { level, showBotToBot: true, showThinking: true })
    }

    this.recording.checkpoints.push({ after: this.recording.steps.length, label, visible })
  }

  /**
   * The owner's acceptance for a reopened chat, checked while recording: at every
   * verbosity no assistant text and no tool card shows twice. A failure stops the
   * recording, so a corpus that holds a duplicate cannot be committed by accident.
   */
  assertNoDuplicates(label: string): void {
    for (const level of LEVELS) {
      const seen = new Set<string>()

      for (const { item } of visibleItems(this.state, { level, showBotToBot: true, showThinking: true })) {
        const key =
          item.kind === 'assistant' && item.text.trim()
            ? `assistant ${item.text}`
            : item.kind === 'tool'
              ? // A call is told apart by its identity where it has one: a provider reuses `call_0`, and
                // two calls that share it are two cards.
                `tool ${item.callKey ?? item.toolId}`
              : undefined

        if (key === undefined) {
          continue
        }

        if (seen.has(key)) {
          throw new Error(`${label} (${level}): ${key.slice(0, 80)} shows twice`)
        }

        seen.add(key)
      }
    }
  }

  async connect(): Promise<void> {
    this.connection += 1

    const connection = this.connection
    const socket = new WebSocket(`${this.gateway.wsUrl}?token=${TOKEN}`)

    this.socket = socket
    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (line.trim()) {
          this.onFrame(connection, JSON.parse(line) as Json)
        }
      }
    })

    await this.until(() =>
      this.recording.frames.some(entry => entry.connection === connection && (entry.frame as Json).params !== undefined)
    )
  }

  async disconnect(): Promise<void> {
    const socket = this.socket

    if (!socket) {
      return
    }

    this.socket = null
    await new Promise<void>(resolve => {
      socket.once('close', () => resolve())
      socket.close()
    })
  }

  async request<T = Json>(method: string, params: Json): Promise<T> {
    return (await this.call<T>(method, params)).result
  }

  /** A JSON-RPC call; resolves with the result and the index of its response frame. */
  call<T = Json>(method: string, params: Json): Promise<{ result: T; frame: number }> {
    const socket = this.socket

    if (!socket) {
      throw new Error(`${method}: not connected`)
    }

    this.requestSeq += 1

    const id = `c-${this.requestSeq}`

    return new Promise<{ result: T; frame: number }>((resolve, reject) => {
      this.pending.set(id, (frame, index) => {
        if (frame.error) {
          reject(new Error(`${method}: ${JSON.stringify(frame.error)}`))
        } else {
          resolve({ result: frame.result as T, frame: index })
        }
      })
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /** Resolve once `predicate` holds, re-checked after every frame. */
  until(predicate: () => boolean, label = 'a condition'): Promise<void> {
    if (predicate()) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`Timed out waiting for ${label}`))
      }, TIMEOUT_MS)
      const check = () => {
        if (predicate()) {
          clearTimeout(timer)
          this.waiters.delete(check)
          resolve()
        }
      }

      this.waiters.add(check)
    })
  }

  /** How many frames of `type` this session has seen so far. */
  count(type: string): number {
    return this.recording.frames.filter(entry => {
      const params = (entry.frame as Json).params as Json | undefined

      return (entry.frame as Json).method === 'event' && params?.type === type
    }).length
  }

  /**
   * Stop reading the socket right after the `nth` frame of `type`, and keep what
   * the app would have cached at that moment: the app going to the background in
   * the middle of a turn (the controller snapshots on background). Nothing after
   * that frame on this connection is recorded or applied, so the recording does
   * not depend on how many more frames the wire delivered before the socket was
   * closed.
   */
  goAwayAfter(type: string, nth = 1): void {
    this.awayAfter = { type, nth }
  }

  get away(): boolean {
    return this.cached !== undefined
  }

  private onFrame(connection: number, frame: Json): void {
    if (connection === this.awayConnection) {
      return
    }

    const index = this.recording.frames.length

    this.recording.frames.push({ connection, frame })

    if (typeof frame.method !== 'string') {
      const id = String(frame.id)
      const settle = this.pending.get(id)

      this.pending.delete(id)
      settle?.(frame, index)
    } else if (frame.method === 'event') {
      const raw = frame.params as Json
      const event = transcriptEventOf(raw)

      // Exactly the controller's filter: only this chat's runtime session.
      if (event && this.runtimeId && event.session_id === this.runtimeId) {
        const now = this.now()

        this.step('applyEvent', [event, now], state => applyEvent(state, event, now), index)

        const away = this.awayAfter

        if (away && away.type === event.type) {
          away.nth -= 1

          if (away.nth === 0) {
            this.awayAfter = undefined
            this.awayConnection = connection
            this.cached = snapshotForCache(this.state, this.now())
          }
        }
      }
    } else if (frame.id !== undefined) {
      this.onServerRequest(frame, index)
    }

    for (const waiter of [...this.waiters]) {
      waiter()
    }
  }

  private onServerRequest(frame: Json, index: number): void {
    const params = (frame.params ?? {}) as Json
    const method = String(frame.method)
    const id = String(frame.id)

    // An interactive request is applied here and answered by the scenario (`answerInteractive`).
    const known =
      method === 'approval' || method === 'clarify' || (INTERACTIVE_METHODS as readonly string[]).includes(method)

    if (!known || params.session_id !== this.runtimeId) {
      return
    }

    const request: ServerRequest = { id, method, params }
    const now = this.now()

    this.step('applyServerRequest', [request, now], state => applyServerRequest(state, request, now), index)

    let result: Json

    if (method === 'approval' && this.answers.approval) {
      const choice = this.answers.approval

      this.step('answerRequest', [id, choice], state => answerRequest(state, id, choice), index)
      result = { choice }
    } else if (method === 'clarify' && this.answers.clarify) {
      const answers = this.answers.clarify
      const batch = Array.isArray(params.questions)

      this.step('answerRequest', [id, answers], state => answerRequest(state, id, answers), index)
      result = batch ? { answers } : { answer: Object.values(answers)[0] ?? '' }
    } else {
      return
    }

    this.socket?.send(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  /**
   * The two `client.capabilities` calls of a client that can show every interactive request: the first
   * learns which methods the gateway raises, the second advertises them (`contract/requests` section 1).
   */
  async advertise(): Promise<void> {
    await this.request('client.capabilities', { server_requests: true })
    await this.request('client.capabilities', {
      server_requests: true,
      confirm: ['plain'],
      requests: [...INTERACTIVE_METHODS]
    })
  }

  /**
   * The person answers an interactive request: the engine records HOW it ended (keys and counts, never the
   * values), and the answer itself goes back on the request's own reply frame.
   */
  answerInteractive(id: string, summary: RequestAnswerSummary, result: Json): void {
    this.step('answerRequest', [id, summary], state => answerRequest(state, id, summary))
    this.socket?.send(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  /** `patchState`: a shallow merge into the state, then the listed keys removed. */
  patch(fields: Json, remove: string[] = [], frame?: number): void {
    this.step(
      'patchState',
      remove.length ? [fields, remove] : [fields],
      state => {
        const next = { ...state, ...fields } as Json

        for (const key of remove) {
          delete next[key]
        }

        return next as unknown as ChatState
      },
      frame
    )
  }

  /** The store's `bindRuntime`: a different runtime session restarts the watermark. */
  private bindRuntime(runtimeId: string, frame: number): void {
    this.runtimeId = runtimeId

    if (this.state.lastSeqSessionId === runtimeId) {
      this.patch({ runtimeSessionId: runtimeId }, [], frame)
    } else {
      this.patch({ runtimeSessionId: runtimeId, lastSeq: 0, lastSeqSessionId: runtimeId }, ['epoch'], frame)
    }
  }

  private async resume(): Promise<{ resume: Json; frame: number }> {
    const { result: resume, frame } = await this.call<Json>('session.resume', {
      session_id: this.storedId,
      profile: this.profile,
      omit_messages: true,
      source: 'hermie',
      cols: 96
    })

    this.bindRuntime(String(resume.session_id), frame)

    return { resume, frame }
  }

  /** The controller's `resumeSnapshotOf`, applied. */
  private applySnapshot(resume: Json, frame: number): void {
    const info = resume.info as Json | undefined
    const record = (value: unknown) => (value && typeof value === 'object' ? { ...(value as Json) } : null)
    const snapshot = {
      inflight: record(resume.inflight),
      running: (resume.running as boolean | undefined) ?? null,
      turn_started_at: (resume.turn_started_at as number | undefined) ?? (info?.turn_started_at as number) ?? null,
      queued: record(resume.queued),
      pending_approval: record(resume.pending_approval),
      todo_state: record(resume.todo_state),
      open_requests: (resume.open_requests as Json[] | undefined) ?? null
    } as Parameters<typeof applyResumeSnapshot>[1]
    const now = this.now()

    this.step('applyResumeSnapshot', [snapshot, now], state => applyResumeSnapshot(state, snapshot, now), frame)
  }

  /** The controller's `registerOpenRequests`: re-delivered requests become cards again. */
  private registerOpenRequests(entries: unknown, frame: number): void {
    for (const entry of Array.isArray(entries) ? (entries as Json[]) : []) {
      if (typeof entry?.id !== 'string' || typeof entry.method !== 'string') {
        continue
      }

      const request: ServerRequest = {
        id: entry.id,
        method: entry.method,
        params: entry.params && typeof entry.params === 'object' ? (entry.params as Json) : {},
        replayed: true
      }
      const now = this.now()

      this.step('applyServerRequest', [request, now], state => applyServerRequest(state, request, now), frame)
    }
  }

  /**
   * The controller's `replaySince`. Cold (no watermark yet, or another epoch):
   * adopt `latest_seq` without replaying, history already has it. Warm: apply
   * every event the ring returns.
   */
  private async replaySince(): Promise<void> {
    const knownEpoch = this.state.epoch
    const { result: since, frame } = await this.call<{
      events?: Json[]
      latest_seq: number
      epoch: string
      truncated?: boolean
      open_requests?: Json[]
    }>('session.events.since', { session_id: this.runtimeId, last_seen: this.state.lastSeq })
    const epochChanged = knownEpoch !== undefined && knownEpoch !== since.epoch
    const cold = this.state.lastSeq === 0 || epochChanged

    if (cold || since.truncated) {
      this.patch(
        {
          lastSeq: epochChanged ? since.latest_seq : Math.max(this.state.lastSeq, since.latest_seq),
          lastSeqSessionId: this.runtimeId,
          epoch: since.epoch
        },
        [],
        frame
      )
    } else {
      for (const raw of since.events ?? []) {
        // The controller's `transcriptEventOf`, which the live frames go through too.
        const event = transcriptEventOf(raw)

        if (!event) {
          continue
        }

        const now = this.now()

        this.step('applyEvent', [event, now], state => applyEvent(state, event, now), frame)
      }

      if (this.state.epoch !== since.epoch) {
        this.patch({ epoch: since.epoch }, [], frame)
      }
    }

    this.registerOpenRequests(since.open_requests, frame)
  }

  private async canonical(): Promise<Json> {
    const roster = await this.request<{ profiles?: Json[] }>('profiles.list', { include_sessions: true })
    const canonical = (roster.profiles ?? []).find(entry => entry.name === this.profile)?.canonical_session as
      Json | undefined

    if (!canonical) {
      throw new Error(`${this.profile} has no canonical Bot Chat`)
    }

    return canonical
  }

  /**
   * The controller's `hydrate`: roster, resume on the durable id, the resume's
   * own `session.info`, history, the resume snapshot, open requests, replay.
   */
  async hydrate(): Promise<void> {
    const canonical = await this.canonical()

    this.storedId = String(canonical.id)
    this.resolvedId = String(canonical.resolved_id || canonical.id)

    const { storedId, profile } = this
    const resolvedId = this.resolvedId

    this.step('createChatState', [profile, storedId, resolvedId], () => createChatState(profile, storedId, resolvedId))
    await this.load()
  }

  /**
   * The controller's `hydrate` for a chat it has a cache of: the cached
   * transcript is painted first (`stateFromCache`, written down as the state it
   * produces), then the same resume, history, snapshot and replay as a cold
   * open. The cache keeps its watermark, so the replay is warm: it hands back
   * every frame after the moment the app went away, including frames for rows
   * history already holds.
   */
  async reopen(beforeReplay?: () => void): Promise<void> {
    if (!this.cached) {
      throw new Error('reopen: the app never went away')
    }

    // The cache is stored as JSON, so what is painted is what survives that.
    const cached = JSON.parse(JSON.stringify(this.cached)) as CachedTranscript
    const canonical = await this.canonical()

    this.storedId = String(canonical.id)
    this.resolvedId = String(canonical.resolved_id || canonical.id)

    const { storedId, profile } = this
    const resolvedId = this.resolvedId
    const painted = stateFromCache(profile, { storedSessionId: storedId, resolvedSessionId: resolvedId }, cached)
    const { botName: _botName, storedSessionId: _stored, resolvedSessionId: _resolved, ...fields } = painted

    this.step('createChatState', [profile, storedId, resolvedId], () => createChatState(profile, storedId, resolvedId))
    this.patch(JSON.parse(JSON.stringify(fields)) as Json)
    await this.load(beforeReplay)
  }

  /**
   * `hydrate` from the resume on: resume, its `session.info`, history, snapshot,
   * open requests, replay. `beforeReplay` runs when history, snapshot and open
   * requests are in and the replay has not started: what the screen holds in
   * between.
   */
  private async load(beforeReplay?: () => void): Promise<void> {
    const { resume, frame: resumeFrame } = await this.resume()

    if (resume.info) {
      const event = { type: 'session.info', session_id: this.runtimeId, payload: resume.info } as TranscriptEvent
      const now = this.now()

      this.step('applyEvent', [event, now], state => applyEvent(state, event, now), resumeFrame)
    }

    const { result: history, frame: historyFrame } = await this.call<{ messages?: TranscriptRow[] }>(
      'session.history',
      { session_id: this.runtimeId, profile: this.profile }
    )
    const rows = history.messages ?? []

    if (rows.length) {
      const items = rowsToItems(rows, 'rpc')

      this.step('reconcile', [items], state => reconcile(state, items), historyFrame)
    }

    this.applySnapshot(resume, resumeFrame)
    this.registerOpenRequests(resume.open_requests, resumeFrame)
    beforeReplay?.()
    await this.replaySince()
  }

  /**
   * The controller's `recoverAfterReconnect`: re-resume, snapshot, open
   * requests, replay, and, when the roster counts more rows than the chat
   * holds, the REST tail.
   */
  async recover(): Promise<void> {
    const canonical = await this.canonical()
    const { resume, frame } = await this.resume()

    this.applySnapshot(resume, frame)
    this.registerOpenRequests(resume.open_requests, frame)
    await this.replaySince()

    const expected = typeof canonical.message_count === 'number' ? canonical.message_count : 0
    const persisted = this.state.order.filter(id => this.state.items[id]?.rowId !== undefined).length

    if (expected > persisted) {
      const response = await fetch(
        `${this.gateway.url}/api/sessions/${encodeURIComponent(this.resolvedId)}/messages?limit=${TAIL_ROW_LIMIT}&order=latest`,
        { headers: { 'X-Hermes-Session-Token': TOKEN } }
      )
      const body = (await response.json()) as { messages?: TranscriptRow[] }
      const index = this.recording.frames.length

      this.recording.frames.push({ connection: 'rest', frame: body })

      const rows = body.messages ?? []

      if (rows.length) {
        const items = rowsToItems(rows, 'rest')

        this.step('reconcileTail', [items], state => reconcileTail(state, items), index)
      }
    }
  }

  /** Paint, submit and confirm a turn, in the order the controller's `send` does. */
  async submit(text: string): Promise<void> {
    const beginNow = this.now()

    this.step('beginLocalTurn', [text, null, beginNow], state => beginLocalTurn(state, text, undefined, beginNow))

    const { result, frame } = await this.call<{ status?: string }>('prompt.submit', {
      session_id: this.runtimeId,
      profile: this.profile,
      text
    })
    const submitResult = { status: result?.status ?? null }
    const confirmNow = this.now()

    this.step(
      'confirmSubmit',
      [submitResult, confirmNow],
      state => confirmSubmit(state, submitResult, confirmNow),
      frame
    )
  }

  /** The end of a turn: its `message.complete`, then the roster nudge that follows it. */
  async settle(completesBefore: number): Promise<void> {
    await this.until(() => this.count('message.complete') > completesBefore, 'message.complete')
    await this.until(() => {
      const last = this.recording.frames[this.recording.frames.length - 1]?.frame as Json | undefined

      return ((last?.params as Json | undefined)?.type as string | undefined) === 'sessions.changed'
    }, 'sessions.changed')
  }
}

// ── scenarios ────────────────────────────────────────────────────────────────

interface Scenario {
  name: string
  description: string
  profile: string
  answers?: { approval?: string; clarify?: Record<string, string> }
  /** The fake gateway's own options for this scenario; the recorded default is the fork's row identity on. */
  gateway?: { rowIdentity?: boolean }
  run: (client: Client, gateway: FakeGateway) => Promise<void>
}

/**
 * The owner's case of 2026-10-03: a turn that writes notes before it answers,
 * the app going away in the middle of it, and the chat opened again from the
 * cache it saved then. History brings every row of the turn, and
 * `session.events.since` replays every frame after the cached watermark,
 * describing rows that are already on screen.
 *
 * The turn goes on without the app, and everything it does is over before the
 * chat is opened again (the fake gateway sends `message.complete` and the
 * roster nudge in the same tick it stops running), so which frames the replay
 * returns never depends on timing.
 */
function reopenScenario(
  cut: { type: string; nth?: number },
  options: { noDuplicates: boolean; earlier?: string[]; prompt?: string }
): Scenario['run'] {
  return async (client, gateway) => {
    await client.hydrate()
    client.checkpoint('hydrated')

    // Turns that finish with the app watching, before the one it goes away in.
    for (const [turn, prompt] of (options.earlier ?? []).entries()) {
      const before = client.count('message.complete')

      await client.submit(prompt)
      await client.settle(before)
      client.checkpoint(`settled ${turn + 1}`)
    }

    client.goAwayAfter(cut.type, cut.nth)
    await client.submit(options.prompt ?? 'reconcile the ledger')
    await client.until(() => client.away, `the ${cut.type} the app goes away on`)
    client.checkpoint('away')

    // The turn goes on without the app.
    for (let waited = 0; gateway.state.runningSessions.size > 0; waited += 5) {
      if (waited > TIMEOUT_MS) {
        throw new Error('Timed out waiting for the turn to finish')
      }

      await new Promise(resolve => setTimeout(resolve, 5))
    }

    await client.disconnect()
    await client.connect()

    // `reopened`: the cache painted, history in, nothing replayed yet. `settled`: the replay applied.
    await client.reopen(() => client.checkpoint('reopened'))
    client.checkpoint('settled')

    if (options.noDuplicates) {
      client.assertNoDuplicates('settled')
    }
  }
}

/**
 * One interactive request on an idle chat: advertised, raised (the contract's example frame for the
 * method), seen, answered with one of the contract's valid answers. The checkpoints are the open card and
 * the settled one.
 */
function interactiveScenario(
  method: InteractiveMethod,
  name: string,
  description: string,
  answer: string,
  summary: RequestAnswerSummary
): Scenario {
  return {
    name,
    description,
    profile: 'researcher',
    async run(client, gateway) {
      await client.hydrate()
      client.checkpoint('hydrated')
      await client.advertise()

      const raised = gateway.raiseInteractive({ method })

      if (raised.kind !== 'raised') {
        throw new Error(`${method}: not raised (${raised.kind})`)
      }

      await client.until(
        () =>
          client.recording.frames.some(
            entry => (entry.frame as Json).id === raised.id && (entry.frame as Json).method === method
          ),
        `the ${method} frame`
      )
      client.checkpoint('asked')

      const examples = (loadContract().examples.methods as Record<string, { answers: Json[] }>)[method]
      const result = examples?.answers.find(entry => entry.name === answer)?.result

      if (!result) {
        throw new Error(`${method}: the contract has no valid answer named ${answer}`)
      }

      client.answerInteractive(raised.id, summary, result as Json)

      const ended = await raised.settled

      if (ended.outcome !== 'answered') {
        throw new Error(`${method}: the gateway did not take the answer (${ended.outcome})`)
      }

      client.checkpoint('answered')
    }
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: 'plain-turn',
    description: 'Open the chat, send a prompt and stream a plain reply (the "math" scenario: no tool call).',
    profile: 'researcher',
    async run(client) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('explain the math behind the retry budget')
      await client.settle(before)
      client.checkpoint('settled')
    }
  },
  {
    name: 'tool-turn',
    description: 'A reply that reasons first, generates and runs one tool call, then answers.',
    profile: 'researcher',
    async run(client) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('summarise the notes')
      await client.settle(before)
      client.checkpoint('settled')
    }
  },
  {
    name: 'approval',
    description: 'The turn parks on a server→client approval; the client answers "once" and the turn completes.',
    profile: 'researcher',
    answers: { approval: 'once' },
    async run(client) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('please approve this cleanup')
      await client.settle(before)
      client.checkpoint('settled')
    }
  },
  {
    name: 'clarify',
    description: 'An idle chat receives a two-question batch clarify; the client answers both by qid.',
    profile: 'researcher',
    answers: { clarify: { q1: 'staging', q2: 'yes' } },
    async run(client, gateway) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const answered = gateway.requestServerSide('clarify', {
        session_id: client.runtimeId,
        questions: [
          { qid: 'q1', question: 'Which environment?', choices: ['staging', 'production'], multi_select: false },
          { qid: 'q2', question: 'Notify the team?', choices: ['yes', 'no'], multi_select: false }
        ]
      })

      await answered
      client.checkpoint('answered')
    }
  },
  interactiveScenario(
    'input.form',
    'input-form',
    'An idle chat that advertised the interactive requests receives an input.form (the contract’s hotel ' +
      'booking: eleven fields of every kind); the person fills it in, the engine records that it was answered ' +
      'and nothing of what was typed.',
    'answered_everything',
    { status: 'answered' }
  ),
  interactiveScenario(
    'input.file',
    'input-file',
    'The same chat receives an input.file (a photo of a receipt, uploaded and answered by reference); the ' +
      'engine records that one file was sent and nothing about it.',
    'photo',
    { status: 'answered', count: 1 }
  ),
  interactiveScenario(
    'review.draft',
    'review-draft',
    'The same chat receives a review.draft (a mail to approve or edit); the person edits it and approves, ' +
      'and the engine records that it was approved, edited, and not what it now says.',
    'approved_edited',
    { decision: 'approved', edited: true }
  ),
  interactiveScenario(
    'review.diff',
    'review-diff',
    'The same chat receives a review.diff (the contract’s two changes to settings.py); the person approves ' +
      'the first hunk and rejects the second, and the engine records that it was approved, how many hunks ' +
      'were approved and rejected, and not a line of the diff.',
    'approved_one_hunk',
    { decision: 'approved', approvedHunks: 1, rejectedHunks: 1 }
  ),
  {
    name: 'subagents',
    description: 'A delegate_task fan-out of three subagents, the third of which fails, inside one turn.',
    profile: 'researcher',
    async run(client) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('delegate the release checks')
      await client.settle(before)
      client.checkpoint('settled')
    }
  },
  {
    name: 'interim-reopen',
    description:
      'A turn with interim assistant messages on writes two notes, each with its tool call, before it answers. ' +
      'The app goes away right after the first note (`message.interim`), the turn finishes without it, and the ' +
      'chat is opened again from the cache: the cached transcript is painted, history brings every row of the ' +
      'turn, then session.events.since replays every frame after the cached watermark, describing rows that ' +
      'are already on screen. Each note, each tool card and the answer must show once, at every verbosity.',
    profile: 'researcher',
    run: reopenScenario({ type: 'message.interim' }, { noDuplicates: true })
  },
  {
    name: 'interim-reopen-legacy',
    description:
      'The same reopen against a gateway before row identity (`rowIdentity: false`): no turn_id, no row_id on the ' +
      'frames, no call identity, and no message.interim at all, so the app goes away right after the first ' +
      'tool.start instead. It records whatever the engine produces without identity (the degrade), and asserts ' +
      'nothing about duplicates.',
    profile: 'researcher',
    gateway: { rowIdentity: false },
    run: reopenScenario({ type: 'tool.start' }, { noDuplicates: false })
  },
  {
    name: 'reused-call-ids',
    description:
      'Two turns on one chat whose tool call the provider names `call_0` both times. The first finishes with the ' +
      'app watching; the app goes away right after the second turn’s note (`message.interim`), the turn finishes ' +
      'without it, ' +
      'and the chat is opened again from the cache: history brings both turns and session.events.since replays ' +
      'the second one’s frames. The two cards share a provider id and differ only by their call identity, so each ' +
      'must show once and keep its own result.',
    profile: 'researcher',
    run: reopenScenario(
      { type: 'message.interim' },
      { noDuplicates: true, earlier: ['recount the entries'], prompt: 'recount the entries again' }
    )
  },
  {
    name: 'reused-call-ids-legacy',
    description:
      'The same two turns against a gateway before row identity (`rowIdentity: false`): the frames carry no call ' +
      'identity, so a card is named by the provider id alone. It records whatever the engine produces without ' +
      'identity (the degrade), and asserts nothing about duplicates.',
    profile: 'researcher',
    gateway: { rowIdentity: false },
    run: reopenScenario(
      { type: 'tool.start' },
      { noDuplicates: false, earlier: ['recount the entries'], prompt: 'recount the entries again' }
    )
  },
  {
    name: 'reconnect-replay',
    description:
      'Stream a turn live, disconnect while idle, let a second device run a turn on the same session, then ' +
      'reconnect the way the controller recovers: re-resume, replay the missed events through ' +
      'session.events.since, and fold in the REST tail because the roster counts more rows than the chat holds.',
    profile: 'researcher',
    async run(client, gateway) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('summarise the notes')
      await client.settle(before)
      client.checkpoint('settled live')

      await client.disconnect()

      // Another device on the same session; nothing it receives is recorded.
      const other = new Client(gateway, client.profile)

      await other.connect()
      await other.hydrate()

      const otherBefore = other.count('message.complete')

      await other.submit('explain the math behind the retry budget')
      await other.settle(otherBefore)
      await other.disconnect()

      await client.connect()
      await client.recover()
      client.checkpoint('recovered')
    }
  }
]

function outDir(): string {
  const index = process.argv.indexOf('--out')
  const dir = index >= 0 ? process.argv[index + 1] : undefined

  if (!dir) {
    console.error('usage: dump-frames.ts --out <dir>')
    process.exit(1)
  }

  return dir
}

async function record(scenario: Scenario): Promise<unknown> {
  uuidCounter = 0

  /*
    The recorded streams carry the roster, and the roster carries the plugin's
    advert. The web client's members of it (`web`, `webPush`) were added after
    these corpora were recorded and mean nothing to a transcript replay, so they
    are held back here: the corpus stays what it was, and a change to the fake's
    default advert for a client of its own does not turn the native CI red.
  */
  const gateway = await startFakeGateway({
    auth: 'token',
    token: TOKEN,
    streamDelayMs: 4,
    subagentStepMs: 4,
    webClient: false,
    webPushKey: false,
    ...scenario.gateway
  })

  try {
    const client = new Client(gateway, scenario.profile, scenario.answers)

    await client.connect()
    await scenario.run(client, gateway)
    await client.disconnect()

    return {
      scenario: scenario.name,
      description: scenario.description,
      profile: scenario.profile,
      pinnedNow: PINNED_NOW,
      stepMs: STEP_MS,
      frames: client.recording.frames,
      steps: client.recording.steps,
      checkpoints: client.recording.checkpoints,
      final: client.state
    }
  } finally {
    await gateway.close()
  }
}

const dir = join(outDir(), 'transcript', 'streams')

mkdirSync(dir, { recursive: true })

for (const scenario of SCENARIOS) {
  writeFileSync(join(dir, `${scenario.name}.json`), prettyJson(await record(scenario)))
}
